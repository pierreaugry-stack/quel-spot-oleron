"use strict";
/* Quel spot à Oléron ? — V2
   Données : Open-Meteo (prévisions), data/obs.json (bouées Candhis, via GitHub Actions),
   Pioupiou (vent mesuré), SHOM (marée mesurée). Critères : spots.json. */

const DAYS = 5;
const BEACONS = [
  { id: 1309, name: "Plage des Saumonards", where: "Côte est d'Oléron, abritée de l'ouest" },
  { id: 2071, name: "MAC17", where: "Marennes / La Tremblade" },
  { id: 1695, name: "La Chainade", where: "Marennes" }
];
const TIDE_GAUGE = { id: 736, name: "La Cotinière", lat: 45.9136, lon: -1.3278 };
const TIDE_POINT = [45.9, -1.36];               // point de prévision de marée (commun aux spots)
const BIAS_BUOYS = ["08504", "08505", "03302"]; // bouées au large utilisées pour corriger la houle
const GRID = { lat: [45.55, 46.35, 0.16], lon: [-1.95, -0.95, 0.2] };

/* ---------- outils ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const angDiff = (a, b) => { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const CARD = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO"];
const card = d => d == null ? "–" : CARD[Math.round((((d % 360) + 360) % 360) / 22.5) % 16];
const arrow = d => d == null ? "" : `<span class="arrow" style="transform:rotate(${(d + 180) % 360}deg)" aria-hidden="true">↑</span>`;
const fmt = (x, n = 1) => x == null || isNaN(x) ? "–" : x.toFixed(n).replace(".", ",");
const JOURS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
const hourOf = t => +t.slice(11, 13);
const ago = ms => { const m = Math.max(0, Math.round(ms / 60000)); return m < 60 ? `il y a ${m} min` : `il y a ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`; };
const energy = (h, t) => h == null || t == null ? null : 0.49 * h * h * t;
function parisKey(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(date).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:00`;
}
const dayLabel = (iso, i) => i === 0 ? "Aujourd'hui" : i === 1 ? "Demain" : (() => { const d = new Date(iso + "T12:00"); return `${JOURS[d.getDay()]} ${d.getDate()}`; })();
const timeLabel = t => { const d = new Date(t.slice(0, 10) + "T12:00"); return `${JOURS[d.getDay()]} ${d.getDate()} · ${hourOf(t)} h`; };
async function getJSON(url, ms = 25000) {
  const c = new AbortController(); const tm = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { signal: c.signal }); if (!r.ok) throw new Error("HTTP " + r.status); return await r.json(); }
  finally { clearTimeout(tm); }
}
const arr = x => Array.isArray(x) ? x : [x];

/* ---------- notation ---------- */
function dirMult(from, spot) {
  if (from == null) return 0;
  const d = angDiff(from, spot.swell.ideal);
  if (d <= spot.swell.window) return 1;
  return clamp(Math.cos((d - spot.swell.window) / 50 * Math.PI / 2), 0, 1);
}
function sizeScore(H, s) {
  const [mn, lo, hi, mx] = s;
  if (H < mn * 0.6) return 0;
  if (H < mn) return lerp(0, 0.35, (H - mn * 0.6) / (mn * 0.4));
  if (H < lo) return lerp(0.35, 1, (H - mn) / (lo - mn));
  if (H <= hi) return 1;
  if (H <= mx) return lerp(1, 0.45, (H - hi) / (mx - hi));
  return clamp(lerp(0.45, 0, (H - mx) / (mx * 0.4)), 0, 0.45);
}
function periodScore(T, min) {
  if (T == null) return 0.6;
  if (min && T < min) return 0.3;
  if (T < 6) return 0.25;
  if (T < 9) return lerp(0.25, 0.75, (T - 6) / 3);
  if (T < 12) return lerp(0.75, 1, (T - 9) / 3);
  return 1;
}
function windInfo(speed, from, spot) {
  if (speed == null || from == null) return { s: 0.6, label: "inconnu" };
  const rule = spot.wind_;
  const rel = angDiff(from, rule.offshore);
  const label = rel <= 45 ? "offshore" : rel <= 90 ? "side-off" : rel <= 135 ? "side-on" : "onshore";
  if (speed < 7) return { s: 1, label: "calme (" + label + ")" };
  let s = rel <= 45 ? 1 : rel <= 90 ? 0.85 : rel <= 135 ? 0.6 : 0.4;
  if (rel > 90) s *= clamp(1 - (speed - 7) / 28, 0.12, 1);
  else if (speed > (rule.maxOffshore ?? 35)) s *= clamp(1 - (speed - (rule.maxOffshore ?? 35)) / 35, 0.45, 1);
  return { s, label };
}
function tideScore(n, rising, t) {
  if (n == null) return 0.8;
  let s;
  if (n >= t.lo && n <= t.hi) s = 1;
  else { const dist = n < t.lo ? t.lo - n : n - t.hi; s = clamp(1 - dist * 1.6, 0.35, 1); }
  if (t.prefer === "montante") s = rising ? Math.min(1, s + 0.1) : Math.max(0, s - 0.08);
  if (t.prefer === "descendante") s = rising ? Math.max(0, s - 0.08) : Math.min(1, s + 0.1);
  return s;
}
function energyScore(E, rule) {
  if (!rule || E == null) return 1;
  if (rule.min && E < rule.min) return clamp((E / rule.min - 0.6) / 0.4, 0, 1);
  if (rule.max && E > rule.max) return clamp(1 - (E / rule.max - 1), 0.4, 1);
  return 1;
}
function coefScore(c, rule) {
  if (!rule || c == null) return 1;
  if (rule.max && c > rule.max) return clamp(1 - (c - rule.max) / 40, 0.6, 1);
  if (rule.min && c < rule.min) return clamp(1 - (rule.min - c) / 40, 0.6, 1);
  return 1;
}
function rate(spot, h, bias = 1) {
  const dm = dirMult(h.sw.d, spot), dmw = dirMult(h.ww.d, spot);
  const swH = (h.sw.h ?? 0) * bias, wwH = (h.ww.h ?? 0) * bias;
  const heff = Math.sqrt(Math.pow(swH * dm, 2) + Math.pow(wwH * dmw * 0.55, 2));
  const E = energy(swH, h.sw.p);
  const parts = {
    size: sizeScore(heff, spot.size), period: periodScore(h.sw.p, spot.periodMin),
    wind: windInfo(h.wind.v, h.wind.d, spot), tide: tideScore(h.tide.n, h.tide.rising, spot.tide),
    energy: energyScore(E, spot.energy), coef: coefScore(h.tide.coef, spot.coef), dir: dm
  };
  const score = Math.round(100 * parts.size * (0.45 + 0.55 * parts.period) * parts.wind.s * parts.tide * parts.energy * parts.coef) / 10;
  return { heff, E, parts, score };
}
const VERDICTS = [[7.5, "Ça vaut le coup"], [5.5, "Bon plan"], [3.5, "Surfable"], [1.5, "Bof"], [-1, "Pas la peine"]];
const verdict = s => s == null ? "Nuit" : VERDICTS.find(v => s >= v[0])[1];
const scoreColor = s => s == null ? "var(--s0)" : s >= 8 ? "var(--s5)" : s >= 6.5 ? "var(--s4)" : s >= 5 ? "var(--s3)" : s >= 3.5 ? "var(--s2)" : s >= 2 ? "var(--s1)" : "var(--s0)";
const scoreInk = s => s != null && s >= 6.5 ? "#fff" : "var(--fg)";
const windColor = v => v == null ? "#999" : v < 10 ? "var(--w1)" : v < 20 ? "var(--w2)" : v < 30 ? "var(--w3)" : v < 40 ? "var(--w4)" : "var(--w5)";

/* ---------- état ---------- */
const S = { cfg: null, spots: [], tide: null, grid: null, obs: null, beacons: [], gauge: null, buoyFc: null, bias: null, nowKey: null, hourIdx: 0, times: [], day: 0, sel: null, layers: { wind: true, swell: true, obs: true } };

/* ---------- chargement ---------- */
const qs = o => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
async function loadTide() {
  const j = await getJSON(`https://marine-api.open-meteo.com/v1/marine?${qs({ latitude: TIDE_POINT[0], longitude: TIDE_POINT[1], hourly: "sea_level_height_msl", timezone: "Europe/Paris", past_days: 30, forecast_days: DAYS })}`);
  const t = j.hourly.time, v = j.hourly.sea_level_height_msl;
  const range = v.map((x, i) => { const w = v.slice(Math.max(0, i - 13), i + 14).filter(y => y != null); return w.length ? Math.max(...w) - Math.min(...w) : null; });
  const rs = range.filter(x => x != null); const rmin = Math.min(...rs), rmax = Math.max(...rs);
  const out = new Map();
  t.forEach((time, i) => {
    if (v[i] == null) return;
    const w = v.slice(Math.max(0, i - 7), i + 8).filter(y => y != null);
    const lo = Math.min(...w), hi = Math.max(...w);
    const n = hi - lo > 0.2 ? (v[i] - lo) / (hi - lo) : 0.5;
    const nx = v[i + 1], pv = v[i - 1];
    const rising = nx != null ? nx > v[i] : pv != null ? v[i] > pv : null;
    const coef = range[i] == null || rmax - rmin < 0.1 ? null : Math.round(35 + 75 * (range[i] - rmin) / (rmax - rmin));
    out.set(time, { level: v[i], n, rising, coef });
  });
  return out;
}
async function loadSpots(spots) {
  const mLat = spots.map(s => s.marine[0]).join(","), mLon = spots.map(s => s.marine[1]).join(",");
  const wLat = spots.map(s => s.wind[0]).join(","), wLon = spots.map(s => s.wind[1]).join(",");
  const [m, w] = await Promise.all([
    getJSON(`https://marine-api.open-meteo.com/v1/marine?${qs({ latitude: mLat, longitude: mLon, hourly: "wave_height,wave_period,swell_wave_height,swell_wave_direction,swell_wave_period,swell_wave_peak_period,wind_wave_height,wind_wave_direction", timezone: "Europe/Paris", forecast_days: DAYS })}`),
    getJSON(`https://api.open-meteo.com/v1/forecast?${qs({ latitude: wLat, longitude: wLon, hourly: "wind_speed_10m,wind_direction_10m,wind_gusts_10m", daily: "sunrise,sunset", wind_speed_unit: "kmh", timezone: "Europe/Paris", forecast_days: DAYS })}`)
  ]);
  return spots.map((spot, i) => {
    const mi = arr(m)[i], wi = arr(w)[i];
    const idx = new Map(mi.hourly.time.map((t, k) => [t, k]));
    const sun = new Map(wi.daily.time.map((d, k) => [d, [wi.daily.sunrise[k], wi.daily.sunset[k]]]));
    const hours = wi.hourly.time.map((t, k) => {
      const j = idx.get(t); const M = key => j == null ? null : mi.hourly[key][j];
      const h = {
        t,
        sw: { h: M("swell_wave_height"), d: M("swell_wave_direction"), p: M("swell_wave_peak_period") ?? M("swell_wave_period") },
        ww: { h: M("wind_wave_height"), d: M("wind_wave_direction") },
        tot: { h: M("wave_height"), p: M("wave_period") },
        wind: { v: wi.hourly.wind_speed_10m[k], d: wi.hourly.wind_direction_10m[k], g: wi.hourly.wind_gusts_10m[k] },
        tide: S.tide?.get(t) || { n: null, rising: null, coef: null, level: null }
      };
      const [sr, ss] = sun.get(t.slice(0, 10)) || [];
      h.day = sr && ss ? hourOf(t) >= hourOf(sr) && hourOf(t) <= hourOf(ss) : hourOf(t) >= 8 && hourOf(t) <= 18;
      h.missing = h.sw.h == null;
      const r = rate(spot, h);
      Object.assign(h, r, { raw: h.missing ? null : r.score });
      h.score = h.day && !h.missing ? r.score : null;
      return h;
    });
    return { spot, hours };
  });
}
function gridPoints() {
  const pts = [];
  for (let la = GRID.lat[0]; la <= GRID.lat[1] + 1e-9; la += GRID.lat[2])
    for (let lo = GRID.lon[0]; lo <= GRID.lon[1] + 1e-9; lo += GRID.lon[2]) pts.push([+la.toFixed(3), +lo.toFixed(3)]);
  return pts;
}
async function loadGrid() {
  const pts = gridPoints();
  const lat = pts.map(p => p[0]).join(","), lon = pts.map(p => p[1]).join(",");
  const [w, m] = await Promise.all([
    getJSON(`https://api.open-meteo.com/v1/forecast?${qs({ latitude: lat, longitude: lon, hourly: "wind_speed_10m,wind_direction_10m,wind_gusts_10m", wind_speed_unit: "kmh", timezone: "Europe/Paris", forecast_days: DAYS })}`),
    getJSON(`https://marine-api.open-meteo.com/v1/marine?${qs({ latitude: lat, longitude: lon, hourly: "swell_wave_height,swell_wave_direction,swell_wave_peak_period", timezone: "Europe/Paris", forecast_days: DAYS })}`)
  ]);
  const W = arr(w), M = arr(m);
  return pts.map((p, i) => ({
    lat: p[0], lon: p[1], land: (W[i]?.elevation ?? 0) > 3,
    time: W[i].hourly.time, wv: W[i].hourly.wind_speed_10m, wd: W[i].hourly.wind_direction_10m, wg: W[i].hourly.wind_gusts_10m,
    mtime: M[i]?.hourly?.time || [], sh: M[i]?.hourly?.swell_wave_height || [], sd: M[i]?.hourly?.swell_wave_direction || [], sp: M[i]?.hourly?.swell_wave_peak_period || []
  }));
}
async function loadObs() {
  const j = await getJSON(`data/obs.json?ts=${Date.now()}`, 15000);
  return j;
}
async function loadBuoyForecast(buoys) {
  if (!buoys.length) return [];
  const j = await getJSON(`https://marine-api.open-meteo.com/v1/marine?${qs({ latitude: buoys.map(b => b.lat).join(","), longitude: buoys.map(b => b.lon).join(","), hourly: "wave_height,wave_peak_period,wave_direction", timezone: "GMT", past_days: 2, forecast_days: 1 })}`);
  return arr(j).map(x => x.hourly);
}
async function loadBeacons() {
  return Promise.all(BEACONS.map(b => getJSON(`https://api.pioupiou.fr/v1/live/${b.id}`, 15000).then(j => ({ ...b, ok: true, d: j.data })).catch(() => ({ ...b, ok: false }))));
}
async function loadBeaconForecast(beacons) {
  const ok = beacons.filter(b => b.ok && b.d.location?.latitude);
  if (!ok.length) return;
  const j = await getJSON(`https://api.open-meteo.com/v1/forecast?${qs({ latitude: ok.map(b => b.d.location.latitude).join(","), longitude: ok.map(b => b.d.location.longitude).join(","), hourly: "wind_speed_10m,wind_direction_10m,wind_gusts_10m", wind_speed_unit: "kmh", timezone: "Europe/Paris", forecast_days: 1, past_days: 1 })}`);
  arr(j).forEach((x, i) => { ok[i].fc = x.hourly; });
}
async function loadGauge() {
  const end = new Date(), start = new Date(end - 12 * 3600e3);
  const iso = d => d.toISOString().slice(0, 19) + "Z";
  const j = await getJSON(`https://services.data.shom.fr/maregraphie/observation/json/${TIDE_GAUGE.id}?sources=1&dtStart=${iso(start)}&dtEnd=${iso(end)}`, 20000);
  return (j.data || []).map(r => ({ t: new Date(r.timestamp.replace(/\//g, "-").replace(" ", "T") + "Z"), v: r.value })).filter(r => r.v != null);
}

/* ---------- correction par les bouées ---------- */
function computeBias() {
  if (!S.obs || !S.buoyFc) return null;
  const ratios = [];
  S.obs.buoys.forEach((b, i) => {
    if (!BIAS_BUOYS.includes(b.id) || !b.series.length) return;
    const last = b.series[b.series.length - 1];
    if (Date.now() - new Date(last.t) > 3 * 3600e3 || last.hs == null) return;
    const fc = S.buoyFc[i]; if (!fc) return;
    const key = last.t.slice(0, 13) + ":00";
    const k = fc.time.indexOf(key); if (k < 0 || !fc.wave_height[k]) return;
    ratios.push(last.hs / fc.wave_height[k]);
  });
  if (!ratios.length) return null;
  const r = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  return { ratio: clamp(r, 0.6, 1.6), raw: r, n: ratios.length };
}

/* ---------- tableau de bord ---------- */
function nowIndex(hours) { const i = hours.findIndex(h => h.t === S.nowKey); return i < 0 ? 0 : i; }
function renderDash() {
  const bias = S.bias?.ratio ?? 1;
  const rows = S.spots.map(({ spot, hours }) => {
    const h = hours[nowIndex(hours)];
    const r = h.missing ? null : rate(spot, h, bias);
    return { spot, h, r, s: h.day && r ? r.score : null, raw: r?.score ?? null };
  });
  const night = rows.every(x => x.s == null);
  const ranked = [...rows].sort((a, b) => (b.raw ?? -1) - (a.raw ?? -1));
  const best = ranked[0];
  const nextWin = windows()[0];
  const hero = $("#hero");
  if (!best || best.raw == null) { hero.innerHTML = `<div class="skel">Pas de prévision pour l'heure actuelle.</div>`; return; }
  const p = best.r.parts, h = best.h;
  const pill = (txt, v) => `<span class="pill ${v >= 0.85 ? "good" : v >= 0.55 ? "warn" : "bad"}">${txt}</span>`;
  const biasTxt = S.bias ? `Houle corrigée par les bouées : mesurée ${S.bias.raw >= 1 ? "+" : ""}${Math.round((S.bias.raw - 1) * 100)} % par rapport à la prévision (${S.bias.n} bouée${S.bias.n > 1 ? "s" : ""}).` : "Pas de correction par les bouées (données absentes ou trop anciennes).";
  hero.innerHTML = `
    <div class="eyebrow">${night ? "Il fait nuit · classement indicatif" : "Maintenant · " + timeLabel(S.nowKey)}</div>
    <div class="row">
      <div class="big" style="background:${scoreColor(best.raw)};color:${scoreInk(best.raw)}">${fmt(best.raw)}</div>
      <div style="min-width:0"><h3>${esc(best.spot.name)}</h3><div class="eyebrow" style="text-transform:none;letter-spacing:0">${esc(best.spot.area)} · ${verdict(best.raw)}</div></div>
    </div>
    <div class="why">
      ${pill(`Houle ${fmt(h.sw.h * bias)} m ${fmt(h.sw.p, 0)} s ${card(h.sw.d)} · ≈ ${fmt(best.r.heff)} m au spot`, p.size)}
      ${pill(`Vent ${fmt(h.wind.v, 0)} km/h ${card(h.wind.d)} · ${p.wind.label}`, p.wind.s)}
      ${pill(`Marée ${tideText(h)}`, p.tide)}
      ${h.tide.coef != null ? pill(`Coef. ≈ ${h.tide.coef}`, p.coef) : ""}
      ${best.r.E != null ? pill(`Énergie ${fmt(best.r.E, 0)} kW/m`, p.energy) : ""}
    </div>
    <p class="note">${biasTxt} ${nextWin ? `Prochain créneau à 5/10 ou plus : <b>${esc(nextWin.spot.name)}</b>, ${dayLabel(nextWin.peak.t.slice(0, 10), dayIndexOf(nextWin.peak.t))} ${hourOf(nextWin.from.t)}–${hourOf(nextWin.to.t) + 1} h (${fmt(nextWin.peak.score)}).` : "Aucun créneau à 5/10 ou plus sur 5 jours."}</p>`;
  $("#rank").innerHTML = `<div class="eyebrow" style="padding:4px 6px">Classement maintenant</div>` + ranked.map(x => `
    <button class="rk" type="button" data-spot="${x.spot.id}" data-t="${x.h.t}">
      <div class="sc" style="background:${scoreColor(x.raw)};color:${scoreInk(x.raw)}">${fmt(x.raw)}</div>
      <div style="min-width:0"><b>${esc(x.spot.name)}</b><span>${fmt(x.r?.heff)} m au spot · vent ${x.r?.parts.wind.label ?? "–"} · ${tideText(x.h)}</span></div>
      <div class="lv">${esc(x.spot.level)}</div>
    </button>`).join("");
}
function tideText(h) {
  const n = h.tide?.n; if (n == null) return "–";
  const lvl = n < 0.2 ? "basse" : n < 0.4 ? "mi-basse" : n < 0.6 ? "mi-marée" : n < 0.8 ? "mi-haute" : "haute";
  return `${lvl} ${h.tide.rising ? "↗" : "↘"}`;
}

/* ---------- créneaux / grille / détail ---------- */
function windows() {
  const out = [];
  S.spots.forEach(({ spot, hours }) => {
    let cur = null;
    hours.forEach((h, i) => {
      if (h.t < S.nowKey) return;
      if (h.score != null && h.score >= 5) {
        if (!cur || hours[i - 1] !== cur.to) { cur = { spot, from: h, to: h, peak: h }; out.push(cur); }
        cur.to = h; if (h.score > cur.peak.score) cur.peak = h;
      } else cur = null;
    });
  });
  return out.sort((a, b) => b.peak.score - a.peak.score).slice(0, 8);
}
const dates = () => [...new Set(S.spots[0].hours.map(h => h.t.slice(0, 10)))].slice(0, DAYS);
function dayIndexOf(t) { return dates().indexOf(t.slice(0, 10)); }
function renderSlots() {
  const ws = windows();
  $("#slots").innerHTML = ws.length ? ws.map(w => { const p = w.peak; return `
    <button class="slot" type="button" data-spot="${w.spot.id}" data-t="${p.t}">
      <div class="sc" style="background:${scoreColor(p.score)};color:${scoreInk(p.score)}">${fmt(p.score)}</div>
      <div style="min-width:0"><b>${esc(w.spot.name)}</b><span>${fmt(p.sw.h)} m ${fmt(p.sw.p, 0)} s ${card(p.sw.d)} · vent ${fmt(p.wind.v, 0)} km/h ${card(p.wind.d)} (${p.parts.wind.label}) · ${tideText(p)}${p.tide.coef ? " · coef ≈ " + p.tide.coef : ""}</span></div>
      <div class="when">${dayLabel(p.t.slice(0, 10), dayIndexOf(p.t))}<br>${hourOf(w.from.t)}–${hourOf(w.to.t) + 1} h</div>
    </button>`; }).join("") : `<div class="skel">Aucun créneau à 5/10 ou plus sur les 5 prochains jours.</div>`;
}
function renderDays() {
  $("#days").innerHTML = dates().map((d, i) => `<button class="chip" type="button" data-day="${i}" aria-pressed="${i === S.day}">${dayLabel(d, i)}</button>`).join("");
}
function renderGrid() {
  const date = dates()[S.day];
  const hrs = S.spots[0].hours.filter(h => h.t.slice(0, 10) === date && h.day).map(h => h.t);
  let html = `<thead><tr><th class="rowh"></th>${hrs.map(t => `<th>${hourOf(t)}h</th>`).join("")}</tr></thead><tbody>`;
  S.spots.forEach(({ spot, hours }) => {
    const map = new Map(hours.map(h => [h.t, h]));
    html += `<tr><th class="rowh" scope="row">${esc(spot.name)}</th>${hrs.map(t => { const h = map.get(t), s = h?.score;
      const sel = S.sel && S.sel.spot === spot.id && S.sel.t === t;
      return `<td class="cell${sel ? " sel" : ""}${t === S.nowKey ? " nowc" : ""}" data-spot="${spot.id}" data-t="${t}" tabindex="0" style="background:${scoreColor(s)};color:${scoreInk(s)}" aria-label="${esc(spot.name)} ${hourOf(t)} h : ${fmt(s)} sur 10">${s == null ? "" : Math.round(s)}</td>`; }).join("")}</tr>`;
  });
  const ref = new Map(S.spots[0].hours.map(h => [h.t, h]));
  const aux = (lab, f) => `<tr class="auxrow"><th>${lab}</th>${hrs.map(t => `<td class="aux">${f(ref.get(t))}</td>`).join("")}</tr>`;
  html += aux("Houle m", h => fmt(h?.sw.h)) + aux("Période s", h => fmt(h?.sw.p, 0)) + aux("Vent km/h", h => `${arrow(h?.wind.d)}${fmt(h?.wind.v, 0)}`) + aux("Marée", h => h?.tide.n == null ? "–" : (h.tide.rising ? "↗" : "↘") + Math.round(h.tide.n * 100) + "%") + aux("Coef.", h => h?.tide.coef ?? "–");
  $("#grid").innerHTML = html + "</tbody>";
  $("#scale").innerHTML = `<span>Note :</span>` + [[0, "0–2"], [2, "2–3,5"], [3.5, "3,5–5"], [5, "5–6,5"], [6.5, "6,5–8"], [8, "8–10"]].map(([s, l]) => `<i style="background:${scoreColor(s)}"></i><span>${l}</span>`).join(" ") + `<span>· lignes du bas : houle et vent à Chassiron</span>`;
}
const meter = (label, v) => `<div class="meter"><span>${label}</span><div class="bar"><span style="width:${Math.round(clamp(v, 0, 1) * 100)}%"></span></div><span class="v">${Math.round(v * 100)}%</span></div>`;
function renderDetail() {
  const sel = S.sel; if (!sel) return;
  const ser = S.spots.find(s => s.spot.id === sel.spot); const h = ser?.hours.find(x => x.t === sel.t); if (!h) return;
  const sp = ser.spot, s = h.raw;
  $("#detail").innerHTML = `<h3>${esc(sp.name)} · ${dayLabel(h.t.slice(0, 10), dayIndexOf(h.t))} ${hourOf(h.t)} h · ${fmt(s)}/10 · ${h.score == null ? "nuit" : verdict(s)}</h3>
    <div><h4>Houle</h4><dl class="facts">
      <dt>Houle</dt><dd>${fmt(h.sw.h)} m · ${fmt(h.sw.p, 0)} s · ${arrow(h.sw.d)} ${card(h.sw.d)} (${Math.round(h.sw.d ?? 0)}°)</dd>
      <dt>Mer du vent</dt><dd>${fmt(h.ww.h)} m ${card(h.ww.d)}</dd>
      <dt>Au spot</dt><dd>≈ ${fmt(h.heff)} m (idéal ${fmt(sp.size[1])}–${fmt(sp.size[2])} m)</dd>
      <dt>Énergie</dt><dd>${fmt(h.E, 0)} kW/m</dd></dl></div>
    <div><h4>Vent et marée</h4><dl class="facts">
      <dt>Vent</dt><dd>${fmt(h.wind.v, 0)} km/h, rafales ${fmt(h.wind.g, 0)} · ${arrow(h.wind.d)} ${card(h.wind.d)}</dd>
      <dt>Pour ce spot</dt><dd>${h.parts.wind.label} (offshore = ${card(sp.wind_.offshore)})</dd>
      <dt>Marée</dt><dd>${tideText(h)} · ${h.tide.n == null ? "–" : Math.round(h.tide.n * 100) + " % du marnage"}</dd>
      <dt>Coefficient</dt><dd>≈ ${h.tide.coef ?? "–"} (estimé)</dd></dl></div>
    <div><h4>Ce qui fait la note</h4>${meter("Taille", h.parts.size)}${meter("Période", h.parts.period)}${meter("Vent", h.parts.wind.s)}${meter("Marée", h.parts.tide)}${meter("Orientation", h.parts.dir)}${sp.energy ? meter("Énergie", h.parts.energy) : ""}${sp.coef?.max || sp.coef?.min ? meter("Coefficient", h.parts.coef) : ""}</div>`;
}
function renderSpotsCfg() {
  const t = x => Math.round(x * 100) + " %";
  $("#spots").innerHTML = S.cfg.spots.map(s => `<div class="spcard"><h3>${esc(s.name)}</h3><dl class="facts">
    <dt>Type</dt><dd>${esc(s.type)}</dd><dt>Niveau</dt><dd>${esc(s.level)}</dd>
    <dt>Houle</dt><dd>${card(s.swell.ideal)} (${s.swell.ideal}° ± ${s.swell.window}°)</dd>
    <dt>Taille</dt><dd>${fmt(s.size[1])}–${fmt(s.size[2])} m idéal · ${fmt(s.size[0])} mini · ${fmt(s.size[3])} maxi</dd>
    <dt>Période</dt><dd>${s.periodMin ? s.periodMin + " s mini" : "–"}${s.energy?.min ? ` · énergie ≥ ${s.energy.min} kW/m` : ""}</dd>
    <dt>Offshore</dt><dd>${card(s.wind_.offshore)} (${s.wind_.offshore}°)</dd>
    <dt>Marée</dt><dd>${t(s.tide.lo)}–${t(s.tide.hi)} du marnage${s.tide.prefer ? ", " + s.tide.prefer : ""}${s.coef?.max ? ` · coef ≤ ${s.coef.max}` : ""}</dd>
    <dt>Dangers</dt><dd>${esc(s.dangers)}</dd></dl><p>${esc(s.notes)}</p></div>`).join("");
}

/* ---------- carte ---------- */
let MAP, L_WIND, L_SWELL, L_SPOTS, L_OBS;
const svgArrow = (deg, color, size = 26, stroke = "#fff") => `<svg width="${size}" height="${size}" viewBox="-14 -14 28 28" style="transform:rotate(${(deg + 180) % 360}deg);display:block" aria-hidden="true"><path d="M0,-12 L6,3 L1.6,1 L1.6,12 L-1.6,12 L-1.6,1 L-6,3Z" fill="${color}" stroke="${stroke}" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
function icon(html, size) { return L.divIcon({ className: "ico", html: `<div style="position:relative;width:${size}px;height:${size}px">${html}</div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }); }
function initMap() {
  MAP = L.map("map", { zoomControl: true, scrollWheelZoom: false }).setView([45.98, -1.4], 10);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 15, className: "basemap", attribution: '© <a href="https://www.openstreetmap.org/copyright">contributeurs OpenStreetMap</a>'
  }).addTo(MAP);
  MAP.on("focus", () => MAP.scrollWheelZoom.enable()); MAP.on("blur", () => MAP.scrollWheelZoom.disable());
  L_SWELL = L.layerGroup().addTo(MAP); L_WIND = L.layerGroup().addTo(MAP); L_OBS = L.layerGroup().addTo(MAP); L_SPOTS = L.layerGroup().addTo(MAP);
  $("#legend").innerHTML = `<span>Vent prévu (km/h) :</span>` + [["var(--w1)", "< 10"], ["var(--w2)", "10–20"], ["var(--w3)", "20–30"], ["var(--w4)", "30–40"], ["var(--w5)", "> 40"]].map(([c, l]) => `<span><i style="background:${c}"></i>${l}</span>`).join("") +
    `<span><i style="background:#2f5fb3"></i>houle prévue (taille ∝ hauteur)</span><span><i style="background:#1d2b31"></i>mesure (balise, bouée)</span><span>● spot coloré par sa note</span>`;
}
function renderMap() {
  if (!MAP) return;
  const t = S.times[S.hourIdx]; if (!t) return;
  $("#hourLabel").textContent = timeLabel(t) + (t === S.nowKey ? " (maintenant)" : "");
  L_WIND.clearLayers(); L_SWELL.clearLayers(); L_SPOTS.clearLayers(); L_OBS.clearLayers();
  if (S.grid) S.grid.forEach(g => {
    const k = g.time.indexOf(t);
    if (S.layers.wind && k >= 0 && g.wv[k] != null) {
      L.marker([g.lat, g.lon], { icon: icon(`${svgArrow(g.wd[k], windColor(g.wv[k]), 24)}<span class="lab">${Math.round(g.wv[k])}</span>`, 24), interactive: false, keyboard: false }).addTo(L_WIND);
    }
    const km = g.mtime.indexOf(t);
    if (S.layers.swell && !g.land && km >= 0 && g.sh[km] != null) {
      const sz = Math.round(clamp(16 + g.sh[km] * 7, 18, 44));
      L.marker([g.lat + 0.035, g.lon + 0.045], { icon: icon(`${svgArrow(g.sd[km], "#2f5fb3", sz)}<span class="lab">${fmt(g.sh[km])} m ${fmt(g.sp[km], 0)}s</span>`, sz), interactive: false, keyboard: false, opacity: 0.85 }).addTo(L_SWELL);
    }
  });
  S.spots.forEach(({ spot, hours }) => {
    const h = hours.find(x => x.t === t); const s = h?.raw;
    const m = L.marker([spot.lat, spot.lon], { icon: L.divIcon({ className: "ico", html: `<div class="spotpin" style="background:${scoreColor(s)};color:${scoreInk(s)};opacity:${h?.day ? 1 : 0.6}">${s == null ? "–" : Math.round(s)}</div>`, iconSize: [34, 34], iconAnchor: [17, 17] }), title: spot.name, zIndexOffset: 1000 }).addTo(L_SPOTS);
    m.bindPopup(() => h ? `<h4>${esc(spot.name)}</h4><div>${timeLabel(t)} · <b>${fmt(s)}/10</b> ${h.day ? "" : "(nuit)"}</div><dl class="facts" style="margin-top:6px"><dt>Houle</dt><dd>${fmt(h.sw.h)} m ${fmt(h.sw.p, 0)} s ${card(h.sw.d)}</dd><dt>Au spot</dt><dd>≈ ${fmt(h.heff)} m</dd><dt>Vent</dt><dd>${fmt(h.wind.v, 0)} km/h ${card(h.wind.d)} · ${h.parts.wind.label}</dd><dt>Marée</dt><dd>${tideText(h)}</dd></dl>` : esc(spot.name));
  });
  if (S.layers.obs) renderObsOnMap(t);
}
function obsFresh(t) { return t === S.nowKey; }
function renderObsOnMap(t) {
  const isNow = obsFresh(t), op = isNow ? 1 : 0.45;
  S.beacons.forEach(b => {
    if (!b.ok || !b.d.location?.latitude) return;
    const m = b.d.measurements || {};
    const fc = forecastAtNow(b.fc);
    const html = `${svgArrow(m.wind_heading ?? 0, "#1d2b31", 30)}<span class="lab">${fmt(m.wind_speed_avg, 0)} mes.${fc ? " / " + fmt(fc.v, 0) + " prév." : ""}</span>`;
    L.marker([b.d.location.latitude, b.d.location.longitude], { icon: icon(html, 30), opacity: op, zIndexOffset: 900, title: b.name }).addTo(L_OBS)
      .bindPopup(() => beaconPopup(b, fc, isNow));
  });
  if (S.obs) S.obs.buoys.forEach((b, i) => {
    const last = b.series[b.series.length - 1]; if (!last) return;
    const html = `<div class="buoypin">${fmt(last.hs)}</div>${last.dir != null ? `<div style="position:absolute;left:24px;top:-14px">${svgArrow(last.dir, "#1d2b31", 22)}</div>` : ""}<span class="lab">${esc(b.name)}</span>`;
    L.marker([b.lat, b.lon], { icon: icon(html, 30), opacity: op, zIndexOffset: 900, title: b.name }).addTo(L_OBS).bindPopup(() => buoyPopup(b, i));
  });
  if (S.gauge?.length) {
    const g = S.gauge[S.gauge.length - 1];
    L.circleMarker([TIDE_GAUGE.lat, TIDE_GAUGE.lon], { radius: 7, color: "#fff", weight: 2, fillColor: "#1d2b31", fillOpacity: op }).addTo(L_OBS)
      .bindPopup(`<h4>Marégraphe ${TIDE_GAUGE.name}</h4><div>${fmt(g.v, 2)} m · ${gaugeTrend()}</div><div class="m">${ago(Date.now() - g.t)}</div>`);
  }
}
function forecastAtNow(h) {
  if (!h) return null; const k = h.time.indexOf(S.nowKey); if (k < 0) return null;
  return { v: h.wind_speed_10m[k], d: h.wind_direction_10m[k], g: h.wind_gusts_10m[k] };
}
function beaconPopup(b, fc, isNow) {
  const m = b.d.measurements || {}; const t = m.date ? new Date(m.date) : null;
  return `<h4>Balise ${esc(b.d.meta?.name || b.name)}</h4><div class="m">${esc(b.where)} · ${t ? ago(Date.now() - t) : "pas de mesure"}${isNow ? "" : " · mesure actuelle"}</div>
    <table class="cmp" style="margin-top:6px"><tr><th></th><th>Mesuré</th><th>Prévu</th></tr>
    <tr><td>Vent moyen</td><td>${fmt(m.wind_speed_avg, 0)} km/h</td><td>${fmt(fc?.v, 0)} km/h</td></tr>
    <tr><td>Rafales</td><td>${fmt(m.wind_speed_max, 0)} km/h</td><td>${fmt(fc?.g, 0)} km/h</td></tr>
    <tr><td>Direction</td><td>${card(m.wind_heading)}</td><td>${card(fc?.d)}</td></tr></table>`;
}
function buoyPopup(b, i) {
  const last = b.series[b.series.length - 1]; const fc = buoyFcAt(i, last.t);
  return `<h4>Bouée ${esc(b.name)}</h4><div class="m">${ago(Date.now() - new Date(last.t))} · position approximative</div>
    <table class="cmp" style="margin-top:6px"><tr><th></th><th>Mesuré</th><th>Prévu</th></tr>
    <tr><td>Hauteur (H1/3)</td><td>${fmt(last.hs)} m</td><td>${fmt(fc?.h)} m</td></tr>
    <tr><td>Période</td><td>${fmt(last.tp ?? last.th, 0)} s</td><td>${fmt(fc?.p, 0)} s</td></tr>
    <tr><td>Direction</td><td>${last.dir != null ? card(last.dir) : "–"}</td><td>${card(fc?.d)}</td></tr></table>`;
}
function buoyFcAt(i, tIso) {
  const fc = S.buoyFc?.[i]; if (!fc) return null; const k = fc.time.indexOf(tIso.slice(0, 13) + ":00"); if (k < 0) return null;
  return { h: fc.wave_height[k], p: fc.wave_peak_period?.[k], d: fc.wave_direction?.[k] };
}
function gaugeTrend() {
  const pts = S.gauge; if (!pts?.length) return "–"; const last = pts[pts.length - 1];
  const prev = pts.find(p => p.t >= new Date(last.t - 30 * 60e3)) || pts[0]; const d = last.v - prev.v;
  return Math.abs(d) < 0.03 ? "étale" : d > 0 ? "monte ↗" : "descend ↘";
}

/* ---------- prévu vs mesuré ---------- */
function chart(series) { // series: [{pts:[{x,y}], color, dash}]
  const all = series.flatMap(s => s.pts); if (all.length < 2) return "";
  const W = 260, H = 70, xs = all.map(p => p.x), ys = all.map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = 0, y1 = Math.max(...ys) * 1.15 || 1;
  const X = x => 4 + (x - x0) / (x1 - x0 || 1) * (W - 8), Y = y => H - 14 - (y - y0) / (y1 - y0) * (H - 22);
  const now = X(Date.now());
  const lines = series.map(s => s.pts.length > 1 ? `<path d="${s.pts.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join("")}" fill="none" stroke="${s.color}" stroke-width="2" ${s.dash ? 'stroke-dasharray="4 3"' : ""} vector-effect="non-scaling-stroke"/>` : "").join("");
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><line x1="4" x2="${W - 4}" y1="${H - 14}" y2="${H - 14}" stroke="var(--line)"/>${now > 4 && now < W ? `<line x1="${now}" x2="${now}" y1="4" y2="${H - 14}" stroke="var(--muted)" stroke-dasharray="2 3"/>` : ""}${lines}<text x="4" y="${H - 2}" font-size="9" fill="var(--muted)" font-family="IBM Plex Mono, monospace">-48 h</text><text x="${W - 4}" y="${H - 2}" font-size="9" fill="var(--muted)" text-anchor="end" font-family="IBM Plex Mono, monospace">max ${fmt(y1 / 1.15)} m</text></svg>`;
}
const deltaTxt = (o, f, u, n = 1) => o == null || f == null ? "" : `<span class="delta" style="color:${Math.abs(o - f) / Math.max(f, 0.1) > 0.25 ? "var(--warn)" : "var(--good)"}">${o - f >= 0 ? "+" : ""}${fmt(o - f, n)} ${u}</span>`;
function renderCmp() {
  const cards = [];
  if (S.obs) S.obs.buoys.forEach((b, i) => {
    const last = b.series[b.series.length - 1];
    if (!last) { cards.push(`<div class="ccard"><h3>Bouée ${esc(b.name)}</h3><div class="m stale">${b.error ? "Bouée injoignable" : "Pas de données"}</div></div>`); return; }
    const fc = buoyFcAt(i, last.t), old = Date.now() - new Date(last.t) > 2 * 3600e3;
    const meas = b.series.filter(r => r.hs != null).map(r => ({ x: +new Date(r.t), y: r.hs }));
    const f = S.buoyFc?.[i]; const fpts = f ? f.time.map((t, k) => ({ x: +new Date(t + ":00Z"), y: f.wave_height[k] })).filter(p => p.y != null && p.x >= (meas[0]?.x ?? 0) && p.x <= Date.now() + 6 * 3600e3) : [];
    cards.push(`<div class="ccard"><h3>Bouée ${esc(b.name)}${b.id === "01705" ? " <span class='m'>(abritée, Gironde)</span>" : ""}</h3>
      <div class="m${old ? " stale" : ""}">Candhis ${b.id} · ${ago(Date.now() - new Date(last.t))}</div>
      <div class="vs"><span class="h"></span><span class="h">Mesuré</span><span class="h">Prévu</span>
        <span>Hauteur</span><span class="o">${fmt(last.hs)} m ${deltaTxt(last.hs, fc?.h, "m")}</span><span>${fmt(fc?.h)} m</span>
        <span>Période</span><span class="o">${fmt(last.tp ?? last.th, 0)} s</span><span>${fmt(fc?.p, 0)} s</span>
        <span>Direction</span><span class="o">${last.dir != null ? card(last.dir) : "–"}</span><span>${card(fc?.d)}</span></div>
      ${chart([{ pts: fpts, color: "var(--fc)", dash: true }, { pts: meas, color: "var(--obs)" }])}
      <div class="m">— mesuré · - - prévu</div></div>`);
  });
  S.beacons.forEach(b => {
    if (!b.ok) { cards.push(`<div class="ccard"><h3>Balise ${esc(b.name)}</h3><div class="m stale">Balise injoignable</div></div>`); return; }
    const m = b.d.measurements || {}, t = m.date ? new Date(m.date) : null, old = !t || Date.now() - t > 90 * 60e3, fc = forecastAtNow(b.fc);
    cards.push(`<div class="ccard"><h3>Balise ${esc(b.d.meta?.name || b.name)}</h3><div class="m${old ? " stale" : ""}">${esc(b.where)} · ${t ? ago(Date.now() - t) : "jamais"}</div>
      <div class="vs"><span class="h"></span><span class="h">Mesuré</span><span class="h">Prévu</span>
        <span>Vent</span><span class="o">${fmt(m.wind_speed_avg, 0)} km/h ${deltaTxt(m.wind_speed_avg, fc?.v, "", 0)}</span><span>${fmt(fc?.v, 0)} km/h</span>
        <span>Rafales</span><span class="o">${fmt(m.wind_speed_max, 0)} km/h</span><span>${fmt(fc?.g, 0)} km/h</span>
        <span>Direction</span><span class="o">${arrow(m.wind_heading)} ${card(m.wind_heading)}</span><span>${arrow(fc?.d)} ${card(fc?.d)}</span></div></div>`);
  });
  if (S.gauge?.length) {
    const g = S.gauge[S.gauge.length - 1]; const now = S.tide?.get(S.nowKey);
    cards.push(`<div class="ccard"><h3>Marée à ${TIDE_GAUGE.name}</h3><div class="m">Marégraphe SHOM · ${ago(Date.now() - g.t)}</div>
      <div class="vs"><span class="h"></span><span class="h">Mesuré</span><span class="h">Prévu</span>
      <span>Niveau</span><span class="o">${fmt(g.v, 2)} m</span><span>${now ? Math.round(now.n * 100) + " % du marnage" : "–"}</span>
      <span>Tendance</span><span class="o">${gaugeTrend()}</span><span>${now ? (now.rising ? "monte ↗" : "descend ↘") : "–"}</span></div>
      ${chart([{ pts: S.gauge.filter((_, i) => i % 5 === 0).map(p => ({ x: +p.t, y: p.v })), color: "var(--obs)" }])}</div>`);
  }
  $("#cmp").innerHTML = cards.join("") || `<div class="skel">Aucune mesure disponible.</div>`;
}

/* ---------- interactions ---------- */
function select(spot, t) {
  S.sel = { spot, t }; const di = dayIndexOf(t); if (di >= 0 && di !== S.day) { S.day = di; renderDays(); }
  renderGrid(); renderDetail();
  const k = S.times.indexOf(t); if (k >= 0) { S.hourIdx = k; $("#hour").value = k; renderMap(); }
}
document.addEventListener("click", e => {
  const el = e.target.closest("[data-spot][data-t]");
  if (el && !el.closest("#map")) { select(el.dataset.spot, el.dataset.t); if (!el.matches("td")) $("#h-detail").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); return; }
  const d = e.target.closest("[data-day]"); if (d) { S.day = +d.dataset.day; renderDays(); renderGrid(); return; }
  const l = e.target.closest("[data-layer]"); if (l) { const k = l.dataset.layer; S.layers[k] = !S.layers[k]; l.setAttribute("aria-pressed", S.layers[k]); renderMap(); }
});
document.addEventListener("keydown", e => { const el = e.target.closest("td[data-spot]"); if (el && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); select(el.dataset.spot, el.dataset.t); } });
$("#hour").addEventListener("input", e => { S.hourIdx = +e.target.value; renderMap(); });
$("#toNow").addEventListener("click", () => { const k = S.times.indexOf(S.nowKey); if (k >= 0) { S.hourIdx = k; $("#hour").value = k; renderMap(); } });

/* ---------- démarrage ---------- */
async function run() {
  $("#refresh").disabled = true; $("#stamp").textContent = "Mise à jour…";
  const errs = [];
  S.nowKey = parisKey();
  try { S.cfg = S.cfg || await getJSON("spots.json?ts=" + Date.now(), 10000); } catch (e) { errs.push("Réglages des spots introuvables (spots.json)."); }
  if (!S.cfg) { showErr(errs); return; }
  if (!MAP && window.L) initMap();
  if (!window.L) errs.push("La carte n'a pas pu se charger.");
  try { S.tide = await loadTide(); } catch (e) { errs.push("Marée prévue indisponible."); S.tide = new Map(); }
  const pSpots = loadSpots(S.cfg.spots).then(x => { S.spots = x; }).catch(e => errs.push("Prévisions des spots indisponibles (" + e.message + ")."));
  const pGrid = loadGrid().then(x => { S.grid = x; }).catch(() => errs.push("Carte des prévisions indisponible."));
  const pObs = loadObs().then(async o => { S.obs = o; S.buoyFc = await loadBuoyForecast(o.buoys).catch(() => null); }).catch(() => { S.obs = null; });
  const pBeac = loadBeacons().then(async b => { S.beacons = b; await loadBeaconForecast(b).catch(() => {}); });
  const pGauge = loadGauge().then(g => { S.gauge = g; }).catch(() => { S.gauge = null; });
  await pSpots;
  if (S.spots.length) {
    S.times = S.spots[0].hours.map(h => h.t);
    const k = S.times.indexOf(S.nowKey); S.hourIdx = k >= 0 ? k : 0;
    $("#hour").max = S.times.length - 1; $("#hour").value = S.hourIdx;
    if (!S.sel) { const w = windows()[0]; S.sel = w ? { spot: w.spot.id, t: w.peak.t } : { spot: S.spots[0].spot.id, t: S.times[S.hourIdx] }; S.day = Math.max(0, dayIndexOf(S.nowKey)); }
    renderDash(); renderSlots(); renderDays(); renderGrid(); renderDetail(); renderSpotsCfg();
  }
  await Promise.all([pGrid, pObs, pBeac, pGauge]);
  S.bias = computeBias();
  if (S.spots.length) renderDash();
  renderMap(); renderCmp();
  showErr(errs);
  const obsAge = S.obs?.generated ? ` · bouées relevées ${ago(Date.now() - new Date(S.obs.generated))}` : "";
  $("#stamp").textContent = "Mis à jour à " + new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) + obsAge;
  $("#refresh").disabled = false;
}
function showErr(errs) { const eb = $("#errors"); eb.hidden = !errs.length; eb.textContent = errs.join(" "); $("#refresh").disabled = false; }
$("#refresh").addEventListener("click", run);
run();
setInterval(run, 15 * 60e3);
