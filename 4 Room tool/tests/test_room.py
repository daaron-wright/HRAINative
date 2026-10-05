"""End-to-end test of the workshop room: 25 simulated phones, every activity type, the facilitator
actions, long-poll wake-up, persistence across a restart, exports and basic abuse cases.
    python3 tests/test_room.py          (starts its own server on port 8097 with a temporary data file)"""
import json, os, subprocess, sys, tempfile, threading, time, urllib.request, urllib.error
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
PORT, KEY = 8097, 'test-key-123'
BASE = f'http://127.0.0.1:{PORT}'
ACTS = json.load(open(os.path.join(ROOT, 'activities.json'), encoding='utf-8'))['activities']
results = []

def check(name, cond, detail=''):
    results.append((name, bool(cond), detail)); print(('PASS ' if cond else 'FAIL ') + name + (f'  [{detail}]' if detail and not cond else ''))

def req(path, body=None, timeout=10):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, headers={'Content-Type': 'application/json'} if data else {})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as f:
            raw = f.read(); ct = f.headers.get('Content-Type', '')
            return 200, (json.loads(raw) if 'json' in ct else raw.decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'{}')

def host(op, **kw):
    kw.update(key=KEY, op=op); c, j = req('/api/host', kw); assert c == 200, (op, kw, j); return j

def ans(tok, aid, payload):
    return req('/api/answer', {'t': tok, 'aid': aid, 'payload': payload})

def state(view='host', **kw):
    if view == 'host': kw.setdefault('key', KEY)
    q = '&'.join(f'{k}={v}' for k, v in dict(view=view, v=0, **kw).items())
    return req('/api/state?' + q)[1]

def start(datafile):
    env = dict(os.environ, ROOM_DATA=datafile, ROOM_KEY=KEY)
    p = subprocess.Popen([sys.executable, '-u', os.path.join(ROOT, 'room.py'), '--port', str(PORT)], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for _ in range(50):
        try: urllib.request.urlopen(BASE + '/api/config', timeout=1); return p
        except Exception: time.sleep(0.1)
    raise SystemExit('server did not start')

tmp = tempfile.mkdtemp(); datafile = os.path.join(tmp, 'room-data.json')
srv = start(datafile)
try:
    # ---------------------------------------------------------------- pages and config
    for path in ['/', '/stage', '/host', '/print', '/static/app.js', '/static/stage.js', '/static/host.js', '/static/common.js', '/static/style.css', '/static/qrcode.min.js']:
        c, _ = req(path); check(f'page {path} loads', c == 200, c)
    c, _ = req('/static/../room.py'); check('no path traversal', c == 404, c)
    c, cfg = req('/api/config'); check('config lists every activity', len(cfg['activities']) == len(ACTS), len(cfg['activities']))
    check('config has no secrets', KEY not in json.dumps(cfg))

    # ---------------------------------------------------------------- joining
    toks = {}
    def join(i):
        c, j = req('/api/join', {'name': f'Person {i:02d}', 'pin': f'{1000 + i}'}); toks[i] = j.get('token')
    th = [threading.Thread(target=join, args=(i,)) for i in range(1, 26)]
    [t.start() for t in th]; [t.join() for t in th]
    check('25 people join at once', all(toks.get(i) for i in range(1, 26)) and len(state()['people']) == 25)
    c, j = req('/api/join', {'name': 'person 03', 'pin': '9999'}); check('wrong PIN for a taken name is refused', c == 400 and 'PIN' in j['error'], j)
    c, j = req('/api/join', {'name': 'Person 03', 'pin': '1003'}); check('right PIN rejoins the same person', c == 200 and len(state()['people']) == 25)
    toks[3] = j['token']
    c, j = req('/api/join', {'name': 'X', 'pin': '12'}); check('PIN must be four digits', c == 400)
    c, j = req('/api/join', {'name': '', 'pin': '1234'}); check('empty name refused', c == 400)
    c, j = req('/api/first?name=Person%2003'); check('known name reported as taken', j.get('state') == 'taken', j)
    host('roster', names='Rostered Person, Data\nPerson 01')
    c, j = req('/api/first?name=Rostered%20Person'); check('roster name reported as roster', j.get('state') == 'roster', j)
    c, j = req('/api/join', {'name': 'Rostered Person', 'pin': '4321'}); check('roster name claims a PIN on first join', c == 200)
    c, j = req('/api/join', {'name': 'Rostered Person', 'pin': '1111'}); check('roster name then needs its PIN', c == 400)
    c, j = req('/api/host', {'key': 'wrong', 'op': 'open', 'aid': 'arrive.comfort'}); check('wrong facilitator key refused', c == 400)
    c, j = req('/api/state?view=host&key=wrong&v=0'); check('host state needs the key', c == 400)

    T = [toks[i] for i in range(1, 26)]

    # ---------------------------------------------------------------- long-poll wakes up on change
    v = state('stage')['v']; got = {}
    def waiter(): t0 = time.time(); s = req(f'/api/state?view=stage&v={v}', timeout=30)[1]; got['dt'] = time.time() - t0; got['cur'] = s['current']
    w = threading.Thread(target=waiter); w.start(); time.sleep(0.5); host('open', aid='arrive.comfort'); w.join()
    check('room screen wakes within a second of a change', got.get('cur') == 'arrive.comfort' and got['dt'] < 1.5, got)

    # ---------------------------------------------------------------- scale
    c, j = ans(T[0], 'welcome.sure', {'v': 3}); check('closed activity refuses answers', c == 400, j)
    for i, t in enumerate(T): ans(t, 'arrive.comfort', {'v': (i % 5) + 1})
    ans(T[0], 'arrive.comfort', {'v': 5})   # change of mind replaces the answer
    a = state()['agg']; check('scale counts and mean', a['n'] == 25 and a['counts']['5'] == 6 and abs(a['mean'] - (sum((i % 5) + 1 for i in range(25)) - 1 + 5) / 25) < 0.01, a)
    c, j = ans(T[1], 'arrive.comfort', {'v': 9}); check('scale out of range refused', c == 400)
    p = state('part', t=T[0]); check('participant does not see scale results before the reveal', 'counts' not in p['agg'] and p['mine']['v'] == 5)
    host('reveal', aid='arrive.comfort'); p = state('part', t=T[0]); check('participant sees results after the reveal', 'counts' in p['agg'])

    # ---------------------------------------------------------------- words, with moderation and hostile text
    host('open', aid='arrive.stuck')
    for i, t in enumerate(T[:10]): ans(t, 'arrive.stuck', {'text': ['Waiting for release', 'Atlas stage wrong', '<script>alert(1)</script>'][i % 3]})
    for k in range(3): ans(T[11], 'arrive.stuck', {'text': f'answer {k}'})
    c, j = ans(T[11], 'arrive.stuck', {'text': 'fourth'}); check('three answers each', c == 400)
    c, j = ans(T[12], 'arrive.stuck', {'text': 'x' * 61}); check('words longer than the limit refused', c == 400)
    a = state()['agg']; check('words entries counted', a['n'] == 13, a['n'])
    bad = [x for x in a['entries'] if 'script' in x['text']]
    for e in bad: host('words_hide', aid='arrive.stuck', pid=e['pid'], ts=e['t'])
    s_ = state('stage'); check('hidden answers leave the room screen', bad and all('script' not in x['text'] for x in s_['agg']['entries']) and len(s_['agg']['entries']) == 13 - len(bad))
    check('hidden answers stay visible to the facilitator, marked', sum(1 for x in state()['agg']['entries'] if x['hidden']) == len(bad))
    check('room screen never carries names', all(x.get('who') is None for x in s_['agg']['entries']))

    # ---------------------------------------------------------------- poll with a correct answer
    host('open', aid='reality.check')
    for i, t in enumerate(T): ans(t, 'reality.check', {'choice': 1 if i < 18 else 0})
    s_ = state('stage'); check('poll counts', s_['agg']['counts'] == [7, 18, 0], s_['agg']['counts'])
    host('reveal', aid='reality.check'); s_ = state('stage'); check('reveal closes a check', s_['agg']['status'] == 'closed' and s_['agg']['reveal'])
    c, j = ans(T[0], 'reality.check', {'choice': 2}); check('no answers after the reveal', c == 400)

    # ---------------------------------------------------------------- multi-choice poll
    host('open', aid='rotation.unlock')
    ans(T[0], 'rotation.unlock', {'choices': [0, 2]}); ans(T[1], 'rotation.unlock', {'choices': [2]})
    a = state()['agg']; check('multi-choice poll counts each choice', a['counts'][0] == 1 and a['counts'][2] == 2, a['counts'])
    c, j = ans(T[2], 'rotation.unlock', {'choices': []}); check('multi-choice needs one', c == 400)
    ex = ACTS['rotation.unlock']['exclusive']
    c, j = ans(T[3], 'rotation.unlock', {'choices': [0, ex]}); check('"None of them" cannot be ticked with other answers', c == 400, j)
    c, j = ans(T[3], 'rotation.unlock', {'choices': [ex]}); check('"None of them" on its own is fine', c == 200, j)

    # ---------------------------------------------------------------- poll with rounds (take a side, vote twice)
    host('open', aid='boundaries.b1')
    for i, t in enumerate(T): ans(t, 'boundaries.b1', {'choice': i % 3})
    host('next', aid='boundaries.b1')
    for i, t in enumerate(T): ans(t, 'boundaries.b1', {'choice': 0})
    a = state()['agg']; check('second vote kept apart from the first', a['round'] == 1 and a['counts'][0] == 25 and a['history'][0]['counts'] == [9, 8, 8], a)

    # ---------------------------------------------------------------- game: 7 rounds, scores, leaderboard
    g = ACTS['reality.game']; host('open', aid='reality.game')
    for r in range(len(g['rounds'])):
        right = g['rounds'][r]['answer']
        for i, t in enumerate(T): ans(t, 'reality.game', {'choice': right if i < 10 + r else (right + 1) % 3})
        host('reveal', aid='reality.game')
        c, j = ans(T[24], 'reality.game', {'choice': right}); check(f'game round {r + 1}: answers locked after reveal', c == 400)
        if r < len(g['rounds']) - 1: host('next', aid='reality.game')
    c, j = req('/api/host', {'key': KEY, 'op': 'next', 'aid': 'reality.game'}); check('no round after the last', c == 400)
    c, j = req('/api/host', {'key': KEY, 'op': 'open', 'aid': 'reality.game'}); check('a finished game round cannot be reopened by mistake', c == 400, j)
    s_ = state('stage'); p0 = state('part', t=T[0]); p24 = state('part', t=T[24])
    check('game scores', p0['score'] == 7 and p24['score'] == 0, (p0.get('score'), p24.get('score')))
    check('leaderboard top score', s_['agg']['board'][0][1] == 7)
    check('scores on the room screen show first name and initial only', all(len(b[0].split()) <= 2 and b[0].endswith('.') for b in s_['agg']['board']), s_['agg']['board'][:3])

    host('open', aid='welcome.sure'); host('show', aid='welcome.check')
    check('showing another activity closes the one it replaces', state()['acts']['welcome.sure']['status'] == 'closed')
    # ---------------------------------------------------------------- dots and points
    host('open', aid='reality.pain')
    for i, t in enumerate(T): ans(t, 'reality.pain', {'alloc': {str(i % 7): 2, '5': 1} if i % 7 != 5 else {'5': 3}})
    a = state()['agg']; check('dots totals', sum(a['totals']) == 75 and a['totals'][5] == 3 * 3 + 22, a['totals'])
    c, j = ans(T[0], 'reality.pain', {'alloc': {'0': 4}}); check('more dots than allowed refused', c == 400)
    host('open', aid='next.measures')
    for t in T[:4]: ans(t, 'next.measures', {'alloc': {'0': 50, '1': 50}})
    c, j = ans(T[5], 'next.measures', {'alloc': {'0': 60}}); check('points must add up to 100', c == 400)
    a = state()['agg']; check('points mean', a['mean'][0] == 50.0 and a['n'] == 4, a)

    # ---------------------------------------------------------------- sort (graded and with many bins)
    host('open', aid='outcome.which'); corr = ACTS['outcome.which']['correct']
    for i, t in enumerate(T): ans(t, 'outcome.which', {'bins': {str(k): (corr[k] if i % 4 else 1 - corr[k]) for k in range(len(corr))}})
    a = state()['agg']; check('sort grid', all(sum(r) == 25 for r in a['grid']), a['grid'])
    p = state('part', t=T[0]); check('graded sort hidden from participants before reveal', 'grid' not in p['agg'])
    host('open', aid='decisions.owner')
    for i, t in enumerate(T): ans(t, 'decisions.owner', {'bins': {'0': i % 9, '3': 3}})
    a = state()['agg']; check('sort with nine roles', a['grid'][3][3] == 25)
    c, j = ans(T[0], 'decisions.owner', {'bins': {'0': 99}}); check('unknown bin refused', c == 400)

    # ---------------------------------------------------------------- forms: votes, tally, numbers, limits
    host('open', aid='outcome.edit')
    for i, t in enumerate(T[:6]): ans(t, 'outcome.edit', {'change': f'wording {i}', 'why': 'clearer'})
    c, j = ans(T[0], 'outcome.edit', {'change': '', 'why': 'x'}); check('empty form field refused', c == 400)
    subs = state()['agg']['subs']; sid = subs[0]['id']
    for t in T[:5]: req('/api/vote', {'t': t, 'aid': 'outcome.edit', 'sid': sid})
    req('/api/vote', {'t': T[0], 'aid': 'outcome.edit', 'sid': sid})   # toggles off
    a = state()['agg']; check('votes count and toggle', next(s['votes'] for s in a['subs'] if s['id'] == sid) == 4)
    for s in a['subs'][1:4]: req('/api/vote', {'t': T[9], 'aid': 'outcome.edit', 'sid': s['id']})
    c, j = req('/api/vote', {'t': T[9], 'aid': 'outcome.edit', 'sid': a['subs'][4]['id']}); check('three votes each', c == 400, j)
    host('sub', aid='outcome.edit', sid=sid, what='hide'); s_ = state('stage')
    check('hidden card leaves the room screen', all(s['id'] != sid for s in s_['agg']['subs']))
    host('open', aid='outcome.end'); opts = ACTS['outcome.end']['fields'][0]['options']
    for i, t in enumerate(T[:9]): ans(t, 'outcome.end', {'end': opts[i % 3], 'why': 'because'})
    c, j = ans(T[10], 'outcome.end', {'end': 'Somewhere else', 'why': 'x'}); check('choice outside the list refused', c == 400)
    a = state()['agg']; check('tally by end point', a['tally'][opts[0]] == 3, a['tally'])
    host('open', aid='rotation.months')
    for i, t in enumerate(T[:5]): ans(t, 'rotation.months', {'junior': 10 + i, 'middle': 18, 'senior': 20 + i})
    c, j = ans(T[6], 'rotation.months', {'junior': 'abc', 'middle': 1, 'senior': 1}); check('months must be numbers', c == 400)
    c, j = ans(T[6], 'rotation.months', {'junior': 60, 'middle': 1, 'senior': 1}); check('months over 48 refused', c == 400)
    a = state()['agg']; check('median and range', a['stats']['junior']['median'] == 12 and a['stats']['senior']['max'] == 24, a['stats'])

    # ---------------------------------------------------------------- findings with the judge
    host('open', aid='test.findings')
    for i, t in enumerate(T[:8]): ans(t, 'test.findings', {'kind': 'Wrong result' if i % 2 else 'Unclear', 'step': ACTS['test.findings']['steps'][0], 'text': f'saw {i}'})
    subs = state()['agg']['subs']
    for s in subs[:3]: host('sub', aid='test.findings', sid=s['id'], what='accepted')
    a = state()['agg']; check('findings counted by kind', a['kinds']['Wrong result'] == 4 and a['kinds']['Unclear'] == 4, a['kinds'])
    check('points only for accepted findings', sum(b[1] for b in a['board']) == sum(ACTS['test.findings']['points'][s['data']['kind']] for s in subs[:3]), a['board'])
    p = state('part', t=T[0]); check('participant sees own finding status', p['mine'][0]['status'] in ('accepted', 'new'))

    # ---------------------------------------------------------------- claim seats
    host('open', aid='checkpoint.seats')
    ans(T[0], 'checkpoint.seats', {'item': 0, 'slot': 0}); ans(T[1], 'checkpoint.seats', {'item': 0, 'slot': 0}); ans(T[2], 'checkpoint.seats', {'item': 1, 'slot': 1})
    ans(T[1], 'checkpoint.seats', {'item': 0, 'slot': 0})   # gives it back
    for k in range(3): ans(T[3], 'checkpoint.seats', {'item': k, 'slot': 0})
    c, j = ans(T[3], 'checkpoint.seats', {'item': 4, 'slot': 0}); check('three seats each', c == 400)
    a = state('stage')['agg']; check('seat claims with names', a['claims'][0][0] == ['Person 01', 'Person 04'] and a['claims'][1][1] == ['Person 03'], a['claims'][:2])

    # ---------------------------------------------------------------- checklist
    host('open', aid='live.score')
    for i, t in enumerate(T): ans(t, 'live.score', {'marks': {'0': i % 3, '1': 0}})
    a = state()['agg']; check('checklist grid', a['grid'][1][0] == 25 and sum(a['grid'][0]) == 25)

    # ---------------------------------------------------------------- wheel and the linked poll
    host('spin', aid='rules.wheel'); item1 = state()['agg']['item']
    host('open', aid='rules.respond')
    for i, t in enumerate(T[:6]): ans(t, 'rules.respond', {'choice': i % 3})
    a = state()['agg']; check('linked poll counts for the spun exception', a['item'] == item1 and sum(a['counts']) == 6, a)
    host('spin', aid='rules.wheel'); s_ = state()
    check('spinning keeps the linked poll on screen', s_['current'] == 'rules.respond')
    item2 = s_['agg']['item']; check('new exception starts with no answers', item2 != item1 and sum(s_['agg']['counts']) == 0, (item1, item2))
    for _ in range(3): host('spin', aid='rules.wheel')
    hist = state(sel='rules.wheel')['sel_agg']['history']; check('five spins cover five different exceptions', len(set(hist)) == 5, hist)

    # ---------------------------------------------------------------- pulse, questions, timer, settings, people
    for i, t in enumerate(T[:6]): req('/api/pulse', {'t': t, 'clarity': ['Clear', 'Lost'][i % 2], 'pace': 'Too fast'})
    s_ = state(); check('pulse totals', s_['pulse_summary']['clarity']['Lost'] == 3 and s_['pulse_summary']['pace']['Too fast'] == 6)
    req('/api/parking', {'t': T[0], 'text': 'Who pays for bench time?'})
    pk = state()['parking'][0]; host('parking', id=pk['id'], owner='Resourcing lead', done=True)
    p = state('part', t=T[0]); check('asker sees the owner of their question', p['parking'][0]['owner'] == 'Resourcing lead')
    host('timer', minutes=5); s_ = state('stage'); check('timer set', 295 < s_['timer']['end'] - time.time() <= 300.5)
    host('set', k='join_open', v=False); c, j = req('/api/join', {'name': 'Late Person', 'pin': '1234'}); check('joining can be closed', c == 400)
    c, j = req('/api/join', {'name': 'Person 05', 'pin': '1005'}); check('known people can still rejoin when joining is closed', c == 200)
    host('set', k='join_open', v=True)
    pid25 = next(p['id'] for p in state()['people'] if p['name'] == 'Person 25')
    host('person', pid=pid25, what='pin', pin='0000'); c, j = ans(T[24], 'live.score', {'marks': {'0': 0}}); check('a new PIN signs the old phone out', c == 400)
    c, j = req('/api/join', {'name': 'Person 25', 'pin': '0000'}); check('the new PIN works', c == 200); T[24] = j['token']

    # ---------------------------------------------------------------- exports
    c, body = req(f'/api/export.csv?key={KEY}&aid=outcome.edit'); check('CSV export', c == 200 and 'wording 0' in body and body.splitlines()[0].startswith('who'))
    c, body = req(f'/api/export.json?key={KEY}'); check('JSON export has every touched activity and no tokens or PINs', c == 200 and 'summary' in body and 'tokens' not in body and all('pin' not in p for p in body['people'].values()))
    c, body = req('/api/export.json?key=nope'); check('export needs the key', c == 400)

    # ---------------------------------------------------------------- 25 phones answering at the same moment
    host('open', aid='close.criteria'); errs = []
    def burst(t):
        c, j = ans(t, 'close.criteria', {'marks': {'0': 0, '1': 1}})
        if c != 200: errs.append(j)
    th = [threading.Thread(target=burst, args=(t,)) for t in T]; [x.start() for x in th]; [x.join() for x in th]
    check('25 simultaneous answers all saved', not errs and state()['agg']['n'] == 25, errs[:2])

    # ---------------------------------------------------------------- reset needs the typed word
    c, j = req('/api/host', {'key': KEY, 'op': 'reset', 'aid': 'close.criteria', 'confirm': 'yes'}); check('reset needs RESET', c == 400)
    host('reset', aid='close.criteria', confirm='RESET'); check('reset clears answers', state()['agg']['n'] == 0)

    before = state(); n_people = len(before['people'])
finally:
    srv.terminate(); srv.wait()

# ---------------------------------------------------------------- persistence across a restart
srv = start(datafile)
try:
    after = state()
    check('people survive a restart', len(after['people']) == n_people)
    check('answers survive a restart', after['acts']['reality.check']['n'] == 25 and after['acts']['reality.game']['n'] > 0)
    c, j = ans(T[0], 'arrive.comfort', {'v': 1}); check('tokens survive a restart', c == 400 and 'not open' in j['error'], j)
finally:
    srv.terminate(); srv.wait()

# ---------------------------------------------------------------- the facilitator key survives a restart when none is given
def start_nokey(datafile):
    env = dict(os.environ, ROOM_DATA=datafile); env.pop('ROOM_KEY', None)
    p = subprocess.Popen([sys.executable, '-u', os.path.join(ROOT, 'room.py'), '--port', str(PORT)], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for _ in range(50):
        try: urllib.request.urlopen(BASE + '/api/config', timeout=1); return p
        except Exception: time.sleep(0.1)
    raise SystemExit('server did not start')
df2 = os.path.join(tmp, 'room-data-2.json')
srv = start_nokey(df2); k1 = json.load(open(df2))['host_key']; srv.terminate(); srv.wait()
srv = start_nokey(df2)
try:
    c, j = req(f'/api/state?view=host&key={k1}&v=0'); check('facilitator key is kept across a restart', c == 200 and len(k1) >= 9)
    c, body = req(f'/api/export.json?key={k1}'); check('export never contains the facilitator key', k1 not in json.dumps(body))
finally:
    srv.terminate(); srv.wait()

failed = [r for r in results if not r[1]]
print(f'\n{len(results) - len(failed)} of {len(results)} checks passed')
sys.exit(1 if failed else 0)
