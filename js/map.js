"use strict";
/* Carte de prévisions façon « minicarte » :
   - couleurs : vent, hauteur des vagues, énergie ou période (vagues = modèle côtier, js/coast.js) ;
   - traits blancs animés : le vent (sens et force), comme sur les minicartes de surf ;
   - terre OSM par-dessus, étiquettes, pastilles des spots ; clic sur la mer = valeurs du point. */

const FGRID = { lat: [45.3, 46.6, 0.1], lon: [-2.4, -0.85, 0.1] };
const LAYERS = {
  wind: { label: "Vent moyen à 10 m", unit: "km/h", stops: [[0, "#2446a8"], [10, "#1c94d4"], [18, "#22bf86"], [26, "#cfd52d"], [34, "#f3a224"], [45, "#e5452c"], [65, "#9b1235"]] },
  hs: { label: "Hauteur des vagues (Hs)", unit: "m", stops: [[0, "#161c66"], [0.3, "#1534a8"], [0.6, "#1560d4"], [0.9, "#139fe0"], [1.2, "#12c7b0"], [1.5, "#16d65a"], [1.8, "#8ee32a"], [2.1, "#e8e828"], [2.4, "#f7c623"], [2.7, "#f79a22"], [3.0, "#f36a24"], [4.6, "#e3262b"], [6.1, "#9e0f2c"], [7.6, "#a321a8"], [9.1, "#e03ce0"]] },
  energy: { label: "Énergie de la houle", unit: "kW/m", stops: [[0, "#1d2f8f"], [2, "#1a7fd8"], [5, "#16c597"], [10, "#9fd82d"], [20, "#e9de2b"], [40, "#f6b023"], [80, "#e02c2c"], [150, "#7d1f8c"]] },
  period: { label: "Période des vagues", unit: "s", stops: [[2, "#1d2f8f"], [5, "#1a7fd8"], [7, "#16c597"], [9, "#9fd82d"], [11, "#e9de2b"], [13, "#f6b023"], [15, "#e02c2c"], [18, "#7d1f8c"]] }
};
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
function rampColor(stops, v) {
  if (v == null || isNaN(v)) return null;
  if (v <= stops[0][0]) return hex(stops[0][1]);
  for (let i = 1; i < stops.length; i++) if (v <= stops[i][0]) {
    const [a, ca] = stops[i - 1], [b, cb] = stops[i], t = (v - a) / (b - a), A = hex(ca), B = hex(cb);
    return [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t];
  }
  return hex(stops[stops.length - 1][1]);
}

const MV = { map: null, grid: null, land: null, mode: "hs", idx: 0, times: [], playing: null, field: null, part: null, particles: [], raf: null, spotsLayer: null, ready: false, partOn: true, cache: new Map(), probe: null };

/* ---------- grille Météo-France (0,1°) ---------- */
function gridPts() {
  const lats = [], lons = [];
  for (let la = FGRID.lat[0]; la <= FGRID.lat[1] + 1e-9; la += FGRID.lat[2]) lats.push(+la.toFixed(3));
  for (let lo = FGRID.lon[0]; lo <= FGRID.lon[1] + 1e-9; lo += FGRID.lon[2]) lons.push(+lo.toFixed(3));
  return { lats, lons };
}
/* grille précalculée toutes les 3 h par GitHub Actions (data/grid.json) : chargement instantané */
async function loadPrecomputedGrid() {
  const j = await getJSON(`data/grid.json?ts=${Math.floor(Date.now() / 9e5)}`, 20000);
  if (Date.now() - new Date(j.generated) > 5 * 3600e3 || !j.times.includes(S.nowKey)) throw new Error("grille trop ancienne");
  const nr = j.lats.length, nc = j.lons.length, rad = Math.PI / 180;
  const g = { lats: j.lats, lons: j.lons, nr, nc, times: j.times, hours: [], source: "précalculée " + ago(Date.now() - new Date(j.generated)) };
  j.times.forEach((_, t) => {
    const sd = j.swd[t], wd = j.wd[t];
    const f = { swh: j.swh[t], swp: j.swp[t], wwh: j.wwh[t], ws: j.ws[t],
      sws: sd.map(d => d == null ? null : Math.sin(d * rad)), swc: sd.map(d => d == null ? null : Math.cos(d * rad)),
      wds: wd.map(d => d == null ? null : Math.sin(d * rad)), wdc: wd.map(d => d == null ? null : Math.cos(d * rad)) };
    ["swh", "sws", "swc", "swp", "wwh"].forEach(k => { f[k] = fillGaps(f[k], nr, nc); });
    g.hours.push(f);
  });
  return g;
}
async function loadFieldGrid() {
  try { return await loadPrecomputedGrid(); } catch (e) { /* repli : interrogation directe d'Open-Meteo */ }
  const { lats, lons } = gridPts();
  const pts = []; lats.forEach(la => lons.forEach(lo => pts.push([la, lo])));
  const lat = pts.map(p => p[0]).join(","), lon = pts.map(p => p[1]).join(",");
  const [m, w] = await Promise.all([
    cachedJSON("grid-wave-v5", `https://marine-api.open-meteo.com/v1/marine?${qs({ latitude: lat, longitude: lon, hourly: "swell_wave_height,swell_wave_direction,swell_wave_period,wind_wave_height,wave_period", models: "meteofrance_wave", timezone: "Europe/Paris", forecast_days: DAYS })}`),
    cachedJSON("grid-wind-v5", `https://api.open-meteo.com/v1/forecast?${qs({ latitude: lat, longitude: lon, hourly: "wind_speed_10m,wind_direction_10m", models: "meteofrance_arome_france_hd,meteofrance_seamless", wind_speed_unit: "kmh", timezone: "Europe/Paris", forecast_days: DAYS })}`)
  ]);
  const M = arr(m), W = arr(w), nr = lats.length, nc = lons.length, nT = W[0].hourly.time.length;
  const g = { lats, lons, nr, nc, times: W[0].hourly.time, hours: [] };
  const rad = Math.PI / 180;
  for (let t = 0; t < nT; t++) {
    const f = { swh: [], sws: [], swc: [], swp: [], wwh: [], ws: [], wds: [], wdc: [] };
    pts.forEach((_, i) => {
      const mh = M[i]?.hourly || {}, wh = W[i].hourly;
      const d = mh.swell_wave_direction?.[t];
      f.swh.push(mh.swell_wave_height?.[t] ?? null); f.swp.push(mh.swell_wave_period?.[t] ?? null); f.wwh.push(mh.wind_wave_height?.[t] ?? null);
      f.sws.push(d == null ? null : Math.sin(d * rad)); f.swc.push(d == null ? null : Math.cos(d * rad));
      const v = wh.wind_speed_10m_meteofrance_arome_france_hd?.[t] ?? wh.wind_speed_10m_meteofrance_seamless?.[t];
      const wd = wh.wind_direction_10m_meteofrance_arome_france_hd?.[t] ?? wh.wind_direction_10m_meteofrance_seamless?.[t];
      f.ws.push(v ?? null); f.wds.push(wd == null ? null : Math.sin(wd * rad)); f.wdc.push(wd == null ? null : Math.cos(wd * rad));
    });
    ["swh", "sws", "swc", "swp", "wwh"].forEach(k => { f[k] = fillGaps(f[k], nr, nc); });
    g.hours.push(f);
  }
  return g;
}
/* comble les points sans valeur (terre) par la moyenne des voisins */
function fillGaps(vals, nr, nc) {
  const v = vals.slice();
  for (let pass = 0; pass < 12; pass++) {
    const nv = v.slice(); let changed = false;
    for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) {
      const i = r * nc + c; if (v[i] != null) continue;
      let s = 0, n = 0;
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const rr = r + dr, cc = c + dc; if (rr >= 0 && rr < nr && cc >= 0 && cc < nc && v[rr * nc + cc] != null) { s += v[rr * nc + cc]; n++; } }
      if (n) { nv[i] = s / n; changed = true; }
    }
    for (let i = 0; i < v.length; i++) v[i] = nv[i];
    if (!changed) break;
  }
  return v;
}
function bil(a, lat, lon) {
  const g = MV.grid, fr = clamp((lat - g.lats[0]) / FGRID.lat[2], 0, g.nr - 1), fc = clamp((lon - g.lons[0]) / FGRID.lon[2], 0, g.nc - 1);
  const r0 = Math.floor(fr), c0 = Math.floor(fc), r1 = Math.min(r0 + 1, g.nr - 1), c1 = Math.min(c0 + 1, g.nc - 1), tr = fr - r0, tc = fc - c0;
  const q = (r, c) => a[r * g.nc + c]; const A = q(r0, c0), B = q(r0, c1), C = q(r1, c0), D = q(r1, c1);
  if (A == null || B == null || C == null || D == null) return A ?? B ?? C ?? D;
  return (A * (1 - tc) + B * tc) * (1 - tr) + (C * (1 - tc) + D * tc) * tr;
}
/* accès aux champs du large pour le modèle côtier */
function sourceAt(idx) {
  const f = MV.grid.hours[idx];
  const dir = (s, c) => s == null || c == null ? null : (Math.atan2(s, c) * 180 / Math.PI + 360) % 360;
  return {
    at(k, lat, lon) {
      if (k === "swd") return dir(bil(f.sws, lat, lon), bil(f.swc, lat, lon));
      if (k === "wd") return dir(bil(f.wds, lat, lon), bil(f.wdc, lat, lon));
      return bil(f[k], lat, lon);
    }
  };
}
function fieldFor(idx) {
  if (MV.cache.has(idx)) return MV.cache.get(idx);
  const res = coastalField(sourceAt(idx), tideLevelAt(MV.times[idx]));
  if (MV.cache.size > 30) MV.cache.delete(MV.cache.keys().next().value);
  MV.cache.set(idx, res); return res;
}

/* ---------- carte ---------- */
function initForecastMap() {
  if (MV.map) { MV.map.invalidateSize(); return; }
  const m = L.map("fmap", { zoomAnimation: false, scrollWheelZoom: false, minZoom: 9, maxZoom: 13, maxBounds: [[45.3, -2.4], [46.6, -0.85]] }).setView([45.98, -1.4], 10);
  MV.map = m;
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, attribution: "Fond © Esri, HERE, Garmin, © contributeurs OpenStreetMap · bathymétrie © EMODnet" }).addTo(m);
  m.createPane("field").style.zIndex = 350;
  m.createPane("labels").style.zIndex = 450; m.getPane("labels").style.pointerEvents = "none";
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { pane: "labels", maxZoom: 16 }).addTo(m);
  MV.field = L.DomUtil.create("canvas", "fcanvas", m.getPane("field"));
  MV.part = L.DomUtil.create("canvas", "fcanvas", m.getPane("field"));
  MV.spotsLayer = L.layerGroup().addTo(m);
  m.on("focus", () => m.scrollWheelZoom.enable()); m.on("blur", () => m.scrollWheelZoom.disable());
  m.on("movestart", () => { const c = MV.part.getContext("2d"); c.clearRect(0, 0, MV.part.width, MV.part.height); });
  m.on("moveend zoomend resize", () => { drawField(); seedParticles(); });
  m.on("click", e => probe(e.latlng));
}
async function showForecastMap() {
  initForecastMap();
  const st = $("#fmapStatus");
  if (!MV.grid) {
    st.textContent = "Chargement de la houle du large, du vent et des fonds…";
    try {
      const [g, land, bathy] = await Promise.all([loadFieldGrid(), MV.land || getJSON("data/land.json", 15000), CM.ready ? null : getJSON("data/bathy.json", 20000)]);
      MV.grid = g; MV.land = land; MV.times = g.times; MV.cache.clear();
      await loadWW3Grid();
      if (!CM.ready) { st.textContent = "Calcul du modèle côtier (ombre des îles, fonds)…"; await new Promise(r => setTimeout(r, 30)); buildCoast(land, bathy); }
      const k = MV.times.indexOf(S.nowKey); MV.idx = k >= 0 ? k : 0;
      const sl = $("#fhour"); sl.max = MV.times.length - 1; sl.value = MV.idx;
      st.textContent = "";
    } catch (e) { st.textContent = "La carte n'a pas pu se charger (" + e.message + ")."; console.error(e); return; }
  }
  MV.ready = true; MV.map.invalidateSize();
  drawAll(); startParticles();
}
function hideForecastMap() { MV.ready = false; stopParticles(); if (MV.playing) togglePlay(); }

function drawAll() { updateLabel(); drawField(); drawSpots(); drawLegend(); seedParticles(); }
function updateLabel() {
  const t = MV.times[MV.idx]; if (!t) return;
  $("#fhourLabel").textContent = timeLabel(t) + (t === S.nowKey ? " · maintenant" : "");
  const st = $("#fmapStatus"); if (!st || MV.mode === "wind") { if (st) st.textContent = ""; return; }
  st.textContent = ww3Hour(MV.idx) ? `Houle près des côtes : WaveWatch III Météo-France (maillage ≈ 1 km), run du ${new Date(W3.data.run).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}.`
    : "Houle près des côtes : modèle côtier simplifié (au-delà de l'horizon de WaveWatch III).";
}
function canvasFit(cv) {
  const m = MV.map, size = m.getSize(), dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = size.x * dpr; cv.height = size.y * dpr; cv.style.width = size.x + "px"; cv.style.height = size.y + "px";
  L.DomUtil.setPosition(cv, m.containerPointToLayerPoint([0, 0]));
  return dpr;
}
function drawLand(ctx, dpr, color) {
  const m = MV.map; ctx.save(); ctx.scale(dpr, dpr); ctx.fillStyle = color; ctx.beginPath();
  MV.land.forEach(ring => ring.forEach(([lo, la], i) => { const p = m.latLngToContainerPoint([la, lo]); i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); }));
  ctx.fill("evenodd"); ctx.restore();
}
function drawCoast(ctx, dpr) {
  const m = MV.map; ctx.save(); ctx.scale(dpr, dpr); ctx.strokeStyle = "rgba(20,24,28,.85)"; ctx.lineWidth = 1.4; ctx.beginPath();
  MV.land.forEach(ring => ring.forEach(([lo, la], i) => { const p = m.latLngToContainerPoint([la, lo]); i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); }));
  ctx.closePath(); ctx.stroke(); ctx.restore();
}
/* ---------- houle côtière WaveWatch III (data/ww3.json, grille 0,01°, octets en base64) ---------- */
const W3 = { data: null, cache: new Map() };
async function loadWW3Grid() { try { W3.data = await getJSON(`data/ww3.json?ts=${Math.floor(Date.now() / 18e5)}`, 30000); W3.idx = new Map(W3.data.times.map((t, i) => [t.slice(0, 13), i])); } catch (e) { W3.data = null; } }
function ww3Hour(idx) {
  if (!W3.data) return null;
  const k = W3.idx.get(new Date(MV.times[idx] + ":00").toISOString().slice(0, 13)); if (k == null) return null;
  if (!W3.cache.has(k)) {
    const dec = b => { const s = atob(b), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
    W3.cache.set(k, { hs: dec(W3.data.hs[k]), dir: dec(W3.data.dir[k]), tp: dec(W3.data.tp[k]) });
  }
  return W3.cache.get(k);
}
function w3Sample(u, lat, lon, scale) {
  const D = W3.data, fy = (lat - D.lat0) / D.d, fx = (lon - D.lon0) / D.d;
  if (fx < 0 || fy < 0 || fx > D.nc - 1 || fy > D.nr - 1) return undefined; // hors de la zone WW3
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  let s = 0, w = 0;
  for (const [dx, dy, ww] of [[0, 0, (1 - tx) * (1 - ty)], [1, 0, tx * (1 - ty)], [0, 1, (1 - tx) * ty], [1, 1, tx * ty]]) {
    const x = Math.min(x0 + dx, D.nc - 1), y = Math.min(y0 + dy, D.nr - 1), v = u[y * D.nc + x];
    if (v !== 255) { s += v * ww; w += ww; }
  }
  return w > 0.05 ? s / w * scale : null;
}
function w3Dir(u, lat, lon) {
  const D = W3.data, x = Math.round((lon - D.lon0) / D.d), y = Math.round((lat - D.lat0) / D.d);
  if (x < 0 || y < 0 || x >= D.nc || y >= D.nr) return null; const v = u[y * D.nc + x]; return v === 255 ? null : v * 360 / 256;
}
function valueAt(lat, lon) {
  if (MV.mode === "wind") return bil(MV.grid.hours[MV.idx].ws, lat, lon);
  const w3 = ww3Hour(MV.idx);
  if (w3) {
    const h = w3Sample(w3.hs, lat, lon, 0.05);
    if (h !== undefined) {
      if (h == null) return null;
      const t = w3Sample(w3.tp, lat, lon, 0.1);
      return MV.mode === "hs" ? h : MV.mode === "energy" ? 0.49 * h * h * (t ?? 0) : t;
    }
  }
  if (lon < CM.X0 + 0.01) { // au large, hors du modèle côtier : houle Météo-France telle quelle
    const g = MV.grid.hours[MV.idx], h = Math.hypot(bil(g.swh, lat, lon) ?? 0, bil(g.wwh, lat, lon) ?? 0), t = bil(g.swp, lat, lon);
    return MV.mode === "hs" ? h : MV.mode === "energy" ? 0.49 * h * h * (t ?? 0) : t;
  }
  const f = fieldFor(MV.idx);
  return coastSample(MV.mode === "hs" ? f.Hs : MV.mode === "energy" ? f.En : f.Tp, lat, lon);
}
function drawField() {
  if (!MV.ready || !MV.grid) return;
  const m = MV.map, cv = MV.field, dpr = canvasFit(cv); canvasFit(MV.part);
  const ctx = cv.getContext("2d"), size = m.getSize();
  const step = 4, w = Math.ceil(size.x / step), h = Math.ceil(size.y / step);
  const off = document.createElement("canvas"); off.width = w; off.height = h;
  const octx = off.getContext("2d"), img = octx.createImageData(w, h), stops = LAYERS[MV.mode].stops;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ll = m.containerPointToLatLng([x * step + step / 2, y * step + step / 2]);
    const c = rampColor(stops, valueAt(ll.lat, ll.lng)); const o = (y * w + x) * 4;
    if (c) { img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 238; }
  }
  octx.putImageData(img, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height); ctx.imageSmoothingEnabled = true; ctx.drawImage(off, 0, 0, cv.width, cv.height);
  if (MV.mode === "wind") drawCoast(ctx, dpr); else drawLand(ctx, dpr, "#3b3d40");
}

/* ---------- particules de vent ---------- */
function seedParticles() {
  if (!MV.ready) return;
  const s = MV.map.getSize(), n = Math.round(clamp(s.x * s.y / 700, 400, 1800));
  MV.particles = Array.from({ length: n }, () => ({ x: Math.random() * s.x, y: Math.random() * s.y, age: Math.random() * 60 | 0 }));
}
function onSea(lat, lon) {
  if (!CM.ready) return true;
  const i = Math.floor((lon - CM.X0) / CM.d), j = Math.floor((lat - CM.Y0) / CM.d);
  if (i < 0) return true; if (j < 0 || i >= CM.nx || j >= CM.ny) return false;
  return !CM.land[j * CM.nx + i];
}
/* déplacement des traits : le vent en mode Vent, la houle (sens de propagation, vitesse selon la période) sinon */
function flowVec(lat, lon) {
  if (MV.mode === "wind") { const w = windVec(lat, lon); return w ? [w[0], w[1], 0.25 + w[2] * 0.06] : null; }
  if (!onSea(lat, lon)) return null;
  const w3 = ww3Hour(MV.idx);
  if (w3) { const d = w3Dir(w3.dir, lat, lon); if (d != null) { const p = w3Sample(w3.tp, lat, lon, 0.1); const r = d * Math.PI / 180; return [-Math.sin(r), -Math.cos(r), 0.35 + (p ?? 8) * 0.07]; } }
  const f = MV.grid.hours[MV.idx], s = bil(f.sws, lat, lon), c = bil(f.swc, lat, lon), p = bil(f.swp, lat, lon);
  if (s == null || c == null) return null;
  const n = Math.hypot(s, c) || 1; return [-s / n, -c / n, 0.35 + (p ?? 8) * 0.07];
}
function windVec(lat, lon) {
  const f = MV.grid.hours[MV.idx]; const s = bil(f.wds, lat, lon), c = bil(f.wdc, lat, lon), v = bil(f.ws, lat, lon);
  if (s == null || c == null || v == null) return null;
  const n = Math.hypot(s, c) || 1; return [-s / n, -c / n, v];
}
function stepParticles() {
  const m = MV.map, cv = MV.part, ctx = cv.getContext("2d"), s = m.getSize(), dpr = cv.width / s.x;
  ctx.save(); ctx.globalCompositeOperation = "destination-in"; ctx.fillStyle = "rgba(0,0,0,0.92)"; ctx.fillRect(0, 0, cv.width, cv.height); ctx.restore();
  if (!MV.partOn) return;
  ctx.save(); ctx.scale(dpr, dpr); ctx.strokeStyle = "rgba(255,255,255,0.8)"; ctx.lineWidth = 1.1; ctx.lineCap = "round"; ctx.beginPath();
  MV.particles.forEach((p, i) => {
    const ll = m.containerPointToLatLng([p.x, p.y]); const w = flowVec(ll.lat, ll.lng);
    if (!w || p.age > 70) { MV.particles[i] = { x: Math.random() * s.x, y: Math.random() * s.y, age: 0 }; return; }
    const sp = w[2], nx = p.x + w[0] * sp, ny = p.y - w[1] * sp;
    if (nx < 0 || ny < 0 || nx > s.x || ny > s.y) { MV.particles[i] = { x: Math.random() * s.x, y: Math.random() * s.y, age: 0 }; return; }
    ctx.moveTo(p.x, p.y); ctx.lineTo(nx, ny); p.x = nx; p.y = ny; p.age++;
  });
  ctx.stroke(); ctx.restore();
}
function startParticles() {
  stopParticles();
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { for (let i = 0; i < 30; i++) stepParticles(); return; }
  const loop = () => { if (!MV.ready || document.hidden) { MV.raf = null; return; } stepParticles(); MV.raf = requestAnimationFrame(loop); };
  MV.raf = requestAnimationFrame(loop);
}
function stopParticles() { if (MV.raf) cancelAnimationFrame(MV.raf); MV.raf = null; }
function toggleParticles() { MV.partOn = !MV.partOn; $("#fpart").setAttribute("aria-pressed", MV.partOn); if (!MV.partOn) { const c = MV.part.getContext("2d"); c.clearRect(0, 0, MV.part.width, MV.part.height); } }
document.addEventListener("visibilitychange", () => { if (!document.hidden && MV.ready && !MV.raf) startParticles(); });

/* ---------- spots, sonde, légende ---------- */
function drawSpots() {
  if (!MV.spotsLayer) return;
  MV.spotsLayer.clearLayers();
  const t = MV.times[MV.idx], f = MV.grid && CM.ready ? fieldFor(MV.idx) : null;
  S.spots.forEach(({ spot, hours }) => {
    const h = hours.find(x => x.t === t); const s = h?.raw;
    const near = h?.surf?.ww3?.hs ?? (f ? coastSample(f.Hs, spot.lat, spot.lon) : null);
    const html = `<a class="mpin" href="#spot-${spot.id}" style="--c:${scoreColor(s)};--i:${scoreInk(s)}"><b>${s == null ? "–" : fmt(s)}</b><span>${esc(spot.name)} · ${h ? surfTxt(h.surf) : "–"}${near != null ? ` · Hs bord ${fmt(near)} m` : ""}</span></a>`;
    L.marker([spot.lat, spot.lon], { icon: L.divIcon({ className: "ico", html, iconSize: [0, 0], iconAnchor: [0, 0] }), keyboard: false }).addTo(MV.spotsLayer);
  });
}
function probe(ll) {
  if (!MV.ready) return;
  const f = fieldFor(MV.idx), g = MV.grid.hours[MV.idx], w = windVec(ll.lat, ll.lng);
  const hs = coastSample(f.Hs, ll.lat, ll.lng), tp = coastSample(f.Tp, ll.lat, ll.lng), en = coastSample(f.En, ll.lat, ll.lng), kd = coastSample(f.Kd, ll.lat, ll.lng);
  const src = sourceAt(MV.idx), off = src.at("swh", ll.lat, ll.lng);
  const fx = Math.floor((ll.lng - CM.X0) / CM.d), fy = Math.floor((ll.lat - CM.Y0) / CM.d), k = fy * CM.nx + fx;
  const depth = CM.ready && fx >= 0 && fy >= 0 && fx < CM.nx && fy < CM.ny && !CM.land[k] ? CM.depth[k] + CM.LAT + tideLevelAt(MV.times[MV.idx]) : null;
  const wd = w ? (Math.atan2(-w[0], -w[1]) * 180 / Math.PI + 360) % 360 : null;
  const html = hs == null ? `<b>Terre</b><br>Vent ${fmt(w?.[2], 0)} km/h ${card(wd)}` : `<b>${fmt(ll.lat, 3)} N, ${fmt(-ll.lng, 3)} O</b><br>
    Vagues ${fmt(hs)} m · ${fmt(tp, 0)} s · ${fmt(en, 0)} kW/m<br>Houle du large ${fmt(off)} m ${card(src.at("swd", ll.lat, ll.lng))}<br>
    Abri des îles : ${kd == null ? "–" : Math.round((1 - kd) * 100) + " %"}<br>Profondeur ≈ ${fmt(depth, 1)} m (marée comprise)<br>Vent ${fmt(w?.[2], 0)} km/h ${card(wd)}`;
  if (MV.probe) MV.map.removeLayer(MV.probe);
  MV.probe = L.popup({ autoPan: false }).setLatLng(ll).setContent(html).openOn(MV.map);
}
function drawLegend() {
  const L0 = LAYERS[MV.mode], stops = L0.stops, min = stops[0][0], max = stops[stops.length - 1][0];
  const grad = stops.map(([v, c]) => `${c} ${Math.round((v - min) / (max - min) * 100)}%`).join(",");
  const marks = stops.filter((_, i) => i % 2 === 0 || i === stops.length - 1);
  $("#flegend").innerHTML = `<span>${L0.label}</span><div class="ramp" style="background:linear-gradient(90deg,${grad})"></div><div class="rampl">${marks.map(([v]) => `<span>${fmt(v, v % 1 ? 1 : 0)}${v === max ? " " + L0.unit : ""}</span>`).join("")}</div>`;
}
function setMapHour(i) { MV.idx = clamp(i, 0, MV.times.length - 1); $("#fhour").value = MV.idx; updateLabel(); drawField(); drawSpots(); }
function togglePlay() {
  const b = $("#fplay");
  if (MV.playing) { clearInterval(MV.playing); MV.playing = null; b.textContent = "▶ Lecture"; b.setAttribute("aria-pressed", "false"); return; }
  b.textContent = "❚❚ Pause"; b.setAttribute("aria-pressed", "true");
  MV.playing = setInterval(() => setMapHour(MV.idx + 1 >= MV.times.length ? 0 : MV.idx + 1), 800);
}
function setMapMode(mode) {
  MV.mode = mode; document.querySelectorAll("[data-fmode]").forEach(b => b.setAttribute("aria-pressed", b.dataset.fmode === mode));
  drawLegend(); drawField(); seedParticles(); updateLabel();
  const c = MV.part.getContext("2d"); c.clearRect(0, 0, MV.part.width, MV.part.height);
}
