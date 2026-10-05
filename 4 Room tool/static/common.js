/* Shared by the phone page, the room screen and the facilitator console. No libraries except the QR encoder. */
(function () {
  'use strict';
  const R = {};
  R.store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode: keep going */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { } }
  };
  R.esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  R.$ = (sel, root) => (root || document).querySelector(sel);
  R.sleep = ms => new Promise(r => setTimeout(r, ms));

  R.post = async function (path, body) {
    let r;
    try {
      r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    } catch (e) { throw new Error('No connection to the room. Check the Wi-Fi and try again.'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Something went wrong');
    return j;
  };
  R.get = async function (path, signal) {
    const r = await fetch(path, { cache: 'no-store', signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Something went wrong');
    return j;
  };

  /* Long-poll loop. params() returns the query object; restart() forces an immediate refetch. */
  R.live = function (params, onState, onConn) {
    let v = 0, ctl = null, stopped = false, wait = 1000;
    R.clockOffset = 0;
    async function run() {
      while (!stopped) {
        ctl = new AbortController();
        const q = new URLSearchParams(Object.assign({}, params(), { v }));
        try {
          const st = await R.get('/api/state?' + q.toString(), ctl.signal);
          R.clockOffset = st.server_time - Date.now() / 1000;
          v = st.v; wait = 1000; onConn && onConn(true);
          onState(st);
        } catch (e) {
          if (e.name === 'AbortError') { v = 0; continue; }
          onConn && onConn(false, e.message); v = 0;
          await R.sleep(wait); wait = Math.min(wait * 2, 8000);
        }
      }
    }
    run();
    return { restart() { v = 0; if (ctl) ctl.abort(); }, stop() { stopped = true; if (ctl) ctl.abort(); } };
  };

  R.timerLeft = function (timer) {
    if (!timer) return null;
    return Math.max(0, Math.round(timer.end - (Date.now() / 1000 + (R.clockOffset || 0))));
  };
  R.fmt = s => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  R.roundLabel = (cfg, r) => (cfg.round_labels && cfg.round_labels[r]) || ((cfg.round_word || 'Vote') + ' ' + (r + 1));

  /* QR code as a crisp SVG path. */
  R.qrSvg = function (text, dark) {
    const qr = qrcode(0, 'M'); qr.addData(text); qr.make();
    const n = qr.getModuleCount(), m = 2; let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + m},${r + m}h1v1h-1z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * m} ${n + 2 * m}" shape-rendering="crispEdges" role="img" aria-label="QR code for ${R.esc(text)}"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="${dark || '#1F2A33'}"/></svg>`;
  };

  /* ------------------------------------------------------------ results, drawn the same way on the room screen and in the console */
  const COLORS = ['#287079', '#FF462D', '#36454F', '#B7791F', '#2F855A', '#7A5AA6', '#4A90A4', '#C2410C', '#6B7782'];
  const pct = (n, tot) => tot ? Math.round(100 * n / tot) : 0;

  function bars(rows, opts) {
    // rows: [{label, n, right, top, ghost}] ; opts.max, opts.vert (label above the bar)
    const max = opts.max || Math.max(1, ...rows.map(r => Math.max(r.n, r.ghost || 0)));
    return `<div class="sbars${opts.vert ? ' vert' : ''}">` + rows.map(r => `
      <div class="sbar${r.right ? ' right' : ''}${r.top ? ' top3' : ''}">
        <div class="lab">${r.right ? '✓ ' : ''}${R.esc(r.label)}</div>
        <div class="track">${r.ghost != null ? `<div class="ghost" style="width:${100 * r.ghost / max}%"></div>` : ''}<div class="fill" style="width:${100 * r.n / max}%"></div></div>
        <div class="num">${opts.pct ? pct(r.n, opts.total) + '%' : r.n}</div>
      </div>`).join('') + '</div>';
  }

  function hiddenBox(agg, peopleN) {
    return `<div class="hidden-results"><div class="n">${agg.n || 0}</div><div class="t">${agg.n === 1 ? 'answer' : 'answers'}${peopleN ? ' from ' + peopleN + ' people in the room' : ''}</div>
      <div class="t muted">Results appear when the facilitator shows them.</div></div>`;
  }

  /* Should results be visible on the room screen now? Checks and games stay hidden until the reveal. */
  R.showResults = function (cfg, agg, settings, host) {
    if (host) return true;
    if (agg.reveal) return true;
    const graded = cfg.correct != null || cfg.type === 'game' || (cfg.type === 'sort' && cfg.correct);
    if (graded) return false;
    return !!settings.live;
  };

  R.results = function (cfg, agg, ctx) {
    ctx = ctx || {};
    const host = !!ctx.host, t = cfg.type;
    const free = ['wheel', 'claim', 'parking'].includes(t);
    if (!R.showResults(cfg, agg, ctx.settings || {}, host) && !free) return hiddenBox(agg, ctx.people_n);
    if (!free && !agg.n && !(cfg.linked)) return `<div class="hidden-results"><div class="n">0</div><div class="t">Waiting for answers</div></div>`;
    if (t === 'scale') {
      const vals = []; for (let v = cfg.min; v <= cfg.max; v++) vals.push(v);
      const max = Math.max(1, ...vals.map(v => agg.counts[v] || 0));
      return `<div style="display:flex;gap:3cqw;align-items:center;justify-content:center;height:100%">
        <div style="flex:1">
          <div class="hist">${vals.map(v => `<div class="col"><div class="v">${agg.counts[v] || 0}</div><div class="b" style="height:${78 * (agg.counts[v] || 0) / max}%"></div><div class="k">${v}</div></div>`).join('')}</div>
          <div class="ends"><span>1 · ${R.esc(cfg.labels[0])}</span><span>${cfg.max} · ${R.esc(cfg.labels[1])}</span></div>
        </div>
        <div style="text-align:center;min-width:16cqw"><div class="bigstat">${agg.mean == null ? '–' : agg.mean.toFixed(1)}</div><div class="muted" style="font-size:1.4cqw;margin-top:.6cqw">average of ${agg.n}</div></div>
      </div>`;
    }
    if (t === 'words') {
      const live = agg.entries || [];
      if ((cfg.max || 120) <= 60) {
        const g = {};
        live.forEach(e => { if (e.hidden && !host) return; const k = e.text.trim().toLowerCase(); g[k] = g[k] || { text: e.text.trim(), n: 0, hidden: e.hidden }; g[k].n++; });
        const arr = Object.values(g).sort((a, b) => b.n - a.n).slice(0, 40);
        const top = Math.max(1, ...arr.map(x => x.n));
        if (!arr.length) return hiddenBox(agg, ctx.people_n);
        return `<div class="cloud">${arr.map(x => `<span style="font-size:${(1.6 + 3.4 * x.n / top).toFixed(2)}cqw${x.hidden ? ';opacity:.3;text-decoration:line-through' : ''}">${R.esc(x.text)}</span>`).join('')}</div>`;
      }
      const recent = live.filter(e => host || !e.hidden).slice(-12).reverse();
      if (!recent.length) return hiddenBox(agg, ctx.people_n);
      return `<div class="wall">${recent.map(e => `<div class="note"${e.hidden ? ' style="opacity:.35"' : ''}>${R.esc(e.text)}</div>`).join('')}</div>`;
    }
    if (t === 'poll') {
      const opts = agg.options || cfg.options || [];
      const tot = agg.counts.reduce((a, b) => a + b, 0);
      let head = '';
      if (cfg.linked) {
        const w = ctx.acts && ctx.acts[cfg.linked]; const it = w && agg.item && w.items.find(i => i.id === agg.item);
        if (!it) return `<div class="hidden-results"><div class="t">Spin the wheel to pick an exception.</div></div>`;
        head = `<div class="record" style="font-size:1.8cqw;padding:1.2cqw 1.6cqw;border-radius:.8cqw;margin-bottom:1.6cqw"><b style="font-size:1cqw">${R.esc(it.name)}</b>${R.esc(it.line)}</div>`;
      }
      let prev = null;
      if (cfg.rounds && cfg.compare !== false && agg.history && agg.history.length) prev = agg.history[agg.history.length - 1].counts;
      const ptot = prev ? prev.reduce((a, b) => a + b, 0) : 0;
      const rows = opts.map((o, i) => ({ label: o, n: tot ? 100 * agg.counts[i] / tot : 0, raw: agg.counts[i], right: agg.reveal && cfg.correct === i, ghost: prev ? (ptot ? 100 * prev[i] / ptot : 0) : null }));
      const html = '<div class="sbars">' + rows.map(r => `
        <div class="sbar${r.right ? ' right' : ''}"><div class="lab">${r.right ? '✓ ' : ''}${R.esc(r.label)}</div>
        <div class="track">${r.ghost != null ? `<div class="ghost" style="width:${r.ghost}%"></div>` : ''}<div class="fill" style="width:${r.n}%"></div></div>
        <div class="num">${r.raw}</div></div>`).join('') + '</div>';
      const note = prev ? `<div class="legend"><span><i style="background:#287079"></i>${R.esc(R.roundLabel(cfg, agg.round))}</span><span><i style="background:repeating-linear-gradient(45deg,#CBD3D9 0 3px,#fff 3px 6px)"></i>${R.esc(R.roundLabel(cfg, agg.round - 1))}</span></div>` : (cfg.rounds ? `<div class="legend"><span>${R.esc(R.roundLabel(cfg, agg.round))}</span></div>` : '');
      const who = cfg.multi ? `${agg.n} ${agg.n === 1 ? 'person' : 'people'} · as many choices as they liked` : `${tot} ${tot === 1 ? 'answer' : 'answers'}`;
      return head + html + note + `<div class="muted" style="margin-top:1cqw;font-size:1.2cqw">${who}</div>`;
    }
    if (t === 'game') {
      const r = cfg.rounds[Math.min(agg.round, cfg.rounds.length - 1)];
      const tot = agg.counts.reduce((a, b) => a + b, 0);
      const rows = r.options.map((o, i) => ({ label: o, n: agg.counts[i], right: agg.reveal && i === r.answer }));
      const board = (agg.reveal && (ctx.settings || {}).leaderboard && agg.board && agg.board.length)
        ? `<div class="board"><b>Top scores</b><ol>${agg.board.slice(0, 5).map(b => `<li>${R.esc(b[0])} · ${b[1]}</li>`).join('')}</ol></div>` : '';
      return `<div class="game"><div>
          <div class="muted" style="font-size:1.2cqw;font-weight:800;margin-bottom:.8cqw">ROUND ${agg.round + 1} OF ${cfg.rounds.length} · ${R.esc(r.title)}</div>
          <div class="record"><b>The record said</b>${R.esc(r.record)}</div>
          ${agg.reveal ? `<div class="lesson">${R.esc(r.lesson)}</div>` : ''}${board}
        </div><div>
          <div style="font-size:2cqw;font-weight:800;margin-bottom:1.2cqw">${R.esc(r.q)}</div>
          ${agg.reveal ? bars(rows, { max: Math.max(1, ...rows.map(x => x.n)), vert: true }) : `<div class="sbars vert">${r.options.map((o, i) => `<div class="sbar"><div class="lab">${String.fromCharCode(65 + i)}. ${R.esc(o)}</div></div>`).join('')}</div>`}
          <div class="muted" style="margin-top:1cqw;font-size:1.2cqw">${tot} ${tot === 1 ? 'answer' : 'answers'}</div>
        </div></div>`;
    }
    if (t === 'dots' || t === 'points') {
      const vals = t === 'dots' ? agg.totals : agg.mean;
      const order = vals.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
      const top3 = new Set(order.slice(0, 3).filter(x => x[0] > 0).map(x => x[1]));
      let rows = cfg.items.map((it, i) => ({ label: it, n: vals[i], top: top3.has(i) }));
      if (t === 'points') rows = order.map(([v, i]) => ({ label: cfg.items[i], n: v, top: top3.has(i) }));
      return bars(rows, {}) + `<div class="muted" style="margin-top:1cqw;font-size:1.2cqw">${agg.n} ${agg.n === 1 ? 'person' : 'people'}${t === 'points' ? ' · average points out of ' + cfg.total : ' · ' + cfg.dots + ' dots each'}</div>`;
    }
    if (t === 'sort') {
      const nb = cfg.bins.length;
      if (nb <= 3) {
        const legend = `<div class="legend">${cfg.bins.map((b, i) => `<span><i style="background:${COLORS[i]}"></i>${R.esc(b)}</span>`).join('')}</div>`;
        const rows = cfg.items.map((it, i) => {
          const g = agg.grid[i], tot = g.reduce((a, b) => a + b, 0);
          const right = agg.reveal && cfg.correct ? `<div style="font-size:1.1cqw;margin-top:.3cqw;color:#2F855A;font-weight:700">✓ ${R.esc(cfg.bins[cfg.correct[i]])}${cfg.why ? ' · ' + R.esc(cfg.why[i]) : ''}</div>` : '';
          return `<tr><td class="lab">${R.esc(it)}${right}</td><td><div class="stacked">${g.map((n, k) => n ? `<div style="flex-grow:${n};background:${COLORS[k]}">${pct(n, tot)}%</div>` : '').join('') || '<div style="flex-grow:1;color:#6B7782">no answers</div>'}</div></td></tr>`;
        }).join('');
        return legend + `<table class="matrix">${rows}</table>`;
      }
      const rows = cfg.items.map((it, i) => {
        const g = agg.grid[i].map((n, k) => [n, k]).filter(x => x[0]).sort((a, b) => b[0] - a[0]).slice(0, 3);
        return `<tr><td class="lab">${R.esc(it)}</td><td>${g.length ? g.map(([n, k], j) => `<span style="display:inline-block;margin:.2cqw .6cqw .2cqw 0;padding:.4cqw .9cqw;border-radius:99px;background:${j === 0 ? '#287079' : '#F2F4F5'};color:${j === 0 ? '#fff' : '#1F2A33'};font-weight:700">${R.esc(cfg.bins[k])} · ${n}</span>`).join('') : '<span class="muted">no answers yet</span>'}</td></tr>`;
      }).join('');
      return `<table class="matrix">${rows}</table>`;
    }
    if (t === 'form') {
      let top = '';
      if (cfg.tally && agg.tally) {
        const f = cfg.fields.find(x => x.name === cfg.tally);
        top = bars(f.options.map(o => ({ label: o, n: agg.tally[o] || 0 })), {}) + '<div style="height:1.6cqw"></div>';
      }
      if (cfg.numbers) {
        const st = agg.stats || {};
        const rows = cfg.fields.map(f => {
          const s = st[f.name], draft = cfg.draft && cfg.draft[f.name], lo = 0, hi = 48;
          const x = v => (100 * (v - lo) / (hi - lo)).toFixed(1) + '%';
          return `<div style="display:grid;grid-template-columns:18cqw 1fr 14cqw;gap:1.6cqw;align-items:center;margin:2.2cqw 0">
            <div style="font-size:1.6cqw;font-weight:700">${R.esc(f.label.replace(', months', ''))}</div>
            <div style="position:relative;height:3.4cqw;background:#F2F4F5;border-radius:.6cqw">
              ${s ? `<div style="position:absolute;top:0;bottom:0;left:${x(s.min)};width:calc(${x(s.max)} - ${x(s.min)});background:#E3F0F1;border-radius:.6cqw"></div>
              <div style="position:absolute;top:-0.5cqw;bottom:-0.5cqw;left:${x(s.median)};width:.5cqw;background:#287079;border-radius:.2cqw"></div>` : ''}
              ${draft != null ? `<div style="position:absolute;top:-1.6cqw;left:${x(draft)};transform:translateX(-50%);font-size:1cqw;font-weight:800;color:#FF462D">draft ${draft}</div><div style="position:absolute;top:0;bottom:0;left:${x(draft)};border-left:.25cqw dashed #FF462D"></div>` : ''}
            </div>
            <div style="font-size:1.4cqw">${s ? `<b style="font-size:2.2cqw;color:#287079">${s.median}</b> middle answer<br><span class="muted">${s.min}–${s.max} · ${s.n} answers</span>` : '<span class="muted">no answers yet</span>'}</div></div>`;
        }).join('');
        return `<div style="max-width:80cqw;margin:2cqw auto 0">${rows}<div class="muted" style="font-size:1.2cqw">0 to 48 months. Dark mark: the room's middle answer. Pale band: lowest to highest. Red: the draft.</div></div>`;
      }
      return top + wall(cfg, agg, host);
    }
    if (t === 'findings') {
      const kinds = cfg.kinds.map(k => `<div style="background:#F2F4F5;border-radius:.8cqw;padding:1cqw 1.4cqw;min-width:12cqw"><div style="font-size:3cqw;font-weight:800;color:${k === 'Worked as agreed' ? '#2F855A' : '#FF462D'}">${agg.kinds[k] || 0}</div><div style="font-size:1.2cqw">${R.esc(k)}</div></div>`).join('');
      const board = (ctx.settings || {}).leaderboard && agg.board && agg.board.length ? `<div class="board" style="margin:0"><b>Points for accepted findings</b><ol>${agg.board.slice(0, 5).map(b => `<li>${R.esc(b[0])} · ${b[1]}</li>`).join('')}</ol></div>` : '';
      return `<div style="display:flex;gap:1cqw;flex-wrap:wrap;margin-bottom:1.4cqw">${kinds}</div><div style="display:grid;grid-template-columns:1fr ${board ? '22cqw' : '0'};gap:1.6cqw">${wall(cfg, agg, host, true)}${board}</div>`;
    }
    if (t === 'claim') {
      const cl = agg.claims || [];
      return `<table class="seats"><tr><th>Decision</th>${cfg.slots.map(s => `<th>${R.esc(s)}</th>`).join('')}</tr>${cfg.items.map((it, i) => `<tr><td>${R.esc(it)}</td>${cfg.slots.map((s, k) => {
        const names = (cl[i] && cl[i][k]) || [];
        return `<td>${names.length ? names.map(R.esc).join(', ') + (names.length > 1 ? ' <span style="color:#B7791F;font-weight:800">· agree one</span>' : '') : `<span class="empty">${k === 0 ? 'No owner yet' : 'No backup yet'}</span>`}</td>`;
      }).join('')}</tr>`).join('')}</table>`;
    }
    if (t === 'checklist') {
      const cols = cfg.colors || ['#2F855A', '#B7791F', '#9AA5AE'];
      const legend = `<div class="legend">${cfg.scale.map((b, i) => `<span><i style="background:${cols[i] || COLORS[i]}"></i>${R.esc(b)}</span>`).join('')}</div>`;
      return legend + `<table class="matrix">${cfg.items.map((it, i) => {
        const g = agg.grid[i], tot = g.reduce((a, b) => a + b, 0);
        return `<tr><td class="lab">${R.esc(it)}</td><td><div class="stacked">${g.map((n, k) => n ? `<div style="flex-grow:${n};background:${cols[k] || COLORS[k]}">${n}</div>` : '').join('') || '<div style="flex-grow:1;color:#6B7782">no answers</div>'}</div></td></tr>`;
      }).join('')}</table><div class="muted" style="font-size:1.2cqw;margin-top:.6cqw">${agg.n} ${agg.n === 1 ? 'person' : 'people'}</div>`;
    }
    if (t === 'wheel') return wheel(cfg, agg, ctx);
    if (t === 'parking') {
      const items = (agg.items || []).slice(-12).reverse();
      if (!items.length) return `<div class="hidden-results"><div class="t">No questions yet. Use "Ask a question" on your phone.</div></div>`;
      return `<div class="wall">${items.map(p => `<div class="note${p.done ? '' : ''}"${p.done ? ' style="opacity:.45"' : ''}>${p.owner ? `<span class="k">${R.esc(p.owner)}${p.date ? ' · ' + R.esc(p.date) : ''}</span>` : ''}${R.esc(p.text)}${host && p.who ? `<div class="muted" style="font-size:1cqw;margin-top:.3cqw">${R.esc(p.who)}</div>` : ''}</div>`).join('')}</div>`;
    }
    return '';
  };

  function wall(cfg, agg, host, findings) {
    const kf = findings ? null : cfg.fields.find(f => f.kind === 'choice');
    const rest = findings ? [] : cfg.fields.filter(f => f !== kf);
    const cap = rest.length > 3 ? 4 : findings ? 6 : 8;
    const subs = (agg.subs || []).slice().sort((a, b) => (b.starred - a.starred) || (b.votes - a.votes) || (b.t - a.t)).slice(0, cap);
    if (!subs.length) return hiddenBox(agg);
    const short = l => R.esc(String(l || '').split(' (')[0].split(',')[0]);
    return `<div class="wall"${rest.length > 3 ? ' style="grid-template-columns:repeat(2,1fr);font-size:1.15em"' : (!findings ? ' style="grid-template-columns:repeat(auto-fill,minmax(28cqw,1fr))"' : '')}>${subs.map(s => {
      const d = s.data; let head, body;
      if (findings) { head = d.kind + ' · ' + d.step; body = R.esc(d.text); }
      else {
        head = kf ? d[kf.name] : '';
        // on the room screen a long card shows its first three answers; the console and the export keep every field
        const have = rest.filter(f => d[f.name]).slice(0, host ? 99 : 3);
        body = have.map(f => (rest.length > 2 ? `<b>${short(f.label)}:</b> ` : '') + R.esc(d[f.name])).join('<br>');
      }
      const foot = host && s.who ? `<div class="muted" style="font-size:1cqw;margin-top:.3cqw">${R.esc(s.who)}${s.status && s.status !== 'new' ? ' · ' + R.esc(s.status) : ''}</div>`
        : (findings && s.status === 'accepted' ? '<div style="font-size:1cqw;color:#2F855A;font-weight:800;margin-top:.3cqw">ACCEPTED</div>' : '');
      return `<div class="note${s.starred ? ' star' : ''}"${s.hidden ? ' style="opacity:.35"' : ''}>${cfg.vote ? `<span class="votes">♥ ${s.votes}</span>` : ''}${head ? `<span class="k">${R.esc(head)}</span>` : ''}${body}${foot}</div>`;
    }).join('')}</div>`;
  }

  const wheelTurn = {};
  function wheel(cfg, agg, ctx) {
    const items = cfg.items, n = items.length, seg = 360 / n;
    const idx = items.findIndex(i => i.id === agg.item);
    const key = (ctx.host ? 'h' : 's') + cfg.id;
    const st = wheelTurn[key] || (wheelTurn[key] = { turn: 0, prev: 0, item: null });
    if (idx >= 0 && st.item !== agg.item + ':' + (agg.history || []).length) {
      const target = -(idx * seg + seg / 2);
      const base = Math.ceil((st.turn - target) / 360) * 360 + (st.item ? 1440 : 720);
      st.prev = st.turn; st.turn = target + base; st.item = agg.item + ':' + (agg.history || []).length;
    }
    const r = 100, cx = 110, cy = 110;
    let paths = '';
    items.forEach((it, i) => {
      const a0 = (i * seg - 90) * Math.PI / 180, a1 = ((i + 1) * seg - 90) * Math.PI / 180, am = ((i + .5) * seg - 90) * Math.PI / 180;
      const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0), x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      const tx = cx + r * .62 * Math.cos(am), ty = cy + r * .62 * Math.sin(am);
      paths += `<path d="M${cx},${cy}L${x0.toFixed(2)},${y0.toFixed(2)}A${r},${r} 0 0 1 ${x1.toFixed(2)},${y1.toFixed(2)}Z" fill="${COLORS[i % COLORS.length]}" stroke="#fff" stroke-width="2"/>`;
      paths += `<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" fill="#fff" font-size="26" font-weight="800" text-anchor="middle" dominant-baseline="middle" transform="rotate(${(-st.turn).toFixed(1)} ${tx.toFixed(1)} ${ty.toFixed(1)})">${R.esc(it.label || it.id)}</text>`;
    });
    const picked = idx >= 0 ? items[idx] : null;
    const done = (agg.history || []).length;
    return `<div class="wheel-wrap"><div class="wheel"><div class="pointer"></div>
      <svg viewBox="0 0 220 220" style="transform:rotate(${st.prev}deg)" data-turn="${st.turn}"><circle cx="110" cy="110" r="104" fill="#1F2A33"/>${paths}<circle cx="110" cy="110" r="14" fill="#fff"/></svg></div>
      <div class="picked">${picked ? `<div class="tag" style="font-size:1.2cqw">Exception ${R.esc(picked.label || picked.id)} · spin ${done}</div><h2>${R.esc(picked.name)}</h2><p>${R.esc(picked.line)}</p>`
      : `<h2>Five exceptions</h2><p>${items.map(i => R.esc((i.label || i.id) + ' · ' + i.name)).join('<br>')}</p>`}</div></div>`;
  }

  // after a wheel is drawn at its old angle, turn it to the new one so the spin animates
  R.afterRender = function (root) {
    (root || document).querySelectorAll('.wheel svg[data-turn]').forEach(svg => {
      const to = svg.getAttribute('data-turn');
      requestAnimationFrame(() => requestAnimationFrame(() => { svg.style.transform = `rotate(${to}deg)`; }));
    });
    // keep the old angle in the markup until the spin has finished, so a repaint does not cut it short
    clearTimeout(R._wheelT); R._wheelT = setTimeout(() => Object.keys(wheelTurn).forEach(k => { wheelTurn[k].prev = wheelTurn[k].turn; }), 4300);
  };

  window.R = R;
})();
