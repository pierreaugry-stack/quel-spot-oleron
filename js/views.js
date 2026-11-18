"use strict";
/* Vues : classement (accueil), fiche spot, données réelles. */

const V = { rankMode: "now", spotDay: 0, spotSel: null };

/* ---------- petits graphiques ---------- */
const tipEl = () => $("#tip");
function showTip(e, html) { const t = tipEl(); t.innerHTML = html; t.hidden = false; const x = Math.min(window.innerWidth - t.offsetWidth - 8, e.clientX + 12), y = Math.max(8, e.clientY - t.offsetHeight - 12); t.style.left = x + "px"; t.style.top = y + "px"; }
function hideTip() { tipEl().hidden = true; }
/* courbe(s) simples, un seul axe (unité commune) */
function lineChart({ series, w = 320, h = 120, unit = "", yMin = 0, xFmt, now = Date.now(), bands = [] }) {
  const all = series.flatMap(s => s.pts).filter(p => p.y != null); if (all.length < 2) return `<div class="m">Pas assez de mesures.</div>`;
  const xs = all.map(p => p.x), ys = all.map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = yMin ?? Math.min(...ys), y1 = Math.max(...ys) * 1.12 || 1;
  const L = 34, R = 8, T = 8, B = 20, X = x => L + (x - x0) / (x1 - x0 || 1) * (w - L - R), Y = y => T + (1 - (y - y0) / (y1 - y0 || 1)) * (h - T - B);
  const ticks = [y0, (y0 + y1) / 2, y1 / 1.12].map(v => +v.toFixed(1));
  let svg = `<svg class="lc" viewBox="0 0 ${w} ${h}" role="img">`;
  bands.forEach(b => { svg += `<rect x="${X(Math.max(x0, b.a))}" y="${T}" width="${Math.max(0, X(Math.min(x1, b.b)) - X(Math.max(x0, b.a)))}" height="${h - T - B}" fill="var(--night)"/>`; });
  ticks.forEach(v => { svg += `<line x1="${L}" x2="${w - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--grid)"/><text x="${L - 5}" y="${Y(v) + 3}" text-anchor="end" class="ax">${fmt(v, v % 1 ? 1 : 0)}</text>`; });
  if (now > x0 && now < x1) svg += `<line x1="${X(now)}" x2="${X(now)}" y1="${T}" y2="${h - B}" stroke="var(--muted)" stroke-dasharray="2 3"/>`;
  series.forEach(s => {
    const pts = s.pts.filter(p => p.y != null); if (pts.length < 2) return;
    svg += `<path d="${pts.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join("")}" fill="none" stroke="${s.color}" stroke-width="2" ${s.dash ? 'stroke-dasharray="5 4"' : ""} stroke-linejoin="round"/>`;
  });
  const lab = [x0, (x0 + x1) / 2, x1];
  lab.forEach((x, i) => { svg += `<text x="${X(x)}" y="${h - 5}" text-anchor="${i === 0 ? "start" : i === 2 ? "end" : "middle"}" class="ax">${xFmt ? xFmt(x) : ""}</text>`; });
  svg += `<text x="${L}" y="${T - 1}" class="ax" dy="0">${unit}</text></svg>`;
  return svg;
}
const hhmm = x => new Date(x).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
const dayhh = x => new Date(x).toLocaleString("fr-FR", { weekday: "short", hour: "2-digit", timeZone: "Europe/Paris" }).replace(" ", " ");

/* ---------- accueil : classement ---------- */
function renderHome() {
  if (!S.spots.length) { $("#home").innerHTML = `<div class="skel">Prévisions indisponibles.</div>`; return; }
  const dts = dates();
  const modes = [["now", "Maintenant"], ...dts.map((d, i) => [String(i), dayName(d, i)])];
  const rows = S.spots.map(({ spot, hours }) => {
    let h, best = null;
    const dayStr = V.rankMode === "now" ? S.nowKey.slice(0, 10) : dts[+V.rankMode];
    const dayHours = hours.filter(x => x.t.slice(0, 10) === dayStr && x.day);
    const future = dayHours.filter(x => x.t >= (V.rankMode === "now" ? S.nowKey : ""));
    best = (future.length ? future : dayHours).reduce((a, b) => (b.score ?? -1) > (a?.score ?? -1) ? b : a, null);
    h = V.rankMode === "now" ? hours.find(x => x.t === S.nowKey) || hours[0] : best;
    const key = V.rankMode === "now" ? h?.raw : best?.score;
    return { spot, h, best, key, dayHours };
  }).sort((a, b) => (b.key ?? -1) - (a.key ?? -1));
  const top = rows[0];
  const night = V.rankMode === "now" && top.h && !top.h.day;
  const biasTxt = S.bias ? `Bouées au large : houle mesurée ${S.bias.raw >= 1 ? "+" : ""}${Math.round((S.bias.raw - 1) * 100)} % par rapport à la prévision, note corrigée.` : "";
  $("#home").innerHTML = `
    <div class="chips" role="group" aria-label="Moment du classement">${modes.map(([k, l]) => `<button class="chip" type="button" data-rank="${k}" aria-pressed="${V.rankMode === k}">${l}</button>`).join("")}</div>
    <p class="lede">${V.rankMode === "now" ? (night ? "Il fait nuit : classement indicatif sur l'heure en cours." : `Classement pour ${timeLabel(S.nowKey)}, selon tes critères.`) : `Classement par meilleure heure de la journée (${longDay(dts[+V.rankMode])}).`} ${biasTxt}</p>
    <ol class="ranking">${rows.map((r, i) => rankCard(r, i)).join("")}</ol>`;
}
function rankCard({ spot, h, best, key, dayHours }, i) {
  if (!h) return "";
  const strip = dayHours.map(x => `<i title="${hourOf(x.t)} h : ${fmt(x.score)}" style="background:${scoreColor(x.score)}"${x.t === S.nowKey ? ' class="now"' : ""}></i>`).join("");
  const c = h.conf;
  return `<li><a class="rcard${i === 0 ? " first" : ""}" href="#spot-${spot.id}">
    <div class="rnum">${i + 1}</div>
    <div class="rscore" style="background:${scoreColor(key)};color:${scoreInk(key)}">${fmt(key)}</div>
    <div class="rmain">
      <div class="rtitle"><b>${esc(spot.name)}</b><span>${verdict(key)}${V.rankMode !== "now" && best ? ` · meilleur à ${hourOf(best.t)} h` : ""}</span></div>
      <div class="rfacts">
        <span><em>Surf</em> ${surfTxt(h.surf)}</span>
        <span><em>Houle</em> ${fmt(h.sw.h)} m ${fmt(h.sw.p, 0)} s ${arrow(h.sw.d)} ${card(h.sw.d)}</span>
        <span><em>Vent</em> ${arrow(h.wind.d)} ${fmt(h.wind.v, 0)} km/h · ${h.parts.wind.label}</span>
        <span><em>Marée</em> ${tideState(h)}${h.tide.coef ? " · coef ≈ " + h.tide.coef : ""}</span>
      </div>
      <div class="rstrip" aria-hidden="true">${strip}</div>
    </div>
    <div class="rconf ${c?.label}" title="Indice de confiance">${c ? c.v + " %" : "–"}<small>confiance</small></div>
  </a></li>`;
}

/* ---------- fiche spot ---------- */
function renderSpot(id) {
  const ser = S.spots.find(s => s.spot.id === id);
  if (!ser) { $("#spotview").innerHTML = `<p>Spot inconnu. <a href="#classement">Retour au classement</a></p>`; return; }
  const { spot, hours, sun } = ser, dts = dates();
  V.spotDay = clamp(V.spotDay, 0, dts.length - 1);
  const day = dts[V.spotDay];
  const dh = hours.filter(h => h.t.slice(0, 10) === day);
  const daylight = dh.filter(h => h.day);
  const best = daylight.reduce((a, b) => (b.score ?? -1) > (a?.score ?? -1) ? b : a, null);
  if (!V.spotSel || V.spotSel.slice(0, 10) !== day) V.spotSel = (day === S.nowKey.slice(0, 10) ? S.nowKey : best?.t) || dh[12]?.t;
  const sel = dh.find(h => h.t === V.spotSel) || best || dh[0];
  const [sr, ss] = sun.get(day) || [];
  $("#spotview").innerHTML = `
    <a class="back" href="#classement">← Classement</a>
    <div class="shead">
      <div><div class="eyebrow">${esc(spot.area)} · ${esc(spot.level)}</div><h2 class="sname">${esc(spot.name)}</h2></div>
      <div class="chips" role="group" aria-label="Jour">${dts.map((d, i) => `<button class="chip" type="button" data-sday="${i}" aria-pressed="${i === V.spotDay}">${dayName(d, i)}</button>`).join("")}</div>
    </div>
    <div class="sgrid">
      <div class="card sbest">
        <div class="eyebrow">${longDay(day)} · heure choisie ${hourOf(sel.t)} h</div>
        <div class="bigrow"><div class="big" style="background:${scoreColor(sel.raw)};color:${scoreInk(sel.raw)}">${fmt(sel.raw)}</div>
          <div><div class="surfbig">${surfTxt(sel.surf)}</div><div class="m">hauteur de surf estimée au bord${sel.surf?.kd != null ? ` · ${Math.round(sel.surf.kd * 100)} % de la houle arrive (ombre des îles et fonds)` : ""} · ${sel.day ? verdict(sel.raw) : "nuit"}</div></div></div>
        <p class="m">${best ? `Meilleure heure : <b>${hourOf(best.t)} h (${fmt(best.score)})</b>.` : "Pas d'heure de jour."} Lever ${sr ? sr.slice(11) : "–"} · coucher ${ss ? ss.slice(11) : "–"}.</p>
      </div>
      ${confCard(sel)}
    </div>
    <div class="card">
      <h3>Heure par heure</h3>
      <div class="hourchart" id="hourchart">${hourChart(dh, sel)}</div>
      <div class="htable-wrap"><table class="htable">${hourTable(dh, sel)}</table></div>
    </div>
    <div class="sgrid">
      <div class="card"><h3>Marée</h3>${tideChart(day, sr, ss)}</div>
      <div class="card"><h3>Ce qui fait la note à ${hourOf(sel.t)} h</h3>${partsBlock(sel, spot)}</div>
    </div>
    <div class="card"><h3>Réglages du spot</h3>${spotCfg(spot)}</div>`;
}
function confCard(h) {
  const c = h.conf; if (!c) return `<div class="card"><h3>Indice de confiance</h3><p class="m">Indisponible.</p></div>`;
  const pct = x => x == null ? "–" : Math.round(x * 100) + " %";
  const sk = S.skill || {};
  return `<div class="card sconf"><h3>Indice de confiance</h3>
    <div class="bigrow"><div class="confv ${c.label}">${c.v} %</div><div class="m">Confiance ${c.label} pour ${timeLabel(h.t)}.</div></div>
    ${meter("Accord houle", c.ag.wave, "Météo-France (MFWAM) et DWD (EWAM) donnent la même houle ?")}
    ${meter("Accord vent", c.ag.wind, "AROME HD et ECMWF donnent le même vent ?")}
    ${meter("Mesures 24 h", c.skill, `Écart moyen prévision / réel : houle ${sk.waveErr == null ? "–" : Math.round(sk.waveErr * 100) + " %"} (${sk.nWave || 0} mesures de bouées), vent ${sk.windErr == null ? "–" : fmt(sk.windErr, 0) + " km/h"} (${sk.nWind || 0} mesures de balises)`)}
    ${meter("Échéance", c.lead, `${h.lead > 0 ? "dans " + Math.round(h.lead) + " h" : "maintenant"} : plus c'est loin, moins c'est sûr`)}
  </div>`;
}
function meter(label, v, hint) { return `<div class="meter" title="${esc(hint || "")}"><span>${label}</span><div class="bar"><span style="width:${v == null ? 0 : Math.round(clamp(v, 0, 1) * 100)}%"></span></div><span class="v">${v == null ? "–" : Math.round(v * 100) + "%"}</span></div>${hint ? `<div class="hint">${esc(hint)}</div>` : ""}`; }
function hourChart(dh, sel) {
  const w = 760, h = 190, L = 34, R = 6, T = 12, B = 46, n = dh.length;
  const maxS = Math.max(1.5, ...dh.map(x => x.surf?.max ?? 0)) * 1.1;
  const bw = (w - L - R) / n, Y = v => T + (1 - v / maxS) * (h - T - B);
  let s = `<svg viewBox="0 0 ${w} ${h}" class="hc" role="img" aria-label="Hauteur de surf et note heure par heure">`;
  [0, maxS / 2 / 1.1, maxS / 1.1].forEach(v => { s += `<line x1="${L}" x2="${w - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--grid)"/><text x="${L - 5}" y="${Y(v) + 3}" text-anchor="end" class="ax">${fmt(v)}</text>`; });
  s += `<text x="${L}" y="${T - 3}" class="ax">m</text>`;
  dh.forEach((x, i) => {
    const cx = L + i * bw;
    if (!x.day) s += `<rect x="${cx}" y="${T}" width="${bw}" height="${h - T - B}" fill="var(--night)"/>`;
    if (x.surf) { const y1 = Y(x.surf.max), y0 = Y(x.surf.min); s += `<rect x="${cx + 3}" y="${y1}" width="${bw - 6}" height="${Math.max(2, Y(0) - y1)}" rx="3" fill="${scoreColor(x.raw)}" opacity="${x.day ? 1 : 0.45}"/><line x1="${cx + 3}" x2="${cx + bw - 3}" y1="${y0}" y2="${y0}" stroke="var(--panel)" stroke-width="1.5" opacity=".7"/>`; }
    if (x.t === sel.t) s += `<rect x="${cx + 1}" y="${T}" width="${bw - 2}" height="${h - T - B + 30}" fill="none" stroke="var(--fg)" stroke-width="1.5" rx="4"/>`;
    if (i % 3 === 0) s += `<text x="${cx + bw / 2}" y="${h - B + 13}" text-anchor="middle" class="ax">${hourOf(x.t)}h</text>`;
    s += `<g transform="translate(${cx + bw / 2},${h - B + 28})"><path d="M0,-7 L4,3 L0,1 L-4,3Z" fill="${windColor(x.wind.v)}" transform="rotate(${(x.wind.d + 180) % 360})"/></g>`;
    s += `<rect class="hit" x="${cx}" y="0" width="${bw}" height="${h}" fill="transparent" data-ht="${x.t}"/>`;
  });
  return s + `</svg><div class="m">Barres : hauteur de surf (fourchette basse à haute), couleur = note. Flèches : vent AROME, couleur = force. Zones grisées : nuit.</div>`;
}
function hourTable(dh, sel) {
  const rows = dh.filter((x, i) => x.day || i % 3 === 0);
  return `<thead><tr><th>Heure</th><th>Note</th><th>Surf</th><th>Houle 1</th><th>Houle 2</th><th>Vent</th><th>Marée</th><th>Conf.</th></tr></thead><tbody>${rows.map(x => `
    <tr data-ht="${x.t}" class="${x.t === sel.t ? "sel" : ""}${x.day ? "" : " nightrow"}">
      <td>${hourOf(x.t)} h</td>
      <td><span class="sc" style="background:${scoreColor(x.raw)};color:${scoreInk(x.raw)}">${fmt(x.raw)}</span></td>
      <td>${surfTxt(x.surf)}</td>
      <td>${fmt(x.sw.h)} m ${fmt(x.sw.p, 0)} s ${arrow(x.sw.d)}${card(x.sw.d)}</td>
      <td>${x.sw2.h ? `${fmt(x.sw2.h)} m ${fmt(x.sw2.p, 0)} s ${card(x.sw2.d)}` : "–"}</td>
      <td>${arrow(x.wind.d)} ${fmt(x.wind.v, 0)} (${fmt(x.wind.g, 0)}) ${x.parts.wind.label}</td>
      <td>${tideState(x)}</td>
      <td>${x.conf ? x.conf.v + "%" : "–"}</td></tr>`).join("")}</tbody>`;
}
function tideChart(day, sr, ss) {
  const pts = S.tide.series.filter(p => p.t.slice(0, 10) === day || p.t === nextDay(day) + "T00:00");
  if (pts.length < 2) return `<p class="m">Marée indisponible.</p>`;
  const w = 380, h = 150, L = 8, R = 8, T = 18, B = 22;
  const vs = pts.map(p => p.v), lo = Math.min(...vs), hi = Math.max(...vs);
  const X = i => L + i / 24 * (w - L - R), Y = v => T + (1 - (v - lo) / (hi - lo || 1)) * (h - T - B);
  let s = `<svg viewBox="0 0 ${w} ${h}" class="tc" role="img" aria-label="Courbe de marée">`;
  if (sr) s += `<rect x="${L}" y="${T}" width="${X(hourOf(sr) + +sr.slice(14, 16) / 60) - L}" height="${h - T - B}" fill="var(--night)"/>`;
  if (ss) s += `<rect x="${X(hourOf(ss) + +ss.slice(14, 16) / 60)}" y="${T}" width="${w - R - X(hourOf(ss) + +ss.slice(14, 16) / 60)}" height="${h - T - B}" fill="var(--night)"/>`;
  const line = pts.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`).join("");
  s += `<path d="${line} L${X(pts.length - 1)},${h - B} L${X(0)},${h - B}Z" fill="var(--tidefill)"/><path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2"/>`;
  S.tide.extremes.filter(e => e.time.slice(0, 10) === day).forEach(e => {
    const fh = (e.at.getTime() - new Date(day + "T00:00:00").getTime()) / 3600e3;
    const x = L + fh / 24 * (w - L - R), y = Y(e.level);
    s += `<circle cx="${x}" cy="${y}" r="3.5" fill="var(--accent)"/><text x="${x}" y="${e.high ? y - 7 : y + 14}" text-anchor="middle" class="ax strong">${e.high ? "PM" : "BM"} ${hhmm(e.at)}</text>`;
  });
  if (S.nowKey.slice(0, 10) === day) { const now = new Date(), fh = now.getHours() + now.getMinutes() / 60; s += `<line x1="${X(fh)}" x2="${X(fh)}" y1="${T}" y2="${h - B}" stroke="var(--fg)" stroke-dasharray="2 3"/>`; }
  [0, 6, 12, 18, 24].forEach(hh => { s += `<text x="${X(hh)}" y="${h - 6}" text-anchor="${hh === 0 ? "start" : hh === 24 ? "end" : "middle"}" class="ax">${hh}h</text>`; });
  const coef = S.tide.map.get(day + "T12:00")?.coef;
  const g = S.gauge?.length ? S.gauge[S.gauge.length - 1] : null;
  return s + `</svg><p class="m">Coefficient estimé ≈ ${coef ?? "–"}. ${g && S.nowKey.slice(0, 10) === day ? `Mesuré à La Cotinière : ${fmt(g.v, 2)} m (${ago(Date.now() - g.t)}).` : ""} Heures de pleine et basse mer estimées par le modèle, à vérifier sur l'annuaire du SHOM.</p>`;
}
const nextDay = d => { const x = new Date(d + "T12:00"); x.setDate(x.getDate() + 1); return x.toISOString().slice(0, 10); };
function partsBlock(h, spot) {
  const p = h.parts; if (!p) return "";
  const m = (l, v) => `<div class="meter"><span>${l}</span><div class="bar"><span style="width:${Math.round(clamp(v, 0, 1) * 100)}%"></span></div><span class="v">${Math.round(v * 100)}%</span></div>`;
  return `${m("Taille", p.size)}${m("Période", p.period)}${m("Vent", p.wind.s)}${m("Marée", p.tide)}${m("Orientation", p.dir)}${spot.energy ? m("Énergie", p.energy) : ""}${spot.coef?.max || spot.coef?.min ? m("Coefficient", p.coef) : ""}
    <dl class="facts" style="margin-top:8px"><dt>Houle vue du spot</dt><dd>${fmt(h.heff)} m (idéal ${fmt(spot.size[1])}–${fmt(spot.size[2])} m)</dd><dt>Énergie</dt><dd>${fmt(h.E, 0)} kW/m</dd><dt>Vent</dt><dd>${h.wind.model}, offshore = ${card(spot.wind_.offshore)}</dd></dl>`;
}
function spotCfg(s) {
  const t = x => Math.round(x * 100) + " %";
  return `<dl class="facts"><dt>Type</dt><dd>${esc(s.type)}</dd>
    <dt>Houle</dt><dd>${card(s.swell.ideal)} (${s.swell.ideal}° ± ${s.swell.window}°), ${fmt(s.size[1])}–${fmt(s.size[2])} m idéal, ${fmt(s.size[0])} mini, ${fmt(s.size[3])} maxi, période ≥ ${s.periodMin ?? "–"} s${s.energy?.min ? `, énergie ≥ ${s.energy.min} kW/m` : ""}</dd>
    <dt>Vent offshore</dt><dd>${card(s.wind_.offshore)} (${s.wind_.offshore}°), offshore toléré jusqu'à ${s.wind_.maxOffshore} km/h</dd>
    <dt>Marée</dt><dd>${t(s.tide.lo)}–${t(s.tide.hi)} du marnage${s.tide.prefer ? ", " + s.tide.prefer : ""}${s.coef?.max ? `, coef ≤ ${s.coef.max}` : ""}</dd>
    <dt>Abri</dt><dd>${CM.ready ? "calculé heure par heure par le modèle côtier (ombre des îles, fonds, marée)" : Math.round((s.shelter ?? 1) * 100) + " % de la houle du large arrive au bord (valeur fixe)"}</dd>
    <dt>Dangers</dt><dd>${esc(s.dangers)}</dd><dt>Notes</dt><dd>${esc(s.notes)}</dd></dl>
    <p class="m">Pour modifier ces critères : le doc <a href="https://claude.ai/artifact/WRi3Vq397kEE8tk5ay1vrA" target="_blank" rel="noopener">Critères des spots</a>.</p>`;
}

