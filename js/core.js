/*
 * core.js
 * DRISHTI planning engine. No DOM code, so it runs in the browser and in Node.
 *
 *   orbits    - satellite positions (SGP4 from live TLEs via satellite.js,
 *               or a sun-synchronous circular orbit as a fallback)
 *   access    - when each satellite can see each target, and ground contacts
 *   ANN       - multilayer perceptron that predicts P(clear sky) at the
 *               moment of a pass, learned from past forecasts vs reality
 *   fuzzy     - Mamdani fuzzy system that scores each imaging opportunity
 *   GA        - genetic algorithm that builds the day's imaging schedule
 *               under slew, memory and power limits
 */
(function (root) {
  'use strict';

  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const RE = 6371;               // km
  const MU = 398600.4418;        // km^3/s^2
  const DAY = 86400000;

  // ------------------------------------------------------------------
  // Random numbers
  // ------------------------------------------------------------------
  function mulberry32(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  let rand = mulberry32(20261023);
  const random = () => rand();
  const seed = (s) => { rand = mulberry32(s); };
  const randInt = (n) => Math.floor(rand() * n);
  function gauss() {
    let u = 0;
    while (u === 0) u = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  }
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  // ------------------------------------------------------------------
  // The fleet, ground stations and standing requests
  // ------------------------------------------------------------------
  const SATELLITES = [
    {
      id: 'carto3', name: 'Cartosat-3', norad: 44804, sensor: 'optical',
      altKm: 509, incDeg: 97.5, ltdnHours: 9.5, phaseDeg: 40,
      maxRollDeg: 40, slewDegPerS: 2.5, settleS: 10, memory: 7, maxShots: 16,
      resolution: '0.25 m', colour: '#ff9f43',
    },
    {
      id: 'rs2a', name: 'Resourcesat-2A', norad: 41877, sensor: 'optical',
      altKm: 817, incDeg: 98.7, ltdnHours: 10.5, phaseDeg: 200,
      maxRollDeg: 26, slewDegPerS: 1.0, settleS: 20, memory: 5, maxShots: 12,
      resolution: '5.8 m', colour: '#2ed3b7',
    },
    {
      id: 'eos4', name: 'EOS-04 (radar)', norad: 51656, sensor: 'sar',
      altKm: 529, incDeg: 97.5, ltdnHours: 6.0, phaseDeg: 300,
      maxRollDeg: 35, slewDegPerS: 1.5, settleS: 15, memory: 4, maxShots: 10,
      resolution: '1 m', colour: '#8c7bff',
    },
  ];

  const STATIONS = [
    { id: 'shadnagar', name: 'NRSC Shadnagar', lat: 17.03, lon: 78.18 },
    { id: 'bharati', name: 'Bharati, Antarctica', lat: -69.41, lon: 76.19 },
  ];

  // How useful each sensor is for each kind of request (0..1).
  const SUITABILITY = {
    flood: [0.6, 1.0], cyclone: [0.5, 0.9], wildfire: [1.0, 0.3], crop: [1.0, 0.6],
    urban: [1.0, 0.6], glacier: [0.9, 0.8], forest: [0.9, 0.7], coast: [0.9, 0.7],
    water: [0.9, 0.8], landslide: [0.9, 0.6], energy: [1.0, 0.4], volcano: [0.9, 0.6],
    haze: [1.0, 0.1], ice: [0.9, 0.8], drought: [1.0, 0.5], default: [0.8, 0.6],
  };
  function suitability(type, sensor) {
    const s = SUITABILITY[type] || SUITABILITY.default;
    return sensor === 'sar' ? s[1] : s[0];
  }

  const STANDING = [
    { name: 'Ludhiana wheat sowing', lat: 30.90, lon: 75.85, type: 'crop', urgency: 0.45, waitDays: 3 },
    { name: 'Sundarbans mangroves', lat: 21.95, lon: 88.90, type: 'forest', urgency: 0.35, waitDays: 6 },
    { name: 'Gangotri glacier', lat: 30.92, lon: 79.08, type: 'glacier', urgency: 0.40, waitDays: 9 },
    { name: 'Chennai coastline', lat: 13.08, lon: 80.29, type: 'coast', urgency: 0.40, waitDays: 2 },
    { name: 'Delhi urban growth', lat: 28.61, lon: 77.21, type: 'urban', urgency: 0.25, waitDays: 4 },
    { name: 'Kaziranga floodplain', lat: 26.58, lon: 93.17, type: 'flood', urgency: 0.55, waitDays: 1 },
    { name: 'Mumbai port', lat: 18.95, lon: 72.84, type: 'urban', urgency: 0.30, waitDays: 2 },
    { name: 'Rann of Kutch', lat: 23.80, lon: 70.00, type: 'drought', urgency: 0.20, waitDays: 8 },
    { name: 'Wayanad slopes', lat: 11.60, lon: 76.10, type: 'landslide', urgency: 0.60, waitDays: 1 },
    { name: 'Bengaluru lakes', lat: 12.97, lon: 77.59, type: 'water', urgency: 0.30, waitDays: 5 },
    { name: 'Paradip coast', lat: 20.27, lon: 86.67, type: 'cyclone', urgency: 0.50, waitDays: 0 },
    { name: 'Pangong Tso', lat: 33.75, lon: 78.65, type: 'ice', urgency: 0.35, waitDays: 7 },
    { name: 'Hirakud reservoir', lat: 21.53, lon: 83.87, type: 'water', urgency: 0.30, waitDays: 3 },
    { name: 'Bhadla solar park', lat: 27.53, lon: 71.91, type: 'energy', urgency: 0.25, waitDays: 5 },
    { name: 'Barren Island volcano', lat: 12.28, lon: 93.86, type: 'volcano', urgency: 0.45, waitDays: 4 },
    { name: 'Kochi backwaters', lat: 9.93, lon: 76.27, type: 'water', urgency: 0.25, waitDays: 2 },
    { name: 'Kolkata wetlands', lat: 22.55, lon: 88.45, type: 'water', urgency: 0.30, waitDays: 6 },
    { name: 'Nagpur cotton belt', lat: 21.15, lon: 79.09, type: 'crop', urgency: 0.35, waitDays: 4 },
    { name: 'Joshimath subsidence', lat: 30.56, lon: 79.56, type: 'landslide', urgency: 0.55, waitDays: 2 },
    { name: 'Gir forest', lat: 21.12, lon: 70.82, type: 'forest', urgency: 0.25, waitDays: 7 },
    { name: 'Hyderabad lakes', lat: 17.42, lon: 78.47, type: 'water', urgency: 0.25, waitDays: 3 },
    { name: 'Varanasi ghats', lat: 25.31, lon: 83.01, type: 'urban', urgency: 0.20, waitDays: 5 },
    { name: 'Chilika lagoon', lat: 19.72, lon: 85.32, type: 'water', urgency: 0.35, waitDays: 4 },
    { name: 'Teesta valley', lat: 27.10, lon: 88.45, type: 'landslide', urgency: 0.50, waitDays: 2 },
    { name: 'Kosi river', lat: 26.00, lon: 86.90, type: 'flood', urgency: 0.55, waitDays: 1 },
    { name: 'Majuli island', lat: 26.95, lon: 94.17, type: 'flood', urgency: 0.45, waitDays: 3 },
    { name: 'Srinagar Dal lake', lat: 34.11, lon: 74.87, type: 'water', urgency: 0.20, waitDays: 6 },
    { name: 'Puducherry coast', lat: 11.93, lon: 79.83, type: 'cyclone', urgency: 0.50, waitDays: 0 },
    { name: 'Nellore aquaculture', lat: 14.44, lon: 79.99, type: 'coast', urgency: 0.25, waitDays: 5 },
    { name: 'Indore city', lat: 22.72, lon: 75.86, type: 'urban', urgency: 0.20, waitDays: 4 },
    { name: 'Bundelkhand farms', lat: 25.45, lon: 78.57, type: 'drought', urgency: 0.35, waitDays: 6 },
    { name: 'Western Ghats, Goa', lat: 15.35, lon: 74.10, type: 'forest', urgency: 0.30, waitDays: 7 },
    { name: 'Spiti valley', lat: 32.25, lon: 78.03, type: 'glacier', urgency: 0.30, waitDays: 9 },
    { name: 'Visakhapatnam port', lat: 17.69, lon: 83.28, type: 'urban', urgency: 0.30, waitDays: 2 },
    { name: 'Thoothukudi coast', lat: 8.79, lon: 78.13, type: 'coast', urgency: 0.30, waitDays: 3 },
    { name: 'Punjab stubble fields', lat: 30.20, lon: 74.95, type: 'wildfire', urgency: 0.60, waitDays: 1 },
  ];

  let reqId = 1;
  function makeRequest(r) {
    return {
      id: r.id || 'r' + reqId++, name: r.name, lat: r.lat, lon: r.lon, type: r.type || 'default',
      urgency: clamp(r.urgency === undefined ? 0.4 : r.urgency, 0, 1), waitDays: r.waitDays || 0,
      source: r.source || 'standing', detail: r.detail || '', link: r.link || '',
    };
  }

  // ------------------------------------------------------------------
  // Geometry helpers
  // ------------------------------------------------------------------
  function gmst(date) {
    const jd = date.getTime() / DAY + 2440587.5;
    const T = (jd - 2451545.0) / 36525;
    let g = 280.46061837 + 360.98564736629 * (jd - 2451545) + 0.000387933 * T * T - (T * T * T) / 38710000;
    g = ((g % 360) + 360) % 360;
    return g * D2R;
  }

  function geoToEcef(lat, lon, altKm) {
    const la = lat * D2R, lo = lon * D2R, r = RE + (altKm || 0);
    return [r * Math.cos(la) * Math.cos(lo), r * Math.cos(la) * Math.sin(lo), r * Math.sin(la)];
  }
  function ecefToGeo(p) {
    const r = Math.hypot(p[0], p[1], p[2]);
    return { lat: Math.asin(p[2] / r) * R2D, lon: Math.atan2(p[1], p[0]) * R2D, altKm: r - RE };
  }
  function eciToEcef(p, g) {
    const c = Math.cos(g), s = Math.sin(g);
    return [c * p[0] + s * p[1], -s * p[0] + c * p[1], p[2]];
  }

  // Sun position (low-precision almanac). Returns unit vector in ECI and RA.
  function sunEci(date) {
    const jd = date.getTime() / DAY + 2440587.5;
    const n = jd - 2451545.0;
    const L = (280.46 + 0.9856474 * n) * D2R;
    const g = (357.528 + 0.9856003 * n) * D2R;
    const lam = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * D2R;
    const eps = 23.439 * D2R;
    const v = [Math.cos(lam), Math.cos(eps) * Math.sin(lam), Math.sin(eps) * Math.sin(lam)];
    return { v, ra: Math.atan2(v[1], v[0]) };
  }
  function sunElevation(lat, lon, date) {
    const s = eciToEcef(sunEci(date).v, gmst(date));
    const u = geoToEcef(lat, lon, 0).map((x) => x / RE);
    return Math.asin(clamp(u[0] * s[0] + u[1] * s[1] + u[2] * s[2], -1, 1)) * R2D;
  }

  // ------------------------------------------------------------------
  // Orbits
  // ------------------------------------------------------------------
  // Each satellite gets propagate(date) -> {ecef:[x,y,z] km, vel:[..] km/s}
  function makeOrbit(sat, tle, epoch) {
    const SJ = root.satellite;
    if (tle && SJ) {
      try {
        const rec = SJ.twoline2satrec(tle[0], tle[1]);
        const test = SJ.propagate(rec, epoch);
        if (test && test.position) {
          return {
            live: true,
            at(date) {
              const pv = SJ.propagate(rec, date);
              const g = SJ.gstime(date);
              const p = SJ.eciToEcf(pv.position, g);
              const v = SJ.eciToEcf(pv.velocity, g);
              return { ecef: [p.x, p.y, p.z], vel: [v.x, v.y, v.z] };
            },
          };
        }
      } catch (e) { /* fall back */ }
    }
    // Circular sun-synchronous orbit placed so the descending node crosses
    // at the satellite's local time. Good enough to plan with when no TLE.
    const a = RE + sat.altKm;
    const n = Math.sqrt(MU / (a * a * a));
    const inc = sat.incDeg * D2R;
    const t0 = new Date(Date.UTC(epoch.getUTCFullYear(), epoch.getUTCMonth(), epoch.getUTCDate()));
    const ra = sunEci(t0).ra;
    // ascending node local time = descending + 12 h, so the node sits ltdn*15 deg from the sun
    const raan0 = ra + sat.ltdnHours * 15 * D2R;
    const u0 = sat.phaseDeg * D2R;
    const raanRate = (0.9856 * D2R) / 86400;
    return {
      live: false,
      at(date) {
        const dt = (date - t0) / 1000;
        const u = u0 + n * dt, O = raan0 + raanRate * dt;
        const cu = Math.cos(u), su = Math.sin(u), cO = Math.cos(O), sO = Math.sin(O), ci = Math.cos(inc), si = Math.sin(inc);
        const p = [a * (cO * cu - sO * su * ci), a * (sO * cu + cO * su * ci), a * su * si];
        const vv = a * n;
        const v = [vv * (-cO * su - sO * cu * ci), vv * (-sO * su + cO * cu * ci), vv * cu * si];
        const g = gmst(date);
        return { ecef: eciToEcef(p, g), vel: eciToEcef(v, g) };
      },
    };
  }

  // ------------------------------------------------------------------
  // Access: imaging opportunities and ground contacts for one day
  // ------------------------------------------------------------------
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = (a) => Math.hypot(a[0], a[1], a[2]);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

  // Signed roll angle (deg) the satellite needs to point at a ground point.
  function lookAngle(st, target) {
    const los = sub(target, st.ecef);
    const nadir = st.ecef.map((x) => -x);
    const off = Math.acos(clamp(dot(los, nadir) / (norm(los) * norm(nadir)), -1, 1)) * R2D;
    const side = Math.sign(dot(cross(st.vel, nadir), los)) || 1;
    // elevation of the satellite seen from the target
    const up = target.map((x) => x / norm(target));
    const el = Math.asin(clamp(dot(sub(st.ecef, target), up) / norm(sub(st.ecef, target)), -1, 1)) * R2D;
    return { off, roll: off * side, el };
  }

  function computeAccess(fleet, requests, startMs, hours, stepS) {
    stepS = stepS || 20;
    const steps = Math.floor((hours * 3600) / stepS);
    const targets = requests.map((r) => geoToEcef(r.lat, r.lon, 0));
    const stations = STATIONS.map((s) => geoToEcef(s.lat, s.lon, 0));
    const opps = [];
    const contacts = [];
    const tracks = {};
    for (const f of fleet) {
      const sat = f.sat;
      const open = requests.map(() => null);
      const sOpen = STATIONS.map(() => null);
      const track = [];
      for (let k = 0; k <= steps; k++) {
        const t = startMs + k * stepS * 1000;
        const date = new Date(t);
        const st = f.orbit.at(date);
        if (k % 3 === 0) track.push({ t, ...ecefToGeo(st.ecef) });
        // imaging
        for (let i = 0; i < requests.length; i++) {
          const la = lookAngle(st, targets[i]);
          const ok = la.el > 10 && la.off <= sat.maxRollDeg;
          if (ok) {
            if (!open[i] || la.off < open[i].off) open[i] = Object.assign(open[i] || {}, { t, off: la.off, roll: la.roll, firstT: open[i] ? open[i].firstT : t });
          } else if (open[i]) {
            opps.push(finishOpp(sat, requests[i], open[i]));
            open[i] = null;
          }
        }
        // ground contacts
        for (let j = 0; j < STATIONS.length; j++) {
          const la = lookAngle(st, stations[j]);
          if (la.el > 5) {
            if (!sOpen[j]) sOpen[j] = { start: t };
            sOpen[j].end = t;
          } else if (sOpen[j]) {
            contacts.push({ sat: sat.id, station: STATIONS[j].id, start: sOpen[j].start, end: sOpen[j].end });
            sOpen[j] = null;
          }
        }
      }
      for (let i = 0; i < requests.length; i++) if (open[i]) opps.push(finishOpp(sat, requests[i], open[i]));
      for (let j = 0; j < STATIONS.length; j++) if (sOpen[j]) contacts.push({ sat: sat.id, station: STATIONS[j].id, start: sOpen[j].start, end: sOpen[j].end });
      tracks[sat.id] = track;
    }
    opps.sort((a, b) => a.t - b.t);
    opps.forEach((o, i) => { o.idx = i; });
    contacts.sort((a, b) => a.start - b.start);
    return { opps, contacts, tracks };
  }

  let oppId = 1;
  function finishOpp(sat, req, w) {
    const date = new Date(w.t);
    return {
      id: 'o' + oppId++, sat: sat.id, sensor: sat.sensor, req: req.id, t: w.t,
      off: w.off, roll: w.roll, sunEl: sunElevation(req.lat, req.lon, date),
      pClear: null, value: null,
    };
  }

  // ------------------------------------------------------------------
  // Neural network (multilayer perceptron, backprop + Adam)
  // ------------------------------------------------------------------
  function MLP(sizes) {
    this.sizes = sizes.slice(); this.L = sizes.length - 1;
    this.W = []; this.b = []; this.gW = []; this.gb = []; this.mW = []; this.vW = []; this.mb = []; this.vb = [];
    for (let l = 0; l < this.L; l++) {
      const nin = sizes[l], nout = sizes[l + 1], std = Math.sqrt(2 / nin);
      const W = new Float32Array(nin * nout);
      for (let i = 0; i < W.length; i++) W[i] = gauss() * std;
      this.W.push(W); this.b.push(new Float32Array(nout));
      [this.gW, this.mW, this.vW].forEach((a) => a.push(new Float32Array(nin * nout)));
      [this.gb, this.mb, this.vb].forEach((a) => a.push(new Float32Array(nout)));
    }
    this.a = sizes.map((n) => new Float32Array(n));
    this.d = sizes.map((n) => new Float32Array(n));
    this.t = 0;
  }
  MLP.prototype.forward = function (x) {
    this.a[0].set(x);
    for (let l = 0; l < this.L; l++) {
      const nin = this.sizes[l], nout = this.sizes[l + 1], inp = this.a[l], out = this.a[l + 1], W = this.W[l], b = this.b[l];
      const last = l === this.L - 1;
      for (let j = 0; j < nout; j++) {
        let s = b[j];
        for (let i = 0, r = j * nin; i < nin; i++) s += W[r + i] * inp[i];
        out[j] = last ? 1 / (1 + Math.exp(-s)) : (s > 0 ? s : 0.01 * s);
      }
    }
    return this.a[this.L][0];
  };
  MLP.prototype.backward = function (y) {
    const p = this.a[this.L][0];
    this.d[this.L][0] = p - y;
    for (let l = this.L - 1; l >= 0; l--) {
      const nin = this.sizes[l], nout = this.sizes[l + 1], inp = this.a[l], dOut = this.d[l + 1], W = this.W[l];
      const gW = this.gW[l], gb = this.gb[l], dIn = this.d[l];
      if (l > 0) dIn.fill(0);
      for (let j = 0; j < nout; j++) {
        const dj = dOut[j];
        gb[j] += dj;
        for (let i = 0, r = j * nin; i < nin; i++) {
          gW[r + i] += dj * inp[i];
          if (l > 0) dIn[i] += W[r + i] * dj;
        }
      }
      if (l > 0) for (let i = 0; i < nin; i++) if (inp[i] <= 0) dIn[i] *= 0.01;
    }
    const e = 1e-7;
    return -(y * Math.log(p + e) + (1 - y) * Math.log(1 - p + e));
  };
  MLP.prototype.step = function (lr, batch) {
    this.t++;
    const b1 = 0.9, b2 = 0.999, c1 = 1 - Math.pow(b1, this.t), c2 = 1 - Math.pow(b2, this.t);
    for (let l = 0; l < this.L; l++) {
      for (const [P, g, m, v] of [[this.W[l], this.gW[l], this.mW[l], this.vW[l]], [this.b[l], this.gb[l], this.mb[l], this.vb[l]]]) {
        for (let i = 0; i < P.length; i++) {
          const gi = g[i] / batch;
          m[i] = b1 * m[i] + (1 - b1) * gi;
          v[i] = b2 * v[i] + (1 - b2) * gi * gi;
          P[i] -= lr * (m[i] / c1) / (Math.sqrt(v[i] / c2) + 1e-8);
          g[i] = 0;
        }
      }
    }
  };

  // ------------------------------------------------------------------
  // Cloud model: features + training data
  // ------------------------------------------------------------------
  // A forecast sample: {total, low, mid, high, rh, precip} (0..100), plus
  // where and when. The ANN predicts P(actual cloud cover < CLEAR_LIMIT).
  const CLEAR_LIMIT = 30;
  const N_FEAT = 12;
  function features(fc, lat, lon, date, out) {
    out = out || new Float32Array(N_FEAT);
    const h = (date.getUTCHours() + date.getUTCMinutes() / 60 + lon / 15 + 24) % 24; // local solar hour
    const doy = (Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - Date.UTC(date.getUTCFullYear(), 0, 0)) / DAY;
    out[0] = fc.total / 100; out[1] = fc.low / 100; out[2] = fc.mid / 100; out[3] = fc.high / 100;
    out[4] = fc.rh / 100; out[5] = fc.low / (fc.total + 1);   // share of the cloud that is low cloud
    out[6] = Math.sin((2 * Math.PI * h) / 24); out[7] = Math.cos((2 * Math.PI * h) / 24);
    out[8] = (lat - 20) / 15; out[9] = (lon - 80) / 15;
    out[10] = Math.sin((2 * Math.PI * doy) / 365); out[11] = Math.cos((2 * Math.PI * doy) / 365);
    return out;
  }

  // Built-in weather used when live data is unreachable: a smooth cloud
  // field over South Asia with a diurnal cycle, coastal low cloud and
  // afternoon convection over land. Forecasts are the truth plus the kind
  // of errors real models make (they miss low cloud and afternoon build-up).
  function SyntheticWeather(seedValue) {
    const r = mulberry32(seedValue);
    const lat0 = 5, lon0 = 65, n = 64;
    const grid = new Float32Array(n * n * 4);
    for (let i = 0; i < grid.length; i++) grid[i] = r();
    const lerpNoise = (x, y, z) => {
      const gx = clamp(x, 0, n - 1.001), gy = clamp(y, 0, n - 1.001);
      const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
      const zf = z - Math.floor(z), z0 = ((Math.floor(z) % 4) + 4) % 4, z1 = (z0 + 1) % 4;
      const g = (xx, yy, zz) => grid[(zz * n + yy) * n + xx];
      const s = (zz) => {
        const a = g(x0, y0, zz), b = g(x0 + 1, y0, zz), c = g(x0, y0 + 1, zz), d = g(x0 + 1, y0 + 1, zz);
        return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
      };
      return s(z0) * (1 - zf) + s(z1) * zf;
    };
    this.truth = function (lat, lon, ms) {
      const day = ms / DAY;
      const x = (lon - lon0) / 0.6 + day * 3, y = (lat - lat0) / 0.6;
      let base = 0.6 * lerpNoise(x / 4, y / 4, day * 0.8) + 0.4 * lerpNoise(x, y, day * 1.7) - 0.38;
      // late-October pattern: north-east monsoon over the south-east coast and
      // the north-east; dry north-west
      base += 0.35 * Math.exp(-((lat - 12) ** 2) / 40 - ((lon - 80) ** 2) / 30);
      base += 0.25 * Math.exp(-((lat - 26) ** 2) / 20 - ((lon - 93) ** 2) / 20);
      base -= 0.25 * Math.exp(-((lat - 27) ** 2) / 50 - ((lon - 72) ** 2) / 40);
      const h = ((ms / 3600000) % 24 + lon / 15 + 24) % 24;
      const conv = Math.max(0, Math.sin(((h - 10) / 10) * Math.PI)) * 0.25 * (lat > 8 ? 1 : 0.4);
      const low = clamp(base * 0.8 + (lat < 15 ? 0.2 : 0) + 0.3 * (lerpNoise(x * 2, y * 2, day * 3) - 0.5), 0, 1);
      const mid = clamp(base * 0.7 + conv, 0, 1);
      const high = clamp(0.5 * lerpNoise(x / 2 + 20, y / 2, day) + (lat > 28 ? 0.15 : 0) - 0.15, 0, 1);
      const total = clamp(1 - (1 - low) * (1 - mid) * (1 - high), 0, 1);
      const rh = clamp(0.35 + base * 0.5 + (lat < 15 ? 0.15 : 0), 0, 1);
      return { total: total * 100, low: low * 100, mid: mid * 100, high: high * 100, rh: rh * 100, precip: clamp(total - 0.6, 0, 1) * 150 };
    };
    this.forecast = function (lat, lon, ms, leadHours) {
      const t = this.truth(lat, lon, ms);
      const h = ((ms / 3600000) % 24 + lon / 15 + 24) % 24;
      const err = (leadHours || 24) / 24;
      const miss = h > 10 && h < 17 ? 0.5 : 0.1;        // misses afternoon build-up
      const f = (v, k) => clamp(v * k + gauss() * 22 * err, 0, 100);
      const low = f(t.low, 1 - (lat < 16 ? 0.55 : 0.2));  // under-forecasts coastal low cloud
      const mid = f(t.mid, 1 - miss);
      const high = f(t.high, 1.1);
      const total = clamp(100 - (100 - low) * (100 - mid) * (100 - high) / 10000, 0, 100);
      return { total, low, mid, high, rh: clamp(t.rh + gauss() * 5, 0, 100), precip: clamp(t.precip * 0.8 + gauss() * 5, 0, 100) };
    };
  }

  // Build a training set from synthetic weather (fallback) — pairs of
  // (forecast features, was it actually clear?).
  function syntheticTrainingSet(weather, nPoints, days, endMs) {
    const X = [], Y = [];
    for (let d = 0; d < days; d++) {
      for (let p = 0; p < nPoints; p++) {
        const lat = 8 + random() * 27, lon = 69 + random() * 25;
        const ms = endMs - (d + 1) * DAY + (3 + random() * 9) * 3600000; // daytime UTC
        const date = new Date(ms);
        const fc = weather.forecast(lat, lon, ms, 24);
        const act = weather.truth(lat, lon, ms);
        X.push(features(fc, lat, lon, date)); Y.push(act.total < CLEAR_LIMIT ? 1 : 0);
      }
    }
    return { X, Y, source: 'built-in weather model' };
  }

  function CloudNet() {
    this.net = new MLP([N_FEAT, 20, 10, 1]);
    this.losses = [];
    this.trained = false;
  }
  CloudNet.prototype.trainChunk = function (set, steps, batch) {
    batch = batch || 32;
    let last = 0;
    for (let s = 0; s < steps; s++) {
      let loss = 0;
      for (let k = 0; k < batch; k++) {
        const i = randInt(set.trainIdx.length), j = set.trainIdx[i];
        this.net.forward(set.X[j]);
        loss += this.net.backward(set.Y[j]);
      }
      this.net.step(0.003, batch);
      last = loss / batch;
      this.losses.push(last);
    }
    this.trained = true;
    return last;
  };
  CloudNet.prototype.predict = function (fc, lat, lon, date) {
    return this.net.forward(features(fc, lat, lon, date));
  };
  function splitSet(set, testFrac) {
    const idx = set.X.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) { const j = randInt(i + 1); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    const nt = Math.floor(idx.length * (testFrac || 0.2));
    set.testIdx = idx.slice(0, nt); set.trainIdx = idx.slice(nt);
    return set;
  }
  // Accuracy of ANN vs. simply trusting the forecast ("clear if forecast < 30%").
  function evaluateCloud(cn, set) {
    let annOk = 0, rawOk = 0, brierAnn = 0, brierRaw = 0;
    for (const j of set.testIdx) {
      const x = set.X[j], y = set.Y[j];
      const p = cn.net.forward(x);
      const raw = x[0] * 100 < CLEAR_LIMIT ? 1 : 0;
      const rawP = clamp(1 - x[0] * 1.4, 0, 1);
      if ((p > 0.5 ? 1 : 0) === y) annOk++;
      if (raw === y) rawOk++;
      brierAnn += (p - y) ** 2; brierRaw += (rawP - y) ** 2;
    }
    const n = set.testIdx.length || 1;
    return { ann: annOk / n, raw: rawOk / n, brierAnn: brierAnn / n, brierRaw: brierRaw / n, n };
  }

  // ------------------------------------------------------------------
  // Fuzzy logic: how valuable is this imaging opportunity?
  // ------------------------------------------------------------------
  // Triangular / shoulder membership functions on 0..1, defined by [a, b, c].
  function mu(x, [a, b, c]) {
    if (x <= a) return a === b ? 1 : 0;
    if (x >= c) return b === c ? 1 : 0;
    return x < b ? (x - a) / (b - a) : (c - x) / (c - b);
  }
  function defaultFuzzy() {
    const lmh = () => ({ low: [0, 0, 0.5], medium: [0.15, 0.5, 0.85], high: [0.5, 1, 1] });
    return {
      inputs: {
        urgency: { label: 'Urgency', sets: lmh() },
        waiting: { label: 'Waiting time', sets: { fresh: [0, 0, 0.4], waiting: [0.2, 0.5, 0.8], overdue: [0.6, 1, 1] } },
        clear: { label: 'Clear-sky chance', sets: { cloudy: [0, 0, 0.45], unsure: [0.25, 0.5, 0.75], clear: [0.55, 1, 1] } },
        quality: { label: 'Look angle quality', sets: { oblique: [0, 0, 0.45], fair: [0.2, 0.5, 0.8], sharp: [0.55, 1, 1] } },
        fit: { label: 'Sensor fit', sets: { poor: [0, 0, 0.55], ok: [0.35, 0.65, 0.9], good: [0.7, 1, 1] } },
      },
      output: { label: 'Value', sets: { useless: [0, 0, 0.2], low: [0.1, 0.3, 0.5], medium: [0.35, 0.55, 0.75], high: [0.6, 0.8, 0.95], critical: [0.85, 1, 1] } },
      rules: [
        { on: true, if: [['urgency', 'high'], ['clear', 'clear']], then: 'critical' },
        { on: true, if: [['urgency', 'high'], ['clear', 'unsure']], then: 'high' },
        { on: true, if: [['urgency', 'medium'], ['clear', 'clear'], ['quality', 'sharp']], then: 'high' },
        { on: true, if: [['urgency', 'medium'], ['clear', 'unsure']], then: 'medium' },
        { on: true, if: [['urgency', 'low'], ['clear', 'clear']], then: 'medium' },
        { on: true, if: [['urgency', 'low'], ['clear', 'unsure']], then: 'low' },
        { on: true, if: [['waiting', 'overdue'], ['clear', 'clear']], then: 'high' },
        { on: true, if: [['waiting', 'waiting'], ['clear', 'clear']], then: 'medium' },
        { on: true, if: [['clear', 'cloudy']], then: 'useless' },
        { on: true, if: [['quality', 'oblique'], ['urgency', 'low']], then: 'low' },
        { on: true, if: [['fit', 'poor']], then: 'useless' },
        { on: true, if: [['fit', 'good'], ['clear', 'clear'], ['quality', 'fair']], then: 'medium' },
        // added after testing: without it a medium-urgency shot under a clear sky
        // at an oblique angle fired no rule at all and scored 0
        { on: true, if: [['urgency', 'medium'], ['clear', 'clear']], then: 'medium' },
      ],
    };
  }
  // Mamdani inference: min for AND, max aggregation, centroid defuzzification.
  function fuzzyEval(fz, x, explain) {
    const agg = new Float32Array(101);
    const fired = [];
    for (let k = 0; k < fz.rules.length; k++) {
      const r = fz.rules[k];
      if (!r.on) continue;
      let w = 1;
      for (const [v, s] of r.if) w = Math.min(w, mu(x[v], fz.inputs[v].sets[s]));
      if (w <= 0) continue;
      if (explain) fired.push({ k, w });
      const set = fz.output.sets[r.then];
      for (let i = 0; i <= 100; i++) {
        const m = Math.min(w, mu(i / 100, set));
        if (m > agg[i]) agg[i] = m;
      }
    }
    let num = 0, den = 0;
    for (let i = 0; i <= 100; i++) { num += agg[i] * i; den += agg[i]; }
    const v = den > 0 ? num / den : 0;
    return explain ? { value: v, agg, fired } : v;
  }

  // Inputs for one opportunity
  function fuzzyInputs(o, req, satById) {
    const sat = satById[o.sat];
    return {
      urgency: req.urgency,
      waiting: clamp(req.waitDays / 10, 0, 1),
      clear: o.pClear,
      quality: clamp(1 - o.off / sat.maxRollDeg, 0, 1),
      fit: suitability(req.type, sat.sensor),
    };
  }

  // Crisp alternative used in the "no fuzzy" comparison: a plain weighted sum.
  function crispValue(x) {
    return 100 * (0.4 * x.urgency + 0.1 * x.waiting + 0.3 * x.clear + 0.1 * x.quality + 0.1 * x.fit);
  }

  // ------------------------------------------------------------------
  // Scheduling problem + genetic algorithm
  // ------------------------------------------------------------------
  // problem = { requests, opps (with value + pClear), contacts, fleet }
  function buildProblem(requests, access, fleet) {
    const satById = {};
    fleet.forEach((f) => { satById[f.sat.id] = f.sat; });
    const byReq = {};
    requests.forEach((r) => { byReq[r.id] = []; });
    for (const o of access.opps) if (byReq[o.req]) byReq[o.req].push(o);
    const reqIndex = {};
    requests.forEach((r, i) => { reqIndex[r.id] = i; });
    // downlink boundaries per satellite
    const dl = {};
    fleet.forEach((f) => { dl[f.sat.id] = access.contacts.filter((c) => c.sat === f.sat.id).map((c) => c.start); });
    return { requests, opps: access.opps, contacts: access.contacts, byReq, reqIndex, satById, dl, fleet };
  }

  function segmentOf(prob, sat, t) {
    const a = prob.dl[sat];
    let s = 0;
    for (let i = 0; i < a.length; i++) if (a[i] <= t) s = i + 1;
    return s;
  }

  // Make a set of chosen opportunities feasible. Keeps the most valuable
  // shots and drops ones that break slew, memory or power limits.
  function repair(prob, chosen) {
    const order = chosen.slice().sort((a, b) => b.value - a.value);
    const kept = {};       // sat -> sorted list
    const mem = {};        // sat:segment -> count
    const count = {};
    const accepted = [];
    for (const o of order) {
      const sat = prob.satById[o.sat];
      const list = kept[o.sat] || (kept[o.sat] = []);
      if ((count[o.sat] || 0) >= sat.maxShots) continue;
      const seg = o.sat + ':' + segmentOf(prob, o.sat, o.t);
      if ((mem[seg] || 0) >= sat.memory) continue;
      // slew check against time neighbours
      let pos = 0;
      while (pos < list.length && list[pos].t < o.t) pos++;
      const prev = list[pos - 1], next = list[pos];
      const need = (a, b) => 8000 + (Math.abs(a.roll - b.roll) / sat.slewDegPerS + sat.settleS) * 1000;
      if (prev && o.t - prev.t < need(prev, o)) continue;
      if (next && next.t - o.t < need(o, next)) continue;
      list.splice(pos, 0, o);
      mem[seg] = (mem[seg] || 0) + 1;
      count[o.sat] = (count[o.sat] || 0) + 1;
      accepted.push(o);
    }
    return accepted;
  }

  function scorePlan(plan) {
    let value = 0, expected = 0, wasted = 0, urgent = 0;
    for (const o of plan) {
      value += o.value; expected += o.pClear; wasted += 1 - o.pClear;
    }
    return { value, expected, wasted, shots: plan.length };
  }

  // Every shot costs power, memory and downlink time, so a shot is only worth
  // taking if its value clears this bar.
  const MIN_VALUE = 20, SHOT_COST = 8;

  // Genome: one gene per request = index into its opportunity list, or -1.
  function GA(prob, opts) {
    opts = opts || {};
    this.prob = prob;
    this.pop = opts.pop || 60;
    this.pm = opts.pm || 0.06;
    this.pc = opts.pc || 0.9;
    this.k = opts.k || 3;
    this.elite = 2;
    this.gen = 0;
    this.history = [];
    const R = prob.requests.length;
    this.R = R;
    this.individuals = [];
    for (let i = 0; i < this.pop; i++) this.individuals.push(this.evaluate(this.randomGenome(i)));
    this.individuals.sort((a, b) => b.fit - a.fit);
    this.best = this.individuals[0];
    this.history.push(this.best.fit);
  }
  GA.prototype.randomGenome = function (i) {
    const g = new Int16Array(this.R);
    for (let r = 0; r < this.R; r++) {
      const list = this.prob.byReq[this.prob.requests[r].id];
      if (!list.length) { g[r] = -1; continue; }
      if (i === 0) {
        // seed one individual with each request's best-valued opportunity
        let b = 0;
        for (let j = 1; j < list.length; j++) if (list[j].value > list[b].value) b = j;
        g[r] = b;
      } else g[r] = random() < 0.15 ? -1 : randInt(list.length);
    }
    return g;
  };
  GA.prototype.decode = function (g) {
    const chosen = [];
    for (let r = 0; r < this.R; r++) {
      if (g[r] < 0) continue;
      const o = this.prob.byReq[this.prob.requests[r].id][g[r]];
      if (o && o.value > MIN_VALUE) chosen.push(o);
    }
    return repair(this.prob, chosen);
  };
  GA.prototype.evaluate = function (g) {
    const plan = this.decode(g);
    // write the repair back into the genome (Lamarckian repair)
    const keep = new Set(plan.map((o) => o.id));
    for (let r = 0; r < this.R; r++) {
      if (g[r] < 0) continue;
      const o = this.prob.byReq[this.prob.requests[r].id][g[r]];
      if (!o || !keep.has(o.id)) g[r] = -1;
    }
    let fit = 0;
    for (const o of plan) fit += o.value - SHOT_COST;
    return { g, plan, fit };
  };
  GA.prototype.select = function () {
    let b = null;
    for (let i = 0; i < this.k; i++) {
      const c = this.individuals[randInt(this.individuals.length)];
      if (!b || c.fit > b.fit) b = c;
    }
    return b;
  };
  GA.prototype.step = function () {
    const next = this.individuals.slice(0, this.elite);
    while (next.length < this.pop) {
      const A = this.select(), B = this.select();
      const g = new Int16Array(this.R);
      for (let r = 0; r < this.R; r++) g[r] = random() < this.pc && random() < 0.5 ? B.g[r] : A.g[r];
      for (let r = 0; r < this.R; r++) {
        if (random() < this.pm) {
          const list = this.prob.byReq[this.prob.requests[r].id];
          g[r] = !list.length || random() < 0.2 ? -1 : randInt(list.length);
        }
      }
      next.push(this.evaluate(g));
    }
    next.sort((a, b) => b.fit - a.fit);
    this.individuals = next;
    this.best = next[0];
    this.gen++;
    this.history.push(this.best.fit);
    return this.best;
  };

  // Baselines
  // First come, first served: oldest request first, earliest pass, ignores clouds.
  function planFCFS(prob) {
    const reqs = prob.requests.slice().sort((a, b) => b.waitDays - a.waitDays);
    const chosen = [];
    for (const r of reqs) {
      const list = prob.byReq[r.id].slice().sort((a, b) => a.t - b.t);
      for (const o of list) {
        const test = repairOrdered(prob, chosen.concat([o]));
        if (test.length === chosen.length + 1) { chosen.push(o); break; }
      }
    }
    return chosen;
  }
  // Greedy: each request's single most valuable pass, then repair.
  function planGreedy(prob) {
    const chosen = [];
    for (const r of prob.requests) {
      const list = prob.byReq[r.id];
      if (!list.length) continue;
      let b = list[0];
      for (const o of list) if (o.value > b.value) b = o;
      if (b.value > MIN_VALUE) chosen.push(b);
    }
    return repair(prob, chosen);
  }
  // Feasibility check that keeps everything in the given order (used by FCFS).
  function repairOrdered(prob, list) {
    const saved = list.map((o) => o.value);
    list.forEach((o, i) => { o.value = 1e6 - i; });
    const out = repair(prob, list);
    list.forEach((o, i) => { o.value = saved[i]; });
    return out;
  }

  root.Drishti = {
    D2R, R2D, RE, DAY, CLEAR_LIMIT,
    seed, random, randInt, gauss, clamp, mulberry32,
    SATELLITES, STATIONS, STANDING, SUITABILITY, suitability, makeRequest,
    gmst, geoToEcef, ecefToGeo, eciToEcef, sunEci, sunElevation,
    makeOrbit, computeAccess, lookAngle,
    MLP, CloudNet, features, N_FEAT, SyntheticWeather, syntheticTrainingSet, splitSet, evaluateCloud,
    mu, defaultFuzzy, fuzzyEval, fuzzyInputs, crispValue,
    buildProblem, repair, scorePlan, GA, planFCFS, planGreedy, MIN_VALUE, SHOT_COST,
  };
})(typeof window !== 'undefined' ? window : globalThis);
