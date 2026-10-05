/* Phone page: join with a name and a PIN, then answer whatever the facilitator has opened. */
(function () {
  'use strict';
  const R = window.R, esc = R.esc, $ = R.$;
  let CFG = null, ST = null, token = R.store.get('room.token'), loop = null, renderKey = '', toastT = null;
  const drafts = {};          // unsent text and choices, kept across screen refreshes
  const main = $('#main');

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2600);
  }
  async function send(aid, payload, okMsg) {
    try { await R.post('/api/answer', { t: token, aid, payload }); toast(okMsg || 'Saved'); }
    catch (e) { toast(e.message); if (/join again/i.test(e.message)) leave(); }
  }
  function leave() { R.store.del('room.token'); token = null; if (loop) loop.stop(); loop = null; showJoin(); }

  /* ---------------------------------------------------------- join */
  function showJoin(msg) {
    $('#dock').hidden = true; $('#who').textContent = '';
    const names = (CFG && CFG.roster || []).map(n => `<option value="${esc(n)}">`).join('');
    main.innerHTML = `<div class="card stack">
      <div><span class="tag">${esc(CFG ? CFG.dates : '')}</span><h1>${esc(CFG ? CFG.title : 'Workshop')}</h1></div>
      <form id="join" class="stack" autocomplete="off">
        <div><label class="f" for="nm">Your name</label><input id="nm" type="text" maxlength="60" list="names" required autocapitalize="words" placeholder="First name and surname"><datalist id="names">${names}</datalist></div>
        <div><label class="f" for="pin" id="pinLab">Choose a four-digit PIN</label><input id="pin" type="tel" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required placeholder="1234">
          <div class="muted" id="pinHelp" style="font-size:14px;margin-top:6px">You only need it if you change phone or close this page.</div></div>
        <div class="err" id="joinErr">${esc(msg || '')}</div>
        <button class="btn full" type="submit">Join</button>
      </form>
      <p class="muted" style="font-size:14px;margin:0">Your name appears on the screen only for roles the room agrees, such as who owns a decision, and in game scores as your first name and initial. Other answers appear without names.</p>
    </div>`;
    const nm = $('#nm');
    nm.addEventListener('change', async () => {
      if (!nm.value.trim()) return;
      try {
        const r = await R.get('/api/first?name=' + encodeURIComponent(nm.value.trim()));
        $('#pinLab').textContent = r.state === 'taken' ? 'Welcome back. Enter your PIN' : 'Choose a four-digit PIN';
        $('#pinHelp').textContent = r.state === 'taken' ? 'If this is not you, add your surname to your name.' : r.state === 'roster' ? 'Your name is on the list. Choose a PIN to claim it.' : 'You only need it if you change phone or close this page.';
      } catch (e) { /* offline: the join call will say so */ }
    });
    $('#join').addEventListener('submit', async ev => {
      ev.preventDefault();
      const pin = $('#pin').value.trim();
      if (!/^\d{4}$/.test(pin)) { $('#joinErr').textContent = 'The PIN is four digits'; return; }
      try {
        const r = await R.post('/api/join', { name: nm.value, pin });
        token = r.token; R.store.set('room.token', token); start();
      } catch (e) { $('#joinErr').textContent = e.message; }
    });
  }

  /* ---------------------------------------------------------- live state */
  function start() {
    if (loop) loop.stop();
    loop = R.live(() => ({ view: 'part', t: token }), onState, ok => { if (!ok) $('#who').textContent = 'Reconnecting…'; });
  }
  function onState(st) {
    ST = st;
    if (!st.me) { leave(); return; }
    $('#who').textContent = st.me.name; $('#dock').hidden = false;
    const cur = st.current, a = st.agg || {};
    const key = JSON.stringify([cur, a.status, a.round, a.reveal, a.item, st.mine, st.score]);
    if (key !== renderKey) { renderKey = key; render(); }
    else update();
  }

  function waiting() {
    main.innerHTML = `<div class="card wait"><div class="big" aria-hidden="true">👀</div><h2>Look up at the screen</h2>
      <p class="muted">The next question appears here when the facilitator opens it. Keep this page open.</p></div>`;
  }
  function closedNote(a) {
    return a.status === 'open' ? '' : `<div class="mine">${a.reveal ? 'Results are on the screen.' : 'This activity is closed for now.'}</div>`;
  }

  function render() {
    const cur = ST.current;
    if (!cur || !CFG.activities[cur]) return waiting();
    const cfg = CFG.activities[cur], a = ST.agg, open = a.status === 'open';
    const T = types[cfg.type];
    if (!T) return waiting();
    main.innerHTML = `<div class="card stack"><div><span class="tag">${esc(cfg.title || '')}</span>${cfg.q ? `<div class="q">${esc(cfg.q)}</div>` : ''}</div><div id="body" class="stack"></div></div>`;
    T.render($('#body'), cfg, a, open);
    restoreDrafts(cur);
  }
  function update() {
    const cur = ST.current; if (!cur) return;
    const T = types[CFG.activities[cur].type];
    if (T && T.update) T.update(CFG.activities[cur], ST.agg);
  }
  function restoreDrafts(aid) {
    main.querySelectorAll('[data-draft]').forEach(el => {
      const k = aid + ':' + el.dataset.draft;
      if (drafts[k] != null && !el.value) el.value = drafts[k];
      el.addEventListener('input', () => { drafts[k] = el.value; });
    });
  }
  function clearDrafts(aid) { Object.keys(drafts).forEach(k => { if (k.startsWith(aid + ':')) delete drafts[k]; }); }

  function resultBars(labels, counts, right, mineIdx) {
    const tot = counts.reduce((x, y) => x + y, 0) || 1, max = Math.max(1, ...counts);
    return labels.map((l, i) => `<div class="result-row${right === i ? ' right' : ''}"><div class="lab">${right === i ? '✓ ' : ''}${esc(l)}${mineIdx === i ? ' <span class="status-pill">you</span>' : ''}</div><div class="num">${counts[i]} · ${Math.round(100 * counts[i] / tot)}%</div><div class="bar bar-track"><div class="fill" style="width:${100 * counts[i] / max}%"></div></div></div>`).join('');
  }

  /* ---------------------------------------------------------- one renderer per activity type */
  const types = {};

  types.scale = {
    render(el, cfg, a, open) {
      const mine = ST.mine ? ST.mine.v : null; let h = '<div class="scale">';
      for (let v = cfg.min; v <= cfg.max; v++) h += `<button type="button" data-v="${v}" class="${mine === v ? 'on' : ''}" ${open ? '' : 'disabled'} aria-pressed="${mine === v}">${v}</button>`;
      h += `</div><div class="scale-ends"><span>${cfg.min} · ${esc(cfg.labels[0])}</span><span>${cfg.max} · ${esc(cfg.labels[1])}</span></div>`;
      if (a.counts && (a.reveal)) h += `<div class="mine">The room's average: <b>${a.mean == null ? '–' : a.mean.toFixed(1)}</b> from ${a.n} people</div>`;
      el.innerHTML = h + closedNote(a);
      el.querySelectorAll('button[data-v]').forEach(b => b.onclick = () => send(ST.current, { v: +b.dataset.v }, 'Saved. Tap another number to change it.'));
    }
  };

  types.words = {
    render(el, cfg, a, open) {
      const mine = ST.mine || [];
      el.innerHTML = (open && mine.length < 3 ? `<form id="wf" class="stack"><textarea data-draft="text" id="wt" maxlength="${cfg.max || 120}" rows="2" placeholder="Type here" aria-label="Your answer"></textarea><button class="btn full" type="submit">Send</button><div class="muted" style="font-size:14px">Up to three answers. Shown on the screen without your name.</div></form>` : '')
        + (mine.length ? `<div class="mine"><b>You sent</b><br>${mine.map(m => esc(m.text)).join('<br>')}</div>` : '') + closedNote(a);
      const f = $('#wf', el);
      if (f) f.onsubmit = async ev => { ev.preventDefault(); const v = $('#wt').value.trim(); if (!v) return; await send(ST.current, { text: v }, 'Sent'); clearDrafts(ST.current); };
    }
  };

  types.poll = {
    render(el, cfg, a, open) {
      let opts = cfg.options, head = '';
      if (cfg.linked) {
        const w = CFG.activities[cfg.linked], it = a.item && w.items.find(i => i.id === a.item);
        if (!it) { el.innerHTML = '<div class="mine">Wait for the wheel on the screen to pick an exception.</div>'; return; }
        opts = cfg.options_by_item[a.item]; head = `<div class="record"><b>${esc(it.name)}</b>${esc(it.line)}</div>`;
      }
      if (cfg.rounds) head += `<div class="muted" style="font-size:14px;font-weight:700">${esc(R.roundLabel(cfg, a.round))}</div>`;
      const m = ST.mine; const chosen = new Set(m ? (m.choices || [m.choice]) : []);
      if (a.reveal && a.counts) {
        el.innerHTML = head + resultBars(opts, a.counts, cfg.correct, m && m.choice != null ? m.choice : null) + (cfg.correct != null && m && m.choice != null ? `<div class="mine">${m.choice === cfg.correct ? 'You got it.' : 'Not this time. The answer is ticked.'}</div>` : '');
        return;
      }
      el.innerHTML = head + opts.map((o, i) => `<button type="button" class="choice${chosen.has(i) ? ' on' : ''}" data-i="${i}" ${open ? '' : 'disabled'} aria-pressed="${chosen.has(i)}"><span class="dot"></span><span>${esc(o)}</span></button>`).join('')
        + (cfg.multi && open ? '<button class="btn full" id="pm" type="button">Send</button><div class="muted" style="font-size:14px">Choose as many as you like.</div>' : '')
        + (open && !cfg.multi ? '<div class="muted" style="font-size:14px">Tap to answer. You can change it until the poll closes.</div>' : '') + closedNote(a);
      const sel = new Set(chosen);
      el.querySelectorAll('.choice').forEach(b => b.onclick = () => {
        const i = +b.dataset.i;
        if (cfg.multi) {
          if (sel.has(i)) sel.delete(i);
          else {
            if (cfg.exclusive != null) { if (i === cfg.exclusive) sel.clear(); else sel.delete(cfg.exclusive); }
            sel.add(i);
          }
          el.querySelectorAll('.choice').forEach(x => { const k = +x.dataset.i; x.classList.toggle('on', sel.has(k)); x.setAttribute('aria-pressed', sel.has(k)); });
        }
        else send(ST.current, { choice: i }, 'Saved');
      });
      const pm = $('#pm', el); if (pm) pm.onclick = () => { if (!sel.size) return toast('Choose at least one'); send(ST.current, { choices: [...sel] }, 'Saved'); };
    }
  };

  types.game = {
    render(el, cfg, a, open) {
      const r = cfg.rounds[Math.min(a.round, cfg.rounds.length - 1)], m = ST.mine;
      let h = `<div class="muted" style="font-size:14px;font-weight:700">Round ${a.round + 1} of ${cfg.rounds.length} · ${esc(r.title)}</div>
        <div class="record"><b>The record said</b>${esc(r.record)}</div><div class="q" style="margin:4px 0 0">${esc(r.q)}</div>`;
      h += r.options.map((o, i) => {
        let cls = m && m.choice === i ? ' on' : '';
        if (a.reveal) cls = i === r.answer ? ' right' : (m && m.choice === i ? ' wrong' : '');
        return `<button type="button" class="choice${cls}" data-i="${i}" ${open && !a.reveal ? '' : 'disabled'}><span class="dot"></span><span>${esc(o)}</span></button>`;
      }).join('');
      if (a.reveal) h += `<div class="lesson">${esc(r.lesson)}</div><div class="mine">${m ? (m.choice === r.answer ? 'Right.' : 'Not this time.') : 'You did not answer this round.'} Your score: <b>${ST.score || 0}</b></div>`;
      else if (open) h += '<div class="muted" style="font-size:14px">Tap your answer. You can change it until the facilitator shows the answer.</div>';
      el.innerHTML = h;
      el.querySelectorAll('.choice').forEach(b => b.onclick = () => send(ST.current, { choice: +b.dataset.i }, 'Saved'));
    }
  };

  function allocUI(el, cfg, a, open, kind) {
    const total = kind === 'dots' ? cfg.dots : cfg.total, step = kind === 'dots' ? 1 : 5;
    const alloc = {}; const m = ST.mine && ST.mine.alloc; if (m) Object.keys(m).forEach(k => alloc[k] = m[k]);
    const left = () => total - Object.values(alloc).reduce((x, y) => x + y, 0);
    el.innerHTML = `<div class="mine"><span class="dots-left" id="left"></span> <span id="leftw"></span> left to place</div>`
      + cfg.items.map((it, i) => `<div class="item"><div class="t">${esc(it)}</div><div class="stepper"><button type="button" data-i="${i}" data-d="-1" aria-label="Fewer" ${open ? '' : 'disabled'}>−</button><span class="n" id="n${i}">${alloc[i] || 0}</span><button type="button" data-i="${i}" data-d="1" aria-label="More" ${open ? '' : 'disabled'}>+</button></div></div>`).join('')
      + (open ? `<button class="btn full" id="sendA" type="button">Send</button>` : '') + closedNote(a);
    const paint = () => { const l = left(); $('#left').textContent = l; $('#leftw').textContent = kind === 'dots' ? (l === 1 ? 'dot' : 'dots') : (l === 1 ? 'point' : 'points'); cfg.items.forEach((_, i) => { $('#n' + i).textContent = alloc[i] || 0; }); };
    el.querySelectorAll('.stepper button').forEach(b => b.onclick = () => {
      const i = b.dataset.i, d = +b.dataset.d * step, cur = alloc[i] || 0;
      if (d > 0 && left() < d) return toast(kind === 'dots' ? 'No dots left. Take one back first.' : 'No points left. Take some back first.');
      alloc[i] = Math.max(0, cur + d); paint();
    });
    const sb = $('#sendA'); if (sb) sb.onclick = () => {
      if (kind === 'points' && left() !== 0) return toast(`Place all ${total} points first`);
      if (kind === 'dots' && left() === total) return toast('Place at least one dot');
      send(ST.current, { alloc }, 'Saved. You can change it until it closes.');
    };
    paint();
  }
  types.dots = { render(el, cfg, a, open) { allocUI(el, cfg, a, open, 'dots'); } };
  types.points = { render(el, cfg, a, open) { allocUI(el, cfg, a, open, 'points'); } };

  types.sort = {
    render(el, cfg, a, open) {
      const bins = {}; const m = ST.mine && ST.mine.bins; if (m) Object.keys(m).forEach(k => bins[k] = m[k]);
      const many = cfg.bins.length > 3;
      let h = cfg.items.map((it, i) => {
        let res = '';
        if (a.reveal && cfg.correct) {
          const ok = bins[i] === cfg.correct[i];
          res = `<div class="mine" style="margin-top:8px">${bins[i] != null ? (ok ? '✓ ' : '✗ ') : ''}<b>${esc(cfg.bins[cfg.correct[i]])}</b>${cfg.why ? '. ' + esc(cfg.why[i]) : ''}</div>`;
        }
        const ctl = many
          ? `<select data-i="${i}" ${open ? '' : 'disabled'} aria-label="Choose for: ${esc(it)}"><option value="">Choose…</option>${cfg.bins.map((b, k) => `<option value="${k}" ${bins[i] === k ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>`
          : `<div class="seg">${cfg.bins.map((b, k) => `<button type="button" data-i="${i}" data-k="${k}" class="${bins[i] === k ? 'on' : ''}" ${open ? '' : 'disabled'}>${esc(b)}</button>`).join('')}</div>`;
        return `<div class="item"><div class="t">${esc(it)}</div>${ctl}${res}</div>`;
      }).join('');
      if (open) h += '<button class="btn full" id="sendS" type="button">Send</button><div class="muted" style="font-size:14px">You can send some now and the rest later.</div>';
      el.innerHTML = h + closedNote(a);
      el.querySelectorAll('.seg button').forEach(b => b.onclick = () => {
        bins[b.dataset.i] = +b.dataset.k;
        b.parentNode.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      });
      el.querySelectorAll('select').forEach(s => s.onchange = () => { if (s.value === '') delete bins[s.dataset.i]; else bins[s.dataset.i] = +s.value; });
      const sb = $('#sendS'); if (sb) sb.onclick = () => { if (!Object.keys(bins).length) return toast('Choose for at least one line'); send(ST.current, { bins }, 'Saved'); };
    }
  };

  types.checklist = {
    render(el, cfg, a, open) {
      const marks = {}; const m = ST.mine && ST.mine.marks; if (m) Object.keys(m).forEach(k => marks[k] = m[k]);
      el.innerHTML = cfg.items.map((it, i) => `<div class="item"><div class="t">${esc(it)}</div><div class="seg">${cfg.scale.map((s, k) => `<button type="button" data-i="${i}" data-k="${k}" class="${marks[i] === k ? 'on' : ''}" ${open ? '' : 'disabled'}>${esc(s)}</button>`).join('')}</div></div>`).join('')
        + (open ? '<button class="btn full" id="sendC" type="button">Send</button>' : '') + closedNote(a);
      el.querySelectorAll('.seg button').forEach(b => b.onclick = () => { marks[b.dataset.i] = +b.dataset.k; b.parentNode.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); });
      const sb = $('#sendC'); if (sb) sb.onclick = () => { if (!Object.keys(marks).length) return toast('Mark at least one line'); send(ST.current, { marks }, 'Saved'); };
    }
  };

  function fieldUI(f) {
    const id = 'f_' + f.name;
    if (f.kind === 'choice') return `<div><label class="f" for="${id}">${esc(f.label || f.name)}</label><select id="${id}" data-draft="${f.name}" required><option value="">Choose…</option>${f.options.map(o => `<option>${esc(o)}</option>`).join('')}</select></div>`;
    if (f.kind === 'number') return `<div><label class="f" for="${id}">${esc(f.label)}</label><input id="${id}" data-draft="${f.name}" type="number" inputmode="numeric" min="${f.min || 0}" max="${f.max || 999}" required></div>`;
    return `<div><label class="f" for="${id}">${esc(f.label || f.name)}</label><textarea id="${id}" data-draft="${f.name}" maxlength="300" rows="2" required></textarea></div>`;
  }
  function collect(fields) {
    const d = {}; for (const f of fields) { const v = $('#f_' + f.name).value.trim(); if (!v) { toast('Please fill: ' + (f.label || f.name)); return null; } d[f.name] = v; } return d;
  }
  function votesUI(cfg, a) {
    if (!cfg.vote) return '';
    const subs = (a.subs || []).slice().sort((x, y) => y.votes - x.votes);
    if (!subs.length) return '<div class="muted" style="font-size:14px">Cards from the room appear here for voting.</div>';
    const kf = (cfg.fields || []).find(f => f.kind === 'choice'), voted = new Set(ST.voted || []);
    return `<div class="tag" style="margin-top:6px">Vote for the best (three votes)</div>` + subs.map(s => {
      const d = s.data; const txt = (cfg.fields || []).filter(f => f !== kf).map(f => esc(d[f.name] || '')).filter(Boolean).join(' · ');
      return `<div class="vote"><div class="body">${kf ? `<b>${esc(d[kf.name])}</b><br>` : ''}${txt}</div><button type="button" data-sid="${s.id}" class="${voted.has(s.id) ? 'on' : ''}" aria-pressed="${voted.has(s.id)}">♥ ${s.votes}</button></div>`;
    }).join('');
  }
  types.form = {
    render(el, cfg, a, open) {
      const mine = ST.mine || [];
      el.innerHTML = (open ? `<form id="ff" class="stack">${cfg.fields.map(fieldUI).join('')}<button class="btn full" type="submit">Send</button></form>` : '')
        + (mine.length ? `<div class="mine"><b>You sent ${mine.length}</b>${mine.map(m => '<br>' + esc(Object.values(m.data).join(' · '))).join('')}</div>` : '')
        + closedNote(a) + `<div id="votes" class="stack">${votesUI(cfg, a)}</div>`;
      const f = $('#ff', el);
      if (f) f.onsubmit = async ev => { ev.preventDefault(); const d = collect(cfg.fields); if (!d) return; await send(ST.current, d, 'Sent'); clearDrafts(ST.current); };
      bindVotes(cfg);
    },
    update(cfg, a) { const v = $('#votes'); if (v) { v.innerHTML = votesUI(cfg, a); bindVotes(cfg); } }
  };
  function bindVotes(cfg) {
    main.querySelectorAll('#votes button[data-sid]').forEach(b => b.onclick = async () => {
      try { await R.post('/api/vote', { t: token, aid: ST.current, sid: b.dataset.sid }); } catch (e) { toast(e.message); }
    });
  }

  types.findings = {
    render(el, cfg, a, open) {
      const mine = ST.mine || [];
      const fields = [{ name: 'kind', label: 'What kind of finding?', kind: 'choice', options: cfg.kinds }, { name: 'step', label: 'Which case or step?', kind: 'choice', options: cfg.steps }, { name: 'text', label: 'What did you see? One or two lines.', kind: 'text' }];
      const pts = mine.filter(m => m.status === 'accepted').reduce((s, m) => s + (cfg.points[m.data.kind] || 1), 0);
      el.innerHTML = (open ? `<form id="fd" class="stack">${fields.map(fieldUI).join('')}<button class="btn full red" type="submit">Log it</button></form>` : '')
        + `<div class="mine"><b>Your findings: ${mine.length}</b> · points so far: <b>${pts}</b>${mine.map(m => `<br><span class="status-pill ${m.status}">${m.status === 'new' ? 'waiting' : m.status}</span> ${esc(m.data.kind)}: ${esc(m.data.text)}`).join('')}</div>`
        + `<div class="muted" style="font-size:14px">Points count when the facilitator accepts a finding. ${Object.entries(cfg.points).map(([k, v]) => esc(k) + ' ' + v).join(' · ')}</div>` + closedNote(a);
      const f = $('#fd', el);
      if (f) f.onsubmit = async ev => { ev.preventDefault(); const d = collect(fields); if (!d) return; await send(ST.current, d, 'Logged'); clearDrafts(ST.current); };
    }
  };

  types.claim = {
    render(el, cfg, a, open) {
      const cl = a.claims || [], me = ST.me.name;
      el.innerHTML = cfg.items.map((it, i) => `<div class="item"><div class="t">${esc(it)}</div><div class="seg">${cfg.slots.map((s, k) => {
        const names = (cl[i] && cl[i][k]) || [], on = names.includes(me);
        return `<button type="button" data-i="${i}" data-k="${k}" class="${on ? 'on' : ''}" ${open ? '' : 'disabled'} aria-pressed="${on}">${esc(s)}${names.length ? ' · ' + names.length : ''}</button>`;
      }).join('')}</div>${cl[i] && (cl[i][0].length || cl[i][1].length) ? `<div class="muted" style="font-size:13px;margin-top:6px">${cl[i].map((n, k) => n.length ? esc(cfg.slots[k]) + ': ' + n.map(esc).join(', ') : '').filter(Boolean).join(' · ')}</div>` : ''}</div>`).join('')
        + '<div class="muted" style="font-size:14px">Tap to claim a seat, tap again to give it back. Up to three seats.</div>' + closedNote(a);
      el.querySelectorAll('.seg button').forEach(b => b.onclick = () => send(ST.current, { item: +b.dataset.i, slot: +b.dataset.k }, 'Updated'));
    },
    update(cfg, a) { types.claim.render($('#body'), cfg, a, a.status === 'open'); }
  };

  types.wheel = {
    render(el, cfg, a) {
      const it = a.item && cfg.items.find(i => i.id === a.item);
      el.innerHTML = it ? `<div class="record"><b>${esc(it.label || it.id)} · ${esc(it.name)}</b>${esc(it.line)}</div><div class="muted" style="font-size:14px">Talk it through at your table. The vote opens next.</div>` : '<div class="mine">Watch the wheel on the screen.</div>';
    }
  };

  types.parking = {
    render(el, cfg, a, open) {
      el.innerHTML = `<form id="pk" class="stack"><textarea data-draft="text" id="pkt" maxlength="300" rows="3" placeholder="Your question" aria-label="Your question"></textarea><button class="btn full" type="submit">Send</button></form>`
        + ((a.items || []).length ? `<div class="mine"><b>On the board</b>${a.items.slice(-8).map(p => '<br>' + esc(p.text) + (p.owner ? ` <span class="status-pill">${esc(p.owner)}</span>` : '')).join('')}</div>` : '');
      $('#pk').onsubmit = async ev => { ev.preventDefault(); const v = $('#pkt').value.trim(); if (!v) return; try { await R.post('/api/parking', { t: token, text: v }); toast('Sent'); clearDrafts(ST.current); $('#pkt').value = ''; } catch (e) { toast(e.message); } };
    }
  };

  /* ---------------------------------------------------------- pulse and questions, always available */
  function sheet(html) { $('#sheetPanel').innerHTML = html; $('#sheet').hidden = false; }
  $('#sheet').addEventListener('click', ev => { if (ev.target.id === 'sheet' || ev.target.dataset.close != null) $('#sheet').hidden = true; });
  $('#btnPulse').onclick = () => {
    const p = ST && ST.pulse || {}, P = CFG.activities.pulse;
    sheet(`<div class="stack"><h2>How is it going?</h2>
      <div><div class="f" style="font-weight:600;margin-bottom:6px">Is it clear?</div><div class="seg" id="pc">${P.clarity.map(c => `<button type="button" class="${p.clarity === c ? 'on' : ''}">${esc(c)}</button>`).join('')}</div></div>
      <div><div class="f" style="font-weight:600;margin-bottom:6px">The pace?</div><div class="seg" id="pp">${P.pace.map(c => `<button type="button" class="${p.pace === c ? 'on' : ''}">${esc(c)}</button>`).join('')}</div></div>
      <div class="muted" style="font-size:14px">Only the facilitator sees this, as totals. Your answer counts for ten minutes.</div>
      <button class="btn ghost full" type="button" data-close>Close</button></div>`);
    const go = (k, el) => el.querySelectorAll('button').forEach(b => b.onclick = async () => {
      el.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      try { await R.post('/api/pulse', { t: token, [k]: b.textContent }); toast('Thanks'); } catch (e) { toast(e.message); }
    });
    go('clarity', $('#pc')); go('pace', $('#pp'));
  };
  $('#btnAsk').onclick = () => {
    const mine = ST && ST.parking || [];
    sheet(`<form class="stack" id="ask"><h2>Ask or park a question</h2><textarea id="askT" maxlength="300" rows="4" placeholder="${esc(CFG.activities.parking.q)}" aria-label="Your question"></textarea>
      <button class="btn full" type="submit">Send</button><button class="btn ghost full" type="button" data-close>Close</button>
      ${mine.length ? `<div class="mine"><b>Your questions</b>${mine.map(p => `<br>${esc(p.text)}${p.owner ? ` <span class="status-pill">${esc(p.owner)}</span>` : ''}${p.done ? ' <span class="status-pill accepted">answered</span>' : ''}`).join('')}</div>` : ''}</form>`);
    $('#ask').onsubmit = async ev => {
      ev.preventDefault(); const v = $('#askT').value.trim(); if (!v) return;
      try { await R.post('/api/parking', { t: token, text: v }); toast('Sent to the facilitator'); $('#sheet').hidden = true; } catch (e) { toast(e.message); }
    };
  };

  /* ---------------------------------------------------------- boot */
  (async function boot() {
    for (let i = 0; i < 30 && !CFG; i++) {
      try { CFG = await R.get('/api/config'); } catch (e) { main.innerHTML = '<div class="card wait"><p>Cannot reach the room. Check you are on the right Wi-Fi.</p></div>'; await R.sleep(2000); }
    }
    document.title = CFG.title;
    if (token) start(); else showJoin();
  })();
})();
