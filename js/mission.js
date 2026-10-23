/*
 * mission.js
 * "Click a place": one target from request to delivered picture, with every
 * step the AI takes shown on screen.
 *
 *   1. Target      lock the spot, name it
 *   2. Weather     live hourly cloud forecast for that exact spot
 *   3. Routes      propagate every satellite's orbit for 48 h, find every overflight,
 *                  draw each pass's ground track on the globe
 *   4. Filter      tilt limit -> daylight -> neural-net cloud check -> conflicts with
 *                  the fleet plan -> fuzzy priority; the best passes become shots
 *   5. Capture     fly each chosen pass and take the picture
 *   6. Check       fuzzy cloud mask on every picture, pixel by pixel; keep the usable
 *                  ones, downlink the best through the next ground-station contact
 */
(function () {
  'use strict';

  const D = window.Drishti, L = window.Live;
  const HOUR = 3600000, MIN = 60000;
  const CANCEL = new Error('cancelled');
  const M = { token: 0, speed: 1, req: null, running: false };
  let A = null;   // app context, set by app.js
  const $ = (id) => document.getElementById(id);

  const wait = (ms) => new Promise((res, rej) => {
    const tk = M.token;
    setTimeout(() => (tk === M.token ? res() : rej(CANCEL)), ms * M.speed);
  });
  const alive = (tk) => { if (tk !== M.token) throw CANCEL; };
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const pct = (v) => Math.round(v * 100) + '%';
  const short = (sat) => sat.name.replace(' (radar)', '');
  const tiny = (sat) => ({ carto3: 'Carto-3', rs2a: 'RS-2A', eos4: 'EOS-04' })[sat.id] || short(sat);
  const WD = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short' });
  const when = (ms) => `${WD.format(new Date(ms))} ${A.fmtIST(ms)}`;

  // ------------------------------------------------------------------
  // Naming the clicked spot: nearest city, or the sea it is in
  // ------------------------------------------------------------------
  const CITIES = [
    ['Delhi', 28.61, 77.21], ['Mumbai', 19.08, 72.88], ['Kolkata', 22.57, 88.36], ['Chennai', 13.08, 80.27],
    ['Bengaluru', 12.97, 77.59], ['Hyderabad', 17.39, 78.49], ['Ahmedabad', 23.02, 72.57], ['Pune', 18.52, 73.86],
    ['Jaipur', 26.91, 75.79], ['Lucknow', 26.85, 80.95], ['Patna', 25.59, 85.14], ['Bhopal', 23.26, 77.41],
    ['Nagpur', 21.15, 79.09], ['Indore', 22.72, 75.86], ['Bhubaneswar', 20.30, 85.82], ['Guwahati', 26.14, 91.74],
    ['Shillong', 25.58, 91.89], ['Imphal', 24.82, 93.94], ['Srinagar', 34.08, 74.80], ['Leh', 34.15, 77.58],
    ['Shimla', 31.10, 77.17], ['Dehradun', 30.32, 78.03], ['Chandigarh', 30.73, 76.78], ['Amritsar', 31.63, 74.87],
    ['Jodhpur', 26.24, 73.02], ['Jaisalmer', 26.92, 70.91], ['Bhuj', 23.24, 69.67], ['Surat', 21.17, 72.83],
    ['Panaji', 15.50, 73.83], ['Mangaluru', 12.91, 74.86], ['Kochi', 9.93, 76.27], ['Thiruvananthapuram', 8.52, 76.94],
    ['Madurai', 9.93, 78.12], ['Puducherry', 11.94, 79.81], ['Visakhapatnam', 17.69, 83.22], ['Vijayawada', 16.51, 80.65],
    ['Raipur', 21.25, 81.63], ['Ranchi', 23.34, 85.31], ['Varanasi', 25.32, 82.97], ['Kanpur', 26.45, 80.33],
    ['Agra', 27.18, 78.01], ['Gwalior', 26.22, 78.18], ['Siliguri', 26.73, 88.40], ['Gangtok', 27.33, 88.61],
    ['Itanagar', 27.08, 93.61], ['Agartala', 23.83, 91.29], ['Aizawl', 23.73, 92.72], ['Port Blair', 11.62, 92.73],
    ['Kavaratti', 10.57, 72.64], ['Kathmandu', 27.72, 85.32], ['Dhaka', 23.81, 90.41], ['Colombo', 6.93, 79.86],
    ['Karachi', 24.86, 67.01], ['Lahore', 31.55, 74.34], ['Thimphu', 27.47, 89.64], ['Udaipur', 24.59, 73.71],
    ['Kota', 25.18, 75.83], ['Jabalpur', 23.18, 79.99], ['Aurangabad', 19.88, 75.34], ['Hubballi', 15.36, 75.12],
    ['Tirupati', 13.63, 79.42], ['Coimbatore', 11.02, 76.96], ['Gorakhpur', 26.76, 83.37], ['Dibrugarh', 27.47, 94.91],
  ];
  function distKm(a, b, c, d) {
    const r = D.D2R, x = Math.sin((c - a) * r / 2), y = Math.sin((d - b) * r / 2);
    return 2 * 6371 * Math.asin(Math.sqrt(x * x + Math.cos(a * r) * Math.cos(c * r) * y * y));
  }
  function compass(fromLat, fromLon, lat, lon) {
    const ang = Math.atan2(lat - fromLat, (lon - fromLon) * Math.cos(fromLat * D.D2R)) * D.R2D;
    return ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east'][((Math.round(ang / 45) % 8) + 8) % 8];
  }
  function onLand(lat, lon) {
    const land = (window.GEO && window.GEO.land) || [];
    let inside = false;
    for (const ring of land) {
      let hit = false;
      for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
        const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
        if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
      }
      if (hit) inside = !inside;
    }
    return inside;
  }
  function placeName(lat, lon) {
    let best = null, bd = Infinity;
    for (const [n, la, lo] of CITIES) { const d = distKm(lat, lon, la, lo); if (d < bd) { bd = d; best = [n, la, lo]; } }
    const land = onLand(lat, lon);
    if (!land) {
      const sea = lat < 7 ? 'Indian Ocean' : lon < 77.5 ? 'Arabian Sea' : 'Bay of Bengal';
      return { name: bd < 250 ? `${sea}, off ${best[0]}` : sea, sea: true };
    }
    if (bd < 25) return { name: best[0], sea: false };
    return { name: `${Math.round(bd / 5) * 5} km ${compass(best[1], best[2], lat, lon)} of ${best[0]}`, sea: false };
  }

  // ------------------------------------------------------------------
  // Weather at the spot: live point forecast, else the app's weather grid
  // ------------------------------------------------------------------
  async function pointWeather(lat, lon) {
    const S = A.S, pt = [{ lat, lon }];
    if (S.weather.kind === 'live') {
      try {
        if (S.day === 'today') return { fc: (await L.fetchForecast(pt))[0], act: null, live: true };
        const a = S.startMs - 6 * HOUR, b = S.startMs + 54 * HOUR;
        const [f, x] = await Promise.all([L.fetchPastForecast(pt, a, b), L.fetchActual(pt, a, b)]);
        return { fc: f[0], act: x[0], live: true };
      } catch (e) { /* use the grid */ }
    }
    return { fc: null, act: null, live: false };
  }
  const fcAt = (W, lat, lon, ms) => (W.fc && L.sample(W.fc, ms)) || A.S.weather.gridAt(A.S.weather.grid, lat, lon, ms);
  const actAt = (W, lat, lon, ms) => (W.act && L.sample(W.act, ms)) || (A.S.weather.gridAct ? A.S.weather.gridAt(A.S.weather.gridAct, lat, lon, ms) : null);

  // ------------------------------------------------------------------
  // Fuzzy cloud mask: every pixel is judged by three small rules
  //   IF brightness is high AND colour is grey THEN cloud
  //   IF brightness is medium AND colour is grey THEN thin cloud (half weight)
  //   IF colour is vivid OR tint is blue-white (snow, water glint) THEN not cloud
  // Snow and white sand look exactly like cloud in visible light, so a fourth
  // rule compares with a clear-day reference picture of the same spot:
  //   IF it is cloud-like now AND it was NOT cloud-like on a clear day THEN cloud
  // A pixel counts as cloud when its membership is above 0.5 (alpha cut).
  // ------------------------------------------------------------------
  const ramp = (x, a, b) => (x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a));
  function cloudness(r, g, b) {
    const br = (r + g + b) / 765, mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = mx > 0 ? (mx - mn) / mx : 0;
    const bright = ramp(br, 0.66, 0.86), medium = Math.min(ramp(br, 0.45, 0.62), 1 - ramp(br, 0.7, 0.86));
    const grey = 1 - ramp(sat, 0.09, 0.26), vivid = ramp(sat, 0.22, 0.4), blue = ramp((b - r) / 255, 0.05, 0.1);
    const cloud = Math.max(Math.min(bright, grey), 0.5 * Math.min(medium, grey));
    return Math.min(cloud, 1 - vivid, 1 - blue);
  }

  // ------------------------------------------------------------------
  // Small UI builders
  // ------------------------------------------------------------------
  function scrollDown() { const b = $('mBody'); b.scrollTo({ top: b.scrollHeight, behavior: M.speed < 1 ? 'auto' : 'smooth' }); }
  function stage(n, title, sub) {
    const el = document.createElement('section');
    el.className = 'mstage run';
    el.innerHTML = `<header><span class="num">${n}</span><div class="ttl"><h4>${title}</h4><small>${sub || ''}</small></div><span class="state" aria-hidden="true"></span></header><div class="mbody"></div>`;
    $('mBody').appendChild(el);
    $('mSteps').querySelectorAll('li').forEach((li, i) => li.className = i + 1 < n ? 'ok' : i + 1 === n ? 'run' : '');
    scrollDown();
    return {
      el, body: el.querySelector('.mbody'),
      note(t) { el.querySelector('small').textContent = t; },
      done(t, bad) { el.classList.remove('run'); el.classList.add(bad ? 'bad' : 'ok'); if (t) el.querySelector('small').textContent = t; },
    };
  }
  function line(parent, html, cls) {
    const p = document.createElement('div');
    p.className = 'mline ' + (cls || '');
    p.innerHTML = html;
    parent.appendChild(p);
    scrollDown();
    return p;
  }

  // 48-hour cloud forecast for the spot, with night shading and pass marks.
  function drawCloudChart(c, W, req, passes) {
    const S = A.S;
    const dpr = Math.min(window.devicePixelRatio || 1, 2), w = c.clientWidth || 360, h = c.clientHeight || 86;
    c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const X = (ms) => 4 + ((ms - S.startMs) / (48 * HOUR)) * (w - 8), Y = (v) => h - 16 - (v / 100) * (h - 26);
    let ns = null;
    g.fillStyle = 'rgba(0,0,0,0.35)';
    for (let m = 0; m <= 48 * 60; m += 15) {
      const ms = S.startMs + m * MIN, night = D.sunElevation(req.lat, req.lon, new Date(ms)) < 0;
      if (night && ns === null) ns = ms;
      if ((!night || m === 48 * 60) && ns !== null) { g.fillRect(X(ns), 0, X(ms) - X(ns), h - 14); ns = null; }
    }
    g.beginPath();
    for (let k = 0; k <= 48; k++) { const v = fcAt(W, req.lat, req.lon, S.startMs + k * HOUR); const y = Y(v ? v.total : 50); k ? g.lineTo(X(S.startMs + k * HOUR), y) : g.moveTo(X(S.startMs), y); }
    g.lineTo(X(S.startMs + 48 * HOUR), h - 16); g.lineTo(X(S.startMs), h - 16); g.closePath();
    const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, 'rgba(220,230,255,0.55)'); gr.addColorStop(1, 'rgba(220,230,255,0.08)');
    g.fillStyle = gr; g.fill();
    g.strokeStyle = 'rgba(92,200,255,0.5)'; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(4, Y(D.CLEAR_LIMIT)); g.lineTo(w - 4, Y(D.CLEAR_LIMIT)); g.stroke(); g.setLineDash([]);
    g.font = '500 10px "JetBrains Mono", monospace'; g.fillStyle = '#98a2c8'; g.textAlign = 'left';
    g.fillText('cloud %', 6, 11); g.textAlign = 'right'; g.fillText(`clear below ${D.CLEAR_LIMIT}%`, w - 6, Y(D.CLEAR_LIMIT) - 3);
    g.textAlign = 'center';
    for (let k = 0; k <= 48; k += 12) g.fillText(A.fmtIST(S.startMs + k * HOUR), Math.min(w - 18, Math.max(18, X(S.startMs + k * HOUR))), h - 3);
    for (const o of passes || []) {
      const x = X(o.t), col = o.state === 'out' ? 'rgba(255,93,115,0.55)' : o.state === 'shot' ? '#ffffff' : A.SAT_BY_ID[o.sat].colour;
      g.fillStyle = col;
      g.beginPath(); g.moveTo(x, h - 22); g.lineTo(x + 4, h - 16); g.lineTo(x, h - 10); g.lineTo(x - 4, h - 16); g.closePath(); g.fill();
      if (o.state === 'shot') { g.strokeStyle = '#ff9f43'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, 4); g.lineTo(x, h - 22); g.stroke(); }
    }
  }

  // Animate simulated time so the satellites visibly fly along their orbits.
  function animateSim(from, to, dur) {
    const S = A.S, tk = M.token;
    return new Promise((res, rej) => {
      const t0 = performance.now(), len = Math.max(1, dur * M.speed);
      const tick = (now) => {
        if (tk !== M.token) { rej(CANCEL); return; }
        const k = Math.min(1, (now - t0) / len), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        S.simMs = from + (to - from) * e;
        S.globe.updateSatellites(S.simMs);
        S.globe.setSun(new Date(S.simMs));
        A.updateClouds();
        A.drawTimeline();
        if (k < 1) requestAnimationFrame(tick); else res();
      };
      requestAnimationFrame(tick);
    });
  }

  // The picture a pass would take. Past days: the clouds that really were there
  // (and NASA's real image of the spot that day when it can be loaded).
  // Next 48 h: drawn from the forecast cloud cover, clearly labelled as such.
  function loadReal(req, o) {
    return new Promise((res) => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      const timer = setTimeout(() => res(null), 6000);
      im.onload = () => {
        clearTimeout(timer);
        try {
          const c = document.createElement('canvas'); c.width = c.height = 192;
          const g = c.getContext('2d'); g.drawImage(im, 0, 0, 192, 192);
          g.getImageData(0, 0, 1, 1);    // throws if the image is not readable
          const px = g.getImageData(0, 0, 192, 192).data;
          let s = 0; for (let i = 0; i < px.length; i += 4) s += px[i] + px[i + 1] + px[i + 2];
          if (s / (px.length / 4) < 30) { res(null); return; }      // blank tile (no data that day)
          g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(0, 176, 192, 16);
          g.fillStyle = '#fff'; g.font = '600 8px "JetBrains Mono", monospace';
          g.fillText(`NASA MODIS · ${A.fmtIST(o.t, true).toUpperCase()}`, 5, 187, 182);
          res(c);
        } catch (e) { res(null); }
      };
      im.onerror = () => { clearTimeout(timer); res(null); };
      im.src = L.gibsUrl(req.lat, req.lon, o.t, 45, true);
    });
  }
  async function takePicture(o, req, W) {
    const S = A.S, sat = A.SAT_BY_ID[o.sat], sar = sat.sensor === 'sar', dark = !sar && o.sunEl < 10;
    let cloud = (o.fcTotal === undefined || o.fcTotal === null ? 50 : o.fcTotal) / 100, source = 'drawn from the forecast cloud cover';
    if (S.day === 'past') {
      const a = actAt(W, req.lat, req.lon, o.t);
      if (a) { cloud = a.total / 100; source = S.weather.kind === 'live' ? 'drawn from the cloud that was really there (ERA5)' : "drawn from the built-in model's actual cloud"; }
      if (!sar && !dark && W.live) {
        const real = await loadReal(req, o);
        if (real) return { canvas: real, sar, dark, cloud, source: 'real NASA MODIS image of this spot that morning', real: true };
      }
    }
    const c = A.paintPhoto(req, dark ? 0 : cloud, sar, o);
    if (dark) { const g = c.getContext('2d'); g.fillStyle = 'rgba(0,0,10,0.88)'; g.fillRect(0, 0, 192, 176); }
    // clear-day reference of the same spot (a cloud-free composite, as real systems keep)
    const ref = sar || dark ? null : A.paintPhoto(req, 0, false, null).getContext('2d').getImageData(0, 0, 192, 192).data;
    return { canvas: c, sar, dark, cloud, ref, source: sar ? 'radar image' : source, real: false };
  }

  // Scan a picture with the fuzzy cloud mask, painting the mask as it goes.
  async function scanPicture(fig, pic) {
    const src = pic.canvas, W = src.width, H = src.height, ref = pic.ref;
    const px = src.getContext('2d').getImageData(0, 0, W, H).data;
    const ov = document.createElement('canvas'); ov.width = W; ov.height = H; ov.className = 'mask';
    fig.querySelector('.frame').appendChild(ov);
    const bar = document.createElement('i'); bar.className = 'scan';
    fig.querySelector('.frame').appendChild(bar);
    const out = fig.querySelector('.res');
    const og = ov.getContext('2d'), img = og.createImageData(W, H), d = img.data;
    const rowsH = H - 16;   // skip the metadata stamp
    let cloudPx = 0, seen = 0;
    const per = Math.max(2, Math.round(5 / M.speed));
    const tk = M.token;
    for (let y = 0; y < rowsH; y += per) {
      for (let yy = y; yy < Math.min(rowsH, y + per); yy++) {
        for (let x = 0; x < W; x++) {
          const i = (yy * W + x) * 4;
          let m = cloudness(px[i], px[i + 1], px[i + 2]);
          if (ref && m > 0) m = Math.min(m, 1 - cloudness(ref[i], ref[i + 1], ref[i + 2]));
          seen++;
          if (m > 0.5) { cloudPx++; d[i] = 92; d[i + 1] = 200; d[i + 2] = 255; d[i + 3] = 60 + m * 140; }
          else if (m > 0.2) { d[i] = 92; d[i + 1] = 200; d[i + 2] = 255; d[i + 3] = m * 70; }
        }
      }
      og.putImageData(img, 0, 0);
      bar.style.top = ((y + per) / H) * 100 + '%';
      out.textContent = `scanning… cloud ${Math.round((cloudPx / seen) * 100)}%`;
      await frame();
      if (tk !== M.token) throw CANCEL;
    }
    bar.remove();
    return cloudPx / Math.max(1, seen);
  }

  // ------------------------------------------------------------------
  // The run
  // ------------------------------------------------------------------
  async function start(lat, lon, preset) {
    A = window.DrishtiApp;
    if (!A || !A.S.access) return;
    const tk = ++M.token;
    M.running = true;
    $('mission').classList.add('busy');
    try { await run(lat, lon, preset, tk); }
    catch (e) { if (e !== CANCEL) { console.error(e); A.toast('The mission run stopped: ' + e.message, 'bad'); } }
    finally { if (tk === M.token) { M.running = false; $('mission').classList.remove('busy'); } }
  }

  async function run(lat, lon, preset, tk) {
    const S = A.S, SAT = A.SAT_BY_ID;
    if (S.flying) A.stopFly();
    $('mIntro').hidden = true;
    $('mBody').querySelectorAll('.mstage').forEach((x) => x.remove());
    $('mAdd').disabled = true;
    S.globe.clearTracks();
    S.globe.setDownlinks([]);
    S.globe.follow = null;
    // every mission starts from "now": the start of the planning window
    S.simMs = S.startMs;
    S.globe.updateSatellites(S.simMs);
    S.globe.setSun(new Date(S.simMs));
    A.updateClouds(true);
    A.drawTimeline();
    const named = preset ? { name: preset.name, sea: false } : placeName(lat, lon);
    let type = preset ? preset.type : $('mType').value;
    // at sea, land targets make no sense: look for storms and ships' wakes instead
    if (!preset && named.sea && ['crop', 'urban', 'forest', 'glacier', 'landslide', 'wildfire'].includes(type)) type = 'cyclone';
    const urgency = preset ? preset.urgency : +$('mUrg').value / 100;
    const req = D.makeRequest({ id: 'mission-' + tk, name: named.name, lat, lon, type, urgency, waitDays: preset ? preset.waitDays : 0, source: 'user', detail: 'Clicked on the globe' });
    M.req = req;
    $('mTitle').textContent = named.name;
    S.globe.setTarget(lat, lon);
    S.globe.flyTo(lat, lon, 2.5, 1400);
    const askedAt = S.simMs;

    // 1. Target ---------------------------------------------------------
    const s1 = stage(1, 'Target locked', named.name);
    s1.body.innerHTML = `<div class="kv"><span>Where</span><b>${lat.toFixed(3)}°N, ${lon.toFixed(3)}°E${named.sea ? ' · at sea' : ''}</b>
      <span>Looking for</span><b>${A.ICONS[type] || '📍'} ${$('mType').querySelector(`option[value="${type}"]`) ? $('mType').querySelector(`option[value="${type}"]`).textContent : type}</b>
      <span>Urgency</span><b>${pct(urgency)}</b>
      <span>Asked at</span><b>${A.fmtIST(askedAt, true)} IST</b></div>`;
    await wait(500);
    s1.done();

    // 2. Weather ----------------------------------------------------------
    const s2 = stage(2, 'Cloud forecast for this spot', 'asking Open-Meteo…');
    const W = await pointWeather(lat, lon);
    alive(tk);
    s2.body.innerHTML = '<canvas class="mchart"></canvas>';
    const chart = s2.body.querySelector('canvas');
    drawCloudChart(chart, W, req, []);
    let clearHours = 0, dayHours = 0;
    for (let k = 0; k < 48; k++) {
      const ms = S.startMs + k * HOUR;
      if (D.sunElevation(lat, lon, new Date(ms)) < 10) continue;
      dayHours++;
      const v = fcAt(W, lat, lon, ms); if (v && v.total < D.CLEAR_LIMIT) clearHours++;
    }
    line(s2.body, `Daylight hours forecast clear: <b>${clearHours} of ${dayHours}</b>. Dark bands are night here; optical cameras need sunlight.`);
    s2.done(W.live ? (S.day === 'past' ? 'Open-Meteo: forecast made that day, plus what really happened' : 'Open-Meteo live hourly forecast, this exact spot') : 'built-in weather model (live data unreachable)');
    await wait(700);

    // 3. Route planning ---------------------------------------------------
    const s3 = stage(3, 'Route planning: where will the satellites be?', 'propagating orbits, 48 h, every 20 s');
    const list = document.createElement('div'); list.className = 'passes';
    const funnelHost = document.createElement('div');
    s3.body.appendChild(funnelHost);
    s3.body.appendChild(list);
    const passes = [], contacts = [];
    for (const f of S.fleet) {
      const wide = { sat: Object.assign({}, f.sat, { maxRollDeg: 55 }), orbit: f.orbit };
      const status = line(funnelHost, `<i class="dot" style="background:${f.sat.colour}"></i>${short(f.sat)}: computing orbit…`, 'sat');
      await frame(); await frame();
      const acc = D.computeAccess([wide], [req], S.startMs, 48, 20);
      alive(tk);
      contacts.push(...acc.contacts);
      for (const o of acc.opps) {
        o.limit = f.sat.maxRollDeg;
        const pts = [];
        for (let m = -7; m <= 7; m += 0.5) { const g = D.ecefToGeo(f.orbit.at(new Date(o.t + m * MIN)).ecef); pts.push([g.lat, g.lon]); }
        S.globe.addTrack({ id: o.id, pts, colour: f.sat.colour });
        o.state = 'kept';
        passes.push(o);
      }
      status.innerHTML = `<i class="dot" style="background:${f.sat.colour}"></i>${short(f.sat)} · ${f.orbit.live ? 'live orbit (SGP4)' : 'approximate orbit'} · <b>${acc.opps.length} overflights</b>`;
      await wait(450);
    }
    passes.sort((a, b) => a.t - b.t);
    const rows = {};
    for (const o of passes) {
      const sat = SAT[o.sat];
      const el = document.createElement('div');
      el.className = 'pass';
      el.innerHTML = `<i class="dot" style="background:${sat.colour}"></i><span class="who">${tiny(sat)}</span>
        <span class="when">${when(o.t)}</span><span class="tilt" title="how far the satellite has to tilt">${o.off.toFixed(0)}°</span>
        <span class="sun" title="sun height at the target">${o.sunEl < 0 ? '☾' : '☀'}</span><span class="why"></span>`;
      list.appendChild(el);
      rows[o.id] = el;
    }
    drawCloudChart(chart, W, req, passes);
    s3.done(`${passes.length} overflights in 48 h, ground tracks drawn on the globe`);
    if (!passes.length) { line(s3.body, 'No satellite comes within range of this spot in the next 48 hours.', 'bad'); return; }
    await wait(800);

    // 4. Filtering ----------------------------------------------------------
    const s4 = stage(4, 'Filtering the passes', 'every pass has to survive five checks');
    s4.body.appendChild(list);   // the same list moves down into the filter stage
    const funnel = document.createElement('div'); funnel.className = 'funnel';
    s4.body.insertBefore(funnel, list);
    const steps = [
      ['Overflights', 'every time a satellite comes within range'],
      ['Tilt limit', 'can the camera lean that far?'],
      ['Daylight', 'optical cameras need the sun; radar does not'],
      ['Clouds · neural net', 'chance of a clear view at that exact minute'],
      ['Fuzzy priority', 'is the picture worth taking?'],
      ['Free satellite', 'not busy with a more valuable target'],
      ['Shots', 'best pass of each satellite'],
    ];
    funnel.innerHTML = steps.map(([t, s], i) => `<div class="fstep" data-i="${i}"><span class="fl">${t}<small>${s}</small></span><span class="fb"><i></i></span><b>–</b></div>`).join('');
    const total = passes.length;
    const setCount = (i, n) => {
      const el = funnel.querySelector(`[data-i="${i}"]`);
      el.querySelector('b').textContent = n;
      el.querySelector('i').style.width = (n / total) * 100 + '%';
    };
    const focus = (i) => funnel.querySelectorAll('.fstep').forEach((el) => el.classList.toggle('on', +el.dataset.i === i));
    const reject = async (o, why) => {
      o.state = 'out';
      rows[o.id].classList.add('out');
      rows[o.id].querySelector('.why').innerHTML = `<em class="x">${why}</em>`;
      rows[o.id].scrollIntoView({ block: 'nearest' });
      S.globe.setTrackState(o.id, 'out');
      await wait(115);
    };
    const tag = async (o, html, cls) => {
      rows[o.id].querySelector('.why').innerHTML = `<em class="${cls || 'k'}">${html}</em>`;
      rows[o.id].scrollIntoView({ block: 'nearest' });
      await wait(55);
    };
    const live = () => passes.filter((o) => o.state !== 'out');
    focus(0); setCount(0, total); await wait(500);

    // a. tilt
    focus(1);
    for (const o of live()) { if (o.off > o.limit) await reject(o, `too steep ${o.off.toFixed(0)}° > ${o.limit}°`); else await tag(o, `tilt ok`); }
    setCount(1, live().length); await wait(400);
    // b. daylight
    focus(2);
    for (const o of live()) {
      const sar = SAT[o.sat].sensor === 'sar';
      if (!sar && o.sunEl < 10) await reject(o, o.sunEl < 0 ? 'night' : `sun too low (${o.sunEl.toFixed(0)}°)`);
      else await tag(o, sar ? 'radar works day or night' : `sun ${o.sunEl.toFixed(0)}° up`);
    }
    setCount(2, live().length); await wait(400);
    // c. clouds via the neural network
    focus(3);
    for (const o of live()) {
      const sar = SAT[o.sat].sensor === 'sar';
      if (sar) { o.pClear = 0.97; o.p0 = 0.97; await tag(o, 'radar sees through cloud'); continue; }
      const fc = fcAt(W, lat, lon, o.t);
      o.fcTotal = fc ? fc.total : 50;
      o.pClear = o.p0 = fc ? S.cloudNet.predict(fc, lat, lon, new Date(o.t)) : 0.4;
      if (o.pClear < 0.35) await reject(o, `forecast ${Math.round(o.fcTotal)}% cloud → ${pct(o.pClear)} clear`);
      else if (o.pClear < 0.5) await tag(o, `forecast ${Math.round(o.fcTotal)}% cloud → <b>${pct(o.pClear)} clear</b> · risky`, 'k warn');
      else await tag(o, `forecast ${Math.round(o.fcTotal)}% cloud → <b>${pct(o.pClear)} clear</b>`, 'k good');
    }
    setCount(3, live().length); drawCloudChart(chart, W, req, passes); await wait(400);
    // d. fuzzy value: is the picture worth taking?
    focus(4);
    for (const o of live()) {
      o.value = D.fuzzyEval(S.fz, D.fuzzyInputs(o, req, SAT));
      if (o.value < 15) await reject(o, `value ${Math.round(o.value)}: not worth a shot`);
      else await tag(o, `value <b>${Math.round(o.value)}</b><span class="vb"><span style="width:${o.value}%"></span></span>`, 'k');
    }
    setCount(4, live().length); await wait(400);
    // e. conflicts with the fleet plan: a more valuable shot bumps a less valuable one
    focus(5);
    const plan = S.plans[S.shown] || S.plans.greedy || [];
    for (const o of live()) {
      const sat = SAT[o.sat];
      let clash = null;
      for (const p of plan) {
        if (p.sat !== o.sat) continue;
        const need = 8000 + (Math.abs(p.roll - o.roll) / sat.slewDegPerS + sat.settleS) * 1000;
        if (Math.abs(p.t - o.t) < need) { clash = p; break; }
      }
      const nm = clash && S.reqById[clash.req] ? S.reqById[clash.req].name : 'another target';
      if (!clash) await tag(o, `free · value <b>${Math.round(o.value)}</b>`, 'k');
      else if (o.value > clash.v0 + 5) { o.bumps = nm; await tag(o, `bumps ${nm} (value ${Math.round(clash.v0)})`, 'k good'); }
      else await reject(o, `busy: ${nm} is worth more`);
    }
    setCount(5, live().length); await wait(400);
    // f. the best ones become shots
    focus(6);
    const ok = live();
    const ranked = ok.slice().sort((a, b) => b.value - a.value);
    // one shot per satellite: three different looks (sharp optical, wide optical, radar)
    const shots = [];
    for (const o of ranked) if (!shots.some((x) => x.sat === o.sat)) shots.push(o);
    shots.sort((a, b) => a.t - b.t);
    for (const o of ok) {
      if (shots.includes(o)) { o.state = 'shot'; rows[o.id].classList.add('shot'); S.globe.setTrackState(o.id, 'chosen'); }
      else { o.state = 'spare'; rows[o.id].classList.add('spare'); S.globe.setTrackState(o.id, 'spare'); await tag(o, `backup · value ${Math.round(o.value)}`, 'k'); }
    }
    shots.forEach((o, i) => { rows[o.id].querySelector('.why').insertAdjacentHTML('afterbegin', `<em class="star">★ shot ${i + 1}</em>`); });
    setCount(6, shots.length);
    drawCloudChart(chart, W, req, passes);
    focus(-1);
    if (!shots.length) {
      s4.done('no pass survived', true);
      line(s4.body, 'Nothing usable in the next 48 hours: every pass is too steep, in the dark, likely cloudy, or the satellite is busy with something more valuable. Raise the urgency, or try the past-day replay.', 'bad');
      $('mAdd').disabled = false;
      return;
    }
    // why the best one won
    const best = ranked[0], x = D.fuzzyInputs(best, req, SAT), ex = D.fuzzyEval(S.fz, x, true);
    const words = (r) => 'IF ' + r.if.map(([v, s]) => `${S.fz.inputs[v].label.toLowerCase()} is ${s}`).join(' AND ') + ` THEN ${r.then}`;
    const top = ex.fired.slice().sort((a, b) => b.w - a.w).slice(0, 2);
    const why = document.createElement('div'); why.className = 'whybox';
    why.innerHTML = `<h5>Why ${short(SAT[best.sat])} at ${A.fmtIST(best.t)} ranks first · fuzzy value ${Math.round(ex.value)}</h5>
      ${[['Urgency', x.urgency], ['Clear-sky chance', x.clear], ['Look angle quality', x.quality], ['Sensor fit', x.fit]].map(([k, v]) => `<div class="in"><span>${k}</span><span class="vb"><span style="width:${v * 100}%"></span></span><b>${pct(v)}</b></div>`).join('')}
      ${top.map((f) => `<div class="rule"><b>${f.w.toFixed(2)}</b> ${words(S.fz.rules[f.k])}</div>`).join('')}`;
    s4.body.appendChild(why);
    s4.done(`${total} overflights → ${shots.length} shot${shots.length > 1 ? 's' : ''} planned`);
    await wait(1200);

    // 5. Capture --------------------------------------------------------------
    const s5 = stage(5, 'Taking the pictures', `${shots.length} pass${shots.length > 1 ? 'es' : ''}, in time order`);
    const strip = document.createElement('div'); strip.className = 'film';
    s5.body.appendChild(strip);
    const figs = shots.map((o, i) => {
      const sat = SAT[o.sat];
      const fig = document.createElement('figure');
      fig.className = 'shotf wait';
      fig.innerHTML = `<div class="frame"><span class="ph">${A.fmtIST(o.t)}<br>waiting</span></div>
        <figcaption><b>${i + 1}. ${tiny(sat)}</b><span>${when(o.t)} · tilt ${o.off.toFixed(0)}°</span><span class="res"></span></figcaption>`;
      strip.appendChild(fig);
      return fig;
    });
    scrollDown();
    const pics = [];
    for (let i = 0; i < shots.length; i++) {
      const o = shots[i], sat = SAT[o.sat], fig = figs[i];
      fig.classList.remove('wait'); fig.classList.add('live');
      s5.note(`${short(sat)} approaching… shot ${i + 1} of ${shots.length}`);
      S.globe.followSat(o.sat);
      S.simMs = Math.max(S.startMs, o.t - 6 * MIN);
      await animateSim(S.simMs, o.t, 2600);
      S.globe.shoot(o.sat, req, true);
      fig.classList.add('flash');
      const pic = await takePicture(o, req, W);
      alive(tk);
      pics.push(pic);
      const fr = fig.querySelector('.frame');
      fr.innerHTML = '';
      fr.appendChild(pic.canvas);
      fig.classList.remove('live');
      fig.querySelector('.res').textContent = pic.real ? 'real NASA image' : pic.sar ? 'radar' : 'captured';
      await wait(700);
      fig.classList.remove('flash');
    }
    S.globe.follow = null;
    S.globe.flyTo(lat, lon, 2.5, 1200);
    s5.done(`${shots.length} picture${shots.length > 1 ? 's' : ''} on board · ${S.day === 'past' ? 'clouds as they really were' : 'clouds as forecast'}`);
    await wait(600);

    // 6. Check + deliver ---------------------------------------------------------
    const s6 = stage(6, 'Checking every picture for cloud', 'fuzzy cloud mask, pixel by pixel');
    s6.body.innerHTML = `<div class="rulesmini">
      <span>IF bright AND grey THEN <b>cloud</b></span><span>IF medium AND grey THEN <b>thin cloud</b></span><span>IF colourful OR blue-white THEN <b>ground</b></span><span>IF white on a clear day too THEN <b>snow, not cloud</b></span></div>`;
    s6.body.appendChild(strip);   // move the film strip into the check stage
    scrollDown();
    const results = [];
    for (let i = 0; i < shots.length; i++) {
      const o = shots[i], pic = pics[i], fig = figs[i], res = fig.querySelector('.res');
      fig.classList.add('live');
      if (pic.sar) {
        await wait(500);
        res.innerHTML = '<span class="g">✓ radar: cloud-proof</span>';
        results.push({ o, pic, usable: true, frac: 0 });
      } else if (pic.dark) {
        res.innerHTML = '<span class="r">✗ too dark</span>';
        results.push({ o, pic, usable: false, frac: 1 });
      } else {
        const frac = await scanPicture(fig, pic);
        const usable = frac * 100 < D.CLEAR_LIMIT;
        res.innerHTML = usable ? `<span class="g">✓ ${Math.round(frac * 100)}% cloud · usable</span>` : `<span class="r">✗ ${Math.round(frac * 100)}% cloud · rejected</span>`;
        results.push({ o, pic, usable, frac });
      }
      fig.classList.remove('live');
      fig.classList.add(results[i].usable ? 'good' : 'bad');
      await wait(450);
    }
    const good = results.filter((r) => r.usable);
    s6.done(`${good.length} of ${results.length} usable`, !good.length);
    if (!good.length) {
      line(s6.body, 'Every picture came back cloudy. DRISHTI would re-task the next radar pass, which sees through cloud.', 'bad');
      $('mAdd').disabled = false;
      return;
    }
    // best usable: prefer optical when it is clear (sharper, true colour), then highest value
    good.sort((a, b) => (a.pic.sar - b.pic.sar) || b.o.value - a.o.value);
    const win = good[0];
    const contact = contacts.filter((c) => c.sat === win.o.sat && c.start >= win.o.t).sort((a, b) => a.start - b.start)[0];
    const s7 = stage(7, 'Delivering the picture', contact ? 'waiting for the satellite to reach a ground station' : 'stored on board');
    if (contact) {
      const st = D.STATIONS.find((x) => x.id === contact.station);
      S.globe.followSat(win.o.sat);
      S.simMs = win.o.t;
      await animateSim(win.o.t, contact.start + 30000, 2600);
      S.globe.setDownlinks([contact]);
      S.globe.follow = null;
      S.globe.flyTo(st.lat, st.lon, 3.2, 1400);
      await wait(1400);
      S.globe.setDownlinks([]);
      const hrs = (contact.end - askedAt) / HOUR;
      const big = document.createElement('div'); big.className = 'deliver';
      const img = win.pic.canvas.cloneNode(); img.getContext('2d').drawImage(win.pic.canvas, 0, 0);
      big.appendChild(img);
      big.insertAdjacentHTML('beforeend', `<div class="dmeta">
        <div class="route">
          <span><b>${when(askedAt)}</b>you asked</span><i>→</i>
          <span><b>${when(win.o.t)}</b>${short(SAT[win.o.sat])} took it</span><i>→</i>
          <span><b>${when(contact.start)}</b>sent down to ${st.name}</span>
        </div>
        <div class="kv"><span>In your hands</span><b>${Math.floor(hrs)} h ${Math.round((hrs % 1) * 60)} min after the click</b>
        <span>Cloud in picture</span><b>${win.pic.sar ? 'radar, not affected' : Math.round(win.frac * 100) + '%'}</b>
        <span>Picture</span><b>${win.pic.source}</b></div></div>`);
      s7.body.appendChild(big);
      s7.done(`downlinked to ${st.name} at ${A.fmtIST(contact.start)} IST`);
      S.globe.flyTo(lat, lon, 2.5, 1600);
    } else {
      line(s7.body, 'No ground-station contact left in this 48-hour window, so the picture waits on board.');
      s7.done('stored on board');
    }
    $('mSteps').querySelectorAll('li').forEach((li) => { li.className = 'ok'; });
    $('mAdd').disabled = false;
    scrollDown();
  }

  // ------------------------------------------------------------------
  function setSpeed(v) {
    M.speed = v;
    document.querySelectorAll('#mSpeed button').forEach((b) => b.classList.toggle('on', +b.dataset.s === v));
  }
  function reset() {
    M.token++;
    M.running = false;
    const S = window.DrishtiApp && window.DrishtiApp.S;
    if (S && S.globe) { S.globe.clearTracks(); S.globe.setTarget(null); S.globe.setDownlinks([]); }
    if ($('mBody')) { $('mBody').querySelectorAll('.mstage').forEach((x) => x.remove()); $('mIntro').hidden = false; }
    if ($('mTitle')) $('mTitle').textContent = 'click anywhere on the globe';
    if ($('mSteps')) $('mSteps').querySelectorAll('li').forEach((li) => { li.className = ''; });
    if ($('mission')) $('mission').classList.remove('busy');
  }
  function bind() {
    document.querySelectorAll('#mSpeed button').forEach((b) => b.addEventListener('click', () => setSpeed(+b.dataset.s)));
    $('mAdd').addEventListener('click', () => {
      if (!M.req) return;
      window.DrishtiApp.addRequestAt(M.req.lat, M.req.lon, M.req.type, M.req.urgency, M.req.name);
      $('mAdd').disabled = true;
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();

  window.Mission = { start, reset, placeName, cloudness, get running() { return M.running; } };
})();
