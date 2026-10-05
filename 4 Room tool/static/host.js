/* Facilitator console: open, close and reveal activities; moderate; run the timer; watch the pulse and the questions. */
(function () {
  'use strict';
  const R = window.R, esc = R.esc, $ = R.$;
  const KEY = new URLSearchParams(location.search).get('key') || '';
  let CFG = null, ST = null, sel = null, loop = null, previewMode = 'room', toastT = null, confirmReset = false;

  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2600); }
  async function host(op, extra) {
    try { await R.post('/api/host', Object.assign({ key: KEY, op }, extra || {})); return true; }
    catch (e) { toast(e.message); return false; }
  }
  const sessTitle = id => { const s = CFG.sessions.find(x => x.id === id); return s ? s.title : ''; };

  /* ---------------------------------------------------------- left: the running order */
  function paintLeft() {
    const acts = ST.acts || {};
    let h = `<h3>Running order</h3>`, day = 0;
    CFG.sessions.forEach(s => {
      if (s.day !== day) { day = s.day; h += `<h3>Day ${day}</h3>`; }
      if (!s.activities.length) return;
      h += `<div class="sess"><div class="st">${esc(s.start)} <span>· ${esc(s.title)}</span></div>`;
      s.activities.forEach(id => {
        const a = CFG.activities[id], st = acts[id] || {}, isCur = ST.current === id;
        const opts = Object.entries(s.by_option).filter(([, l]) => l.includes(id)).map(([k]) => k).join(' ');
        h += `<button class="act${sel === id ? ' sel' : ''}" data-id="${id}"><span class="st-dot${isCur ? ' cur' : st.status === 'open' ? ' open' : ''}"></span>${esc(a.title)} <span class="opts">${opts}</span><span class="n">${st.n || ''}</span></button>`;
      });
      h += '</div>';
    });
    h += `<h3>Always on</h3><button class="act${sel === 'parking' ? ' sel' : ''}" data-id="parking"><span class="st-dot${ST.current === 'parking' ? ' cur' : ''}"></span>Questions board<span class="n">${(ST.parking || []).length || ''}</span></button>`;
    $('#left').innerHTML = h;
    $('#left').querySelectorAll('.act').forEach(b => b.onclick = () => { sel = b.dataset.id; confirmReset = false; loop.restart(); paintAll(); });
  }

  /* ---------------------------------------------------------- middle: the selected activity */
  function paintMid() {
    if (!sel) { $('#mid').innerHTML = `<div class="panel"><h2 style="margin-top:0">Facilitator console</h2><p>Pick an activity on the left. A <b style="color:#2F855A">green</b> dot means open, <b style="color:#FF462D">red</b> means on the room screen. The letters show which session options use it.</p><p>Open the room screen on the projector: <a href="/stage" target="_blank">/stage</a> (press F for full screen). Print the QR cards: <a href="/print" target="_blank">/print</a>.</p></div>`; return; }
    const cfg = CFG.activities[sel], st = (ST.acts || {})[sel] || { status: 'closed', round: 0, reveal: false };
    const agg = sel === ST.current ? ST.agg : ST.sel_agg;
    const isCur = ST.current === sel, t = cfg.type;
    const b = (op, label, cls, extra) => `<button data-op="${op}" ${extra ? `data-x='${esc(JSON.stringify(extra))}'` : ''} class="${cls || ''}">${label}</button>`;
    let ctl = '';
    if (t !== 'wheel' && t !== 'parking') ctl += st.status === 'open' ? b('close', 'Close answers') : (t === 'game' && st.reveal) ? '' : b('open', isCur ? 'Open again' : 'Open and show', 'primary');
    if (t === 'parking') ctl += isCur ? '' : b('show', 'Show on screen', 'primary');
    if (t === 'wheel') ctl += b('spin', 'Spin the wheel', 'primary');
    if (cfg.linked) ctl += `<button data-op="spin" data-x='${esc(JSON.stringify({ aid: cfg.linked }))}'>Spin the wheel</button>`;
    if (!isCur && t !== 'parking') ctl += b('show', 'Show on screen');
    if (isCur) ctl += b('hide_current', 'Clear the screen');
    if (!['wheel', 'parking', 'claim'].includes(t)) ctl += st.reveal ? b('unreveal', 'Hide results') : b('reveal', 'Show results');
    if (t === 'game' || cfg.rounds) ctl += b('prev', '◀ Round') + b('next', t === 'game' ? 'Next round ▶' : 'New vote ▶');
    ctl += `<a class="small" href="/api/export.csv?key=${encodeURIComponent(KEY)}&aid=${encodeURIComponent(sel)}" style="text-decoration:none;color:inherit">Export CSV</a>`;
    ctl += b('askreset', 'Reset…', 'warn');
    let pick = '';
    if (t === 'wheel') pick = `<div class="ctl">${cfg.items.map(i => `<button data-op="pick" data-x='${esc(JSON.stringify({ item: i.id }))}'>${esc(i.id)} ${esc(i.name)}</button>`).join('')}</div>`;
    const roundInfo = (t === 'game') ? ` · round ${st.round + 1} of ${cfg.rounds.length}` : cfg.rounds ? ` · ${R.roundLabel(cfg, st.round).toLowerCase()}` : '';
    const hiddenOnScreen = agg && !R.showResults(cfg, agg, ST.settings, false) && !['wheel', 'claim', 'parking'].includes(t);
    $('#mid').innerHTML = `<div class="panel">
      <div class="tag">${esc(sessTitle(cfg.session) || 'Always on')} · ${esc(t)}${roundInfo}</div>
      <div class="q">${esc(cfg.q || cfg.title)}</div>
      <div class="muted" style="font-size:13px">Status: <b>${st.status}</b>${isCur ? ' · <b style="color:#FF462D">on the room screen</b>' : ''}${st.reveal ? ' · results shown' : ''}${hiddenOnScreen ? ' · results hidden from the room until you show them' : ''}</div>
      <div class="ctl" id="ctl">${ctl}</div>${pick}
      ${confirmReset ? `<div class="banner">This clears every answer to this activity. Type RESET and press Enter. <input type="text" id="resetIn" style="width:120px" autocomplete="off"></div>` : ''}
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;font-size:13px"><b>Preview</b>
        <button class="small" data-pv="room" style="${previewMode === 'room' ? 'background:#E3F0F1' : ''}">As the room sees it</button>
        <button class="small" data-pv="full" style="${previewMode === 'full' ? 'background:#E3F0F1' : ''}">Full results, with names</button></div>
      <div class="preview screen"><div class="stage"><div class="top"><div><div class="eyebrow">${esc(cfg.title)}</div><div class="title">${esc(t === 'game' ? cfg.title : (cfg.q || cfg.title))}</div></div></div>
        <div class="main">${agg ? R.results(cfg, agg, { host: previewMode === 'full', settings: ST.settings, people_n: ST.people_n, acts: CFG.activities }) : '<div class="hidden-results"><div class="t">No answers yet</div></div>'}</div><div class="foot"></div></div></div>
    </div>${moderation(cfg, agg)}`;
    R.afterRender($('#mid'));
    $('#mid').querySelectorAll('[data-op]').forEach(el => el.onclick = () => {
      const op = el.dataset.op, x = el.dataset.x ? JSON.parse(el.dataset.x) : {};
      if (op === 'askreset') { confirmReset = true; paintMid(); const i = $('#resetIn'); i && i.focus(); return; }
      host(op, Object.assign({ aid: sel }, x));
    });
    $('#mid').querySelectorAll('[data-pv]').forEach(el => el.onclick = () => { previewMode = el.dataset.pv; paintMid(); });
    const ri = $('#resetIn'); if (ri) ri.onkeydown = ev => { if (ev.key === 'Enter') { host('reset', { aid: sel, confirm: ri.value.trim() }); confirmReset = false; } if (ev.key === 'Escape') { confirmReset = false; paintMid(); } };
    $('#mid').querySelectorAll('[data-sub]').forEach(el => el.onclick = () => host('sub', { aid: sel, sid: el.dataset.sub, what: el.dataset.what }));
    $('#mid').querySelectorAll('[data-wh]').forEach(el => el.onclick = () => host('words_hide', { aid: sel, pid: el.dataset.pid, ts: +el.dataset.ts }));
  }

  function moderation(cfg, agg) {
    if (!agg) return '';
    const t = cfg.type;
    if (t === 'words') {
      const rows = (agg.entries || []).slice().reverse().map(e => `<div class="row${e.hidden ? ' hid' : ''}"><div class="tx">${esc(e.text)}<div class="who">${esc(e.who || '')}</div></div><button data-wh data-pid="${esc(e.pid)}" data-ts="${e.t}">${e.hidden ? 'Show' : 'Hide'}</button></div>`).join('');
      return `<div class="panel"><h3>Answers (${(agg.entries || []).length})</h3><div class="mod">${rows || '<span class="muted">None yet</span>'}</div></div>`;
    }
    if (t === 'form' || t === 'findings') {
      const rows = (agg.subs || []).slice().reverse().map(s => {
        const txt = Object.values(s.data).map(esc).join(' · ');
        const extra = t === 'findings' ? ['accepted', 'rejected', 'merged'].map(w => `<button data-sub="${s.id}" data-what="${w}" class="${s.status === w ? 'on' : ''}">${w === 'accepted' ? 'Accept' : w === 'rejected' ? 'Reject' : 'Same as another'}</button>`).join('') : '';
        return `<div class="row${s.hidden ? ' hid' : ''}"><div class="tx">${txt}<div class="who">${esc(s.who || '')}${cfg.vote ? ' · ♥ ' + s.votes : ''}</div></div>${extra}<button data-sub="${s.id}" data-what="star" class="${s.starred ? 'on' : ''}">★</button><button data-sub="${s.id}" data-what="hide">${s.hidden ? 'Show' : 'Hide'}</button></div>`;
      }).join('');
      return `<div class="panel"><h3>Cards (${(agg.subs || []).length})</h3>${t === 'findings' ? '<p class="muted" style="font-size:13px;margin:0 0 8px">You accept or reject each finding. Points go to accepted findings only. Scores on the screen show first names and initials.</p>' : ''}<div class="mod">${rows || '<span class="muted">None yet</span>'}</div></div>`;
    }
    if (t === 'parking') return '';
    return '';
  }

  /* ---------------------------------------------------------- right: the room */
  function paintRight() {
    const s = ST.settings, pulse = ST.pulse_summary;
    const sw = (k, label) => `<label class="switch"><span>${label}</span><input type="checkbox" data-set="${k}" ${s[k] ? 'checked' : ''}></label>`;
    const tl = R.timerLeft(ST.timer);
    const people = (ST.people || []).slice().sort((a, b) => a.name.localeCompare(b.name));
    const active = people.filter(p => p.last && (Date.now() / 1000 + R.clockOffset - p.last) < 600).length;
    const park = (ST.parking || []).slice().reverse();
    $('#right').innerHTML = `
      <h3>Join</h3><div style="display:flex;gap:10px;align-items:center"><div style="width:84px;height:84px">${R.qrSvg(CFG.join_url + '/')}</div><div style="font-size:14px;word-break:break-all"><b>${esc(CFG.join_url)}</b><div class="linkrow" style="margin-top:6px"><a href="/stage" target="_blank">Room screen</a><a href="/print" target="_blank">QR cards</a><a href="/api/export.json?key=${encodeURIComponent(KEY)}">Export all</a></div></div></div>
      <h3>People</h3><div class="kv"><span>Joined</span><b>${people.length}</b></div><div class="kv"><span>Active in the last 10 minutes</span><b>${active}</b></div>
      <details><summary style="font-size:13px;cursor:pointer">List, remove, reset a PIN</summary><div class="people">${people.map(p => `<div><span>${esc(p.name)}${p.joined ? '' : ' <span class="muted">(not joined)</span>'}</span><span><button class="small" data-person="${p.id}" data-what="pin">New PIN</button> <button class="small" data-person="${p.id}" data-what="remove">Remove</button></span></div>`).join('') || '<span class="muted">Nobody yet</span>'}</div>
        <div style="margin-top:8px;font-size:13px">Add names (one a line, optional ", team"):</div><textarea id="roster" rows="3"></textarea><button class="small" id="rosterGo" style="margin-top:6px">Add to the list</button></details>
      <h3>Timer</h3><div class="timers">${[1, 2, 3, 5, 10, 15].map(m => `<button data-timer="${m}">${m} min</button>`).join('')}<button data-timer="0">Stop</button></div>
      <div style="font-size:22px;font-weight:800;margin-top:6px;font-variant-numeric:tabular-nums" id="tleft">${tl == null ? '' : R.fmt(tl)}</div>
      <h3>Pulse (last 10 minutes)</h3>${pulse ? `<div class="kv"><span>Clear · Unsure · Lost</span><b>${pulse.clarity.Clear} · ${pulse.clarity.Unsure} · <span style="color:#FF462D">${pulse.clarity.Lost}</span></b></div><div class="kv"><span>Too slow · About right · Too fast</span><b>${pulse.pace['Too slow']} · ${pulse.pace['About right']} · ${pulse.pace['Too fast']}</b></div>` : ''}
      ${pulse && pulse.clarity.Lost >= 3 ? '<div class="banner">Three or more people are lost. Use the session\'s "if people are lost" note.</div>' : ''}
      <h3>Settings</h3>${sw('join_open', 'New people can join')}${sw('live', 'Opinion results show live on the screen')}${sw('leaderboard', 'Show scores in games')}${sw('show_join', 'Small join code on the screen')}${sw('show_pulse', 'Pulse on the screen')}
      <h3>Questions (${park.length})</h3><div class="mod">${park.map(p => `<div class="row${p.hidden ? ' hid' : ''}"><div class="tx">${esc(p.text)}<div class="who">${esc(p.who)}${p.owner ? ' · owner: ' + esc(p.owner) : ''}${p.done ? ' · answered' : ''}</div></div><button data-park="${p.id}" data-what="owner">Owner</button><button data-park="${p.id}" data-what="done" class="${p.done ? 'on' : ''}">✓</button><button data-park="${p.id}" data-what="hidden">${p.hidden ? 'Show' : 'Hide'}</button></div>`).join('') || '<span class="muted">None yet</span>'}</div>
      <h3>Danger</h3><button class="small" id="wipe" style="color:#B42318">Wipe everything…</button><div id="wipeBox"></div>`;
    $('#right').querySelectorAll('[data-set]').forEach(el => el.onchange = () => host('set', { k: el.dataset.set, v: el.checked }));
    $('#right').querySelectorAll('[data-timer]').forEach(el => el.onclick = () => host('timer', { minutes: +el.dataset.timer }));
    $('#right').querySelectorAll('[data-person]').forEach(el => el.onclick = () => {
      if (el.dataset.what === 'pin') { const pin = String(Math.floor(1000 + Math.random() * 9000)); host('person', { pid: el.dataset.person, what: 'pin', pin }).then(ok => { if (ok) toast('New PIN: ' + pin + '. Tell the person.'); }); }
      else host('person', { pid: el.dataset.person, what: 'remove' });
    });
    $('#right').querySelectorAll('[data-park]').forEach(el => el.onclick = () => {
      const id = el.dataset.park, w = el.dataset.what, p = (ST.parking || []).find(x => x.id === id);
      if (w === 'owner') { const box = document.createElement('input'); box.type = 'text'; box.placeholder = 'Owner, then Enter'; box.value = p.owner || ''; el.replaceWith(box); box.focus(); box.onkeydown = ev => { if (ev.key === 'Enter') host('parking', { id, owner: box.value }); }; }
      else if (w === 'done') host('parking', { id, done: !p.done });
      else host('parking', { id, hidden: !p.hidden });
    });
    $('#rosterGo').onclick = () => host('roster', { names: $('#roster').value });
    $('#wipe').onclick = () => { $('#wipeBox').innerHTML = '<div class="banner">This deletes every person and answer. Type WIPE EVERYTHING and press Enter.<input type="text" id="wipeIn" autocomplete="off"></div>'; const w = $('#wipeIn'); w.focus(); w.onkeydown = ev => { if (ev.key === 'Enter') host('wipe', { confirm: w.value.trim() }); }; };
  }

  let editing = false;
  function paintAll() {
    // do not repaint the right panel while someone is typing in it
    const ae = document.activeElement; editing = ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT') && ae.type !== 'checkbox';
    paintLeft();
    if (!(editing && $('#mid').contains(ae))) paintMid();
    if (!(editing && $('#right').contains(ae))) paintRight();
  }

  (async function boot() {
    if (!KEY) { $('#mid').innerHTML = '<div class="panel"><h2>Facilitator key needed</h2><p>Open the address printed when the room started, ending in <code>?key=…</code>.</p></div>'; return; }
    while (!CFG) { try { CFG = await R.get('/api/config'); } catch (e) { await R.sleep(2000); } }
    loop = R.live(() => ({ view: 'host', key: KEY, sel: sel || '' }), st => { ST = st; paintAll(); }, (ok, msg) => {
      if (!ok && /key/i.test(msg || '')) $('#mid').innerHTML = '<div class="panel"><h2>Wrong facilitator key</h2><p>Use the address printed when the room started.</p></div>';
    });
    setInterval(() => { if (ST) { const e = $('#tleft'); const l = R.timerLeft(ST.timer); if (e) e.textContent = l == null ? '' : R.fmt(l); } }, 250);
  })();
})();
