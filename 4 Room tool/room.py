#!/usr/bin/env python3
"""Workshop room: phones join by QR code, the room screen shows live results, the facilitator
runs each activity from a console. Python 3.8+, standard library only, works offline.

    python3 room.py                      # http://<this laptop's address>:8080
    python3 room.py --port 8090 --url https://room.example   # if people reach it through another address

Pages:  /  participants   /stage  the room screen   /host  facilitator console   /print  QR cards
Data is saved to room-data.json next to this file after every change, and reloaded on restart."""
import argparse, hashlib, json, os, random, re, secrets, socket, threading, time, urllib.parse, csv, io
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, 'static')
CONFIG = json.load(open(os.path.join(HERE, 'activities.json'), encoding='utf-8'))
ACTS = CONFIG['activities']
DATA_FILE = os.environ.get('ROOM_DATA') or os.path.join(HERE, 'room-data.json')
LOCK = threading.RLock()
COND = threading.Condition(LOCK)
MAX_PEOPLE, MAX_TEXT = 200, 400
STOP = set('a an and are as at be but by for from has have i in is it its of on or so that the their there this to was we were what when where which who will with you your our not no'.split())

def now(): return time.time()
def pin_hash(pid, pin): return hashlib.sha256(f'{pid}:{pin}:workshop-room'.encode()).hexdigest()

def fresh_state():
    return {'version': 1, 'created': now(), 'people': {}, 'tokens': {}, 'current': None, 'timer': None,
            'settings': {'join_open': True, 'leaderboard': False, 'live': True, 'show_join': True, 'show_pulse': False},
            'acts': {}, 'pulse': {}, 'parking': [], 'session': None}

STATE = fresh_state()
if os.path.exists(DATA_FILE):
    try:
        STATE = json.load(open(DATA_FILE, encoding='utf-8'))
        for k, v in fresh_state().items(): STATE.setdefault(k, v)
    except Exception as e:
        print('Could not read saved data, starting fresh:', e)

_save_pending = False
def save():
    """Atomic write; called with LOCK held."""
    tmp = DATA_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f: json.dump(STATE, f)
    os.replace(tmp, DATA_FILE)

def bump():
    STATE['version'] += 1
    save()
    COND.notify_all()

def act_state(aid):
    a = STATE['acts'].get(aid)
    if a is None:
        a = STATE['acts'][aid] = {'status': 'closed', 'round': 0, 'item': None, 'history': [], 'answers': {}, 'subs': [], 'reveal': False}
    return a

# ------------------------------------------------------------------ aggregation
def words_of(text):
    return [w for w in re.findall(r"[a-zA-Z][a-zA-Z'-]+", text.lower()) if w not in STOP and len(w) > 2]

def name_of(pid):
    p = STATE['people'].get(pid); return p['name'] if p else '?'

def short_name(pid):
    """First name and initial, for scores shown on the room screen."""
    parts = name_of(pid).split()
    return parts[0] + (' ' + parts[-1][0] + '.' if len(parts) > 1 else '')

def aggregate(aid, for_host=False):
    cfg = ACTS[aid]; a = act_state(aid); t = cfg['type']; out = {'id': aid, 'type': t, 'status': a['status'], 'round': a['round'], 'reveal': a['reveal']}
    rkey = str(a['round'])
    if t == 'scale':
        ans = a['answers'].get('0', {})
        counts = {str(v): 0 for v in range(cfg['min'], cfg['max'] + 1)}
        for v in ans.values(): counts[str(v['v'])] = counts.get(str(v['v']), 0) + 1
        vals = [v['v'] for v in ans.values()]
        out.update(n=len(vals), counts=counts, mean=round(sum(vals) / len(vals), 2) if vals else None)
    elif t == 'words':
        entries = []
        for pid, lst in a['answers'].get('0', {}).items():
            for e in lst: entries.append({'text': e['text'], 't': e['t'], 'hidden': e.get('hidden', False), 'who': name_of(pid) if for_host else None, 'pid': pid if for_host else None})
        entries.sort(key=lambda e: e['t'])
        freq = {}
        for e in entries:
            if e['hidden']: continue
            for w in words_of(e['text']): freq[w] = freq.get(w, 0) + 1
        out.update(n=len(entries), entries=[e for e in entries if for_host or not e['hidden']], freq=sorted(freq.items(), key=lambda x: -x[1])[:40])
    elif t == 'poll':
        if cfg.get('linked'):
            item = act_state(cfg['linked'])['item']; opts = cfg['options_by_item'].get(item, []) if item else []
            ans = a['answers'].get(item or '-', {})
        else:
            opts = cfg['options']; ans = a['answers'].get(rkey, {})
        counts = [0] * len(opts)
        for v in ans.values():
            for c in (v['choices'] if 'choices' in v else [v['choice']]):
                if 0 <= c < len(counts): counts[c] += 1
        out.update(n=len(ans), options=opts, counts=counts, correct=cfg.get('correct'), item=act_state(cfg['linked'])['item'] if cfg.get('linked') else None)
        if cfg.get('rounds'):
            hist = []
            for r in sorted(a['answers'].keys(), key=lambda x: int(x) if x.isdigit() else 0):
                if not r.isdigit() or r == rkey: continue
                c2 = [0] * len(opts)
                for v in a['answers'][r].values():
                    for c in (v['choices'] if 'choices' in v else [v['choice']]):
                        if 0 <= c < len(c2): c2[c] += 1
                hist.append({'round': int(r), 'counts': c2})
            out['history'] = hist
    elif t == 'game':
        rounds = cfg['rounds']; r = min(a['round'], len(rounds) - 1); ans = a['answers'].get(str(r), {})
        counts = [0] * len(rounds[r]['options'])
        for v in ans.values():
            if 0 <= v['choice'] < len(counts): counts[v['choice']] += 1
        scores = {}
        for rr, amap in a['answers'].items():
            rr_i = int(rr)
            if rr_i > a['round'] or (rr_i == a['round'] and not a['reveal']): continue
            for pid, v in amap.items():
                scores[pid] = scores.get(pid, 0) + (1 if v['choice'] == rounds[rr_i]['answer'] else 0)
        board = sorted(((short_name(p), s) for p, s in scores.items()), key=lambda x: -x[1])[:8]
        out.update(n=len(ans), counts=counts, total_rounds=len(rounds), board=board)
    elif t == 'dots':
        tot = [0] * len(cfg['items']); ans = a['answers'].get('0', {})
        for v in ans.values():
            for i, c in v['alloc'].items():
                if 0 <= int(i) < len(tot): tot[int(i)] += int(c)
        out.update(n=len(ans), totals=tot)
    elif t == 'points':
        tot = [0] * len(cfg['items']); ans = a['answers'].get('0', {})
        for v in ans.values():
            for i, c in v['alloc'].items():
                if 0 <= int(i) < len(tot): tot[int(i)] += int(c)
        out.update(n=len(ans), totals=tot, mean=[round(x / len(ans), 1) if ans else 0 for x in tot])
    elif t == 'sort':
        ans = a['answers'].get('0', {}); grid = [[0] * len(cfg['bins']) for _ in cfg['items']]
        for v in ans.values():
            for i, b in v['bins'].items():
                i, b = int(i), int(b)
                if 0 <= i < len(grid) and 0 <= b < len(cfg['bins']): grid[i][b] += 1
        out.update(n=len(ans), grid=grid, correct=cfg.get('correct'))
    elif t in ('form', 'findings'):
        subs = []
        for sbm in a['subs']:
            if sbm.get('hidden') and not for_host: continue
            d = {'id': sbm['id'], 'data': sbm['data'], 'votes': len(sbm['votes']), 'starred': sbm.get('starred', False), 'hidden': sbm.get('hidden', False),
                 'status': sbm.get('status', 'new'), 't': sbm['t']}
            if for_host: d['who'] = name_of(sbm['pid'])
            subs.append(d)
        out.update(n=len(subs), subs=subs)
        if t == 'form' and cfg.get('tally'):
            f = next(x for x in cfg['fields'] if x['name'] == cfg['tally']); counts = {o: 0 for o in f['options']}
            for sbm in a['subs']:
                if not sbm.get('hidden'): counts[sbm['data'].get(cfg['tally'])] = counts.get(sbm['data'].get(cfg['tally']), 0) + 1
            out['tally'] = counts
        if t == 'form' and cfg.get('numbers'):
            stats = {}
            for f in cfg['fields']:
                vals = sorted(float(s2['data'][f['name']]) for s2 in a['subs'] if not s2.get('hidden') and str(s2['data'].get(f['name'], '')).replace('.', '', 1).isdigit())
                if vals: stats[f['name']] = {'n': len(vals), 'median': vals[len(vals) // 2], 'min': vals[0], 'max': vals[-1]}
            out['stats'] = stats
        if t == 'findings':
            pts = cfg.get('points', {}); score = {}; kinds = {k: 0 for k in cfg['kinds']}
            for sbm in a['subs']:
                if sbm.get('hidden'): continue
                kinds[sbm['data'].get('kind')] = kinds.get(sbm['data'].get('kind'), 0) + 1
                if sbm.get('status') == 'accepted': score[sbm['pid']] = score.get(sbm['pid'], 0) + pts.get(sbm['data'].get('kind'), 1)
            out.update(kinds=kinds, board=sorted(((short_name(p), s) for p, s in score.items()), key=lambda x: -x[1])[:8])
    elif t == 'claim':
        claims = [[[] for _ in cfg['slots']] for _ in cfg['items']]
        for pid, lst in a['answers'].get('0', {}).items():
            for c in lst: claims[c['item']][c['slot']].append(name_of(pid))
        out.update(claims=claims)
    elif t == 'checklist':
        ans = a['answers'].get('0', {}); grid = [[0] * len(cfg['scale']) for _ in cfg['items']]
        for v in ans.values():
            for i, k in v['marks'].items():
                i, k = int(i), int(k)
                if 0 <= i < len(grid) and 0 <= k < len(cfg['scale']): grid[i][k] += 1
        out.update(n=len(ans), grid=grid)
    elif t == 'wheel':
        out.update(item=a['item'], history=a['history'])
    elif t == 'parking':
        out.update(n=len(STATE['parking']), items=[{'id': p['id'], 'text': p['text'], 'owner': p.get('owner'), 'date': p.get('date'), 'done': p.get('done', False),
                                                     'who': p['who'] if for_host else None} for p in STATE['parking'] if for_host or not p.get('hidden')])
    return out

def pulse_summary():
    cut = now() - 600; clar = {k: 0 for k in ACTS['pulse']['clarity']}; pace = {k: 0 for k in ACTS['pulse']['pace']}
    for p in STATE['pulse'].values():
        if p['t'] < cut: continue
        if p.get('clarity') in clar: clar[p['clarity']] += 1
        if p.get('pace') in pace: pace[p['pace']] += 1
    return {'clarity': clar, 'pace': pace}

# ------------------------------------------------------------------ views
def view(kind, pid=None, sel=None):
    cur = STATE['current']
    base = {'v': STATE['version'], 'current': cur, 'timer': STATE['timer'], 'session': STATE['session'], 'settings': STATE['settings'], 'server_time': now(),
            'people_n': len(STATE['people'])}
    if cur: base['agg'] = aggregate(cur, for_host=(kind == 'host'))
    if kind == 'part':
        me = STATE['people'].get(pid)
        base['me'] = {'id': pid, 'name': me['name'], 'role': me.get('role', '')} if me else None
        if cur and me:
            a = act_state(cur); t = ACTS[cur]['type']
            if t == 'poll' and ACTS[cur].get('linked'):
                key = act_state(ACTS[cur]['linked'])['item'] or '-'
            elif t == 'game' or (t == 'poll' and ACTS[cur].get('rounds')):
                key = str(a['round'])
            else:
                key = '0'
            mine = a['answers'].get(key, {}).get(pid)
            if t in ('form', 'findings'):
                mine = [{'id': s2['id'], 'data': s2['data'], 'status': s2.get('status', 'new')} for s2 in a['subs'] if s2['pid'] == pid]
                base['voted'] = [s2['id'] for s2 in a['subs'] if pid in s2['votes']]
            base['mine'] = mine
            if t == 'game':
                rounds = ACTS[cur]['rounds']; sc = 0
                for rr, amap in a['answers'].items():
                    rr_i = int(rr)
                    if pid in amap and (rr_i < a['round'] or (rr_i == a['round'] and a['reveal'])) and amap[pid]['choice'] == rounds[rr_i]['answer']: sc += 1
                base['score'] = sc
            # participants see results only after reveal, except where the room screen is the point
            if not (a['reveal'] or (STATE['settings']['live'] and t in ('words', 'dots', 'points', 'claim', 'form', 'wheel'))):
                base['agg'] = {k: base['agg'][k] for k in ('id', 'type', 'status', 'round', 'reveal', 'n', 'item', 'options', 'total_rounds') if k in base['agg']}
        base['pulse'] = STATE['pulse'].get(pid)
        base['parking'] = [p for p in STATE['parking'] if p['pid'] == pid]
    elif kind == 'stage':
        base['pulse_summary'] = pulse_summary() if STATE['settings']['show_pulse'] else None
        base['parking'] = [{'text': p['text'], 'owner': p.get('owner'), 'done': p.get('done')} for p in STATE['parking'] if not p.get('hidden')][-12:]
    elif kind == 'host':
        base['people'] = [{'id': k, 'name': v['name'], 'role': v.get('role', ''), 'joined': v['joined'], 'last': v.get('last')} for k, v in STATE['people'].items()]
        base['pulse_summary'] = pulse_summary()
        base['parking'] = STATE['parking']
        base['acts'] = {k: {'status': v['status'], 'round': v['round'], 'reveal': v['reveal'], 'n': sum(len(x) for x in v['answers'].values()) + len(v['subs'])} for k, v in STATE['acts'].items()}
        if sel in ACTS and sel != cur: base['sel_agg'] = aggregate(sel, for_host=True)
    return base

# ------------------------------------------------------------------ actions
class Bad(Exception):
    pass

def need(cond, msg):
    if not cond: raise Bad(msg)

def clean(text, n=MAX_TEXT):
    need(isinstance(text, str), 'Text expected')
    text = text.strip(); need(0 < len(text) <= n, f'Please write between 1 and {n} characters')
    return text

def do_join(body):
    name = clean(body.get('name', ''), 60); pin = str(body.get('pin', '')).strip(); role = str(body.get('role', ''))[:60]
    need(re.fullmatch(r'\d{4}', pin) is not None, 'Choose a four-digit PIN')
    with LOCK:
        pid = next((k for k, v in STATE['people'].items() if v['name'].lower() == name.lower()), None)
        if pid and not STATE['people'][pid].get('pin'):
            STATE['people'][pid]['pin'] = pin_hash(pid, pin); STATE['people'][pid]['joined'] = now()   # first join of a roster name
        elif pid:
            need(STATE['people'][pid]['pin'] == pin_hash(pid, pin), 'That name is taken. Enter its PIN, or add your surname.')
        else:
            need(STATE['settings']['join_open'], 'Joining is closed. Ask the facilitator.')
            need(len(STATE['people']) < MAX_PEOPLE, 'The room is full')
            pid = 'p' + secrets.token_hex(3)
            STATE['people'][pid] = {'name': name, 'role': role, 'pin': pin_hash(pid, pin), 'joined': now()}
        if role: STATE['people'][pid]['role'] = role
        tok = secrets.token_urlsafe(18); STATE['tokens'][tok] = pid
        bump()
        return {'token': tok, 'id': pid}

def who(token):
    pid = STATE['tokens'].get(token or '')
    need(pid is not None and pid in STATE['people'], 'Please join again')
    STATE['people'][pid]['last'] = now()
    return pid

def do_answer(body):
    with LOCK:
        pid = who(body.get('t')); aid = body.get('aid'); need(aid in ACTS, 'Unknown activity')
        cfg = ACTS[aid]; a = act_state(aid); t = cfg['type']
        need(a['status'] == 'open', 'This activity is not open')
        p = body.get('payload') or {}
        if t == 'scale':
            v = int(p.get('v')); need(cfg['min'] <= v <= cfg['max'], 'Out of range')
            a['answers'].setdefault('0', {})[pid] = {'v': v, 't': now()}
        elif t == 'words':
            text = clean(p.get('text', ''), cfg.get('max', 120)); lst = a['answers'].setdefault('0', {}).setdefault(pid, [])
            need(len(lst) < 3, 'Three answers each is the limit'); lst.append({'text': text, 't': now()})
        elif t == 'poll':
            if cfg.get('linked'):
                item = act_state(cfg['linked'])['item']; need(item, 'Wait for the wheel'); key = item; n = len(cfg['options_by_item'][item])
            else:
                key = str(a['round']) if cfg.get('rounds') else '0'; n = len(cfg['options'])
            if cfg.get('multi'):
                ch = sorted(set(int(x) for x in p.get('choices', []))); need(all(0 <= c < n for c in ch) and ch, 'Choose at least one')
                ex = cfg.get('exclusive')
                need(ex is None or ex not in ch or len(ch) == 1, f"\"{(cfg.get('options') or [''] * n)[ex] if ex is not None else ''}\" cannot be chosen with other answers")
                a['answers'].setdefault(key, {})[pid] = {'choices': ch, 't': now()}
            else:
                c = int(p.get('choice')); need(0 <= c < n, 'Choose an option')
                a['answers'].setdefault(key, {})[pid] = {'choice': c, 't': now()}
        elif t == 'game':
            need(not a['reveal'], 'This round is closed'); c = int(p.get('choice')); r = a['round']
            need(0 <= c < len(cfg['rounds'][r]['options']), 'Choose an option')
            a['answers'].setdefault(str(r), {})[pid] = {'choice': c, 't': now()}
        elif t in ('dots', 'points'):
            alloc = {str(int(k)): int(v) for k, v in (p.get('alloc') or {}).items() if int(v) > 0}
            need(all(0 <= int(k) < len(cfg['items']) for k in alloc), 'Unknown item')
            tot = sum(alloc.values())
            if t == 'dots': need(0 < tot <= cfg['dots'], f"Use up to {cfg['dots']} dots")
            else: need(tot == cfg['total'], f"Spread exactly {cfg['total']} points")
            a['answers'].setdefault('0', {})[pid] = {'alloc': alloc, 't': now()}
        elif t == 'sort':
            bins = {str(int(k)): int(v) for k, v in (p.get('bins') or {}).items()}
            need(all(0 <= int(k) < len(cfg['items']) and 0 <= v < len(cfg['bins']) for k, v in bins.items()) and bins, 'Place at least one item')
            a['answers'].setdefault('0', {})[pid] = {'bins': bins, 't': now()}
        elif t == 'checklist':
            marks = {str(int(k)): int(v) for k, v in (p.get('marks') or {}).items()}
            need(all(0 <= int(k) < len(cfg['items']) and 0 <= v < len(cfg['scale']) for k, v in marks.items()) and marks, 'Mark at least one line')
            a['answers'].setdefault('0', {})[pid] = {'marks': marks, 't': now()}
        elif t == 'claim':
            item, slot = int(p.get('item')), int(p.get('slot')); need(0 <= item < len(cfg['items']) and 0 <= slot < len(cfg['slots']), 'Unknown seat')
            lst = a['answers'].setdefault('0', {}).setdefault(pid, [])
            hit = next((c for c in lst if c['item'] == item and c['slot'] == slot), None)
            if hit: lst.remove(hit)
            else: need(len(lst) < 3, 'Three seats each is the limit'); lst.append({'item': item, 'slot': slot})
        elif t in ('form', 'findings'):
            data = {}
            fields = cfg['fields'] if t == 'form' else [{'name': 'kind', 'kind': 'choice', 'options': cfg['kinds']}, {'name': 'step', 'kind': 'choice', 'options': cfg['steps']}, {'name': 'text', 'kind': 'text'}]
            for f in fields:
                v = p.get(f['name'], '')
                if f['kind'] == 'choice': need(v in f['options'], f"Choose {f.get('label', f['name'])}")
                elif f['kind'] == 'number':
                    v = str(v).strip(); need(v.replace('.', '', 1).isdigit() and f.get('min', 0) <= float(v) <= f.get('max', 1e9), f"{f.get('label', f['name'])}: a number")
                else: v = clean(str(v), 300)
                data[f['name']] = v
            mine = [s2 for s2 in a['subs'] if s2['pid'] == pid]; need(len(mine) < (10 if t == 'findings' else 5), 'That is the limit for this activity')
            a['subs'].append({'id': secrets.token_hex(4), 'pid': pid, 'data': data, 'votes': [], 't': now()})
        else:
            raise Bad('Nothing to answer here')
        bump(); return {'ok': True}

def do_vote(body):
    with LOCK:
        pid = who(body.get('t')); aid = body.get('aid'); need(aid in ACTS and ACTS[aid].get('vote'), 'No voting here')
        a = act_state(aid); sbm = next((s2 for s2 in a['subs'] if s2['id'] == body.get('sid')), None); need(sbm, 'Unknown card')
        if pid in sbm['votes']: sbm['votes'].remove(pid)
        else:
            need(sum(1 for s2 in a['subs'] if pid in s2['votes']) < 3, 'Three votes each. Take one back first.')
            sbm['votes'].append(pid)
        bump(); return {'ok': True}

def do_pulse(body):
    with LOCK:
        pid = who(body.get('t')); p = STATE['pulse'].setdefault(pid, {})
        if body.get('clarity') in ACTS['pulse']['clarity']: p['clarity'] = body['clarity']
        if body.get('pace') in ACTS['pulse']['pace']: p['pace'] = body['pace']
        p['t'] = now(); bump(); return {'ok': True}

def do_parking(body):
    with LOCK:
        pid = who(body.get('t')); text = clean(body.get('text', ''), 300)
        need(sum(1 for p in STATE['parking'] if p['pid'] == pid) < 10, 'Ten questions each is the limit')
        STATE['parking'].append({'id': secrets.token_hex(4), 'pid': pid, 'who': name_of(pid), 'text': text, 't': now()})
        bump(); return {'ok': True}

HOST_KEY = None

def set_current(aid):
    """Put an activity on the room screen; the one it replaces stops taking answers."""
    prev = STATE['current']
    if prev and prev != aid and prev in ACTS: act_state(prev)['status'] = 'closed'
    STATE['current'] = aid
    if aid: STATE['session'] = ACTS[aid].get('session')

def do_host(body):
    need(body.get('key') == HOST_KEY, 'Wrong facilitator key')
    op = body.get('op'); aid = body.get('aid')
    with LOCK:
        if aid is not None: need(aid in ACTS, 'Unknown activity'); a = act_state(aid)
        if op == 'open':
            need(not (ACTS[aid]['type'] == 'game' and a['reveal']), 'This round is over. Use Next round.')
            set_current(aid); a['status'] = 'open'; a['reveal'] = False
        elif op == 'show':
            set_current(aid)
        elif op == 'close': a['status'] = 'closed'
        elif op == 'reveal': a['reveal'] = True; a['status'] = 'closed' if ACTS[aid]['type'] in ('poll', 'game') else a['status']
        elif op == 'unreveal': a['reveal'] = False
        elif op == 'next':
            if ACTS[aid]['type'] == 'game': need(a['round'] < len(ACTS[aid]['rounds']) - 1, 'That was the last round')
            a['round'] += 1; a['reveal'] = False; a['status'] = 'open'
        elif op == 'prev': need(a['round'] > 0, 'This is the first round'); a['round'] -= 1; a['reveal'] = True
        elif op == 'spin':
            items = [i['id'] for i in ACTS[aid]['items']]; left = [i for i in items if i not in a['history']] or items
            a['item'] = random.choice(left); a['history'].append(a['item'])
            cur = STATE['current']
            if not (cur and ACTS[cur].get('linked') == aid): set_current(aid)   # keep the linked poll on screen
        elif op == 'pick':
            need(body.get('item') in [i['id'] for i in ACTS[aid]['items']], 'Unknown item'); a['item'] = body['item']; a['history'].append(a['item'])
        elif op == 'reset':
            need(body.get('confirm') == 'RESET', 'Type RESET to confirm'); STATE['acts'].pop(aid, None); act_state(aid)
            if ACTS[aid]['type'] == 'parking': STATE['parking'] = []
        elif op == 'hide_current': set_current(None)
        elif op == 'sub':
            sbm = next((s2 for s2 in a['subs'] if s2['id'] == body.get('sid')), None); need(sbm, 'Unknown card'); what = body.get('what')
            if what == 'hide': sbm['hidden'] = not sbm.get('hidden', False)
            elif what == 'star': sbm['starred'] = not sbm.get('starred', False)
            elif what in ('accepted', 'rejected', 'merged', 'new'): sbm['status'] = what
        elif op == 'words_hide':
            for pid, lst in a['answers'].get('0', {}).items():
                for e in lst:
                    if e['t'] == body.get('ts') and pid == body.get('pid'): e['hidden'] = not e.get('hidden', False)
        elif op == 'timer':
            m = float(body.get('minutes', 0)); STATE['timer'] = {'end': now() + m * 60, 'minutes': m} if m > 0 else None
        elif op == 'set':
            k = body.get('k'); need(k in STATE['settings'], 'Unknown setting'); STATE['settings'][k] = bool(body.get('v'))
        elif op == 'parking':
            p = next((x for x in STATE['parking'] if x['id'] == body.get('id')), None); need(p, 'Unknown question')
            for k in ('owner', 'date'):
                if k in body: p[k] = str(body[k])[:80]
            if 'done' in body: p['done'] = bool(body['done'])
            if 'hidden' in body: p['hidden'] = bool(body['hidden'])
        elif op == 'person':
            pid = body.get('pid'); need(pid in STATE['people'], 'Unknown person')
            if body.get('what') == 'remove':
                STATE['people'].pop(pid); STATE['tokens'] = {k: v for k, v in STATE['tokens'].items() if v != pid}
            elif body.get('what') == 'pin':
                pin = str(body.get('pin', '')); need(re.fullmatch(r'\d{4}', pin) is not None, 'Four digits')
                STATE['people'][pid]['pin'] = pin_hash(pid, pin); STATE['tokens'] = {k: v for k, v in STATE['tokens'].items() if v != pid}
        elif op == 'roster':
            names = [n.strip() for n in str(body.get('names', '')).splitlines() if n.strip()]
            for line in names:
                parts = [x.strip() for x in line.split(',')]; nm = parts[0][:60]; role = parts[1][:60] if len(parts) > 1 else ''
                if any(v['name'].lower() == nm.lower() for v in STATE['people'].values()): continue
                pid = 'p' + secrets.token_hex(3)
                STATE['people'][pid] = {'name': nm, 'role': role, 'pin': '', 'joined': None, 'roster': True}
        elif op == 'wipe':
            need(body.get('confirm') == 'WIPE EVERYTHING', 'Type WIPE EVERYTHING to confirm'); fresh = fresh_state(); fresh['host_key'] = HOST_KEY; STATE.clear(); STATE.update(fresh)
        else:
            raise Bad('Unknown action')
        bump(); return {'ok': True}

def roster_names():
    with LOCK:
        return sorted([v['name'] for v in STATE['people'].values()], key=str.lower)

def name_state(name):
    """'new' (nobody has it), 'roster' (on the list, no PIN yet) or 'taken' (has a PIN)."""
    with LOCK:
        p = next((v for v in STATE['people'].values() if v['name'].lower() == name.strip().lower()), None)
        return 'new' if p is None else ('roster' if not p.get('pin') else 'taken')

# ------------------------------------------------------------------ export
def export_csv(aid):
    cfg = ACTS[aid]; a = act_state(aid); buf = io.StringIO(); w = csv.writer(buf)
    if cfg['type'] in ('form', 'findings'):
        keys = [f['name'] for f in cfg.get('fields', [])] or ['kind', 'step', 'text']
        w.writerow(['who', 'votes', 'status', 'hidden'] + keys)
        for s2 in a['subs']: w.writerow([name_of(s2['pid']), len(s2['votes']), s2.get('status', 'new'), s2.get('hidden', False)] + [s2['data'].get(k, '') for k in keys])
    else:
        w.writerow(['round_or_item', 'who', 'answer'])
        for r, amap in a['answers'].items():
            for pid, v in amap.items(): w.writerow([r, name_of(pid), json.dumps(v, ensure_ascii=False)])
    return buf.getvalue()

# ------------------------------------------------------------------ http
def local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect(('10.255.255.255', 1)); ip = s.getsockname()[0]; s.close(); return ip
    except Exception:
        return '127.0.0.1'

JOIN_URL = None
TYPES = {'.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8'}

class H(BaseHTTPRequestHandler):
    server_version = 'WorkshopRoom/1'
    def log_message(self, *a): pass
    def send(self, code, body, ctype='application/json; charset=utf-8', extra=None):
        data = body if isinstance(body, bytes) else (json.dumps(body, ensure_ascii=False).encode() if not isinstance(body, str) else body.encode())
        self.send_response(code); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store'); self.send_header('X-Content-Type-Options', 'nosniff')
        for k, v in (extra or {}).items(): self.send_header(k, v)
        self.end_headers(); self.wfile.write(data)
    def page(self, name):
        p = os.path.join(STATIC, name)
        self.send(200, open(p, 'rb').read(), TYPES['.html'])
    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = dict(urllib.parse.parse_qsl(u.query))
        try:
            if u.path in ('/', '/join'): return self.page('index.html')
            if u.path == '/stage': return self.page('stage.html')
            if u.path == '/host': return self.page('host.html')
            if u.path == '/print': return self.page('print.html')
            if u.path.startswith('/static/'):
                f = os.path.normpath(os.path.join(STATIC, u.path[len('/static/'):]))
                if not f.startswith(STATIC) or not os.path.isfile(f): return self.send(404, {'error': 'Not found'})
                return self.send(200, open(f, 'rb').read(), TYPES.get(os.path.splitext(f)[1], 'application/octet-stream'))
            if u.path == '/api/config':
                return self.send(200, {'join_url': JOIN_URL, 'activities': ACTS, 'sessions': CONFIG['sessions'], 'title': CONFIG['title'], 'dates': CONFIG.get('dates', ''),
                                       'subtitle': CONFIG.get('subtitle', ''), 'roster': roster_names()})
            if u.path == '/api/state':
                kind = q.get('view', 'part'); since = int(q.get('v', '0') or 0)
                if kind == 'host': need(q.get('key') == HOST_KEY, 'Wrong facilitator key')
                deadline = time.time() + 25
                with COND:
                    while STATE['version'] <= since and time.time() < deadline:
                        COND.wait(timeout=max(0.1, deadline - time.time()))
                    pid = STATE['tokens'].get(q.get('t', '')) if kind == 'part' else None
                    return self.send(200, view(kind, pid, q.get('sel')))
            if u.path == '/api/first':
                return self.send(200, {'state': name_state(q.get('name', ''))})
            if u.path == '/api/export.json':
                need(q.get('key') == HOST_KEY, 'Wrong facilitator key')
                with LOCK:
                    data = {k: v for k, v in STATE.items() if k not in ('tokens', 'host_key')}
                    data['people'] = {k: {'name': v['name'], 'role': v.get('role')} for k, v in STATE['people'].items()}
                    data['summary'] = {aid: aggregate(aid, True) for aid in STATE['acts']}
                return self.send(200, data, extra={'Content-Disposition': 'attachment; filename="workshop-room-export.json"'})
            if u.path == '/api/export.csv':
                need(q.get('key') == HOST_KEY, 'Wrong facilitator key'); aid = q.get('aid'); need(aid in ACTS, 'Unknown activity')
                with LOCK: body = export_csv(aid)
                return self.send(200, body, 'text/csv; charset=utf-8', {'Content-Disposition': f'attachment; filename="{aid}.csv"'})
            return self.send(404, {'error': 'Not found'})
        except Bad as e:
            return self.send(400, {'error': str(e)})
    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        try:
            n = int(self.headers.get('Content-Length', '0')); need(n < 20000, 'Too large')
            body = json.loads(self.rfile.read(n) or b'{}')
            routes = {'/api/join': do_join, '/api/answer': do_answer, '/api/vote': do_vote, '/api/pulse': do_pulse, '/api/parking': do_parking, '/api/host': do_host}
            if u.path not in routes: return self.send(404, {'error': 'Not found'})
            return self.send(200, routes[u.path](body))
        except Bad as e:
            return self.send(400, {'error': str(e)})
        except (ValueError, TypeError, KeyError) as e:
            return self.send(400, {'error': 'That did not look right: ' + str(e)[:80]})

def main():
    global HOST_KEY, JOIN_URL
    ap = argparse.ArgumentParser(description='Workshop room')
    ap.add_argument('--port', type=int, default=8080)
    ap.add_argument('--url', help='the address people should use, if not this laptop\'s own')
    ap.add_argument('--key', help='facilitator key (default: random, printed below)')
    a = ap.parse_args()
    # the key is kept with the saved data, so the console address survives a restart
    HOST_KEY = a.key or os.environ.get('ROOM_KEY') or STATE.get('host_key') or (secrets.token_hex(2) + '-' + secrets.token_hex(2))
    with LOCK: STATE['host_key'] = HOST_KEY; save()
    JOIN_URL = a.url or f'http://{local_ip()}:{a.port}'
    srv = ThreadingHTTPServer(('0.0.0.0', a.port), H); srv.daemon_threads = True
    print('\n  Workshop room is running.\n', flush=True)
    print(f'  Participants:   {JOIN_URL}/')
    print(f'  Room screen:    {JOIN_URL}/stage')
    print(f'  Facilitator:    {JOIN_URL}/host?key={HOST_KEY}')
    print(f'  QR cards:       {JOIN_URL}/print')
    print(f'\n  Facilitator key: {HOST_KEY}   (keep it private)', flush=True)
    print(f'  Saved data:      {DATA_FILE}\n  Stop with Ctrl+C.\n', flush=True)
    try: srv.serve_forever()
    except KeyboardInterrupt: print('\nStopped. Your data is saved.')

if __name__ == '__main__':
    main()
