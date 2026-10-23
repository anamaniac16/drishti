/*
 * live.js
 * Pulls live data. Every call has a timeout and a fallback, so the app still
 * works offline (or inside sandboxes that block outside requests).
 *
 *   CelesTrak     - current orbital elements (TLE) for the ISRO satellites
 *   Open-Meteo    - hourly cloud forecasts, past forecasts and what actually
 *                   happened (ERA5), used to train and test the cloud ANN
 *   NASA EONET    - open natural events (fires, storms, floods, volcanoes)
 *   NASA GIBS     - recent true-colour satellite views of each target
 */
(function (root) {
  'use strict';

  const TIMEOUT = 9000;

  async function getText(url, ms) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms || TIMEOUT);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }
  const getJSON = async (url, ms) => JSON.parse(await getText(url, ms));

  const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

  // --- CelesTrak -----------------------------------------------------------
  async function fetchTLE(norad) {
    try {
      const txt = await getText(`https://celestrak.org/NORAD/elements/gp.php?CATNR=${norad}&FORMAT=TLE`);
      const lines = txt.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const l1 = lines.find((l) => l.startsWith('1 ')), l2 = lines.find((l) => l.startsWith('2 '));
      if (!l1 || !l2) throw new Error('no TLE');
      return [l1, l2];
    } catch (e) {
      // second source (also serves CelesTrak data, with CORS enabled)
      const j = await getJSON(`https://tle.ivanstanojevic.me/api/tle/${norad}`);
      if (!j.line1 || !j.line2) throw new Error('no TLE');
      return [j.line1, j.line2];
    }
  }

  // --- NASA EONET ------------------------------------------------------------
  const EONET_TYPES = {
    wildfires: ['wildfire', 0.75], severeStorms: ['cyclone', 0.9], floods: ['flood', 0.95],
    volcanoes: ['volcano', 0.7], landslides: ['landslide', 0.9], dustHaze: ['haze', 0.5],
    drought: ['drought', 0.5], seaLakeIce: ['ice', 0.4], snow: ['glacier', 0.4],
    waterColor: ['water', 0.45], earthquakes: ['landslide', 0.85], tempExtremes: ['drought', 0.5],
  };
  async function fetchEvents() {
    // bbox = min lon, max lat, max lon, min lat (South Asia and nearby seas)
    const j = await getJSON('https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=21&bbox=62,38,100,2');
    const out = [];
    for (const ev of j.events || []) {
      const g = (ev.geometry || []).filter((x) => x.type === 'Point').pop();
      if (!g) continue;
      const [lon, lat] = g.coordinates;
      if (lat < 4 || lat > 37 || lon < 64 || lon > 99) continue;
      const cat = (ev.categories && ev.categories[0] && ev.categories[0].id) || '';
      const [type, urgency] = EONET_TYPES[cat] || ['default', 0.6];
      const ageDays = Math.max(0, (Date.now() - Date.parse(g.date)) / 86400000);
      out.push({
        name: ev.title.replace(/\s+/g, ' ').slice(0, 48), lat, lon, type,
        urgency: Math.min(1, urgency + (ageDays < 3 ? 0.1 : 0)), waitDays: Math.round(ageDays),
        source: 'event', detail: (ev.categories[0] && ev.categories[0].title) || 'Natural event',
        link: ev.link || '',
      });
    }
    return out.slice(0, 15);
  }

  // --- Open-Meteo -------------------------------------------------------------
  const HOURLY = 'cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,relative_humidity_2m';
  const list = (a, k) => a.map((p) => p[k].toFixed(2)).join(',');

  function toSeries(j) {
    const arr = Array.isArray(j) ? j : [j];
    return arr.map((o) => {
      const h = o.hourly || {};
      const t = (h.time || []).map((s) => Date.parse(s.endsWith('Z') ? s : s + 'Z'));
      return {
        t,
        total: h.cloud_cover || [], low: h.cloud_cover_low || [], mid: h.cloud_cover_mid || [],
        high: h.cloud_cover_high || [], rh: h.relative_humidity_2m || [],
      };
    });
  }

  async function fetchForecast(points) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${list(points, 'lat')}&longitude=${list(points, 'lon')}` +
      `&hourly=${HOURLY}&forecast_days=3&past_days=1&timezone=GMT`;
    return toSeries(await getJSON(url, 15000));
  }
  async function fetchPastForecast(points, startMs, endMs) {
    const url = `https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${list(points, 'lat')}&longitude=${list(points, 'lon')}` +
      `&hourly=${HOURLY}&start_date=${ymd(startMs)}&end_date=${ymd(endMs)}&timezone=GMT`;
    return toSeries(await getJSON(url, 20000));
  }
  async function fetchActual(points, startMs, endMs) {
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${list(points, 'lat')}&longitude=${list(points, 'lon')}` +
      `&hourly=cloud_cover&start_date=${ymd(startMs)}&end_date=${ymd(endMs)}&timezone=GMT`;
    return toSeries(await getJSON(url, 20000));
  }

  // Value of a series at time ms (nearest hour).
  function sample(series, ms) {
    if (!series || !series.t.length) return null;
    const i0 = Math.round((ms - series.t[0]) / 3600000);
    const i = Math.max(0, Math.min(series.t.length - 1, i0));
    if (series.total[i] === null || series.total[i] === undefined) return null;
    return { total: series.total[i], low: series.low[i] || 0, mid: series.mid[i] || 0, high: series.high[i] || 0, rh: series.rh[i] || 50, precip: 0 };
  }

  // --- NASA GIBS: a recent true-colour image of a target ---------------------
  // sameDay: the image from the day of `ms` (for past days); otherwise the
  // previous day's (today's is not processed yet). Terra MODIS crosses India
  // around 10:30 local time, close to the optical satellites' passes.
  function gibsUrl(lat, lon, ms, km, sameDay) {
    const d = (km || 60) / 111;
    const date = ymd(sameDay ? ms + 5.5 * 3600000 : ms - 86400000);
    const layer = sameDay ? 'MODIS_Terra_CorrectedReflectance_TrueColor' : 'VIIRS_SNPP_CorrectedReflectance_TrueColor';
    return 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0' +
      `&LAYERS=${layer}&STYLES=&CRS=EPSG:4326` +
      `&BBOX=${(lat - d).toFixed(3)},${(lon - d).toFixed(3)},${(lat + d).toFixed(3)},${(lon + d).toFixed(3)}` +
      `&WIDTH=256&HEIGHT=256&FORMAT=image/jpeg&TIME=${date}`;
  }

  root.Live = { fetchTLE, fetchEvents, fetchForecast, fetchPastForecast, fetchActual, sample, gibsUrl, ymd };
})(typeof window !== 'undefined' ? window : globalThis);
