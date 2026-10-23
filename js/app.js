/*
 * app.js
 * Wires live data, the planning engine and the 3D globe into the app.
 */
(function () {
  'use strict';

  const D = window.Drishti, L = window.Live;
  const $ = (id) => document.getElementById(id);
  const HOUR = 3600000, H48 = 48;
  const GRID = { lat0: 6, lon0: 66, step: 2.5, n: 13 };
  const ICONS = { flood: '🌊', cyclone: '🌀', wildfire: '🔥', landslide: '⛰️', volcano: '🌋', crop: '🌾', forest: '🌳', water: '💧', urban: '🏙️', coast: '🏖️', glacier: '🏔️', ice: '🧊', drought: '🏜️', energy: '☀️', haze: '🌫️', default: '📍' };
  const SAT_BY_ID = {}; D.SATELLITES.forEach((s) => { SAT_BY_ID[s.id] = s; });

  const S = {
    mode: 'plan', day: 'today', startMs: 0, simMs: 0,
    fleet: [], orbitLive: false, events: [], requests: [], reqById: {},
    weather: null, cloudNet: null, trainSet: null, cloudEval: null,
    fz: D.defaultFuzzy(),
    access: null, prob: null,
    plans: { fcfs: null, greedy: null, you: [], ai: null }, shown: 'greedy', aiLabel: '',
    manual: false, adding: false, selectedReq: null, selectedOpp: null,
    flying: false, shotIdx: 0, lastCloudHour: -1, follow: '',
    filter: 'all', gaRun: null, gaHist: [], brainTab: 'ann', mfVar: 'clear',
  };

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  const fmtIST = (ms, withDay) => new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
    ...(withDay ? { weekday: 'short', day: 'numeric', month: 'short' } : {}),
  }).format(new Date(ms));
  const pct = (v) => Math.round(v * 100) + '%';
  const clamp = D.clamp;
  const rawP = (total) => clamp(1 - (total / 100) * 1.4, 0, 1);
  function toast(html, cls, img, ms) {
    const el = document.createElement('div');
    el.className = 'toast ' + (cls || '');
    if (img) el.appendChild(img);
    const t = document.createElement('div');
    t.innerHTML = html;
    if (!img) el.style.gridTemplateColumns = '1fr';
    el.appendChild(t);
    $('toasts').appendChild(el);
    while ($('toasts').children.length > 3) $('toasts').firstChild.remove();
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 420); }, ms || 3800);
  }
  function step(name, state, note) {
    const li = document.querySelector(`#steps [data-s="${name}"]`);
    if (!li) return;
    li.className = state;
    li.querySelector('.r').textContent = note || '';
  }
  function chip(id, live, label) {
    const c = $(id);
    c.className = 'chip ' + (live ? 'live' : 'fallback');
    c.lastChild.textContent = label;
  }
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

  // ------------------------------------------------------------------
  // Weather: series for grid points + request points, live or built-in
  // ------------------------------------------------------------------
  function gridPoints() {
    const pts = [];
    for (let i = 0; i < GRID.n; i++) for (let j = 0; j < GRID.n; j++) pts.push({ lat: GRID.lat0 + i * GRID.step, lon: GRID.lon0 + j * GRID.step });
    return pts;
  }

  function Weather(kind) {
    this.kind = kind;          // 'live' | 'builtin'
    this.grid = null; this.gridAct = null;
    this.req = {}; this.reqAct = {};
  }
  Weather.prototype.gridAt = function (series, lat, lon, ms) {
    const gi = clamp((lat - GRID.lat0) / GRID.step, 0, GRID.n - 1.001), gj = clamp((lon - GRID.lon0) / GRID.step, 0, GRID.n - 1.001);
    const i0 = Math.floor(gi), j0 = Math.floor(gj), fi = gi - i0, fj = gj - j0;
    const at = (i, j) => L.sample(series[i * GRID.n + j], ms);
    const a = at(i0, j0), b = at(i0, j0 + 1), c = at(i0 + 1, j0), d = at(i0 + 1, j0 + 1);
    if (!a || !b || !c || !d) return a || b || c || d;
    const mix = (k) => (a[k] * (1 - fj) + b[k] * fj) * (1 - fi) + (c[k] * (1 - fj) + d[k] * fj) * fi;
    return { total: mix('total'), low: mix('low'), mid: mix('mid'), high: mix('high'), rh: mix('rh'), precip: 0 };
  };
  Weather.prototype.forecastAt = function (lat, lon, ms, reqId) {
    if (reqId && this.req[reqId]) { const v = L.sample(this.req[reqId], ms); if (v) return v; }
    return this.gridAt(this.grid, lat, lon, ms);
  };
  Weather.prototype.actualAt = function (lat, lon, ms, reqId) {
    if (!this.gridAct) return null;
    if (reqId && this.reqAct[reqId]) { const v = L.sample(this.reqAct[reqId], ms); if (v) return v; }
    return this.gridAt(this.gridAct, lat, lon, ms);
  };

  // Built-in weather turned into the same series format, so everything
  // downstream is identical whether data is live or not.
  const SYN = new D.SyntheticWeather(2026);
  function synthSeries(pts, startMs, hours, actual) {
    return pts.map((p) => {
      const s = { t: [], total: [], low: [], mid: [], high: [], rh: [] };
      for (let h = -6; h <= hours + 6; h++) {
        const ms = startMs + h * HOUR;
        const v = actual ? SYN.truth(p.lat, p.lon, ms) : SYN.forecast(p.lat, p.lon, ms, Math.max(6, h));
        s.t.push(ms); s.total.push(v.total); s.low.push(v.low); s.mid.push(v.mid); s.high.push(v.high); s.rh.push(v.rh);
      }
      return s;
    });
  }

  async function loadWeather(day, startMs) {
    const grid = gridPoints();
    const reqs = S.requests;
    const w = new Weather('live');
    try {
      if (day === 'today') {
        const [g, r] = await Promise.all([L.fetchForecast(grid), L.fetchForecast(reqs)]);
        w.grid = g; reqs.forEach((q, i) => { w.req[q.id] = r[i]; });
      } else {
        const a = startMs - HOUR * 6, b = startMs + HOUR * 54;
        const [g, r, ga, ra] = await Promise.all([
          L.fetchPastForecast(grid, a, b), L.fetchPastForecast(reqs, a, b),
          L.fetchActual(grid, a, b), L.fetchActual(reqs, a, b),
        ]);
        w.grid = g; w.gridAct = ga;
        reqs.forEach((q, i) => { w.req[q.id] = r[i]; w.reqAct[q.id] = ra[i]; });
      }
      if (!w.grid.length || !w.grid[0].t.length) throw new Error('empty');
      return w;
    } catch (e) {
      const f = new Weather('builtin');
      f.grid = synthSeries(grid, startMs, H48, false);
      const rs = synthSeries(reqs, startMs, H48, false);
      reqs.forEach((q, i) => { f.req[q.id] = rs[i]; });
      if (day === 'past') {
        f.gridAct = synthSeries(grid, startMs, H48, true);
        const ra = synthSeries(reqs, startMs, H48, true);
        reqs.forEach((q, i) => { f.reqAct[q.id] = ra[i]; });
      }
      return f;
    }
  }

  // Training set: past forecasts paired with what actually happened.
  async function loadTrainingSet() {
    const pts = gridPoints().filter((_, i) => i % 6 === 0);
    const end = Date.now() - 7 * 86400000, start = end - 28 * 86400000;
    try {
      const [fc, act] = await Promise.all([L.fetchPastForecast(pts, start, end), L.fetchActual(pts, start, end)]);
      const X = [], Y = [];
      pts.forEach((p, k) => {
        const f = fc[k], a = act[k];
        for (let i = 0; i < f.t.length; i++) {
          const ms = f.t[i];
          const solar = ((new Date(ms).getUTCHours() + p.lon / 15) % 24 + 24) % 24;
          if (solar < 7 || solar > 17) continue;
          const fv = L.sample(f, ms), av = L.sample(a, ms);
          if (!fv || !av) continue;
          X.push(D.features(fv, p.lat, p.lon, new Date(ms)));
          Y.push(av.total < D.CLEAR_LIMIT ? 1 : 0);
        }
      });
      if (X.length < 300) throw new Error('too little');
      return { X, Y, source: `${X.length.toLocaleString('en-IN')} real samples: Open-Meteo past forecasts vs. ERA5 observed cloud, ${pts.length} sites, 4 weeks`, live: true };
    } catch (e) {
      const set = D.syntheticTrainingSet(SYN, 40, 60, Date.now());
      set.source = `${set.X.length.toLocaleString('en-IN')} samples from the built-in weather model (live history unreachable)`;
      set.live = false;
      return set;
    }
  }

  // ------------------------------------------------------------------
  // Planning pipeline
  // ------------------------------------------------------------------
  function scoreOpp(o) {
    const r = S.reqById[o.req];
    const sat = SAT_BY_ID[o.sat];
    if (sat.sensor === 'sar') { o.p0 = 0.97; o.pRaw = 0.97; }
    else if (o.sunEl < 10) { o.p0 = 0; o.pRaw = 0; }
    else {
      const fc = S.weather.forecastAt(r.lat, r.lon, o.t, r.id);
      o.fcTotal = fc ? fc.total : 50;
      o.p0 = fc ? S.cloudNet.predict(fc, r.lat, r.lon, new Date(o.t)) : 0.4;
      o.pRaw = fc ? rawP(fc.total) : 0.4;
    }
    o.pClear = o.p0;
    o.v0 = D.fuzzyEval(S.fz, D.fuzzyInputs(o, r, SAT_BY_ID));
    // what really happened (past days only)
    if (S.day === 'past') {
      if (sat.sensor === 'sar') o.actual = 1;
      else if (o.sunEl < 10) o.actual = 0;
      else { const a = S.weather.actualAt(r.lat, r.lon, o.t, r.id); o.actual = a && a.total < D.CLEAR_LIMIT ? 1 : 0; o.actTotal = a ? a.total : null; }
    } else o.actual = null;
  }

  // Values used by the planner under the current AI-engine switches.
  function setPlanningValues() {
    const useANN = $('useANN').checked, useFuzzy = $('useFuzzy').checked;
    for (const o of S.access.opps) {
      const r = S.reqById[o.req];
      o.pClear = useANN ? o.p0 : o.pRaw;
      const x = D.fuzzyInputs(o, r, SAT_BY_ID);
      o.value = useFuzzy ? D.fuzzyEval(S.fz, x) : D.crispValue(x);
    }
  }
  function setCanonicalValues() { for (const o of S.access.opps) { o.pClear = o.p0; o.value = o.v0; } }

  function score(plan) {
    if (!plan) return null;
    const served = new Set(plan.map((o) => o.req));
    let value = 0, expected = 0, actual = 0, urgent = 0;
    for (const o of plan) { value += o.v0; expected += o.p0; actual += o.actual || 0; }
    served.forEach((id) => { if (S.reqById[id].urgency >= 0.6) urgent++; });
    return { value, expected, actual, wasted: plan.length - (S.day === 'past' ? actual : expected), served: served.size, urgent, shots: plan.length };
  }

  function rebuildProblem() {
    for (const o of S.access.opps) scoreOpp(o);
    S.prob = D.buildProblem(S.requests, S.access, S.fleet);
    setCanonicalValues();
    S.plans.fcfs = D.planFCFS(S.prob);
    S.plans.greedy = D.planGreedy(S.prob);
    // keep the user's plan only where it is still valid
    const ids = new Set(S.access.opps.map((o) => o.id));
    S.plans.you = S.plans.you.filter((o) => ids.has(o.id));
    S.plans.ai = null;
    if (S.shown === 'ai') S.shown = 'greedy';
    $('claim').hidden = true;
    renderAll();
  }

  async function loadDay(day) {
    S.day = day;
    stopFly();
    if (day === 'today') {
      S.startMs = Math.floor(Date.now() / HOUR) * HOUR;
    } else {
      const d = new Date(Date.now() - 8 * 86400000);
      S.startMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0) - 5.5 * HOUR; // midnight IST
    }
    S.simMs = S.startMs;
    S.fleet = D.SATELLITES.map((sat) => ({ sat, orbit: D.makeOrbit(sat, S.tles[sat.id], new Date(S.startMs)) }));
    if (S.globe) S.fleet.forEach((f) => { if (S.globe.sats[f.sat.id]) S.globe.sats[f.sat.id].f = f; });
    step('cloud', 'run');
    S.weather = await loadWeather(day, S.startMs);
    step('cloud', S.weather.kind === 'live' ? 'ok' : 'fb', S.weather.kind === 'live' ? 'Open-Meteo live' : 'built-in model');
    chip('chipCloud', S.weather.kind === 'live', S.weather.kind === 'live' ? (day === 'past' ? 'Clouds: forecast + actual' : 'Clouds: live forecast') : 'Clouds: built-in model');
    step('access', 'run');
    await nextFrame();
    S.access = D.computeAccess(S.fleet, S.requests, S.startMs, H48, 20);
    step('access', 'ok', S.access.opps.length + ' passes');
    S.plans.you = [];
    rebuildProblem();
    if (S.globe) {
      S.globe.setSun(new Date(S.simMs));
      S.globe.updateSatellites(S.simMs);
      updateClouds(true);
    }
    $('planWindow').textContent = fmtIST(S.startMs, true) + ' → +48 h';
    $('scoreNote').textContent = day === 'past' ? 'checked against real clouds' : 'expected';
  }

  // ------------------------------------------------------------------
  // AI plan (animated GA)
  // ------------------------------------------------------------------
  function runAI() {
    if (S.gaRun) return;
    stopFly();
    setPlanningValues();
    const useGA = $('useGA').checked;
    const tags = [$('useANN').checked ? 'ANN' : null, $('useFuzzy').checked ? 'fuzzy' : null, useGA ? 'GA' : 'greedy'].filter(Boolean).join(' + ');
    S.aiLabel = tags;
    if (!useGA) {
      const plan = D.planGreedy(S.prob);
      setCanonicalValues();
      finishAI(plan, [0]);
      return;
    }
    const ga = new D.GA(S.prob, { pop: 70 });
    S.gaRun = { ga, gens: 160 };
    S.gaHist = [ga.best.fit];
    $('btnAI').disabled = true;
    S.shown = 'ai';
  }
  function gaTick() {
    const run = S.gaRun;
    if (!run) return;
    for (let k = 0; k < 6 && run.ga.gen < run.gens; k++) S.gaHist.push(run.ga.step().fit);
    S.plans.ai = run.ga.best.plan;
    $('gaGen').textContent = `generation ${run.ga.gen} / ${run.gens}`;
    drawGA();
    drawTimeline();
    if (run.ga.gen >= run.gens) {
      S.gaRun = null;
      $('btnAI').disabled = false;
      setCanonicalValues();
      finishAI(run.ga.best.plan, S.gaHist);
    }
  }
  function finishAI(plan, hist) {
    S.plans.ai = plan;
    S.shown = 'ai';
    S.gaHist = hist;
    const a = score(plan), f = score(S.plans.fcfs);
    const good = (x) => (S.day === 'past' ? x.actual : x.expected);
    const rate = (x) => (x.shots ? good(x) / x.shots : 0);
    $('claimNum').textContent = Math.round(rate(a) * 100) + '%';
    $('claimTxt').textContent = `of the AI's photos ${S.day === 'past' ? 'came back usable (checked against the real clouds)' : 'are expected to be usable'}, vs ${Math.round(rate(f) * 100)}% the usual way. Wasted shots: ${Math.round(a.shots - good(a))} vs ${Math.round(f.shots - good(f))}.`;
    $('claim').hidden = false;
    toast(`<b>AI plan ready</b> · ${plan.length} shots for ${a.served} targets <span class="muted">(${S.aiLabel})</span>`, 'good');
    renderAll();
  }

  // ------------------------------------------------------------------
  // Manual planning
  // ------------------------------------------------------------------
  function whyNot(plan, o) {
    const sat = SAT_BY_ID[o.sat];
    const mine = plan.filter((p) => p.sat === o.sat && p.req !== o.req).sort((a, b) => a.t - b.t);
    if (mine.length >= sat.maxShots) return `${sat.name} has no power left for more shots today`;
    const seg = (t) => { let s = 0; for (const c of S.prob.dl[o.sat]) if (c <= t) s++; return s; };
    if (mine.filter((p) => seg(p.t) === seg(o.t)).length >= sat.memory) return `${sat.name}'s memory is full until its next downlink`;
    for (const p of mine) {
      const need = 8000 + (Math.abs(p.roll - o.roll) / sat.slewDegPerS + sat.settleS) * 1000;
      if (Math.abs(p.t - o.t) < need) return `${sat.name} can't turn from ${S.reqById[p.req].name} to here in time`;
    }
    return null;
  }
  function toggleManual(o) {
    const plan = S.plans.you;
    const i = plan.findIndex((p) => p.id === o.id);
    if (i >= 0) { plan.splice(i, 1); }
    else {
      const reason = whyNot(plan, o);
      if (reason) { toast(`<b>Can't add that shot.</b> ${reason}.`, 'bad'); return; }
      const j = plan.findIndex((p) => p.req === o.req);
      if (j >= 0) plan.splice(j, 1);
      plan.push(o);
    }
    S.shown = 'you';
    renderAll();
  }

  // ------------------------------------------------------------------
  // Fly the plan
  // ------------------------------------------------------------------
  function shownPlan() { return (S.plans[S.shown] || []).slice().sort((a, b) => a.t - b.t); }
  function startFly() {
    if (S.simMs >= S.startMs + H48 * HOUR - HOUR) S.simMs = S.startMs;
    S.flying = true;
    S.flyPlan = shownPlan();
    S.shotIdx = S.flyPlan.findIndex((o) => o.t >= S.simMs);
    if (S.shotIdx < 0) S.shotIdx = S.flyPlan.length;
    S.flyStats = { good: 0, bad: 0 };
    for (const o of S.flyPlan) if (o.t >= S.simMs) S.globe.setPinState(o.req, 'planned');
    $('btnPlay').textContent = '❚❚ Pause';
    if (S.follow) S.globe.followSat(S.follow);
  }
  function stopFly() {
    S.flying = false;
    if ($('btnPlay')) $('btnPlay').textContent = '▶ Fly the plan';
  }
  function flyTick(dtMs) {
    const speed = +$('speed').value * 60000; // sim ms per real second
    S.simMs = Math.min(S.startMs + H48 * HOUR, S.simMs + speed * (dtMs / 1000));
    while (S.shotIdx < S.flyPlan.length && S.flyPlan[S.shotIdx].t <= S.simMs) {
      fireShot(S.flyPlan[S.shotIdx]);
      S.shotIdx++;
    }
    if (S.simMs >= S.startMs + H48 * HOUR) {
      stopFly();
      const n = S.flyStats.good + S.flyStats.bad;
      toast(`<b>Mission complete.</b> ${S.flyStats.good} of ${n} shots ${S.day === 'past' ? 'came back cloud-free' : 'expected cloud-free'}.`, 'good', null, 6000);
    }
  }
  function fireShot(o) {
    const r = S.reqById[o.req];
    const good = S.day === 'past' ? o.actual === 1 : o.p0 >= 0.5;
    S.flyStats[good ? 'good' : 'bad']++;
    S.globe.shoot(o.sat, r, good);
    S.globe.setPinState(r.id, good ? 'clear' : 'cloudy');
    const img = thumb(r, o, 54);
    const sat = SAT_BY_ID[o.sat];
    toast(`<b>${r.name}</b><br><span class="muted">${sat.name} · ${fmtIST(o.t)} IST</span><br>${good
      ? '<span style="color:var(--teal)">Cloud-free image</span>'
      : `<span style="color:var(--rose)">${S.day === 'past' ? 'Clouds covered it' : 'Likely cloudy'}</span>`}`, good ? 'good' : 'bad', img, 2600);
    renderReqList();
  }

  // Image of a target: NASA true-colour when online, a painted tile otherwise.
  function thumb(r, o, size) {
    const img = new Image();
    img.alt = r.name;
    img.referrerPolicy = 'no-referrer';
    img.width = size; img.height = size;
    img.src = L.gibsUrl(r.lat, r.lon, o ? o.t : S.startMs, 60);
    img.onerror = () => {
      const c = paintPhoto(r, 0, false, null);
      c.className = img.className;
      img.replaceWith(c);
    };
    return img;
  }

  // ------------------------------------------------------------------
  // Painted "satellite photo" used when real imagery can't be loaded:
  // ground drawn from the target type, clouds from the measured cloud cover.
  // ------------------------------------------------------------------
  function hashStr(t) { let h = 2166136261; for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619); return h >>> 0; }
  function noise2(seed) {
    const r = D.mulberry32(seed), N = 32, v = new Float32Array(N * N);
    for (let i = 0; i < v.length; i++) v[i] = r();
    const at = (x, y) => v[((y % N + N) % N) * N + ((x % N + N) % N)];
    const n = (x, y) => {
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      const u = fx * fx * (3 - 2 * fx), w = fy * fy * (3 - 2 * fy);
      return (at(x0, y0) * (1 - u) + at(x0 + 1, y0) * u) * (1 - w) + (at(x0, y0 + 1) * (1 - u) + at(x0 + 1, y0 + 1) * u) * w;
    };
    return (x, y, oct) => { let a = 0.5, f = 1, s = 0, t = 0; for (let o = 0; o < (oct || 4); o++) { s += a * n(x * f, y * f); t += a; a *= 0.5; f *= 2; } return s / t; };
  }
  function paintPhoto(r, cloud, sar, o) {
    const W = 192, c = document.createElement('canvas');
    c.width = c.height = W;
    const g = c.getContext('2d');
    const seed = hashStr(r.id + r.name);
    const N = noise2(seed), C = noise2(seed + (o ? Math.floor(o.t / 3600000) : 7));
    const rnd = D.mulberry32(seed);
    const img = g.createImageData(W, W), d = img.data;
    const type = r.type;
    // field patchwork for farmland-like types
    const fieldCols = type === 'drought' ? [[196, 170, 120], [178, 150, 104], [210, 188, 140], [160, 140, 100]]
      : [[96, 140, 64], [128, 160, 72], [176, 168, 96], [84, 120, 60], [150, 130, 80]];
    const cell = 14 + rnd() * 10, tilt = rnd() * 0.5 - 0.25;
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        const u = x / W, v = y / W, n = N(u * 6, v * 6, 4), n2 = N(u * 22 + 9, v * 22, 2);
        let R, G, B;
        const sea = (type === 'coast' || type === 'cyclone' || type === 'volcano') ? (type === 'volcano' ? Math.hypot(u - 0.5, v - 0.5) > 0.18 + n * 0.12 : u + (n - 0.5) * 0.5 > 0.62) : false;
        const lake = (type === 'water' || type === 'flood') && N(u * 2.5 + 3, v * 2.5, 3) > (type === 'flood' ? 0.48 : 0.58);
        if (sea) { R = 20 + n * 20; G = 70 + n * 40; B = 120 + n * 50; }
        else if (lake) { R = type === 'flood' ? 120 + n * 30 : 30 + n * 20; G = type === 'flood' ? 100 + n * 20 : 70 + n * 30; B = type === 'flood' ? 70 : 100 + n * 40; }
        else if (type === 'urban') {
          const gx = (x + y * 0.15) % 18, gy = (y - x * 0.1) % 22;
          const road = gx < 2 || gy < 2;
          const t = 150 + n2 * 50;
          R = road ? 90 : t; G = road ? 90 : t - 8; B = road ? 95 : t - 20;
          if (n > 0.66) { R = 70; G = 110; B = 60; }
        } else if (type === 'glacier' || type === 'ice') {
          const snow = n > 0.45; R = snow ? 225 + n2 * 25 : 110 + n2 * 40; G = snow ? 232 + n2 * 20 : 105 + n2 * 40; B = snow ? 245 : 100 + n2 * 40;
        } else if (type === 'forest' || type === 'landslide') {
          R = 30 + n * 40; G = 70 + n * 60; B = 30 + n * 25;
          if (type === 'landslide' && Math.abs(Math.sin(u * 3 + n * 4) - v + 0.3) < 0.04 + n2 * 0.03) { R = 150; G = 110; B = 80; }
        } else if (type === 'energy') {
          const row = ((y + x * 0.05) % 10) < 6 && u > 0.15 && u < 0.85 && v > 0.15 && v < 0.85;
          R = row ? 30 : 205 + n * 20; G = row ? 45 : 180 + n * 20; B = row ? 80 : 130 + n * 20;
        } else {
          const fx = Math.floor((x + y * tilt) / cell), fy = Math.floor((y - x * tilt) / cell);
          const col = fieldCols[(((fx * 7 + fy * 13 + (seed & 7)) % fieldCols.length) + fieldCols.length) % fieldCols.length];
          const k = 0.85 + n2 * 0.3;
          R = col[0] * k; G = col[1] * k; B = col[2] * k;
          if ((x + y * tilt) % cell < 1 || (y - x * tilt) % cell < 1) { R *= 0.8; G *= 0.8; B *= 0.8; }
        }
        if (type === 'wildfire' && N(u * 9, v * 9, 2) > 0.8) { R = 230; G = 60; B = 20; }
        if (sar) {
          // radar: grey; calm water is black, buildings and slopes bright; grainy speckle
          const lum = 0.3 * R + 0.55 * G + 0.15 * B;
          let L = sea || lake ? 12 + rnd() * 18 : lum * 0.9 + 20 + (rnd() - 0.5) * 46;
          if (type === 'urban' && !(sea || lake)) L += 40 * (rnd() > 0.7 ? 1 : 0.3);
          R = G = B = Math.max(0, Math.min(255, L));
        } else if (cloud > 0) {
          const th = 1 - Math.min(1, cloud * 1.1);
          const edge = (q) => Math.max(0, Math.min(1, (q - th + 0.06) / 0.12));
          const a = edge(C(u * 3.2, v * 3.2, 5));
          const shadow = edge(C(u * 3.2 - 0.18, v * 3.2 - 0.12, 5)) * 0.45;   // clouds cast shadows
          R *= 1 - shadow; G *= 1 - shadow; B *= 1 - shadow * 0.8;
          const shade = 200 + C(u * 11 + 3, v * 11, 3) * 55;               // lumpy tops
          R = R * (1 - a) + shade * a; G = G * (1 - a) + shade * a; B = B * (1 - a) + (shade + 8) * a;
        }
        const i = (y * W + x) * 4;
        d[i] = R; d[i + 1] = G; d[i + 2] = B; d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    if (r.type === 'wildfire' && !sar) {           // smoke plume
      const gr = g.createLinearGradient(W * 0.4, W * 0.6, W, 0);
      gr.addColorStop(0, 'rgba(200,190,180,0.0)'); gr.addColorStop(0.3, 'rgba(200,190,180,0.55)'); gr.addColorStop(1, 'rgba(200,190,180,0)');
      g.fillStyle = gr; g.fillRect(0, 0, W, W);
    }
    // metadata stamp, like a real product
    if (o) {
      g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(0, W - 16, W, 16);
      g.fillStyle = '#fff'; g.font = '600 9px "JetBrains Mono", monospace';
      g.fillText(`${SAT_BY_ID[o.sat].name.split(' ')[0].toUpperCase()} · ${fmtIST(o.t, true).toUpperCase()}`, 5, W - 5);
    }
    return c;
  }

  // ------------------------------------------------------------------
  // The photo album: one day of pictures, usual way vs AI
  // ------------------------------------------------------------------
  function photoFor(o) {
    const r = S.reqById[o.req], sat = SAT_BY_ID[o.sat];
    const sar = sat.sensor === 'sar';
    const cloud = S.day === 'past' ? (o.actTotal === null || o.actTotal === undefined ? (o.actual ? 0.1 : 0.9) : o.actTotal / 100) : (o.fcTotal || 50) / 100;
    const dark = !sar && o.sunEl < 10;
    const good = S.day === 'past' ? o.actual === 1 : o.p0 >= 0.5;
    const holder = document.createElement('div');
    holder.className = 'img';
    const painted = paintPhoto(r, dark ? 0 : cloud, sar, o);
    if (dark) { const g = painted.getContext('2d'); g.fillStyle = 'rgba(0,0,10,0.88)'; g.fillRect(0, 0, 192, 176); }
    holder.appendChild(painted);
    // real NASA image of that place that morning (online only, optical only)
    if (!sar && !dark && S.weather.kind === 'live') {
      const im = new Image();
      im.referrerPolicy = 'no-referrer';
      im.alt = r.name;
      im.onload = () => { painted.replaceWith(im); im.insertAdjacentHTML('afterend', '<span class="real">NASA photo</span>'); };
      im.src = L.gibsUrl(r.lat, r.lon, o.t, 45, S.day === 'past');
    }
    return { holder, good, sar, dark, cloud };
  }

  function openAlbum() {
    // optical photos first (that is where clouds matter), radar after
    const order = (a, b) => (SAT_BY_ID[a.sat].sensor === 'sar') - (SAT_BY_ID[b.sat].sensor === 'sar') || a.t - b.t;
    const left = (S.plans.fcfs || []).slice().sort(order);
    const right = (S.plans.ai || []).slice().sort(order);
    const past = S.day === 'past';
    const col = (title, sub, plan, cls) => {
      const sec = document.createElement('div');
      sec.className = 'album-col ' + cls;
      let good = 0;
      const cards = plan.map((o, i) => {
        const p = photoFor(o);
        if (p.good) good++;
        const r = S.reqById[o.req];
        const fig = document.createElement('figure');
        fig.className = 'ph ' + (p.good ? 'good' : 'bad');
        fig.style.animationDelay = (0.15 + i * 0.07) + 's';
        fig.appendChild(p.holder);
        const cap = document.createElement('figcaption');
        cap.innerHTML = `<b>${r.name}</b><span>${p.sar ? 'radar · ' : ''}${p.dark ? 'after dark · ' : ''}${p.sar ? 'sees through cloud' : `${past ? 'real' : 'forecast'} cloud ${Math.round(p.cloud * 100)}%`}</span><i>${p.good ? '✓ usable' : '✗ wasted'}</i>`;
        fig.appendChild(cap);
        return fig;
      });
      const urgent = new Set(plan.map((o) => o.req).filter((id) => S.reqById[id].urgency >= 0.6)).size;
      sec.innerHTML = `<div class="album-head"><span class="eyebrow">${title} <span class="muted">· ${sub}</span></span>
        <div class="album-stats"><div><b class="count good-n" data-to="${good}">0</b><span>usable photos</span></div>
        <div><b class="count bad-n" data-to="${plan.length - good}">0</b><span>wasted on clouds or darkness</span></div></div>
        <span class="muted">${plan.length} photos taken · ${new Set(plan.map((o) => o.req)).size} places · ${urgent} urgent</span></div>`;
      const grid = document.createElement('div');
      grid.className = 'album-grid';
      cards.forEach((c) => grid.appendChild(c));
      sec.appendChild(grid);
      return sec;
    };
    const box = $('albumBody');
    box.innerHTML = '';
    box.appendChild(col('The usual way', 'first come, first served', left, 'usual'));
    box.appendChild(col('DRISHTI AI', 'GA + neural net + fuzzy', right, 'ai'));
    $('albumTitle').textContent = `${past ? 'What the satellites actually photographed on' : 'Expected photos for'} ${fmtIST(S.startMs, true).replace(/,? \d\d:\d\d$/, '')}${past ? ' (checked against real clouds)' : ' (from the forecast)'}`;
    $('album').hidden = false;
    // count-up numbers
    box.querySelectorAll('.count').forEach((el) => {
      const to = +el.dataset.to, t0 = performance.now(), dur = 1400 + to * 40;
      const tick = (now) => { const k = Math.min(1, (now - t0) / dur); el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
  }

  // One click from opening the app to the album.
  async function showMe() {
    if (S.loading) return;
    $('btnShow').disabled = true;
    if (S.day !== 'past') {
      S.loading = true;
      document.querySelectorAll('[data-day]').forEach((x) => x.classList.toggle('on', x.dataset.day === 'past'));
      toast('Loading last week: the forecast the planners had, and the clouds that really came…');
      await loadDay('past');
      S.loading = false;
    }
    if (!S.plans.ai) {
      toast('AI is planning the day…');
      await nextFrame(); await nextFrame();
      setPlanningValues();
      const ga = new D.GA(S.prob, { pop: 70 });
      const hist = [ga.best.fit];
      for (let i = 0; i < 160; i++) { hist.push(ga.step().fit); if (i % 40 === 0) await nextFrame(); }
      setCanonicalValues();
      S.aiLabel = 'ANN + fuzzy + GA';
      finishAI(ga.best.plan, hist);
    }
    $('btnShow').disabled = false;
    openAlbum();
  }

  // ------------------------------------------------------------------
  // Rendering: requests, detail card, scoreboard, timeline, charts
  // ------------------------------------------------------------------
  function reqStatus(r) {
    const plan = S.plans[S.shown] || [];
    if (!S.prob.byReq[r.id] || !S.prob.byReq[r.id].length) return 'none';
    const pin = S.globe && S.globe.pins[r.id] && S.globe.pins[r.id].userData.state;
    if (pin === 'clear' || pin === 'cloudy') return pin;
    return plan.some((o) => o.req === r.id) ? 'planned' : 'idle';
  }

  function renderReqList() {
    const box = $('reqList');
    const list = S.requests.filter((r) => S.filter === 'all' || r.source === S.filter)
      .sort((a, b) => (b.source === 'event') - (a.source === 'event') || b.urgency - a.urgency);
    $('reqCount').textContent = `${S.requests.length} targets · ${S.requests.filter((r) => r.source === 'event').length} live`;
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = `<p class="muted" style="padding:8px;font-size:13px">${S.filter === 'user' ? 'Nothing added yet. Pick a type below and click anywhere on India.' : S.filter === 'event' ? 'No open natural events in the region right now, or NASA EONET could not be reached.' : 'No requests.'}</p>`;
      return;
    }
    for (const r of list) {
      const el = document.createElement('div');
      el.className = 'req' + (S.selectedReq === r.id ? ' sel' : '');
      el.tabIndex = 0;
      const st = reqStatus(r);
      el.innerHTML = `<div class="ico">${ICONS[r.type] || '📍'}</div>
        <div style="min-width:0"><div class="nm">${r.name}</div>
        <div class="sub"><span class="badge ${r.source}">${r.source === 'event' ? 'live' : r.source === 'user' ? 'you' : 'standing'}</span>
        <span class="urg" title="urgency ${pct(r.urgency)}"><span style="width:${r.urgency * 100}%"></span></span>
        <span>${(S.prob.byReq[r.id] || []).length} passes</span></div></div>
        <span class="st ${st}" title="${st}"></span>`;
      el.addEventListener('click', () => selectReq(r.id, true));
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') selectReq(r.id, true); });
      box.appendChild(el);
    }
    // pins follow the shown plan
    if (S.globe && !S.flying) {
      for (const r of S.requests) {
        const cur = S.globe.pins[r.id] && S.globe.pins[r.id].userData.state;
        if (cur === 'clear' || cur === 'cloudy') continue;
        S.globe.setPinState(r.id, reqStatus(r));
      }
    }
  }

  function selectReq(id, fly) {
    S.selectedReq = id;
    const r = S.reqById[id];
    if (fly) S.globe.flyTo(r.lat, r.lon, 2.0);
    renderReqList();
    renderDetail();
  }

  function renderDetail() {
    const box = $('detail');
    const r = S.reqById[S.selectedReq];
    if (!r || S.mode === 'brain') { box.hidden = true; return; }
    const opps = (S.prob.byReq[r.id] || []).slice().sort((a, b) => a.t - b.t);
    const plan = S.plans[S.shown] || [];
    box.innerHTML = `<button class="x" aria-label="Close">×</button>
      <h3>${ICONS[r.type] || ''} ${r.name}</h3>
      <div class="mono muted" style="font-size:11.5px">${r.lat.toFixed(2)}°N ${r.lon.toFixed(2)}°E · ${r.detail || r.type} · urgency ${pct(r.urgency)} · waiting ${r.waitDays} d</div>
      <div id="dImg"></div>
      <div class="cap">Latest true-colour view (NASA VIIRS, previous day)</div>
      <div class="opp-list">${opps.length ? opps.map((o) => `
        <div class="opp${plan.includes(o) ? ' chosen' : ''}" data-o="${o.id}">
          <i style="background:${SAT_BY_ID[o.sat].colour}"></i>
          <span>${SAT_BY_ID[o.sat].name.split(' ')[0]} · ${fmtIST(o.t, true)}</span>
          <span class="v" title="chance of a clear shot">${SAT_BY_ID[o.sat].sensor === 'sar' ? 'radar' : pct(o.p0)}</span>
          <span class="v" title="fuzzy value">${Math.round(o.v0)}</span>
        </div>`).join('') : '<p class="muted" style="margin:0;font-size:12.5px">No satellite passes over this spot in the next 48 hours.</p>'}</div>
      ${r.link ? `<a class="mono" style="font-size:11.5px;color:var(--sky)" href="${r.link}" target="_blank" rel="noopener">NASA EONET event ↗</a>` : ''}`;
    const im = thumb(r, null, 270);
    box.querySelector('#dImg').appendChild(im);
    box.querySelector('.x').addEventListener('click', () => { S.selectedReq = null; box.hidden = true; renderReqList(); });
    box.querySelectorAll('.opp').forEach((el) => el.addEventListener('click', () => {
      const o = S.access.opps.find((x) => x.id === el.dataset.o);
      S.selectedOpp = o.id;
      if (S.manual) toggleManual(o); else { drawTimeline(); renderExplain(); }
    }));
    const left = document.getElementById('reqPanel').getBoundingClientRect();
    box.style.left = (left.right + 12) + 'px';
    box.style.top = left.top + 'px';
    box.hidden = false;
  }

  function renderScore() {
    const rows = [['fcfs', 'First come, first served'], ['greedy', 'Greedy'], ['you', 'Your plan'], ['ai', 'AI plan']];
    const past = S.day === 'past';
    const sc = {};
    rows.forEach(([k]) => { sc[k] = k === 'you' && !S.plans.you.length ? null : score(S.plans[k]); });
    const key = past ? 'actual' : 'expected';
    let best = null;
    rows.forEach(([k]) => { if (sc[k] && (!best || sc[k][key] > sc[best][key])) best = k; });
    $('score').innerHTML = `<tr><th>Plan</th><th>Targets</th><th>Urgent</th><th>${past ? 'Real clear' : 'Clear (exp)'}</th><th>Wasted</th></tr>` +
      rows.map(([k, name]) => {
        const s = sc[k];
        const cls = [k === 'ai' ? 'ai' : '', k === best ? 'best' : '', k === S.shown ? 'shown' : ''].join(' ');
        if (!s) return `<tr class="${cls}" data-k="${k}"><td>${name}</td><td class="na" colspan="4">${k === 'ai' ? 'press AI plan' : 'click passes on the timeline'}</td></tr>`;
        return `<tr class="${cls}" data-k="${k}" title="show this plan"><td>${name}</td><td>${s.served}</td><td>${s.urgent}</td><td>${past ? s.actual : s.expected.toFixed(1)}</td><td>${s.wasted.toFixed(past ? 0 : 1)}</td></tr>`;
      }).join('');
    $('score').querySelectorAll('tr[data-k]').forEach((tr) => tr.addEventListener('click', () => {
      if (!S.plans[tr.dataset.k] || (tr.dataset.k === 'you' && !S.plans.you.length)) return;
      S.shown = tr.dataset.k; renderAll();
    }));
  }

  function renderAll() {
    renderReqList();
    renderScore();
    drawTimeline();
    drawGA();
    if (!$('detail').hidden) renderDetail();
    if (S.mode === 'brain') renderBrain();
  }

  // --- timeline ------------------------------------------------------------
  const TL = { labelW: 156, axisH: 18 };
  function sizeCanvas(c) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    return { g, w, h };
  }
  function tlGeom(w, h) {
    const x0 = TL.labelW, x1 = w - 6, rows = S.fleet.length;
    const rowH = (h - TL.axisH) / rows;
    const X = (ms) => x0 + ((ms - S.startMs) / (H48 * HOUR)) * (x1 - x0);
    const T = (x) => S.startMs + ((x - x0) / (x1 - x0)) * H48 * HOUR;
    return { x0, x1, rowH, X, T };
  }
  function drawTimeline() {
    if (!S.access) return;
    const c = $('timeline');
    const { g, w, h } = sizeCanvas(c);
    const { x0, x1, rowH, X } = tlGeom(w, h);
    // night over India
    g.fillStyle = 'rgba(0,0,0,0.38)';
    let nightStart = null;
    for (let m = 0; m <= H48 * 60; m += 15) {
      const ms = S.startMs + m * 60000;
      const night = D.sunElevation(22, 80, new Date(ms)) < 0;
      if (night && nightStart === null) nightStart = ms;
      if ((!night || m === H48 * 60) && nightStart !== null) { g.fillRect(X(nightStart), 0, X(ms) - X(nightStart), h - TL.axisH); nightStart = null; }
    }
    // axis
    g.font = '500 10.5px "JetBrains Mono", monospace';
    g.fillStyle = '#98a2c8'; g.strokeStyle = 'rgba(150,170,255,0.14)'; g.lineWidth = 1;
    const firstHour = Math.ceil(S.startMs / (6 * HOUR)) * 6 * HOUR;
    for (let ms = firstHour; ms <= S.startMs + H48 * HOUR; ms += 6 * HOUR) {
      const x = X(ms);
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h - TL.axisH); g.stroke();
      g.textAlign = 'center';
      g.fillText(fmtIST(ms, false), x, h - 5);
    }
    const plan = S.plans[S.shown] || [];
    const inPlan = new Set(plan.map((o) => o.id));
    S.fleet.forEach((f, i) => {
      const y = i * rowH, cy = y + rowH / 2;
      g.fillStyle = 'rgba(255,255,255,0.025)'; if (i % 2) g.fillRect(x0, y, x1 - x0, rowH);
      g.fillStyle = f.sat.colour; g.beginPath(); g.arc(10, cy, 4, 0, 7); g.fill();
      g.fillStyle = '#eef1ff'; g.textAlign = 'left'; g.font = '600 12px Manrope, sans-serif';
      g.fillText(f.sat.name.replace(' (radar)', ''), 20, cy - 2);
      g.fillStyle = '#98a2c8'; g.font = '500 10px "JetBrains Mono", monospace';
      g.fillText(f.sat.sensor === 'sar' ? 'radar · sees through cloud' : 'optical · ' + f.sat.resolution, 20, cy + 11);
      // downlinks
      g.fillStyle = 'rgba(255,159,67,0.35)';
      for (const ct of S.access.contacts) if (ct.sat === f.sat.id) g.fillRect(X(ct.start), y + rowH - 6, Math.max(2, X(ct.end) - X(ct.start)), 4);
      // opportunities
      for (const o of S.access.opps) {
        if (o.sat !== f.sat.id) continue;
        const x = X(o.t);
        const chosen = inPlan.has(o.id);
        if (chosen) {
          g.fillStyle = 'rgba(255,159,67,0.9)';
          g.beginPath(); g.roundRect ? g.roundRect(x - 6, y + 6, 12, rowH - 14, 4) : g.rect(x - 6, y + 6, 12, rowH - 14); g.fill();
        }
        const good = f.sat.sensor === 'sar' || o.p0 >= 0.5;
        const night = f.sat.sensor !== 'sar' && o.sunEl < 10;
        const rr = 2.5 + (o.v0 / 100) * 4;
        g.fillStyle = night ? 'rgba(107,116,153,0.6)' : good ? '#2ed3b7' : '#ff5d73';
        if (chosen) g.fillStyle = '#1c1006';
        g.beginPath(); g.moveTo(x, cy - rr); g.lineTo(x + rr, cy); g.lineTo(x, cy + rr); g.lineTo(x - rr, cy); g.closePath(); g.fill();
        if (S.day === 'past' && o.actual !== null && chosen) {
          g.fillStyle = o.actual ? '#2ed3b7' : '#ff5d73';
          g.beginPath(); g.arc(x, y + 10, 3, 0, 7); g.fill();
        }
        if (S.selectedOpp === o.id) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.arc(x, cy, rr + 4, 0, 7); g.stroke(); }
      }
      g.strokeStyle = 'rgba(150,170,255,0.12)'; g.beginPath(); g.moveTo(x0, y + rowH); g.lineTo(x1, y + rowH); g.stroke();
    });
    // now cursor
    const nx = X(S.simMs);
    g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(nx, 0); g.lineTo(nx, h - TL.axisH); g.stroke();
    g.fillStyle = '#fff'; g.beginPath(); g.moveTo(nx - 5, 0); g.lineTo(nx + 5, 0); g.lineTo(nx, 6); g.fill();
  }
  function tlHit(ev) {
    const c = $('timeline');
    const rect = c.getBoundingClientRect();
    const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    const { rowH, X, T, x0 } = tlGeom(rect.width, rect.height);
    const row = Math.floor(y / rowH);
    const f = S.fleet[row];
    let best = null, bd = 9;
    if (f && y < rect.height - TL.axisH) {
      for (const o of S.access.opps) {
        if (o.sat !== f.sat.id) continue;
        const d = Math.abs(X(o.t) - x);
        if (d < bd) { bd = d; best = o; }
      }
    }
    return { opp: best, time: x > x0 ? T(x) : null };
  }

  // --- small charts ----------------------------------------------------------
  function drawGA() {
    const c = $('gaChart');
    const { g, w, h } = sizeCanvas(c);
    const hist = S.gaHist;
    g.fillStyle = '#6b7499'; g.font = '500 10.5px "JetBrains Mono", monospace';
    if (!hist || hist.length < 2) { g.fillText('Press AI plan to watch the plan evolve', 4, h / 2); return; }
    const mn = Math.min(...hist), mx = Math.max(...hist);
    const Y = (v) => h - 6 - ((v - mn) / Math.max(1, mx - mn)) * (h - 18);
    const X = (i) => (i / (hist.length - 1)) * (w - 4) + 2;
    const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, 'rgba(255,159,67,0.35)'); gr.addColorStop(1, 'rgba(255,159,67,0)');
    g.beginPath(); g.moveTo(X(0), h); hist.forEach((v, i) => g.lineTo(X(i), Y(v))); g.lineTo(X(hist.length - 1), h); g.fillStyle = gr; g.fill();
    g.beginPath(); hist.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v)))); g.strokeStyle = '#ff9f43'; g.lineWidth = 2; g.stroke();
    g.fillStyle = '#eef1ff'; g.textAlign = 'right';
    g.fillText(`best plan value ${Math.round(mx)}  (start ${Math.round(hist[0])})`, w - 2, 11);
  }

  // ------------------------------------------------------------------
  // Brain view
  // ------------------------------------------------------------------
  function renderBrain() {
    $('brainAnn').hidden = S.brainTab !== 'ann';
    $('brainFuzzy').hidden = S.brainTab !== 'fuzzy';
    document.querySelectorAll('#brainTabs button').forEach((b) => b.classList.toggle('on', b.dataset.b === S.brainTab));
    if (S.brainTab === 'ann') renderAnn(); else renderFuzzy();
  }
  function renderAnn() {
    const e = S.cloudEval;
    if (e) {
      $('annAcc').textContent = pct(e.ann);
      $('rawAcc').textContent = pct(e.raw);
      $('annNote').innerHTML = `Accuracy at calling a shot <b>clear or cloudy</b> on ${e.n.toLocaleString('en-IN')} held-out cases the network never trained on. Training data: ${S.trainSet.source}. Network: 12 inputs (cloud layers, humidity, time of day, place, season) → 20 → 10 → 1.`;
    }
    // loss
    {
      const { g, w, h } = sizeCanvas($('annLoss'));
      const ls = S.cloudNet.losses;
      const sm = []; let m = ls[0] || 0; for (const v of ls) { m = m * 0.95 + v * 0.05; sm.push(m); }
      const mx = Math.max(...sm, 0.1);
      g.strokeStyle = 'rgba(150,170,255,0.15)'; g.beginPath(); g.moveTo(0, h - 14); g.lineTo(w, h - 14); g.stroke();
      g.beginPath(); sm.forEach((v, i) => { const x = (i / Math.max(1, sm.length - 1)) * w, y = h - 14 - (v / mx) * (h - 24); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.strokeStyle = '#2ed3b7'; g.lineWidth = 2; g.stroke();
      g.fillStyle = '#98a2c8'; g.font = '500 10.5px "JetBrains Mono", monospace';
      g.fillText(`${ls.length} training steps · loss ${(sm[sm.length - 1] || 0).toFixed(3)}`, 2, h - 2);
    }
    // scatter: forecast cloud vs predicted P(clear)
    {
      const { g, w, h } = sizeCanvas($('annCurve'));
      const L0 = 34, B = 20;
      const X = (v) => L0 + v * (w - L0 - 8), Y = (v) => h - B - v * (h - B - 8);
      g.strokeStyle = 'rgba(150,170,255,0.15)'; g.fillStyle = '#98a2c8'; g.font = '500 10.5px "JetBrains Mono", monospace';
      [0, 0.5, 1].forEach((v) => { g.beginPath(); g.moveTo(L0, Y(v)); g.lineTo(w - 8, Y(v)); g.stroke(); g.textAlign = 'right'; g.fillText(pct(v), L0 - 4, Y(v) + 4); });
      g.textAlign = 'center';
      [0, 25, 50, 75, 100].forEach((v) => g.fillText(v + '%', X(v / 100), h - 6));
      const set = S.trainSet;
      const idx = set.testIdx.slice(0, 700);
      for (const j of idx) {
        const x = set.X[j][0];
        const p = S.cloudNet.net.forward(set.X[j]);
        g.fillStyle = set.Y[j] ? 'rgba(46,211,183,0.75)' : 'rgba(255,93,115,0.6)';
        g.beginPath(); g.arc(X(x), Y(p), 2.2, 0, 7); g.fill();
      }
      g.beginPath();
      for (let v = 0; v <= 1.0001; v += 0.02) { const y = Y(rawP(v * 100)); v ? g.lineTo(X(v), y) : g.moveTo(X(v), y); }
      g.strokeStyle = 'rgba(255,255,255,0.6)'; g.setLineDash([4, 4]); g.lineWidth = 1.5; g.stroke(); g.setLineDash([]);
      g.textAlign = 'left'; g.fillStyle = '#eef1ff';
      g.fillText('dots: network’s chance of a clear shot (teal = was clear, rose = was cloudy) · dashed: trusting the raw forecast', L0 + 4, 14);
    }
  }

  function renderFuzzy() {
    const vars = Object.keys(S.fz.inputs);
    $('mfPick').innerHTML = vars.map((v) => `<button data-v="${v}" class="${v === S.mfVar ? 'on' : ''}">${S.fz.inputs[v].label}</button>`).join('') +
      `<button data-v="__out" class="${S.mfVar === '__out' ? 'on' : ''}">Value (output)</button>`;
    $('mfPick').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { S.mfVar = b.dataset.v; renderFuzzy(); }));
    const def = S.mfVar === '__out' ? S.fz.output : S.fz.inputs[S.mfVar];
    const cols = ['#ff5d73', '#ff9f43', '#2ed3b7', '#5cc8ff', '#8c7bff'];
    {
      const { g, w, h } = sizeCanvas($('mfChart'));
      const X = (v) => 6 + v * (w - 12), Y = (v) => h - 16 - v * (h - 34);
      Object.entries(def.sets).forEach(([name, abc], k) => {
        g.beginPath();
        for (let i = 0; i <= 100; i++) { const x = X(i / 100), y = Y(D.mu(i / 100, abc)); i ? g.lineTo(x, y) : g.moveTo(x, y); }
        g.strokeStyle = cols[k % cols.length]; g.lineWidth = 2; g.stroke();
        g.fillStyle = cols[k % cols.length]; g.font = '600 11px Manrope, sans-serif';
        const lx = X(abc[1]);
        g.textAlign = lx < 40 ? 'left' : lx > w - 40 ? 'right' : 'center';
        g.fillText(name, lx, Y(1) - 4);
      });
      g.fillStyle = '#98a2c8'; g.font = '500 10px "JetBrains Mono", monospace'; g.textAlign = 'left'; g.fillText('0', 4, h - 3); g.textAlign = 'right'; g.fillText('1', w - 4, h - 3);
    }
    // editor: move the peak of one set
    const names = Object.keys(def.sets);
    if (!S.mfSet || !def.sets[S.mfSet]) S.mfSet = names[Math.floor(names.length / 2)];
    $('mfEdit').innerHTML = `<span>Move the peak of <select id="mfSet">${names.map((n) => `<option ${n === S.mfSet ? 'selected' : ''}>${n}</option>`).join('')}</select> then re-plan</span>
      <input type="range" id="mfPeak" min="0" max="100" value="${Math.round(def.sets[S.mfSet][1] * 100)}">`;
    $('mfSet').addEventListener('change', (e) => { S.mfSet = e.target.value; renderFuzzy(); });
    $('mfPeak').addEventListener('input', (e) => {
      const s = def.sets[S.mfSet];
      const b = +e.target.value / 100;
      const half = (s[2] - s[0]) / 2;
      const shoulderL = s[0] === s[1], shoulderR = s[1] === s[2];
      if (shoulderL) { s[0] = b; s[1] = b; s[2] = Math.min(1, b + half * 2); }
      else if (shoulderR) { s[1] = b; s[2] = b; s[0] = Math.max(0, b - half * 2); }
      else { s[0] = Math.max(0, b - half); s[1] = b; s[2] = Math.min(1, b + half); }
      renderFuzzy();
    });
    $('mfPeak').addEventListener('change', () => { rebuildProblem(); toast('Fuzzy sets changed. Values recomputed: press <b>AI plan</b> to re-plan.'); });
    renderExplain();
    // rules
    const ex = currentExplain();
    const firedW = {}; if (ex) ex.res.fired.forEach((f) => { firedW[f.k] = f.w; });
    $('rules').innerHTML = S.fz.rules.map((r, k) => `<div class="rule ${firedW[k] ? 'fired' : ''}" data-k="${k}" style="opacity:${r.on ? 1 : 0.4};cursor:pointer">
      <span class="mono muted">R${k + 1}</span>
      <code>IF ${r.if.map(([v, s]) => `${S.fz.inputs[v].label.toLowerCase()} is <em>${s}</em>`).join(' AND ')} THEN value is <em>${r.then}</em></code>
      <span class="w">${r.on ? (firedW[k] ? firedW[k].toFixed(2) : '') : 'off'}</span></div>`).join('');
    $('rules').querySelectorAll('.rule').forEach((el) => el.addEventListener('click', () => {
      const r = S.fz.rules[+el.dataset.k];
      r.on = !r.on;
      rebuildProblem();
      toast(`Rule R${+el.dataset.k + 1} switched <b>${r.on ? 'on' : 'off'}</b>. Press <b>AI plan</b> to see how the plan changes.`);
    }));
  }
  function currentExplain() {
    let o = S.access.opps.find((x) => x.id === S.selectedOpp);
    if (!o) { const p = (S.plans[S.shown] || [])[0]; o = p || S.access.opps[0]; }
    if (!o) return null;
    const r = S.reqById[o.req];
    const x = D.fuzzyInputs(o, r, SAT_BY_ID);
    return { o, r, x, res: D.fuzzyEval(S.fz, x, true) };
  }
  function renderExplain() {
    const ex = currentExplain();
    if (!ex) return;
    $('explainWho').textContent = `${ex.r.name} · ${SAT_BY_ID[ex.o.sat].name.split(' ')[0]} ${fmtIST(ex.o.t, true)}`;
    $('explainIn').innerHTML = Object.entries(ex.x).map(([k, v]) => `${S.fz.inputs[k].label}: <span style="color:var(--text)">${v.toFixed(2)}</span>`).join(' · ');
    const { g, w, h } = sizeCanvas($('outChart'));
    const X = (v) => 6 + v * (w - 12), Y = (v) => h - 16 - v * (h - 26);
    g.beginPath(); g.moveTo(X(0), Y(0));
    for (let i = 0; i <= 100; i++) g.lineTo(X(i / 100), Y(ex.res.agg[i]));
    g.lineTo(X(1), Y(0)); g.closePath();
    g.fillStyle = 'rgba(255,159,67,0.35)'; g.fill(); g.strokeStyle = '#ff9f43'; g.lineWidth = 1.5; g.stroke();
    const cx = X(ex.res.value / 100);
    g.strokeStyle = '#fff'; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(cx, 6); g.lineTo(cx, h - 16); g.stroke(); g.setLineDash([]);
    g.fillStyle = '#fff'; g.font = '600 12px "JetBrains Mono", monospace'; g.textAlign = cx > w - 90 ? 'right' : 'left';
    g.fillText(`value ${ex.res.value.toFixed(0)}`, cx + (cx > w - 90 ? -6 : 6), 16);
    g.fillStyle = '#98a2c8'; g.font = '500 10px "JetBrains Mono", monospace'; g.textAlign = 'left';
    g.fillText('useless', 4, h - 3); g.textAlign = 'right'; g.fillText('critical', w - 4, h - 3);
  }

  async function trainCloudNet(animate) {
    const net = new D.CloudNet();
    const total = 1400;
    for (let done = 0; done < total; done += 100) {
      net.trainChunk(S.trainSet, 100, 32);
      step('train', 'run', Math.round((done / total) * 100) + '%');
      if (animate) { S.cloudNet = net; if (S.mode === 'brain') renderAnn(); }
      await nextFrame();
    }
    S.cloudNet = net;
    S.cloudEval = D.evaluateCloud(net, S.trainSet);
    return net;
  }

  // ------------------------------------------------------------------
  // Clouds on the globe
  // ------------------------------------------------------------------
  function updateClouds(force) {
    const hr = Math.floor(S.simMs / HOUR);
    if (!force && hr === S.lastCloudHour) return;
    S.lastCloudHour = hr;
    const useAct = S.day === 'past' && S.flying && S.weather.gridAct;
    S.globe.setClouds((lat, lon) => {
      const v = useAct ? S.weather.gridAt(S.weather.gridAct, lat, lon, S.simMs) : S.weather.gridAt(S.weather.grid, lat, lon, S.simMs);
      return v ? v.total / 100 : 0;
    });
  }

  // ------------------------------------------------------------------
  // Modes and controls
  // ------------------------------------------------------------------
  function setMode(m) {
    S.mode = m;
    document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    $('reqPanel').classList.toggle('away', m !== 'plan');
    $('planPanel').classList.toggle('away', m !== 'plan');
    $('brain').hidden = m !== 'brain';
    if (m === 'fly') {
      $('detail').hidden = true;
      if (!S.follow) { S.follow = 'carto3'; $('followSat').value = 'carto3'; }
      S.globe.followSat(S.follow);
      if (!S.flying) startFly();
    } else {
      if (S.flying) stopFly();
      S.globe.follow = null;
      if (m === 'plan') S.globe.flyTo(20, 80, 3.4);
      if (m === 'brain') { S.globe.flyTo(20, 72, 3.9); renderBrain(); }
    }
    renderDetail();
  }

  function bindUI() {
    document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    document.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', async () => {
      if (S.day === b.dataset.day || S.loading) return;
      document.querySelectorAll('[data-day]').forEach((x) => x.classList.toggle('on', x === b));
      S.loading = true;
      toast(b.dataset.day === 'past' ? 'Loading a past day: what was forecast, and what the clouds <b>actually</b> did…' : 'Loading the next 48 hours…');
      await loadDay(b.dataset.day);
      S.loading = false;
      toast(b.dataset.day === 'past'
        ? `<b>${fmtIST(S.startMs, true)}</b> loaded. Plans are made from the forecast; the scoreboard checks them against the real clouds.`
        : '<b>Next 48 hours</b> loaded.', 'good');
    }));
    $('reqFilters').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      S.filter = b.dataset.f;
      $('reqFilters').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      renderReqList();
    }));
    $('btnAI').addEventListener('click', runAI);
    $('btnShow').addEventListener('click', showMe);
    $('albumClose').addEventListener('click', () => { $('album').hidden = true; });
    $('albumFly').addEventListener('click', () => { $('album').hidden = true; S.shown = 'ai'; renderAll(); setMode('fly'); });
    $('btnManual').addEventListener('click', () => {
      S.manual = !S.manual;
      $('btnManual').classList.toggle('on', S.manual);
      $('hint').hidden = !S.manual;
      $('hint').textContent = 'Click passes (◆) on the timeline to add or remove shots. Teal = likely clear, rose = likely cloudy.';
      if (S.manual) { S.shown = 'you'; renderAll(); }
    });
    ['useANN', 'useFuzzy', 'useGA'].forEach((id) => $(id).addEventListener('change', () => {
      toast(`${$(id).checked ? 'Switched on' : 'Switched off'}: ${$(id).parentElement.querySelector('span').firstChild.textContent}. Press <b>AI plan</b> to compare.`);
    }));
    $('btnAdd').addEventListener('click', () => {
      S.adding = !S.adding;
      $('btnAdd').classList.toggle('on', S.adding);
      $('globe').classList.toggle('adding', S.adding);
      $('hint').hidden = !S.adding;
      $('hint').textContent = 'Click anywhere over India to place your request.';
    });
    $('btnPlay').addEventListener('click', () => { if (S.flying) stopFly(); else startFly(); });
    $('btnNext').addEventListener('click', () => {
      const next = shownPlan().find((o) => o.t > S.simMs + 60000);
      if (!next) { toast('No more planned shots in this window.'); return; }
      S.simMs = next.t - 90000;
      if (S.flying) { S.shotIdx = S.flyPlan.findIndex((o) => o.t >= S.simMs); if (S.shotIdx < 0) S.shotIdx = S.flyPlan.length; }
      else startFly();
      S.follow = next.sat; $('followSat').value = next.sat; S.globe.followSat(next.sat);
      S.globe.updateSatellites(S.simMs);
    });
    $('followSat').innerHTML = '<option value="">Free camera</option>' + D.SATELLITES.map((s) => `<option value="${s.id}">Follow ${s.name}</option>`).join('');
    $('followSat').addEventListener('change', (e) => { S.follow = e.target.value; if (S.follow) S.globe.followSat(S.follow); else S.globe.follow = null; });
    $('brainTabs').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { S.brainTab = b.dataset.b; renderBrain(); }));
    $('btnRetrain').addEventListener('click', async () => {
      $('btnRetrain').disabled = true;
      D.splitSet(S.trainSet);
      await trainCloudNet(true);
      rebuildProblem();
      renderAnn();
      $('btnRetrain').disabled = false;
      toast(`Retrained. Neural network ${pct(S.cloudEval.ann)} vs raw forecast ${pct(S.cloudEval.raw)}.`, 'good');
    });

    // timeline
    const tl = $('timeline');
    tl.addEventListener('mousemove', (e) => {
      const { opp } = tlHit(e);
      const tip = $('tip');
      if (!opp) { tip.hidden = true; return; }
      const r = S.reqById[opp.req], sat = SAT_BY_ID[opp.sat];
      tip.innerHTML = `<b>${r.name}</b><div class="muted" style="margin-bottom:4px">${sat.name} · ${fmtIST(opp.t, true)} IST</div>
        <div class="row"><span>Look angle</span><span>${opp.off.toFixed(0)}°</span></div>
        <div class="row"><span>Clear-sky chance</span><span>${sat.sensor === 'sar' ? 'radar' : opp.sunEl < 10 ? 'dark' : pct(opp.p0)}</span></div>
        ${S.day === 'past' && sat.sensor !== 'sar' ? `<div class="row"><span>Actually was</span><span>${opp.actual ? 'clear' : 'cloudy'}${opp.actTotal !== undefined && opp.actTotal !== null ? ` (${Math.round(opp.actTotal)}%)` : ''}</span></div>` : ''}
        <div class="row"><span>Fuzzy value</span><span>${Math.round(opp.v0)}</span></div>`;
      tip.hidden = false;
      tip.style.left = Math.min(window.innerWidth - 290, e.clientX + 12) + 'px';
      tip.style.top = (e.clientY - tip.offsetHeight - 12) + 'px';
    });
    tl.addEventListener('mouseleave', () => { $('tip').hidden = true; });
    tl.addEventListener('click', (e) => {
      const { opp, time } = tlHit(e);
      if (opp) {
        S.selectedOpp = opp.id;
        if (S.manual) toggleManual(opp);
        else { selectReq(opp.req, true); drawTimeline(); }
        if (S.mode === 'brain') renderFuzzy();
      } else if (time) {
        S.simMs = time;
        S.globe.updateSatellites(S.simMs);
        S.globe.setSun(new Date(S.simMs));
        updateClouds();
        drawTimeline();
      }
    });

    // globe: pick pins / add requests / hover labels
    const cv = $('globe');
    let down = null;
    cv.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    cv.addEventListener('pointerup', async (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
      const hit = S.globe.pick(e.clientX, e.clientY);
      if (!hit) return;
      if (S.adding && hit.ground) {
        const { lat, lon } = hit.ground;
        if (lat < 5 || lat > 37 || lon < 65 || lon > 98) { toast('Pick a spot over India and its seas: that is where the fleet is being planned.', 'bad'); return; }
        addUserRequest(lat, lon);
      } else if (hit.req) selectReq(hit.req.id, false);
    });
    cv.addEventListener('mousemove', (e) => {
      if (S.adding) return;
      const hit = S.globe.pick(e.clientX, e.clientY);
      const tip = $('tip');
      if (hit && hit.req) {
        const r = hit.req;
        tip.innerHTML = `<b>${ICONS[r.type] || ''} ${r.name}</b><div class="muted">${r.source === 'event' ? 'Live event · ' + r.detail : r.source === 'user' ? 'Your request' : 'Standing request'} · urgency ${pct(r.urgency)}</div>`;
        tip.hidden = false;
        tip.style.left = (e.clientX + 14) + 'px'; tip.style.top = (e.clientY + 14) + 'px';
        cv.style.cursor = 'pointer';
      } else if (!tip.matches(':hover')) { tip.hidden = true; cv.style.cursor = ''; }
    });
    window.addEventListener('resize', () => { drawTimeline(); drawGA(); if (S.mode === 'brain') renderBrain(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('album').hidden = true; $('detail').hidden = true; S.selectedReq = null; if (S.adding) $('btnAdd').click(); } });
  }

  let userN = 1;
  async function addUserRequest(lat, lon) {
    const type = $('addType').value;
    const r = D.makeRequest({ name: `Your ${$('addType').selectedOptions[0].textContent.toLowerCase()} #${userN++}`, lat, lon, type, urgency: +$('addUrg').value / 100, waitDays: 0, source: 'user', detail: 'Added by you' });
    S.requests.push(r); S.reqById[r.id] = r;
    // weather for the new point (live if possible)
    try {
      if (S.weather.kind === 'live') {
        const a = S.startMs - 6 * HOUR, b = S.startMs + 54 * HOUR;
        if (S.day === 'today') S.weather.req[r.id] = (await L.fetchForecast([r]))[0];
        else { S.weather.req[r.id] = (await L.fetchPastForecast([r], a, b))[0]; S.weather.reqAct[r.id] = (await L.fetchActual([r], a, b))[0]; }
      }
    } catch (e) { /* fall back to the grid */ }
    const acc = D.computeAccess(S.fleet, [r], S.startMs, H48, 20);
    S.access.opps.push(...acc.opps);
    S.access.opps.sort((a, b) => a.t - b.t);
    S.globe.setRequests(S.requests);
    rebuildProblem();
    selectReq(r.id, false);
    toast(`<b>${r.name}</b> added · ${acc.opps.length} passes in the next 48 h. Press <b>AI plan</b> to fit it in.`, 'good');
    $('btnAdd').click();
  }

  // ------------------------------------------------------------------
  // Main loop
  // ------------------------------------------------------------------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(100, now - last);
    last = now;
    try {
      if (S.gaRun) gaTick();
      if (S.flying) {
        flyTick(dt);
        S.globe.setSun(new Date(S.simMs));
        S.globe.updateSatellites(S.simMs);
        updateClouds();
        const links = S.access.contacts.filter((c) => c.start <= S.simMs && c.end >= S.simMs);
        S.globe.setDownlinks(links);
        if (Math.floor(now / 120) !== Math.floor((now - dt) / 120)) drawTimeline();
      }
      $('clock').textContent = fmtIST(S.simMs, true) + ' IST';
      S.globe.render();
    } catch (err) { console.error(err); }
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  async function boot() {
    S.globe = new window.Globe($('globe'));
    S.globe.addStations(D.STATIONS);
    S.globe.setSun(new Date());
    requestAnimationFrame(frame);
    bindUI();

    // 1. orbits
    step('orbit', 'run');
    S.tles = {};
    const tl = await Promise.allSettled(D.SATELLITES.map((s) => L.fetchTLE(s.norad)));
    let liveCount = 0;
    tl.forEach((res, i) => { if (res.status === 'fulfilled') { S.tles[D.SATELLITES[i].id] = res.value; liveCount++; } });
    S.orbitLive = liveCount > 0;
    step('orbit', liveCount ? 'ok' : 'fb', liveCount ? `${liveCount}/3 live TLE` : 'approximate orbits');
    chip('chipOrbit', !!liveCount, liveCount ? 'Orbits: live CelesTrak' : 'Orbits: approximate');

    // 2. events
    step('events', 'run');
    let events = [];
    try { events = await L.fetchEvents(); step('events', 'ok', events.length + ' open events'); chip('chipEvents', true, `Events: ${events.length} live`); }
    catch (e) { step('events', 'fb', 'unreachable'); chip('chipEvents', false, 'Events: offline'); }
    S.requests = events.map((e) => D.makeRequest(e)).concat(D.STANDING.map((r) => D.makeRequest(r)));
    S.requests.forEach((r) => { S.reqById[r.id] = r; });
    S.globe.setRequests(S.requests);

    // 3+4. training data and ANN
    step('train', 'run', 'getting history');
    S.trainSet = D.splitSet(await loadTrainingSet());
    await trainCloudNet(false);
    step('train', S.trainSet.live ? 'ok' : 'fb', `${pct(S.cloudEval.ann)} accurate`);

    // 5. the day
    await loadDay('today');
    S.globe.addSatellites(S.fleet);
    S.globe.updateSatellites(S.simMs);
    await new Promise((r) => setTimeout(r, 500));
    $('loader').classList.add('done');
    setTimeout(() => $('loader').remove(), 900);
    S.globe.flyTo(21, 80, 3.4, 2600);
    toast(`<b>${S.requests.length} imaging requests</b> waiting, ${S.access.opps.length} satellite passes in the next 48 hours. Press <b>📸 Show me the photos</b> to see what the AI changes.`, 'good', null, 7000);
  }

  boot();
})();
