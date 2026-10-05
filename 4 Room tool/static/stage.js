/* Room screen: a join code when nothing is open, the live results of whatever is. Press F for full screen. */
(function () {
  'use strict';
  const R = window.R, esc = R.esc, $ = R.$;
  let CFG = null, ST = null, lastHtml = '';
  const sessTitle = id => { const s = CFG.sessions.find(x => x.id === id); return s ? s.title : ''; };

  function splash() {
    const url = CFG.join_url + '/';
    return `<div class="splash"><div class="qr">${R.qrSvg(url)}</div><div>
      <h1>Join on your phone</h1><div class="url">${esc(url.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</div>
      <ol><li>Point your phone camera at the code.</li><li>Type your name and choose a four-digit PIN.</li><li>Keep the page open. Questions appear when it is time.</li></ol>
      <div class="people">${ST.people_n} ${ST.people_n === 1 ? 'person has' : 'people have'} joined</div></div></div>`;
  }

  function paint() {
    if (!ST || !CFG) return;
    const cur = ST.current, cfg = cur && CFG.activities[cur];
    let html, eyebrow = '', title = '';
    if (!cfg) { html = splash(); eyebrow = CFG.dates; title = CFG.title; }
    else {
      eyebrow = [sessTitle(cfg.session), cfg.title].filter(Boolean).join(' · ');
      title = cfg.type === 'game' ? cfg.title : cfg.type === 'parking' ? 'Questions from the room' : (cfg.q || cfg.title);
      html = R.results(cfg, ST.agg, { settings: ST.settings, people_n: ST.people_n, acts: CFG.activities });
    }
    $('#eyebrow').textContent = eyebrow; $('#title').textContent = title;
    if (html !== lastHtml) { $('#main').innerHTML = html; lastHtml = html; R.afterRender($('#main')); }
    const showMini = cfg && ST.settings.show_join;
    $('#joinMini').innerHTML = showMini ? R.qrSvg(CFG.join_url + '/') + `<span>${esc(CFG.join_url.replace(/^https?:\/\//, ''))}</span>` : '';
    const a = ST.agg;
    $('#count').textContent = cfg && a && a.n != null && !['wheel', 'claim'].includes(cfg.type) ? `${a.n} ${a.n === 1 ? 'answer' : 'answers'} · ${ST.people_n} in the room` : (cfg ? `${ST.people_n} in the room` : '');
    const p = ST.pulse_summary;
    $('#pulse').innerHTML = p ? `<div class="pulse-mini"><span>Clear <b>${p.clarity.Clear}</b></span><span>Unsure <b>${p.clarity.Unsure}</b></span><span>Lost <b>${p.clarity.Lost}</b></span><span>·</span><span>Too slow <b>${p.pace['Too slow']}</b></span><span>Too fast <b>${p.pace['Too fast']}</b></span></div>` : '';
  }
  function tick() {
    const left = ST && R.timerLeft(ST.timer), el = $('#timer');
    // a finished timer shows "Time" for ten seconds, then disappears
    const over = ST && ST.timer ? (Date.now() / 1000 + (R.clockOffset || 0)) - ST.timer.end : -1;
    if (left == null || over > 10) { el.innerHTML = ''; return; }
    if (left === 0) { el.innerHTML = '<div class="timer low">Time</div>'; return; }
    el.innerHTML = `<div class="timer${left <= 30 ? ' low' : ''}">${R.fmt(left)}</div>`;
  }
  document.addEventListener('keydown', ev => { if (ev.key === 'f' || ev.key === 'F') { const d = document.documentElement; (document.fullscreenElement ? document.exitFullscreen() : d.requestFullscreen()).catch(() => {}); } });

  (async function boot() {
    while (!CFG) { try { CFG = await R.get('/api/config'); } catch (e) { await R.sleep(2000); } }
    R.live(() => ({ view: 'stage' }), st => { ST = st; paint(); tick(); }, ok => { document.body.style.outline = ok ? '' : '6px solid #FF462D'; });
    setInterval(tick, 250);
  })();
})();
