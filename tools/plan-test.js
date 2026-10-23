// Headless run of a full planning day with the built-in fallbacks.
//   node tools/plan-test.js
require('../js/core.js');
const D = globalThis.Drishti;
D.seed(5);
const t0 = Date.now();
const start = Date.UTC(2026, 9, 24, 0, 0, 0);
const fleet = D.SATELLITES.map((sat) => ({ sat, orbit: D.makeOrbit(sat, null, new Date(start)) }));
const requests = D.STANDING.map(D.makeRequest);
const access = D.computeAccess(fleet, requests, start, 48, 20);
console.log('opps', access.opps.length, 'contacts', access.contacts.length, (Date.now() - t0) + 'ms');
const per = {}; access.opps.forEach(o => per[o.sat] = (per[o.sat] || 0) + 1); console.log(per);
console.log('contacts', access.contacts.map(c => c.sat + '@' + c.station + ' ' + new Date(c.start).toISOString().slice(11, 16)).join(', '));
// weather + ANN
const W = new D.SyntheticWeather(11);
const set = D.splitSet(D.syntheticTrainingSet(W, 40, 60, start));
const cn = new D.CloudNet();
for (let i = 0; i < 30; i++) cn.trainChunk(set, 50);
console.log('cloud ANN', D.evaluateCloud(cn, set), 'loss', cn.losses.slice(-1)[0].toFixed(3));
// values
const fz = D.defaultFuzzy();
const satById = {}; D.SATELLITES.forEach(s => satById[s.id] = s);
const reqById = {}; requests.forEach(r => reqById[r.id] = r);
for (const o of access.opps) {
  const r = reqById[o.req];
  if (o.sensor === 'sar') o.pClear = 0.97;
  else if (o.sunEl < 10) o.pClear = 0;
  else o.pClear = cn.predict(W.forecast(r.lat, r.lon, o.t, (o.t - start) / 3600000 + 6), r.lat, r.lon, new Date(o.t));
  o.value = D.fuzzyEval(fz, D.fuzzyInputs(o, r, satById));
}
const prob = D.buildProblem(requests, access, fleet);
const ga = new D.GA(prob);
for (let i = 0; i < 150; i++) ga.step();
const truthUsable = (plan) => plan.reduce((s, o) => { const r = reqById[o.req]; if (o.sensor === 'sar') return s + 1; if (o.sunEl < 10) return s; return s + (W.truth(r.lat, r.lon, o.t).total < D.CLEAR_LIMIT ? 1 : 0); }, 0);
for (const [name, plan] of [['FCFS', D.planFCFS(prob)], ['Greedy', D.planGreedy(prob)], ['GA', ga.best.plan]]) {
  const s = D.scorePlan(plan);
  const served = new Set(plan.map(o => o.req)).size;
  const urgent = plan.filter(o => reqById[o.req].urgency >= 0.5).length;
  console.log(name.padEnd(7), 'value', s.value.toFixed(0), 'shots', s.shots, 'served', served, 'urgent', urgent, 'expected usable', s.expected.toFixed(1), 'ACTUAL usable', truthUsable(plan));
}
console.log('GA history', ga.history.filter((_, i) => i % 25 === 0).map(v => v.toFixed(0)).join(' '), (Date.now() - t0) + 'ms');
