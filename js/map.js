"use strict";
/* Carte de prévisions façon « minicarte » : champ coloré interpolé (houle ou vent),
   particules qui suivent la direction, terre masquée, étiquettes au-dessus, spots notés. */

const FGRID = { lat: [45.45, 46.45, 0.1], lon: [-2.25, -0.85, 0.1] };
const WAVE_STOPS = [[0, "#1d3a9e"], [0.5, "#1c66cf"], [1, "#17a8d6"], [1.5, "#19c08a"], [2, "#8fd334"], [2.5, "#f0d72c"], [3, "#f5a623"], [4, "#ea4c2a"], [6, "#a8122e"]];
const WIND_STOPS = [[0, "#2446a8"], [10, "#1c94d4"], [18, "#22bf86"], [26, "#cfd52d"], [34, "#f3a224"], [45, "#e5452c"], [65, "#9b1235"]];
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

const MV = { map: null, grid: null, land: null, mode: "wave", idx: 0, times: [], playing: null, field: null, part: null, landCv: null, particles: [], raf: null, spotsLayer: null, ready: false };

function gridPts() {
  const lats = [], lons = [];
  for (let la = FGRID.lat[0]; la <= FGRID.lat[1] + 1e-9; la += FGRID.lat[2]) lats.push(+la.toFixed(3));
  for (let lo = FGRID.lon[0]; lo <= FGRID.lon[1] + 1e-9; lo += FGRID.lon[2]) lons.push(+lo.toFixed(3));
  return { lats, lons };
}
async function loadFieldGrid() {
  const { lats, lons } = gridPts();
  const pts = []; lats.forEach(la => lons.forEach(lo => pts.push([la, lo])));
  const lat = pts.map(p => p[0]).join(","), lon = pts.map(p => p[1]).join(",");
  const [m, w] = await Promise.all([
    cachedJSON("grid-wave-v31", `https://marine-api.open-meteo.com/v1/marine?${qs({ latitude: lat, longitude: lon, hourly: "wave_height,wave_direction,wave_period", models: "meteofrance_wave", timezone: "Europe/Paris", forecast_days: DAYS })}`),
    cachedJSON("grid-wind-v31", `https://api.open-meteo.com/v1/forecast?${qs({ latitude: lat, longitude: lon, hourly: "wind_speed_10m,wind_direction_10m", models: "meteofrance_seamless", wind_speed_unit: "kmh", timezone: "Europe/Paris", forecast_days: DAYS })}`)
  ]);
  const M = arr(m), W = arr(w), nT = W[0].hourly.time.length;
  const g = { lats, lons, times: W[0].hourly.time, wave: [], wind: [] };
  for (let t = 0; t < nT; t++) {
    const wh = [], wd = [], wp = [], vs = [], vd = [];
    pts.forEach((_, i) => {
      wh.push(M[i]?.hourly?.wave_height?.[t] ?? null); wd.push(M[i]?.hourly?.wave_direction?.[t] ?? null); wp.push(M[i]?.hourly?.wave_period?.[t] ?? null);
      vs.push(W[i].hourly.wind_speed_10m[t]); vd.push(W[i].hourly.wind_direction_10m[t]);
    });
    g.wave.push({ v: fillGaps(wh, lats.length, lons.length), u: dirToVec(fillGaps(wd.map(d => d == null ? null : Math.sin(d * Math.PI / 180)), lats.length, lons.length), fillGaps(wd.map(d => d == null ? null : Math.cos(d * Math.PI / 180)), lats.length, lons.length)), p: fillGaps(wp, lats.length, lons.length) });
    g.wind.push({ v: vs, u: dirToVec(vd.map(d => Math.sin(d * Math.PI / 180)), vd.map(d => Math.cos(d * Math.PI / 180))) });
  }
  return g;
}
/* direction « d'où ça vient » -> vecteur de déplacement (vers où ça va), en composantes sin/cos */
function dirToVec(s, c) { return s.map((x, i) => x == null || c[i] == null ? null : [-x, -c[i]]); }
/* comble les points terre par la moyenne des voisins (pour que la couleur atteigne la côte) */
function fillGaps(vals, nr, nc) {
  const v = vals.slice();
  for (let pass = 0; pass < 6; pass++) {
    const nv = v.slice(); let changed = false;
    for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) {
      const i = r * nc + c; if (v[i] != null) continue;
      let s = 0, n = 0;
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dr, dc]) => { const rr = r + dr, cc = c + dc; if (rr >= 0 && rr < nr && cc >= 0 && cc < nc && v[rr * nc + cc] != null) { s += v[rr * nc + cc]; n++; } });
      if (n) { nv[i] = s / n; changed = true; }
    }
    for (let i = 0; i < v.length; i++) v[i] = nv[i];
    if (!changed) break;
  }
  return v;
}
function sample(arrv, lat, lon) {
  const g = MV.grid, nc = g.lons.length, nr = g.lats.length;
  const fr = (lat - g.lats[0]) / FGRID.lat[2], fc = (lon - g.lons[0]) / FGRID.lon[2];
  if (fr < 0 || fc < 0 || fr > nr - 1 || fc > nc - 1) return null;
  const r0 = Math.floor(fr), c0 = Math.floor(fc), r1 = Math.min(r0 + 1, nr - 1), c1 = Math.min(c0 + 1, nc - 1), tr = fr - r0, tc = fc - c0;
  const q = (r, c) => arrv[r * nc + c];
  const a = q(r0, c0), b = q(r0, c1), c = q(r1, c0), d = q(r1, c1);
  if ([a, b, c, d].some(x => x == null)) return a ?? b ?? c ?? d;
  if (Array.isArray(a)) return [0, 1].map(k => (a[k] * (1 - tc) + b[k] * tc) * (1 - tr) + (c[k] * (1 - tc) + d[k] * tc) * tr);
  return (a * (1 - tc) + b * tc) * (1 - tr) + (c * (1 - tc) + d * tc) * tr;
}

function initForecastMap() {
  if (MV.map) { MV.map.invalidateSize(); return; }
  const m = L.map("fmap", { zoomAnimation: false, scrollWheelZoom: false, minZoom: 8, maxZoom: 13, maxBounds: [[45.3, -2.25], [46.6, -0.85]] }).setView([45.98, -1.45], 10);
  MV.map = m;
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, attribution: "Fond © Esri, HERE, Garmin, © contributeurs OpenStreetMap" }).addTo(m);
  m.createPane("field").style.zIndex = 350;
  m.createPane("labels").style.zIndex = 450; m.getPane("labels").style.pointerEvents = "none";
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { pane: "labels", maxZoom: 16 }).addTo(m);
  MV.field = L.DomUtil.create("canvas", "fcanvas", m.getPane("field"));
  MV.part = L.DomUtil.create("canvas", "fcanvas", m.getPane("field"));
  MV.landCv = document.createElement("canvas");
  MV.spotsLayer = L.layerGroup().addTo(m);
  m.on("focus", () => m.scrollWheelZoom.enable()); m.on("blur", () => m.scrollWheelZoom.disable());
  m.on("movestart", () => { MV.part.getContext("2d").clearRect(0, 0, MV.part.width, MV.part.height); });
  m.on("moveend zoomend resize", () => { drawField(); seedParticles(); });
}
async function showForecastMap() {
  initForecastMap();
  const st = $("#fmapStatus");
  if (!MV.grid) {
    st.textContent = "Chargement de la grille de prévision…";
    try {
      const [g, land] = await Promise.all([loadFieldGrid(), MV.land ? MV.land : getJSON("data/land.json", 15000)]);
      MV.grid = g; MV.land = land; MV.times = g.times;
      const k = MV.times.indexOf(S.nowKey); MV.idx = k >= 0 ? k : 0;
      const sl = $("#fhour"); sl.max = MV.times.length - 1; sl.value = MV.idx;
      st.textContent = "";
    } catch (e) { st.textContent = "La grille de prévision n'a pas pu se charger (" + e.message + ")."; return; }
  }
  MV.ready = true;
  MV.map.invalidateSize();
  drawAll(); startParticles();
}
function hideForecastMap() { MV.ready = false; stopParticles(); if (MV.playing) togglePlay(); }

function drawAll() { updateLabel(); drawField(); drawSpots(); drawLegend(); seedParticles(); }
function updateLabel() { const t = MV.times[MV.idx]; if (t) $("#fhourLabel").textContent = timeLabel(t) + (t === S.nowKey ? " · maintenant" : ""); }
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
function drawField() {
  if (!MV.ready || !MV.grid) return;
  const m = MV.map, cv = MV.field, dpr = canvasFit(cv); canvasFit(MV.part);
  const ctx = cv.getContext("2d"), size = m.getSize();
  const step = 5, w = Math.ceil(size.x / step), h = Math.ceil(size.y / step);
  const off = document.createElement("canvas"); off.width = w; off.height = h;
  const octx = off.getContext("2d"), img = octx.createImageData(w, h);
  const fr = MV.mode === "wave" ? MV.grid.wave[MV.idx] : MV.grid.wind[MV.idx];
  const stops = MV.mode === "wave" ? WAVE_STOPS : WIND_STOPS;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ll = m.containerPointToLatLng([x * step + step / 2, y * step + step / 2]);
    const c = rampColor(stops, sample(fr.v, ll.lat, ll.lng)); const o = (y * w + x) * 4;
    if (c) { img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 235; }
  }
  octx.putImageData(img, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height); ctx.imageSmoothingEnabled = true; ctx.drawImage(off, 0, 0, cv.width, cv.height);
  // terre par-dessus le champ de houle (le vent reste visible sur terre, plus discret)
  if (MV.mode === "wave") drawLand(ctx, dpr, "#3b3d40"); else { ctx.globalAlpha = 0.45; drawLand(ctx, dpr, "#2a2c2f"); ctx.globalAlpha = 1; }
  // masque terre pour les particules
  MV.landCv.width = size.x; MV.landCv.height = size.y; const lc = MV.landCv.getContext("2d"); lc.clearRect(0, 0, size.x, size.y); drawLand(lc, 1, "#000");
  MV.landData = lc.getImageData(0, 0, size.x, size.y).data;
}
const onLand = (x, y) => { if (!MV.landData) return false; const s = MV.map.getSize(); x |= 0; y |= 0; if (x < 0 || y < 0 || x >= s.x || y >= s.y) return true; return MV.landData[(y * s.x + x) * 4 + 3] > 0; };
function seedParticles() {
  if (!MV.ready) return;
  const s = MV.map.getSize(), n = Math.round(clamp(s.x * s.y / 900, 300, 1400));
  MV.particles = Array.from({ length: n }, () => newParticle(s));
}
function newParticle(s) {
  for (let k = 0; k < 20; k++) { const x = Math.random() * s.x, y = Math.random() * s.y; if (MV.mode === "wind" || !onLand(x, y)) return { x, y, age: Math.random() * 80 | 0 }; }
  return { x: Math.random() * s.x, y: Math.random() * s.y, age: 0 };
}
function stepParticles() {
  const m = MV.map, cv = MV.part, ctx = cv.getContext("2d"), dpr = cv.width / m.getSize().x, s = m.getSize();
  ctx.save(); ctx.globalCompositeOperation = "destination-in"; ctx.fillStyle = "rgba(0,0,0,0.9)"; ctx.fillRect(0, 0, cv.width, cv.height); ctx.restore();
  ctx.save(); ctx.scale(dpr, dpr); ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 1.1; ctx.beginPath();
  const fr = MV.mode === "wave" ? MV.grid.wave[MV.idx] : MV.grid.wind[MV.idx];
  MV.particles.forEach((p, i) => {
    const ll = m.containerPointToLatLng([p.x, p.y]); const vec = sample(fr.u, ll.lat, ll.lng);
    const mag = MV.mode === "wave" ? 0.35 + 0.06 * (sample(fr.p, ll.lat, ll.lng) ?? 8) : 0.25 + 0.05 * (sample(fr.v, ll.lat, ll.lng) ?? 10);
    if (!vec || p.age > 90) { MV.particles[i] = newParticle(s); return; }
    const nx = p.x + vec[0] * mag, ny = p.y - vec[1] * mag;
    if (nx < 0 || ny < 0 || nx > s.x || ny > s.y || (MV.mode === "wave" && onLand(nx, ny))) { MV.particles[i] = newParticle(s); return; }
    ctx.moveTo(p.x, p.y); ctx.lineTo(nx, ny); p.x = nx; p.y = ny; p.age++;
  });
  ctx.stroke(); ctx.restore();
}
function startParticles() {
  stopParticles();
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { for (let i = 0; i < 25; i++) stepParticles(); return; }
  const loop = () => { if (!MV.ready || document.hidden) { MV.raf = null; return; } stepParticles(); MV.raf = requestAnimationFrame(loop); };
  MV.raf = requestAnimationFrame(loop);
}
function stopParticles() { if (MV.raf) cancelAnimationFrame(MV.raf); MV.raf = null; }
document.addEventListener("visibilitychange", () => { if (!document.hidden && MV.ready && !MV.raf) startParticles(); });

function drawSpots() {
  MV.spotsLayer.clearLayers();
  const t = MV.times[MV.idx];
  S.spots.forEach(({ spot, hours }) => {
    const h = hours.find(x => x.t === t); const s = h?.raw;
    const html = `<a class="mpin" href="#spot-${spot.id}" style="--c:${scoreColor(s)};--i:${scoreInk(s)}"><b>${s == null ? "–" : fmt(s)}</b><span>${esc(spot.name)} · ${h ? surfTxt(h.surf) : "–"}</span></a>`;
    L.marker([spot.lat, spot.lon], { icon: L.divIcon({ className: "ico", html, iconSize: [0, 0], iconAnchor: [0, 0] }), keyboard: false }).addTo(MV.spotsLayer);
  });
}
function drawLegend() {
  const stops = MV.mode === "wave" ? WAVE_STOPS : WIND_STOPS, unit = MV.mode === "wave" ? "m" : "km/h";
  const max = stops[stops.length - 1][0];
  const grad = stops.map(([v, c]) => `${c} ${Math.round(v / max * 100)}%`).join(",");
  $("#flegend").innerHTML = `<span>${MV.mode === "wave" ? "Hauteur des vagues (Hs)" : "Vent moyen à 10 m"}</span><div class="ramp" style="background:linear-gradient(90deg,${grad})"></div><div class="rampl">${stops.filter((_, i) => i % 2 === 0 || i === stops.length - 1).map(([v]) => `<span>${fmt(v, v % 1 ? 1 : 0)}${v === max ? " " + unit : ""}</span>`).join("")}</div>`;
}
function setMapHour(i) { MV.idx = clamp(i, 0, MV.times.length - 1); $("#fhour").value = MV.idx; updateLabel(); drawField(); drawSpots(); }
function togglePlay() {
  const b = $("#fplay");
  if (MV.playing) { clearInterval(MV.playing); MV.playing = null; b.textContent = "▶ Lecture"; b.setAttribute("aria-pressed", "false"); return; }
  b.textContent = "❚❚ Pause"; b.setAttribute("aria-pressed", "true");
  MV.playing = setInterval(() => setMapHour(MV.idx + 1 >= MV.times.length ? 0 : MV.idx + 1), 700);
}
function setMapMode(mode) {
  MV.mode = mode; document.querySelectorAll("[data-fmode]").forEach(b => b.setAttribute("aria-pressed", b.dataset.fmode === mode));
  drawLegend(); drawField(); seedParticles();
}
