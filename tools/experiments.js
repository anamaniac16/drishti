// Experiment suite for the report. Uses the built-in weather model and
// approximate orbits so every number is reproducible offline.
//   node tools/experiments.js      -> results/experiments.json
require('../js/core.js');
global.window = global;
require('../js/geo-data.js');
const D = globalThis.Drishti;
const fs = require('fs');
const HOUR = 3600000;
const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const satById = {}; D.SATELLITES.forEach((s) => { satById[s.id] = s; });
const out = { generatedAt: new Date().toISOString() };
const t00 = Date.now();

// ------------------------------------------------------------------
// 1. Functional tests
// ------------------------------------------------------------------
const tests = [];
const test = (name, fn) => { try { tests.push({ name, pass: true, detail: fn() }); } catch (e) { tests.push({ name, pass: false, detail: e.message }); } };
const assert = (c, m) => { if (!c) throw new Error(m); };

test('Orbit period matches Kepler for each satellite', () => {
  const start = Date.UTC(2026, 9, 24);
  return D.SATELLITES.map((sat) => {
    const orb = D.makeOrbit(sat, null, new Date(start));
    // time between two ascending equator crossings
    let prev = orb.at(new Date(start)).ecef[2], cross = [];
    for (let s = 20; s < 4 * 3600; s += 2) {
      const z = orb.at(new Date(start + s * 1000)).ecef[2];
      if (prev < 0 && z >= 0) cross.push(s);
      prev = z;
    }
    const period = (cross[1] - cross[0]) / 60;
    const a = 6371 + sat.altKm, kepler = (2 * Math.PI * Math.sqrt(a ** 3 / 398600.4418)) / 60;
    assert(Math.abs(period - kepler) < 0.2, `${sat.name}: ${period} vs ${kepler}`);
    return `${sat.name} ${period.toFixed(2)} min (Kepler ${kepler.toFixed(2)})`;
  }).join('; ');
});

test('Pass timing does not depend on the 20 s time step (vs 5 s)', () => {
  const start = Date.UTC(2026, 9, 24);
  const fleet = D.SATELLITES.map((sat) => ({ sat, orbit: D.makeOrbit(sat, null, new Date(start)) }));
  const reqs = D.STANDING.slice(0, 12).map(D.makeRequest);
  const a = D.computeAccess(fleet, reqs, start, 24, 20), b = D.computeAccess(fleet, reqs, start, 24, 5);
  let worst = 0, matched = 0;
  for (const o of a.opps) {
    const m = b.opps.filter((x) => x.req === o.req && x.sat === o.sat).sort((x, y) => Math.abs(x.t - o.t) - Math.abs(y.t - o.t))[0];
    if (m && Math.abs(m.t - o.t) < 120000) { matched++; worst = Math.max(worst, Math.abs(m.t - o.t) / 1000); }
  }
  assert(matched >= a.opps.length - 2, `matched ${matched}/${a.opps.length}`);
  return `${matched}/${a.opps.length} passes matched (5 s: ${b.opps.length}), worst timing difference ${worst.toFixed(0)} s`;
});

test('Optical passes in daylight sit near the satellite\'s design local time', () => {
  const start = Date.UTC(2026, 9, 24);
  const fleet = D.SATELLITES.map((sat) => ({ sat, orbit: D.makeOrbit(sat, null, new Date(start)) }));
  const reqs = D.STANDING.map(D.makeRequest);
  const acc = D.computeAccess(fleet, reqs, start, 48, 20);
  const res = [];
  for (const sat of D.SATELLITES.filter((s) => s.sensor === 'optical')) {
    const lt = acc.opps.filter((o) => o.sat === sat.id && o.sunEl > 0).map((o) => {
      const r = reqs.find((q) => q.id === o.req);
      return ((new Date(o.t).getUTCHours() + new Date(o.t).getUTCMinutes() / 60 + r.lon / 15) % 24 + 24) % 24;
    });
    const m = mean(lt);
    assert(Math.abs(m - sat.ltdnHours) < 1.2, `${sat.name} ${m}`);
    res.push(`${sat.name} ${m.toFixed(1)} h (design ${sat.ltdnHours} h)`);
  }
  return res.join('; ');
});

test('Fuzzy value: no rule-coverage holes, rises with urgency, near-monotone in clear sky', () => {
  const fz = D.defaultFuzzy();
  let worst = 0, holes = 0, curves = 0;
  for (const u of [0, 0.2, 0.4, 0.5, 0.6, 0.8, 1]) for (const w of [0, 0.3, 0.5, 0.8, 1]) for (const q of [0.1, 0.4, 0.7, 1]) for (const f of [0.6, 0.8, 1]) {
    let prev = -1; curves++;
    for (let c = 0; c <= 1.0001; c += 0.025) {
      const v = D.fuzzyEval(fz, { urgency: u, waiting: w, clear: c, quality: q, fit: f });
      if (c >= 0.5 && v < 1) holes++;
      if (prev >= 0) worst = Math.max(worst, prev - v);
      prev = v;
    }
  }
  assert(holes === 0, holes + ' input combinations fire no rule');
  assert(worst <= 5, 'drop of ' + worst.toFixed(1));
  const lo = D.fuzzyEval(fz, { urgency: 0.1, waiting: 0.3, clear: 0.9, quality: 0.7, fit: 1 });
  const hi = D.fuzzyEval(fz, { urgency: 0.9, waiting: 0.3, clear: 0.9, quality: 0.7, fit: 1 });
  assert(hi > lo, 'urgency');
  return `${curves} input curves, 41 points each: no holes, largest dip ${worst.toFixed(1)} points; low urgency ${lo.toFixed(0)} vs high ${hi.toFixed(0)}`;
});

// shared day setup
function makeDay(seed, dayOffset) {
  D.seed(seed);
  const start = Date.UTC(2026, 9, 10 + dayOffset, 0, 0, 0) - 5.5 * HOUR;
  const W = new D.SyntheticWeather(seed);
  const fleet = D.SATELLITES.map((sat) => ({ sat, orbit: D.makeOrbit(sat, null, new Date(start)) }));
  const requests = D.STANDING.map(D.makeRequest);
  // two "live events" per day, as EONET would add
  const r = D.mulberry32(seed * 7 + 1);
  for (let k = 0; k < 3; k++) requests.push(D.makeRequest({ name: 'Event ' + k, lat: 9 + r() * 24, lon: 70 + r() * 22, type: ['flood', 'wildfire', 'cyclone'][k], urgency: 0.85 + r() * 0.15, waitDays: 0, source: 'event' }));
  const reqById = {}; requests.forEach((q) => { reqById[q.id] = q; });
  const access = D.computeAccess(fleet, requests, start, 48, 20);
  const set = D.splitSet(D.syntheticTrainingSet(W, 40, 60, start - 7 * 86400000));
  const cn = new D.CloudNet();
  for (let i = 0; i < 40; i++) cn.trainChunk(set, 50);
  const ev = D.evaluateCloud(cn, set);
  for (const o of access.opps) {
    const q = reqById[o.req];
    if (o.sensor === 'sar') { o.pAnn = o.pRaw = 0.97; o.truth = 1; continue; }
    if (o.sunEl < 10) { o.pAnn = o.pRaw = 0; o.truth = 0; continue; }
    const fc = W.forecast(q.lat, q.lon, o.t, (o.t - start) / HOUR + 6);
    o.fc = fc;
    o.pAnn = cn.predict(fc, q.lat, q.lon, new Date(o.t));
    o.pRaw = D.clamp(1 - (fc.total / 100) * 1.4, 0, 1);
    o.truthTotal = W.truth(q.lat, q.lon, o.t).total;
    o.truth = o.truthTotal < D.CLEAR_LIMIT ? 1 : 0;
  }
  return { seed, start, W, fleet, requests, reqById, access, cn, ev };
}
function setValues(day, useANN, useFuzzy) {
  const fz = D.defaultFuzzy();
  for (const o of day.access.opps) {
    o.pClear = useANN ? o.pAnn : o.pRaw;
    const x = D.fuzzyInputs(o, day.reqById[o.req], satById);
    o.value = useFuzzy ? D.fuzzyEval(fz, x) : D.crispValue(x);
  }
}
function canonical(day) { const fz = D.defaultFuzzy(); for (const o of day.access.opps) { o.pClear = o.pAnn; o.v0 = D.fuzzyEval(fz, D.fuzzyInputs(o, day.reqById[o.req], satById)); } }
function judge(day, plan) {
  const served = new Set(plan.map((o) => o.req));
  const usable = plan.reduce((s, o) => s + o.truth, 0);
  const usableReqs = new Set(plan.filter((o) => o.truth).map((o) => o.req));
  let urgentAsked = 0, urgentGot = 0;
  for (const q of day.requests) if (q.urgency >= 0.6) { urgentAsked++; if (usableReqs.has(q.id)) urgentGot++; }
  return { shots: plan.length, usable, wasted: plan.length - usable, served: served.size, usableTargets: usableReqs.size, urgentGot, urgentAsked, rate: plan.length ? usable / plan.length : 0 };
}
function feasible(prob, plan) {
  // independent check of every constraint
  const bySat = {};
  for (const o of plan) (bySat[o.sat] = bySat[o.sat] || []).push(o);
  for (const id in bySat) {
    const sat = satById[id], list = bySat[id].sort((a, b) => a.t - b.t);
    if (list.length > sat.maxShots) return 'power';
    const segs = {};
    for (const o of list) { let s = 0; for (const c of prob.dl[id]) if (c <= o.t) s++; segs[s] = (segs[s] || 0) + 1; if (segs[s] > sat.memory) return 'memory'; }
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      if (b.t - a.t < 8000 + (Math.abs(a.roll - b.roll) / sat.slewDegPerS + sat.settleS) * 1000) return 'slew';
    }
  }
  if (new Set(plan.map((o) => o.req)).size !== plan.length) return 'duplicate';
  return null;
}

// ------------------------------------------------------------------
// 2. Planning: 8 days, every plan scored against the "real" clouds
// ------------------------------------------------------------------
const DAYS = [[11, 0], [22, 1], [33, 2], [44, 3], [55, 4], [66, 5], [77, 6], [88, 7]];
const rows = [], annRows = [], curves = [];
let feasibleAll = true;
for (const [seed, off] of DAYS) {
  const day = makeDay(seed, off);
  annRows.push(day.ev);
  const plans = {};
  // baselines use the canonical values (ANN + fuzzy) like the app
  setValues(day, true, true);
  let prob = D.buildProblem(day.requests, day.access, day.fleet);
  plans.fcfs = D.planFCFS(prob);
  plans.greedy = D.planGreedy(prob);
  D.seed(seed + 1);
  let ga = new D.GA(prob, { pop: 70 });
  for (let g = 0; g < 160; g++) ga.step();
  plans.ai = ga.best.plan;
  curves.push(ga.history.slice());
  // ablations
  setValues(day, false, true); prob = D.buildProblem(day.requests, day.access, day.fleet);
  D.seed(seed + 1); ga = new D.GA(prob, { pop: 70 }); for (let g = 0; g < 160; g++) ga.step(); plans.noANN = ga.best.plan;
  setValues(day, true, false); prob = D.buildProblem(day.requests, day.access, day.fleet);
  D.seed(seed + 1); ga = new D.GA(prob, { pop: 70 }); for (let g = 0; g < 160; g++) ga.step(); plans.noFuzzy = ga.best.plan;
  setValues(day, true, true); prob = D.buildProblem(day.requests, day.access, day.fleet);
  for (const k of ['greedy', 'ai', 'noANN', 'noFuzzy']) { const f = feasible(prob, plans[k]); if (f) { feasibleAll = false; console.log('INFEASIBLE', k, f); } }
  const row = { seed, opps: day.access.opps.length, ann: day.ev.ann, raw: day.ev.raw };
  for (const k in plans) row[k] = judge(day, plans[k]);
  rows.push(row);
  console.log('day', seed, 'opps', row.opps, 'ANN', (day.ev.ann * 100).toFixed(1), 'raw', (day.ev.raw * 100).toFixed(1),
    Object.keys(plans).map((k) => `${k} ${row[k].usable}/${row[k].shots}`).join('  '));
}
test('Every plan obeys slew, memory, power and one-shot-per-target limits', () => { assert(feasibleAll, 'violation'); return 'checked independently on 32 plans'; });
const agg = (k, f) => ({ mean: mean(rows.map((r) => f(r[k]))), sd: sd(rows.map((r) => f(r[k]))) });
out.planning = {
  days: rows.length, requestsPerDay: D.STANDING.length + 3, oppsPerDay: mean(rows.map((r) => r.opps)),
  table: ['fcfs', 'greedy', 'noANN', 'noFuzzy', 'ai'].map((k) => ({
    plan: k, shots: agg(k, (x) => x.shots), usable: agg(k, (x) => x.usable), wasted: agg(k, (x) => x.wasted),
    rate: agg(k, (x) => x.rate), usableTargets: agg(k, (x) => x.usableTargets), urgent: agg(k, (x) => x.urgentGot / x.urgentAsked),
  })),
  rows,
};
const L = Math.min(...curves.map((c) => c.length));
out.gaCurve = Array.from({ length: L }, (_, i) => mean(curves.map((c) => c[i] / c[c.length - 1])));
out.ann = { acc: mean(annRows.map((e) => e.ann)), accSd: sd(annRows.map((e) => e.ann)), raw: mean(annRows.map((e) => e.raw)), brierAnn: mean(annRows.map((e) => e.brierAnn)), brierRaw: mean(annRows.map((e) => e.brierRaw)), nTest: annRows[0].n };
console.log('ANN', out.ann);
out.planning.table.forEach((t) => console.log(t.plan.padEnd(8), 'usable', t.usable.mean.toFixed(1), 'wasted', t.wasted.mean.toFixed(1), 'rate', (t.rate.mean * 100).toFixed(1) + '%', 'targets', t.usableTargets.mean.toFixed(1), 'urgent', (t.urgent.mean * 100).toFixed(0) + '%'));

// ------------------------------------------------------------------
// 3. Click a place: 60 random spots over India, mission filter funnel
// ------------------------------------------------------------------
function onLand(lat, lon) {
  let inside = false;
  for (const ring of window.GEO.land) {
    let hit = false;
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
    }
    if (hit) inside = !inside;
  }
  return inside;
}
{
  const day = makeDay(11, 0);
  setValues(day, true, true);
  const prob = D.buildProblem(day.requests, day.access, day.fleet);
  canonical(day);
  const plan = D.planGreedy(prob);
  const rnd = D.mulberry32(2026);
  const fz = D.defaultFuzzy();
  const funnel = [0, 0, 0, 0, 0, 0, 0], shotsN = [], usableN = [], latency = [], noShot = [];
  let spots = 0;
  while (spots < 60) {
    const lat = 8 + rnd() * 26, lon = 69 + rnd() * 26;
    if (!onLand(lat, lon)) continue;
    spots++;
    const req = D.makeRequest({ id: 'x' + spots, name: 'spot', lat, lon, type: 'crop', urgency: 0.8 });
    const wide = day.fleet.map((f) => ({ sat: Object.assign({}, f.sat, { maxRollDeg: 55 }), orbit: f.orbit }));
    const acc = D.computeAccess(wide, [req], day.start, 48, 20);
    let live = acc.opps.slice();
    funnel[0] += live.length;
    live = live.filter((o) => o.off <= satById[o.sat].maxRollDeg); funnel[1] += live.length;
    live = live.filter((o) => o.sensor === 'sar' || o.sunEl >= 10); funnel[2] += live.length;
    for (const o of live) {
      if (o.sensor === 'sar') { o.pClear = 0.97; o.truth = 1; continue; }
      const fc = day.W.forecast(lat, lon, o.t, (o.t - day.start) / HOUR + 6);
      o.pClear = day.cn.predict(fc, lat, lon, new Date(o.t));
      o.truth = day.W.truth(lat, lon, o.t).total < D.CLEAR_LIMIT ? 1 : 0;
    }
    live = live.filter((o) => o.pClear >= 0.35); funnel[3] += live.length;
    for (const o of live) o.value = D.fuzzyEval(fz, D.fuzzyInputs(o, req, satById));
    live = live.filter((o) => o.value >= 15); funnel[4] += live.length;
    live = live.filter((o) => {
      const sat = satById[o.sat];
      const clash = plan.find((p) => p.sat === o.sat && Math.abs(p.t - o.t) < 8000 + (Math.abs(p.roll - o.roll) / sat.slewDegPerS + sat.settleS) * 1000);
      return !clash || o.value > clash.v0 + 5;
    });
    funnel[5] += live.length;
    const ranked = live.slice().sort((a, b) => b.value - a.value), shots = [];
    for (const o of ranked) if (!shots.some((x) => x.sat === o.sat)) shots.push(o);
    funnel[6] += shots.length;
    shotsN.push(shots.length);
    const good = shots.filter((o) => o.truth);
    usableN.push(good.length);
    if (!shots.length) noShot.push(1);
    if (good.length) {
      const first = good.sort((a, b) => a.t - b.t)[0];
      const c = acc.contacts.filter((x) => x.sat === first.sat && x.start >= first.t).sort((a, b) => a.start - b.start)[0];
      if (c) latency.push((c.start - day.start) / HOUR);
    }
  }
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  out.mission = {
    spots, funnel: funnel.map((v) => v / spots),
    labels: ['Overflights', 'Tilt limit', 'Daylight', 'Clouds (ANN)', 'Fuzzy value', 'Free satellite', 'Shots'],
    shotsMean: mean(shotsN), usableMean: mean(usableN), noShotPct: noShot.length / spots,
    atLeastOneUsable: usableN.filter((v) => v > 0).length / spots,
    shotUsableRate: usableN.reduce((s, v) => s + v, 0) / Math.max(1, shotsN.reduce((s, v) => s + v, 0)),
    latencyMedianH: med(latency), latencyMinH: Math.min(...latency), latencyMaxH: Math.max(...latency),
  };
  console.log('mission', out.mission);
}

out.tests = tests;
tests.forEach((t) => console.log(t.pass ? 'PASS' : 'FAIL', t.name, '·', t.detail));
out.runtimeS = (Date.now() - t00) / 1000;
fs.mkdirSync(__dirname + '/../results', { recursive: true });
fs.writeFileSync(__dirname + '/../results/experiments.json', JSON.stringify(out, null, 1));
console.log('saved', out.runtimeS.toFixed(0) + ' s');
