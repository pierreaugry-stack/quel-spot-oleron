"use strict";
/* Cœur : outils, chargement des données, modèle de surf, indice de confiance.
   Sources : Open-Meteo (vagues Météo-France MFWAM + DWD EWAM, vent Météo-France AROME HD 1,3 km
   puis AROME/ARPEGE, ECMWF pour comparer), data/obs.json (bouées Candhis via GitHub Actions),
   Pioupiou / OpenWindMap (vent mesuré), SHOM (marée mesurée). */

const DAYS = 5;
const TIDE_POINT = [45.9, -1.36];
const TIDE_GAUGE = { id: 736, name: "La Cotinière", lat: 45.9136, lon: -1.3278 };
const BEACON_BBOX = { s: 45.45, n: 46.45, w: -1.75, e: -0.95 };
const VERIF_BUOYS = ["08504", "08505", "03302"]; // bouées au large utiles pour vérifier la houle
const MF_KEY_NOTE = "Anémomètres Météo-France (Chassiron, phare des Baleines) : nécessitent une clé gratuite de l'API Météo-France.";

/* ---------- outils ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const angDiff = (a, b) => { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const CARD = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO"];
const card = d => d == null ? "–" : CARD[Math.round((((d % 360) + 360) % 360) / 22.5) % 16];
const arrow = (d, cls = "") => d == null ? "" : `<span class="arrow ${cls}" style="transform:rotate(${(d + 180) % 360}deg)" aria-hidden="true">↑</span>`;
const fmt = (x, n = 1) => x == null || isNaN(x) ? "–" : (+x).toFixed(n).replace(".", ",");
const JOURS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
const JOURS_L = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const hourOf = t => +t.slice(11, 13);
const ago = ms => { const m = Math.max(0, Math.round(ms / 60000)); if (m < 60) return `il y a ${m} min`; const h = Math.floor(m / 60); return h < 48 ? `il y a ${h} h ${String(m % 60).padStart(2, "0")}` : `il y a ${Math.round(h / 24)} jours`; };
const arr = x => Array.isArray(x) ? x : [x];
const qs = o => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
const mean = a => { const v = a.filter(x => x != null && !isNaN(x)); return v.length ? v.reduce((p, c) => p + c, 0) / v.length : null; };
function parisKey(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(date).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:00`;
}
const dayName = (iso, i) => i === 0 ? "Aujourd'hui" : i === 1 ? "Demain" : (() => { const d = new Date(iso + "T12:00"); return `${JOURS[d.getDay()]} ${d.getDate()}`; })();
const longDay = iso => { const d = new Date(iso + "T12:00"); return `${JOURS_L[d.getDay()]} ${d.getDate()}`; };
const timeLabel = t => { const d = new Date(t.slice(0, 10) + "T12:00"); return `${JOURS[d.getDay()]} ${d.getDate()} · ${hourOf(t)} h`; };
async function getJSON(url, ms = 25000) {
  const c = new AbortController(); const tm = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { signal: c.signal }); if (!r.ok) throw new Error("HTTP " + r.status); return await r.json(); }
  finally { clearTimeout(tm); }
}
/* cache de session pour les grosses requêtes (carte) */
async function cachedJSON(key, url, maxAgeMin = 30) {
  try { const c = JSON.parse(sessionStorage.getItem(key) || "null"); if (c && Date.now() - c.t < maxAgeMin * 60e3) return c.d; } catch (e) {}
  const d = await getJSON(url, 40000);
  try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), d })); } catch (e) {}
  return d;
}

/* ---------- modèle de surf ----------
   1. Chaque composante (houle primaire, houle secondaire, mer du vent) est filtrée par la fenêtre
      d'orientation du spot (cosinus au-delà de la fenêtre).
   2. Hauteur de déferlement de chaque composante (Komar & Gaughan 1972) :
        Hb = 0,39 · g^(1/5) · (T · H0²)^(2/5)
      donc une houle longue déferle plus haut qu'une houle courte de même hauteur au large.
   3. Les composantes se combinent en énergie (racine de la somme des carrés), puis le coefficient
      d'abri du spot (réfraction, protection) donne la hauteur au bord : fourchette 0,7 à 1,0 × Hb.
   La note, elle, suit les critères du doc (hauteur au large, période, vent, marée, coef.). */
const G = 9.81;
const breakH = (h, t) => h == null || t == null || h <= 0 ? 0 : 0.39 * Math.pow(G, 0.2) * Math.pow(t * h * h, 0.4);
function dirMult(from, spot) {
  if (from == null) return 0;
  const d = angDiff(from, spot.swell.ideal);
  if (d <= spot.swell.window) return 1;
  return clamp(Math.cos((d - spot.swell.window) / 50 * Math.PI / 2), 0, 1);
}
function surfHeight(spot, comps) {
  let e = 0;
  comps.forEach(c => { if (c.h == null) return; const k = dirMult(c.d, spot) * (c.w ?? 1); e += Math.pow(breakH(c.h, c.p) * k, 2); });
  const hb = Math.sqrt(e) * (spot.shelter ?? 1);
  return { min: hb * 0.7, max: hb };
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
  if (speed == null || from == null) return { s: 0.6, label: "inconnu", rel: null };
  const rule = spot.wind_, rel = angDiff(from, rule.offshore);
  const label = rel <= 45 ? "offshore" : rel <= 90 ? "side-off" : rel <= 135 ? "side-on" : "onshore";
  if (speed < 7) return { s: 1, label: "calme", rel };
  let s = rel <= 45 ? 1 : rel <= 90 ? 0.85 : rel <= 135 ? 0.6 : 0.4;
  if (rel > 90) s *= clamp(1 - (speed - 7) / 28, 0.12, 1);
  else if (speed > (rule.maxOffshore ?? 35)) s *= clamp(1 - (speed - (rule.maxOffshore ?? 35)) / 35, 0.45, 1);
  return { s, label, rel };
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
const energyOf = (h, t) => h == null || t == null ? null : 0.49 * h * h * t;
function energyScore(E, r) { if (!r || E == null) return 1; if (r.min && E < r.min) return clamp((E / r.min - 0.6) / 0.4, 0, 1); if (r.max && E > r.max) return clamp(2 - E / r.max, 0.4, 1); return 1; }
function coefScore(c, r) { if (!r || c == null) return 1; if (r.max && c > r.max) return clamp(1 - (c - r.max) / 40, 0.6, 1); if (r.min && c < r.min) return clamp(1 - (r.min - c) / 40, 0.6, 1); return 1; }

function rateHour(spot, h, bias = 1) {
  const comps = [
    { h: h.sw.h * bias, p: h.sw.p, d: h.sw.d },
    { h: h.sw2.h == null ? null : h.sw2.h * bias, p: h.sw2.p, d: h.sw2.d },
    { h: h.ww.h == null ? null : h.ww.h * bias, p: h.ww.p, d: h.ww.d, w: 0.6 }
  ];
  // hauteur « au large » vue du spot (critères du doc)
  const heff = Math.sqrt(comps.reduce((e, c) => c.h == null ? e : e + Math.pow(c.h * dirMult(c.d, spot) * (c.w ?? 1), 2), 0));
  const surf = surfHeight(spot, comps);
  const E = energyOf(h.sw.h * bias, h.sw.p);
  const parts = {
    size: sizeScore(heff, spot.size), period: periodScore(h.sw.p, spot.periodMin),
    wind: windInfo(h.wind.v, h.wind.d, spot), tide: tideScore(h.tide.n, h.tide.rising, spot.tide),
    energy: energyScore(E, spot.energy), coef: coefScore(h.tide.coef, spot.coef), dir: dirMult(h.sw.d, spot)
  };
  const score = Math.round(100 * parts.size * (0.45 + 0.55 * parts.period) * parts.wind.s * parts.tide * parts.energy * parts.coef) / 10;
  return { heff, surf, E, parts, score };
}

/* ---------- indice de confiance ----------
   accord entre modèles (vagues MFWAM / EWAM, vent AROME / ECMWF) pour l'heure visée
   + justesse récente de la prévision face aux mesures (bouées 24 h, balises 24 h)
   + éloignement dans le temps. */
function agreement(h) {
  let wave = null, wind = null;
  if (h.sw.h != null && h.alt.sh != null) {
    const m = Math.max(0.5, (h.sw.h + h.alt.sh) / 2);
    wave = clamp(1 - 0.8 * Math.min(1, Math.abs(h.sw.h - h.alt.sh) / m) - 0.2 * (h.alt.sd == null || h.sw.d == null ? 0 : angDiff(h.sw.d, h.alt.sd) / 90), 0, 1);
  }
  if (h.wind.v != null && h.alt.wv != null) {
    const m = Math.max(10, (h.wind.v + h.alt.wv) / 2);
    const dirPart = Math.max(h.wind.v, h.alt.wv) < 10 || h.alt.wd == null ? 0 : angDiff(h.wind.d, h.alt.wd) / 90;
    wind = clamp(1 - 0.7 * Math.min(1, Math.abs(h.wind.v - h.alt.wv) / m) - 0.3 * Math.min(1, dirPart), 0, 1);
  }
  return { wave, wind };
}
function confidence(h, lead, skill) {
  const ag = agreement(h);
  const lt = Math.exp(-Math.max(0, lead) / 96);
  const obsW = Math.exp(-Math.max(0, lead) / 36); // les mesures comptent surtout à courte échéance
  const parts = [];
  if (ag.wave != null) parts.push([ag.wave, 0.35]);
  if (ag.wind != null) parts.push([ag.wind, 0.25]);
  if (skill?.value != null) parts.push([skill.value, 0.3 * obsW]);
  parts.push([lt, 0.2]);
  const wsum = parts.reduce((s, p) => s + p[1], 0);
  const v = Math.round(100 * parts.reduce((s, p) => s + p[0] * p[1], 0) / wsum);
  return { v, ag, lead: lt, skill: skill?.value ?? null, label: v >= 75 ? "élevée" : v >= 55 ? "moyenne" : "faible" };
}

const VERDICTS = [[7.5, "Ça vaut le coup"], [5.5, "Bon plan"], [3.5, "Surfable"], [1.5, "Bof"], [-1, "Pas la peine"]];
const verdict = s => s == null ? "Nuit" : VERDICTS.find(v => s >= v[0])[1];
const scoreColor = s => s == null ? "var(--s0)" : s >= 8 ? "var(--s5)" : s >= 6.5 ? "var(--s4)" : s >= 5 ? "var(--s3)" : s >= 3.5 ? "var(--s2)" : s >= 2 ? "var(--s1)" : "var(--s0)";
const scoreInk = s => s != null && s >= 6.5 ? "#fff" : "var(--fg)";
const windColor = v => v == null ? "#999" : v < 10 ? "var(--w1)" : v < 20 ? "var(--w2)" : v < 30 ? "var(--w3)" : v < 40 ? "var(--w4)" : "var(--w5)";
const surfTxt = s => s ? `${fmt(s.min)}–${fmt(s.max)} m` : "–";

/* ---------- chargement ---------- */
const S = { cfg: null, spots: [], tide: null, obs: null, buoyFc: null, beacons: [], gauge: null, skill: null, bias: null, nowKey: null, errors: [] };

async function loadTide() {
  const j = await getJSON(`https://marine-api.open-meteo.com/v1/marine?${qs({ latitude: TIDE_POINT[0], longitude: TIDE_POINT[1], hourly: "sea_level_height_msl", timezone: "Europe/Paris", past_days: 30, forecast_days: DAYS + 1 })}`);
  const t = j.hourly.time, v = j.hourly.sea_level_height_msl;
  const range = v.map((x, i) => { const w = v.slice(Math.max(0, i - 13), i + 14).filter(y => y != null); return w.length ? Math.max(...w) - Math.min(...w) : null; });
  const rs = range.filter(x => x != null); const rmin = Math.min(...rs), rmax = Math.max(...rs);
  const map = new Map(), extremes = [];
  t.forEach((time, i) => {
    if (v[i] == null) return;
    const w = v.slice(Math.max(0, i - 7), i + 8).filter(y => y != null);
    const lo = Math.min(...w), hi = Math.max(...w);
    const n = hi - lo > 0.2 ? (v[i] - lo) / (hi - lo) : 0.5;
    const nx = v[i + 1], pv = v[i - 1];
    const rising = nx != null ? nx > v[i] : pv != null ? v[i] > pv : null;
    const coef = range[i] == null || rmax - rmin < 0.1 ? null : Math.round(35 + 75 * (range[i] - rmin) / (rmax - rmin));
    map.set(time, { level: v[i], n, rising, coef });
    if (pv != null && nx != null) {
      // extrêmes affinés par parabole entre 3 points horaires
      if ((v[i] >= pv && v[i] > nx) || (v[i] <= pv && v[i] < nx)) {
        const den = pv - 2 * v[i] + nx; const off = den ? clamp(0.5 * (pv - nx) / den, -0.5, 0.5) : 0;
        const at = new Date(new Date(time + ":00").getTime() + off * 3600e3);
        extremes.push({ time, at, high: v[i] > pv, level: v[i] - 0.25 * (pv - nx) * off, coef });
      }
    }
  });
  return { map, extremes, series: t.map((time, i) => ({ t: time, v: v[i] })).filter(p => p.v != null) };
}

async function loadSpotForecasts(spots) {
  const mLat = spots.map(s => s.marine[0]).join(","), mLon = spots.map(s => s.marine[1]).join(",");
  const wLat = spots.map(s => s.wind[0]).join(","), wLon = spots.map(s => s.wind[1]).join(",");
  const MV = "wave_height,wave_period,swell_wave_height,swell_wave_direction,swell_wave_period,secondary_swell_wave_height,secondary_swell_wave_direction,secondary_swell_wave_period,wind_wave_height,wind_wave_direction,wind_wave_period";
  const [mf, ew, w] = await Promise.all([
    getJSON(`https://marine-api.open-meteo.com/v1/marine?${qs({ latitude: mLat, longitude: mLon, hourly: MV, models: "meteofrance_wave", timezone: "Europe/Paris", forecast_days: DAYS })}`),
    getJSON(`https://marine-api.open-meteo.com/v1/marine?${qs({ latitude: mLat, longitude: mLon, hourly: "swell_wave_height,swell_wave_direction,swell_wave_peak_period", models: "ewam", timezone: "Europe/Paris", forecast_days: DAYS })}`).catch(() => null),
    getJSON(`https://api.open-meteo.com/v1/forecast?${qs({ latitude: wLat, longitude: wLon, hourly: "wind_speed_10m,wind_direction_10m,wind_gusts_10m", models: "meteofrance_arome_france_hd,meteofrance_seamless,ecmwf_ifs025", daily: "sunrise,sunset", wind_speed_unit: "kmh", timezone: "Europe/Paris", forecast_days: DAYS })}`)
  ]);
  return spots.map((spot, i) => {
    const m = arr(mf)[i], e = ew ? arr(ew)[i] : null, wi = arr(w)[i];
    const mi = new Map(m.hourly.time.map((t, k) => [t, k])), ei = e ? new Map(e.hourly.time.map((t, k) => [t, k])) : new Map();
    const sr = wi.daily.sunrise_meteofrance_seamless || wi.daily.sunrise, ss = wi.daily.sunset_meteofrance_seamless || wi.daily.sunset;
    const sun = new Map(wi.daily.time.map((d, k) => [d, [sr?.[k], ss?.[k]]]));
    const W = wi.hourly;
    const hours = W.time.map((t, k) => {
      const j = mi.get(t), je = ei.get(t);
      const M = key => j == null ? null : m.hourly[key]?.[j] ?? null;
      const E = key => je == null || !e ? null : e.hourly[key]?.[je] ?? null;
      const hd = W.wind_speed_10m_meteofrance_arome_france_hd?.[k];
      const useHd = hd != null;
      const h = {
        t,
        sw: { h: M("swell_wave_height"), d: M("swell_wave_direction"), p: M("swell_wave_period") },
        sw2: { h: M("secondary_swell_wave_height"), d: M("secondary_swell_wave_direction"), p: M("secondary_swell_wave_period") },
        ww: { h: M("wind_wave_height"), d: M("wind_wave_direction"), p: M("wind_wave_period") },
        tot: { h: M("wave_height"), p: M("wave_period") },
        wind: {
          v: useHd ? hd : W.wind_speed_10m_meteofrance_seamless?.[k],
          d: useHd ? W.wind_direction_10m_meteofrance_arome_france_hd[k] : W.wind_direction_10m_meteofrance_seamless?.[k],
          g: useHd ? W.wind_gusts_10m_meteofrance_arome_france_hd[k] : W.wind_gusts_10m_meteofrance_seamless?.[k],
          model: useHd ? "AROME HD 1,3 km" : "AROME / ARPEGE"
        },
        alt: { sh: E("swell_wave_height"), sd: E("swell_wave_direction"), wv: W.wind_speed_10m_ecmwf_ifs025?.[k], wd: W.wind_direction_10m_ecmwf_ifs025?.[k] },
        tide: S.tide?.map.get(t) || { n: null, rising: null, coef: null, level: null }
      };
      const [sr, ss] = sun.get(t.slice(0, 10)) || [];
      h.day = sr && ss ? hourOf(t) >= hourOf(sr) && hourOf(t) <= hourOf(ss) : hourOf(t) >= 8 && hourOf(t) <= 18;
      h.missing = h.sw.h == null;
      return h;
    });
    return { spot, hours, sun };
  });
}
/* applique la note (avec correction des bouées décroissante dans le temps) et la confiance */
function scoreAll() {
  const nowT = new Date(S.nowKey + ":00").getTime();
  S.spots.forEach(({ spot, hours }) => hours.forEach(h => {
    const lead = (new Date(h.t + ":00").getTime() - nowT) / 3600e3;
    const b = S.bias ? 1 + (S.bias.ratio - 1) * Math.exp(-Math.max(0, lead) / 12) : 1;
    if (h.missing) { h.raw = h.score = null; return; }
    Object.assign(h, rateHour(spot, h, lead >= -1 ? b : 1));
    h.raw = h.score; h.score = h.day ? h.raw : null;
    h.conf = confidence(h, lead, S.skill);
    h.lead = lead;
  }));
}

async function loadObs() { return getJSON(`data/obs.json?ts=${Date.now()}`, 15000); }
async function loadBuoyForecast(buoys) {
  if (!buoys.length) return [];
  const j = await getJSON(`https://marine-api.open-meteo.com/v1/marine?${qs({ latitude: buoys.map(b => b.lat).join(","), longitude: buoys.map(b => b.lon).join(","), hourly: "wave_height,wave_period,wave_direction", models: "meteofrance_wave", timezone: "GMT", past_days: 2, forecast_days: 2 })}`);
  return arr(j).map(x => x.hourly);
}
async function loadBeacons() {
  const all = await getJSON("https://api.pioupiou.fr/v1/live/all", 20000);
  const near = all.data.filter(s => { const l = s.location || {}; return l.latitude > BEACON_BBOX.s && l.latitude < BEACON_BBOX.n && l.longitude > BEACON_BBOX.w && l.longitude < BEACON_BBOX.e; });
  const live = near.filter(s => s.measurements?.date && Date.now() - new Date(s.measurements.date) < 7 * 86400e3);
  await Promise.all(live.map(async s => {
    try { const a = await getJSON(`https://api.pioupiou.fr/v1/archive/${s.id}?start=last-day&stop=now`, 15000); s.archive = a.data || []; } catch (e) { s.archive = []; }
  }));
  if (live.length) {
    try {
      const j = await getJSON(`https://api.open-meteo.com/v1/forecast?${qs({ latitude: live.map(s => s.location.latitude).join(","), longitude: live.map(s => s.location.longitude).join(","), hourly: "wind_speed_10m,wind_direction_10m,wind_gusts_10m", models: "meteofrance_arome_france_hd", wind_speed_unit: "kmh", timezone: "GMT", past_days: 1, forecast_days: 1 })}`);
      arr(j).forEach((x, i) => { live[i].fc = x.hourly; });
    } catch (e) {}
  }
  return live;
}
async function loadGauge() {
  const end = new Date(), start = new Date(end - 30 * 3600e3);
  const iso = d => d.toISOString().slice(0, 19) + "Z";
  const j = await getJSON(`https://services.data.shom.fr/maregraphie/observation/json/${TIDE_GAUGE.id}?sources=1&dtStart=${iso(start)}&dtEnd=${iso(end)}`, 20000);
  return (j.data || []).map(r => ({ t: new Date(r.timestamp.replace(/\//g, "-").replace(" ", "T") + "Z"), v: r.value })).filter(r => r.v != null);
}
/* valeur prévue (heure UTC) dans une série Open-Meteo en GMT */
function fcAt(h, key, date) { if (!h) return null; const k = h.time.indexOf(date.toISOString().slice(0, 13) + ":00"); return k < 0 ? null : h[key][k]; }

/* justesse des dernières 24 h + correction de houle */
function computeSkill() {
  const waveErr = [], windErr = [], ratios = [];
  S.obs?.buoys.forEach((b, i) => {
    if (!VERIF_BUOYS.includes(b.id)) return;
    const fc = S.buoyFc?.[i]; if (!fc) return;
    const recent = b.series.filter(r => r.hs != null && Date.now() - new Date(r.t) < 24 * 3600e3);
    recent.forEach(r => { const f = fcAt(fc, "wave_height", new Date(r.t)); if (f) waveErr.push(Math.abs(r.hs - f) / Math.max(0.5, f)); });
    const last = recent[recent.length - 1];
    if (last && Date.now() - new Date(last.t) < 3 * 3600e3) { const f = fcAt(fc, "wave_height", new Date(last.t)); if (f) ratios.push(last.hs / f); }
  });
  S.beacons.forEach(s => {
    (s.archive || []).forEach(row => { const t = new Date(row[0]); const f = fcAt(s.fc, "wind_speed_10m", t); if (f != null && row[4] != null && t.getUTCMinutes() < 10) windErr.push(Math.abs(row[4] - f)); });
  });
  const we = mean(waveErr), wi = mean(windErr);
  const parts = [];
  if (we != null) parts.push(clamp(1 - we / 0.5, 0, 1));
  if (wi != null) parts.push(clamp(1 - wi / 15, 0, 1));
  S.skill = { value: parts.length ? mean(parts) : null, waveErr: we, windErr: wi, nWave: waveErr.length, nWind: windErr.length };
  S.bias = ratios.length ? { ratio: clamp(mean(ratios), 0.6, 1.6), raw: mean(ratios), n: ratios.length } : null;
}

async function loadAll() {
  S.errors = []; S.nowKey = parisKey();
  if (!S.cfg) S.cfg = await getJSON("spots.json?ts=" + Date.now(), 10000);
  try { S.tide = await loadTide(); } catch (e) { S.errors.push("Marée prévue indisponible."); S.tide = { map: new Map(), extremes: [], series: [] }; }
  const pF = loadSpotForecasts(S.cfg.spots).then(x => { S.spots = x; }).catch(e => S.errors.push("Prévisions indisponibles (" + e.message + ")."));
  const pO = loadObs().then(async o => { S.obs = o; S.buoyFc = await loadBuoyForecast(o.buoys).catch(() => null); }).catch(() => { S.obs = null; });
  const pB = loadBeacons().then(b => { S.beacons = b; }).catch(() => { S.beacons = []; S.errors.push("Balises de vent injoignables."); });
  const pG = loadGauge().then(g => { S.gauge = g; }).catch(() => { S.gauge = null; });
  await Promise.all([pF, pO, pB, pG]);
  computeSkill(); scoreAll();
}

/* ---------- créneaux ---------- */
function windowsFor(list) {
  const out = [];
  list.forEach(({ spot, hours }) => {
    let cur = null;
    hours.forEach((h, i) => {
      if (h.t < S.nowKey) return;
      if (h.score != null && h.score >= 5) {
        if (!cur || hours[i - 1] !== cur.to) { cur = { spot, from: h, to: h, peak: h }; out.push(cur); }
        cur.to = h; if (h.score > cur.peak.score) cur.peak = h;
      } else cur = null;
    });
  });
  return out.sort((a, b) => b.peak.score - a.peak.score);
}
const dates = () => S.spots.length ? [...new Set(S.spots[0].hours.map(h => h.t.slice(0, 10)))].slice(0, DAYS) : [];
const dayIndexOf = t => dates().indexOf(t.slice(0, 10));
const tideState = h => { const n = h?.tide?.n; if (n == null) return "–"; const l = n < 0.2 ? "basse" : n < 0.4 ? "mi-basse" : n < 0.6 ? "mi-marée" : n < 0.8 ? "mi-haute" : "haute"; return `${l} ${h.tide.rising ? "↗" : "↘"}`; };
