"use strict";
/* Onglet Direct : deux catégories (Vent, Houle et marée), une liste et une carte de stations
   cliquables, et le graphe détaillé des dernières heures de la station choisie. */

const D = { cat: "vent", sel: { vent: null, houle: null }, range: { vent: 12, houle: 24 }, map: null, layer: null, charts: {} };
const H = 3600e3;

/* ---------- stations normalisées ---------- */
function windStations() {
  const out = [];
  (S.obs?.stations || []).forEach(st => {
    if (!st.series?.length) return;
    const fc = S.stationFc?.[st.id];
    out.push({ key: "mf" + st.id, group: "Anémomètres Météo-France", src: `Météo-France ${st.id} · mesure toutes les 6 min`, name: st.name, lat: st.lat, lon: st.lon,
      series: st.series.map(r => ({ t: +new Date(r.t), v: r.v, g: r.g, d: r.d })), fc: fcSeries(fc, "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m") });
  });
  S.beacons.forEach(s => {
    const m = s.measurements || {};
    const series = (s.archive || []).map(r => ({ t: +new Date(r[0]), v: r[4], g: r[5], d: r[6] })).filter(r => r.v != null);
    if (m.date && !series.some(r => r.t === +new Date(m.date))) series.push({ t: +new Date(m.date), v: m.wind_speed_avg, g: m.wind_speed_max, d: m.wind_heading });
    out.push({ key: "pp" + s.id, group: "Balises OpenWindMap", src: `OpenWindMap ${s.id} · balise de particulier ou de club`, name: (s.meta?.name || "Balise " + s.id).trim(), lat: s.location.latitude, lon: s.location.longitude,
      series: series.sort((a, b) => a.t - b.t), fc: fcSeries(s.fc, "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m") });
  });
  out.forEach(s => { s.last = s.series[s.series.length - 1]; s.age = s.last ? Date.now() - s.last.t : Infinity; s.off = s.age > 3 * H; });
  return out;
}
function swellStations() {
  const out = [];
  (S.obs?.buoys || []).forEach((b, i) => {
    const series = b.series.filter(r => r.hs != null).map(r => ({ t: +new Date(r.t), hs: r.hs, hmax: r.hmax, tp: r.tp ?? r.th, dir: r.dir, sst: r.sst }));
    const fc = S.buoyFc?.[i];
    out.push({ key: "b" + b.id, group: "Bouées houlographes Candhis", src: `Candhis ${b.id} · ${b.lat.toFixed(3)} N, ${Math.abs(b.lon).toFixed(3)} O · fond ${b.depth ?? "–"} m${b.id === "01705" ? " · abritée dans l'estuaire" : ""}`,
      name: b.name, lat: b.lat, lon: b.lon, kind: "buoy", series,
      fc: fc ? fc.time.map((t, k) => ({ t: +new Date(t + ":00Z"), hs: fc.wave_height[k], tp: fc.wave_period?.[k], dir: fc.wave_direction?.[k] })).filter(r => r.hs != null) : [] });
  });
  if (S.gauge?.length) out.push({ key: "tide", group: "Marée", src: "Marégraphe SHOM · hauteur au-dessus du zéro des cartes · mesure chaque minute", name: TIDE_GAUGE.name, lat: TIDE_GAUGE.lat, lon: TIDE_GAUGE.lon, kind: "tide",
    series: S.gauge.map(p => ({ t: +p.t, lvl: p.v })), fc: [] });
  out.forEach(s => { s.last = s.series[s.series.length - 1]; s.age = s.last ? Date.now() - s.last.t : Infinity; s.off = s.age > 6 * H; });
  return out;
}
function fcSeries(h, kv, kd, kg) {
  if (!h) return [];
  return h.time.map((t, k) => ({ t: +new Date(t + ":00Z"), v: h[kv][k], d: h[kd]?.[k], g: h[kg]?.[k] })).filter(r => r.v != null);
}

/* ---------- rendu ---------- */
function renderDirect() {
  document.querySelectorAll("[data-dcat]").forEach(b => b.setAttribute("aria-pressed", b.dataset.dcat === D.cat));
  const list = D.cat === "vent" ? windStations() : swellStations();
  if (!list.length) { $("#dlist").innerHTML = `<div class="skel">Aucune station disponible.</div>`; $("#ddetail").innerHTML = ""; return; }
  if (!list.some(s => s.key === D.sel[D.cat])) D.sel[D.cat] = (list.find(s => !s.off) || list[0]).key;
  let html = "", grp = null;
  list.forEach(s => {
    if (s.group !== grp) { grp = s.group; html += `<div class="dgroup">${esc(grp)}</div>`; }
    html += `<button class="drow${s.off ? " off" : ""}" type="button" role="option" data-dst="${s.key}" aria-selected="${s.key === D.sel[D.cat]}">
      <b>${esc(s.name)}</b><span class="val">${rowValue(s)}</span>
      <span class="sub">${s.off ? (s.last ? "muette depuis " + ago(s.age).replace("il y a ", "") : "aucune mesure") : ago(s.age)}</span></button>`;
  });
  $("#dlist").innerHTML = html;
  $("#directstamp").textContent = S.obs?.generated ? `Bouées et anémomètres Météo-France relevés ${ago(Date.now() - new Date(S.obs.generated))} ; balises et marégraphe lus à l'ouverture de la page.` : "";
  renderDetail(list.find(s => s.key === D.sel[D.cat]));
  renderDMap(list);
}
function rowValue(s) {
  const l = s.last; if (!l || s.off) return "–";
  if (D.cat === "vent") return `${arrow(l.d)} ${fmt(l.v, 0)} <small>km/h</small>`;
  if (s.kind === "tide") return `${fmt(l.lvl, 2)} <small>m</small>`;
  return `${fmt(l.hs)} <small>m</small> · ${fmt(l.tp, 0)} <small>s</small>`;
}
function renderDetail(s) {
  const el = $("#ddetail"); if (!s) { el.innerHTML = ""; return; }
  const ranges = D.cat === "vent" ? [3, 6, 12, 24] : s.kind === "tide" ? [6, 12, 24] : [6, 12, 24, 48];
  let r = D.range[D.cat]; if (!ranges.includes(r)) r = ranges[ranges.length - 1];
  const from = Date.now() - r * H, l = s.last;
  const pts = s.series.filter(p => p.t >= from), fc = (s.fc || []).filter(p => p.t >= from && p.t <= Date.now() + 1.5 * H);
  let kpis = "", charts = "";
  if (D.cat === "vent") {
    const f = nearest(s.fc, Date.now());
    const avg = mean(pts.map(p => p.v)), mx = Math.max(...pts.map(p => p.g ?? p.v));
    kpis = l ? `<div class="kpis"><div><b>${fmt(l.v, 0)} km/h</b><span>vent moyen · ${fmt(l.v / 1.852, 0)} nœuds</span></div><div><b>${fmt(l.g, 0)} km/h</b><span>rafales</span></div><div><b>${arrow(l.d)} ${card(l.d)} ${l.d != null ? Math.round(l.d) + "°" : ""}</b><span>direction</span></div><div><b>${f ? fmt(f.v, 0) + " km/h" : "–"}</b><span>prévu AROME HD</span></div><div><b>${fmt(avg, 0)} / ${isFinite(mx) ? fmt(mx, 0) : "–"}</b><span>moyenne / rafale max sur ${r} h</span></div></div>` : "";
    charts = bigChart("w", { series: [{ pts: pts.map(p => ({ x: p.t, y: p.g })), color: "var(--obs2)", name: "Rafales" }, { pts: pts.map(p => ({ x: p.t, y: p.v })), color: "var(--obs)", name: "Vent moyen", w: 2.5 }, { pts: fc.map(p => ({ x: p.t, y: p.v })), color: "var(--fc)", dash: true, name: "Prévu AROME" }], unit: "km/h", from, dirs: pts.map(p => ({ x: p.t, d: p.d })) })
      + legend([["var(--obs)", "vent moyen mesuré"], ["var(--obs2)", "rafales mesurées"], ["var(--fc)", "prévision AROME HD", true]]);
  } else if (s.kind === "tide") {
    kpis = l ? `<div class="kpis"><div><b>${fmt(l.lvl, 2)} m</b><span>hauteur d'eau</span></div><div><b>${gaugeTrendTxt(s.series)}</b><span>tendance (30 min)</span></div></div>` : "";
    charts = bigChart("t", { series: [{ pts: pts.filter((_, i) => i % 3 === 0).map(p => ({ x: p.t, y: p.lvl })), color: "var(--obs)", name: "Hauteur", w: 2.5 }], unit: "m", from, yMin: null });
  } else {
    const f = nearest(s.fc, l?.t ?? Date.now());
    kpis = l && !s.off ? `<div class="kpis"><div><b>${fmt(l.hs)} m</b><span>H1/3 (significative)</span></div><div><b>${fmt(l.hmax)} m</b><span>Hmax</span></div><div><b>${fmt(l.tp, 1)} s</b><span>période</span></div><div><b>${l.dir != null ? arrow(l.dir) + " " + card(l.dir) + " " + Math.round(l.dir) + "°" : "–"}</b><span>direction au pic</span></div><div><b>${f ? fmt(f.hs) + " m" : "–"}</b><span>prévu MFWAM</span></div>${l.sst != null ? `<div><b>${fmt(l.sst)} °C</b><span>eau</span></div>` : ""}</div>` : `<p class="m">${s.key === "b01704" ? "La bouée la plus proche d'Oléron ne transmet plus depuis le 18 avril 2026. Elle reprendra ici automatiquement." : "Pas de mesure récente."}</p>`;
    if (!s.off) charts = bigChart("h", { series: [{ pts: pts.map(p => ({ x: p.t, y: p.hmax })), color: "var(--obs2)", name: "Hmax" }, { pts: pts.map(p => ({ x: p.t, y: p.hs })), color: "var(--obs)", name: "H1/3", w: 2.5 }, { pts: fc.map(p => ({ x: p.t, y: p.hs })), color: "var(--fc)", dash: true, name: "Prévu MFWAM" }], unit: "m", from, dirs: pts.filter(p => p.dir != null).map(p => ({ x: p.t, d: p.dir })) })
      + legend([["var(--obs)", "H1/3 mesurée"], ["var(--obs2)", "Hmax mesurée"], ["var(--fc)", "prévision MFWAM", true]])
      + `<h3 style="margin-top:6px">Période</h3>` + bigChart("p", { series: [{ pts: pts.map(p => ({ x: p.t, y: p.tp })), color: "var(--obs)", name: "Période", w: 2.5 }, { pts: fc.map(p => ({ x: p.t, y: p.tp })), color: "var(--fc)", dash: true, name: "Prévue" }], unit: "s", from, h: 150 });
  }
  el.innerHTML = `<div class="dhead"><h2>${esc(s.name)}</h2><span class="tag">${s.off ? "muette" : "en direct"}</span></div>
    <div class="m">${esc(s.src)} · ${l ? "dernière mesure " + ago(s.age) : "aucune mesure"}</div>
    ${kpis}
    <div class="ranges" role="group" aria-label="Période affichée">${ranges.map(x => `<button class="chip" type="button" data-drange="${x}" aria-pressed="${x === r}">${x} h</button>`).join("")}</div>
    ${charts}`;
}
const legend = items => `<div class="leg">${items.map(([c, t, dash]) => `<span><i ${dash ? `class="dash" style="border-color:${c}"` : `style="background:${c}"`}></i>${t}</span>`).join("")}</div>`;
function nearest(arr, t) { if (!arr?.length) return null; let b = null; arr.forEach(p => { if (!b || Math.abs(p.t - t) < Math.abs(b.t - t)) b = p; }); return Math.abs(b.t - t) < 1.5 * H ? b : null; }
function gaugeTrendTxt(series) { const l = series[series.length - 1], p = series.find(x => x.t >= l.t - 30 * 60e3) || series[0], d = l.lvl - p.lvl; return Math.abs(d) < 0.03 ? "étale" : d > 0 ? "monte ↗" : "descend ↘"; }

/* graphe large avec curseur : un axe, unité commune, flèches de direction en bas */
function bigChart(id, { series, unit, from, dirs, h = 230, yMin = 0 }) {
  const w = 760, L = 40, R = 10, T = 12, B = dirs?.length ? 44 : 24, x0 = from, x1 = Date.now() + (series.some(s => s.dash) ? 1.5 * H : 0);
  const ys = series.flatMap(s => s.pts.map(p => p.y)).filter(v => v != null && isFinite(v));
  if (ys.length < 2) return `<p class="m">Pas assez de mesures sur cette période.</p>`;
  const lo = yMin ?? Math.min(...ys), hi = Math.max(...ys), pad = (hi - lo) * 0.1 || 1, y0 = yMin ?? lo - pad, y1 = hi + pad;
  const X = x => L + (x - x0) / (x1 - x0) * (w - L - R), Y = y => T + (1 - (y - y0) / (y1 - y0)) * (h - T - B);
  const step = niceStep((y1 - y0) / 4);
  let s = `<svg class="bc" viewBox="0 0 ${w} ${h}" role="img" aria-label="Graphe des dernières heures" data-chart="${id}">`;
  for (let v = Math.ceil(y0 / step) * step; v <= y1; v += step) s += `<line x1="${L}" x2="${w - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--grid)"/><text x="${L - 6}" y="${Y(v) + 3.5}" text-anchor="end" class="ax">${fmt(v, step < 1 ? 1 : 0)}</text>`;
  s += `<text x="${L}" y="${T - 2}" class="ax">${unit}</text>`;
  const span = x1 - x0, tick = span <= 6 * H ? H : span <= 12 * H ? 2 * H : span <= 24 * H ? 3 * H : 6 * H;
  for (let t = Math.ceil(x0 / tick) * tick; t <= x1; t += tick) s += `<line x1="${X(t)}" x2="${X(t)}" y1="${h - B}" y2="${h - B + 4}" stroke="var(--muted)"/><text x="${X(t)}" y="${h - B + 15}" text-anchor="middle" class="ax">${hhmm(t)}</text>`;
  const nowX = X(Date.now()); if (nowX < w - R) s += `<line x1="${nowX}" x2="${nowX}" y1="${T}" y2="${h - B}" stroke="var(--muted)" stroke-dasharray="2 3"/><text x="${nowX}" y="${T + 9}" text-anchor="middle" class="ax">maintenant</text>`;
  series.forEach(se => {
    const p = se.pts.filter(q => q.y != null && q.x >= x0 && q.x <= x1); if (p.length < 2) return;
    s += `<path d="${p.map((q, i) => `${i ? "L" : "M"}${X(q.x).toFixed(1)},${Y(q.y).toFixed(1)}`).join("")}" fill="none" stroke="${se.color}" stroke-width="${se.w || 1.6}" ${se.dash ? 'stroke-dasharray="6 4"' : ""} stroke-linejoin="round"/>`;
  });
  if (dirs?.length) {
    const every = Math.max(1, Math.round(dirs.length / 24)), yA = h - 12;
    dirs.filter((_, i) => i % every === 0).forEach(d => { if (d.d == null || d.x < x0) return; s += `<path d="M0,-6 L4,4 L0,2 L-4,4Z" fill="var(--muted)" transform="translate(${X(d.x).toFixed(1)},${yA}) rotate(${(d.d + 180) % 360})"/>`; });
  }
  s += `<line class="cur" x1="0" x2="0" y1="${T}" y2="${h - B}" stroke="var(--fg)" stroke-width="1" visibility="hidden"/>`;
  s += `<rect class="hit" x="${L}" y="0" width="${w - L - R}" height="${h}" fill="transparent"/></svg>`;
  D.charts[id] = { series, unit, X, x0, x1, L, R, w };
  return s;
}
function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / p; return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p; }

/* curseur et infobulle */
document.addEventListener("mousemove", e => {
  const svg = e.target.closest?.(".bc"); if (!svg) return;
  const c = D.charts[svg.dataset.chart]; if (!c) return;
  const r = svg.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * c.w;
  const t = c.x0 + (x - c.L) / (c.w - c.L - c.R) * (c.x1 - c.x0);
  const rows = c.series.map(se => { let b = null; se.pts.forEach(p => { if (p.y != null && (!b || Math.abs(p.x - t) < Math.abs(b.x - t))) b = p; }); return b && Math.abs(b.x - t) < 1.5 * H ? `${se.name} : <b>${fmt(b.y, c.unit === "km/h" ? 0 : 1)} ${c.unit}</b>` : null; }).filter(Boolean);
  const cur = svg.querySelector(".cur"); cur.setAttribute("x1", x); cur.setAttribute("x2", x); cur.setAttribute("visibility", "visible");
  if (rows.length) showTip(e, `<b>${new Date(t).toLocaleString("fr-FR", { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" })}</b><br>${rows.join("<br>")}`);
});
document.addEventListener("mouseout", e => { const svg = e.target.closest?.(".bc"); if (svg && !svg.contains(e.relatedTarget)) { svg.querySelector(".cur")?.setAttribute("visibility", "hidden"); hideTip(); } });

/* ---------- carte des stations ---------- */
function renderDMap(list) {
  if (!window.L) return;
  if (!D.map) {
    D.map = L.map("dmap", { scrollWheelZoom: false }).setView([46.0, -1.5], 8);
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", { maxZoom: 15, attribution: "Fond © Esri, HERE, Garmin, © contributeurs OpenStreetMap" }).addTo(D.map);
    D.layer = L.layerGroup().addTo(D.map);
  } else D.map.invalidateSize();
  D.layer.clearLayers();
  const bounds = [];
  list.forEach(s => {
    const sel = s.key === D.sel[D.cat], cls = s.off ? "off" : D.cat === "vent" ? (s.key.startsWith("mf") ? "mf" : "wind") : s.kind === "tide" ? "tide" : "";
    const val = s.off || !s.last ? "×" : D.cat === "vent" ? `${arrow(s.last.d)} ${fmt(s.last.v, 0)}` : s.kind === "tide" ? fmt(s.last.lvl, 2) + " m" : fmt(s.last.hs) + " m";
    const mk = L.marker([s.lat, s.lon], { icon: L.divIcon({ className: "ico", html: `<div class="dpin ${cls}${sel ? " sel" : ""}">${val}</div><div class="dlab">${esc(s.name)}</div>`, iconSize: [0, 0] }), title: s.name, zIndexOffset: sel ? 1000 : 0 }).addTo(D.layer);
    mk.on("click", () => selectStation(s.key));
    bounds.push([s.lat, s.lon]);
  });
  if (bounds.length && !D.fitted?.[D.cat]) { D.map.fitBounds(bounds, { padding: [30, 30], maxZoom: 10 }); D.fitted = { ...(D.fitted || {}), [D.cat]: true }; }
}
function selectStation(key) { D.sel[D.cat] = key; renderDirect(); if (window.innerWidth < 900) $("#ddetail").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }); }

document.addEventListener("click", e => {
  const c = e.target.closest("[data-dcat]"); if (c) { D.cat = c.dataset.dcat; renderDirect(); return; }
  const st = e.target.closest("[data-dst]"); if (st) { selectStation(st.dataset.dst); return; }
  const rg = e.target.closest("[data-drange]"); if (rg) { D.range[D.cat] = +rg.dataset.drange; renderDirect(); }
});
