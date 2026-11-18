"use strict";
/* Reviews de sessions : formulaire, photos, liste, et pour chaque session les conditions réelles
   (stations les plus proches) et ce que l'outil prévoyait à cette heure-là. Le bilan par spot sert
   à recaler les critères de notation. */

const RV = { list: [], loading: false, preview: null, previewKey: null, archive: {}, timer: null };
const RV_OK = () => !!(REVIEW_CFG.url && REVIEW_CFG.key);
const OFFSHORE_BUOYS = ["01704", "08504", "08505", "03302"];
const RATING_WORDS = ["Plat / impossible", "Très mauvais", "Mauvais", "Médiocre", "Moyen", "Correct", "Bien", "Très bien", "Excellent", "Exceptionnel", "Session de l'année"];

/* ---------- conditions d'une session ---------- */
const distKm = (a, b, c, d) => Math.hypot((a - c) * 111.3, (b - d) * 111.3 * Math.cos(a * Math.PI / 180));
async function archiveMonth(m) {
  if (!(m in RV.archive)) RV.archive[m] = getJSON(`archive/obs/${m}.json?ts=${Math.floor(Date.now() / 18e5)}`, 15000).catch(() => null);
  return RV.archive[m];
}
/* valeur archivée (pas de 30 min, UTC) la plus proche dans ±45 min */
function nearSlot(obj, utc) {
  if (!obj) return null;
  let best = null;
  for (const dm of [0, 30, -30, 60, -60]) {
    const d = new Date(utc.getTime() + dm * 60e3); d.setUTCMinutes(Math.round(d.getUTCMinutes() / 30) * 30, 0, 0);
    const k = d.toISOString().slice(0, 16); if (obj[k] && (best == null)) best = { k, v: obj[k] };
  }
  return best;
}
async function conditionsFor(spot, local) {
  const day = local.slice(0, 10), hourKey = local.slice(0, 13) + ":00", utc = new Date(local + ":00");
  const MVARS = "wave_height,wave_period,swell_wave_height,swell_wave_direction,swell_wave_period,secondary_swell_wave_height,secondary_swell_wave_direction,secondary_swell_wave_period,wind_wave_height,wind_wave_direction,wind_wave_period";
  const [m, w, arch] = await Promise.all([
    getJSON(`https://marine-api.open-meteo.com/v1/marine?${qs({ latitude: spot.marine[0], longitude: spot.marine[1], hourly: MVARS, models: "meteofrance_wave", timezone: "Europe/Paris", start_date: day, end_date: day })}`).catch(() => null),
    getJSON(`https://api.open-meteo.com/v1/forecast?${qs({ latitude: spot.wind[0], longitude: spot.wind[1], hourly: "wind_speed_10m,wind_direction_10m,wind_gusts_10m", models: "meteofrance_arome_france_hd,meteofrance_seamless", wind_speed_unit: "kmh", timezone: "Europe/Paris", start_date: day, end_date: day })}`).catch(() => null),
    archiveMonth(utc.toISOString().slice(0, 7))
  ]);
  const c = { v: 1, at: hourKey, tool: null, measured: { wind: null, beacon: null, buoys: [] } };
  // ce que l'outil aurait calculé à cette heure
  if (m && w) {
    const j = m.hourly.time.indexOf(hourKey), k = w.hourly.time.indexOf(hourKey);
    if (j >= 0 && k >= 0) {
      const M = key => m.hourly[key]?.[j] ?? null, W = w.hourly;
      const hd = W.wind_speed_10m_meteofrance_arome_france_hd?.[k];
      const h = {
        t: hourKey,
        sw: { h: M("swell_wave_height"), d: M("swell_wave_direction"), p: M("swell_wave_period") },
        sw2: { h: M("secondary_swell_wave_height"), d: M("secondary_swell_wave_direction"), p: M("secondary_swell_wave_period") },
        ww: { h: M("wind_wave_height"), d: M("wind_wave_direction"), p: M("wind_wave_period") },
        wind: { v: hd ?? W.wind_speed_10m_meteofrance_seamless?.[k], d: hd != null ? W.wind_direction_10m_meteofrance_arome_france_hd[k] : W.wind_direction_10m_meteofrance_seamless?.[k], g: hd != null ? W.wind_gusts_10m_meteofrance_arome_france_hd[k] : W.wind_gusts_10m_meteofrance_seamless?.[k] },
        tide: S.tide?.map.get(hourKey) || { n: null, rising: null, coef: null }
      };
      if (h.sw.h != null) {
        const r = rateHour(spot, h);
        c.tool = { score: r.score, surf: r.surf ? { min: +r.surf.min.toFixed(2), max: +r.surf.max.toFixed(2), kd: r.surf.kd ?? null } : null, heff: +r.heff.toFixed(2), energy: r.E == null ? null : Math.round(r.E),
          swell: { h: h.sw.h, p: h.sw.p, d: h.sw.d }, swell2: { h: h.sw2.h, p: h.sw2.p, d: h.sw2.d }, windsea: { h: h.ww.h, p: h.ww.p },
          wind: { v: h.wind.v, g: h.wind.g, d: h.wind.d, label: r.parts.wind.label }, tide: { n: h.tide.n == null ? null : +h.tide.n.toFixed(2), rising: h.tide.rising, coef: h.tide.coef, state: tideState(h) },
          parts: { size: +r.parts.size.toFixed(2), period: +r.parts.period.toFixed(2), wind: +r.parts.wind.s.toFixed(2), tide: +r.parts.tide.toFixed(2), dir: +r.parts.dir.toFixed(2) } };
      }
    }
  }
  // anémomètre Météo-France le plus proche (archive, sinon relève du jour)
  const stations = (S.obs?.stations || []).map(s => ({ ...s, dist: distKm(spot.lat, spot.lon, s.lat, s.lon) })).sort((a, b) => a.dist - b.dist);
  for (const st of stations) {
    let hit = nearSlot(arch?.wind?.[st.id], utc);
    if (!hit) { const r = st.series?.find(x => Math.abs(new Date(x.t) - utc) <= 20 * 60e3); if (r) hit = { k: r.t, v: [r.v, r.g, r.d] }; }
    if (hit) { c.measured.wind = { station: st.name, dist: Math.round(st.dist), v: hit.v[0], g: hit.v[1], d: hit.v[2] }; break; }
  }
  // balise OpenWindMap la plus proche (son historique est consultable à n'importe quelle date)
  const beacons = S.beacons.map(b => ({ b, dist: distKm(spot.lat, spot.lon, b.location.latitude, b.location.longitude) })).sort((a, b) => a.dist - b.dist).slice(0, 2);
  for (const { b, dist } of beacons) {
    try {
      const a = await getJSON(`https://api.pioupiou.fr/v1/archive/${b.id}?start=${new Date(utc - 30 * 60e3).toISOString()}&stop=${new Date(+utc + 30 * 60e3).toISOString()}`, 12000);
      const rows = (a.data || []).filter(r => r[4] != null);
      if (rows.length) { c.measured.beacon = { station: (b.meta?.name || "Balise " + b.id).trim(), dist: Math.round(dist), v: +mean(rows.map(r => r[4])).toFixed(1), g: Math.max(...rows.map(r => r[5] ?? 0)), d: rows[Math.floor(rows.length / 2)][6] }; break; }
    } catch (e) {}
  }
  // bouées au large
  (S.obs?.buoys || []).filter(b => OFFSHORE_BUOYS.includes(b.id)).forEach(b => {
    let hit = nearSlot(arch?.buoy?.[b.id], utc);
    if (!hit) { const r = b.series?.find(x => Math.abs(new Date(x.t) - utc) <= 20 * 60e3); if (r) hit = { v: [r.hs, r.hmax, r.tp ?? r.th, r.dir] }; }
    if (hit && hit.v[0] != null) c.measured.buoys.push({ name: b.name, hs: hit.v[0], hmax: hit.v[1], tp: hit.v[2], dir: hit.v[3] });
  });
  return c;
}

/* ---------- Supabase (REST) ---------- */
const sbHeaders = extra => ({ apikey: REVIEW_CFG.key, Authorization: "Bearer " + REVIEW_CFG.key, ...extra });
async function loadReviews() {
  if (!RV_OK()) return [];
  const r = await fetch(`${REVIEW_CFG.url}/rest/v1/reviews?select=*&order=session_at.desc&limit=200`, { headers: sbHeaders() });
  if (!r.ok) throw new Error("lecture impossible (" + r.status + ")");
  return r.json();
}
async function shrinkImage(file, max = 1600) {
  const img = await createImageBitmap(file).catch(() => null); if (!img) throw new Error("image illisible : " + file.name);
  const k = Math.min(1, max / Math.max(img.width, img.height)), cv = document.createElement("canvas");
  cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
  cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
  return new Promise(res => cv.toBlob(res, "image/jpeg", 0.82));
}
async function uploadPhoto(blob, folder, i) {
  const path = `${folder}/${i + 1}.jpg`;
  const r = await fetch(`${REVIEW_CFG.url}/storage/v1/object/photos/${path}`, { method: "POST", headers: sbHeaders({ "Content-Type": "image/jpeg", "x-upsert": "false" }), body: blob });
  if (!r.ok) throw new Error("envoi de la photo " + (i + 1) + " refusé (" + r.status + ")");
  return `${REVIEW_CFG.url}/storage/v1/object/public/photos/${path}`;
}
async function submitReview(data) {
  const r = await fetch(`${REVIEW_CFG.url}/rest/v1/rpc/submit_review`, { method: "POST", headers: sbHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(data) });
  if (!r.ok) { const t = await r.text(); throw new Error(t.includes("code invalide") ? "Code de publication incorrect." : t.includes("date") ? "La date de session doit être dans les 120 derniers jours." : "Publication refusée (" + r.status + ")."); }
  return r.json();
}

/* ---------- rendu ---------- */
function renderReviews() {
  const spots = S.cfg?.spots || [];
  if (!$("#rvform").dataset.ready) {
    const now = new Date(), pad = n => String(n).padStart(2, "0");
    $("#rv-spot").innerHTML = spots.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
    $("#rv-date").value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    $("#rv-date").max = $("#rv-date").value;
    $("#rv-time").value = `${pad(Math.max(7, Math.min(20, now.getHours() - 1)))}:00`;
    try { $("#rv-author").value = localStorage.getItem("rv-author") || ""; $("#rv-code").value = localStorage.getItem("rv-code") || ""; } catch (e) {}
    $("#rvform").dataset.ready = "1";
    updateRating();
  }
  $("#rv-backend").hidden = RV_OK();
  $("#rv-submit").disabled = !RV_OK();
  schedulePreview();
  refreshList();
}
function updateRating() { const v = +$("#rv-rating").value; $("#rv-rating-out").innerHTML = `<b style="background:${scoreColor(v)};color:${scoreInk(v)}">${v}</b> ${RATING_WORDS[v]}`; }
function schedulePreview() { clearTimeout(RV.timer); RV.timer = setTimeout(runPreview, 400); }
async function runPreview() {
  const spot = S.cfg?.spots.find(s => s.id === $("#rv-spot").value); if (!spot) return;
  const local = `${$("#rv-date").value}T${$("#rv-time").value}`; if (local.length < 16) return;
  const key = spot.id + local; if (key === RV.previewKey && RV.preview) return;
  RV.previewKey = key; $("#rv-cond").innerHTML = `<div class="skel">Recherche des conditions à cette heure…</div>`;
  try { const c = await conditionsFor(spot, local); if (RV.previewKey !== key) return; RV.preview = c; $("#rv-cond").innerHTML = condBlock(c); }
  catch (e) { $("#rv-cond").innerHTML = `<p class="m">Conditions introuvables (${esc(e.message)}).</p>`; RV.preview = null; }
}
function condBlock(c, rating) {
  if (!c) return `<p class="m">Conditions non enregistrées.</p>`;
  const t = c.tool, m = c.measured;
  const tool = t ? `<div class="cond"><div class="eyebrow">Ce que l'outil prévoyait</div>
      <div class="condrow"><span class="sc" style="background:${scoreColor(t.score)};color:${scoreInk(t.score)}">${fmt(t.score)}</span>
      <span>Surf ${t.surf ? `${fmt(t.surf.min)}–${fmt(t.surf.max)} m` : "–"} · houle ${fmt(t.swell.h)} m ${fmt(t.swell.p, 0)} s ${card(t.swell.d)} · vent ${fmt(t.wind.v, 0)} km/h ${card(t.wind.d)} (${t.wind.label}) · marée ${t.tide.state}${t.tide.coef ? " · coef ≈ " + t.tide.coef : ""}</span></div>
      ${rating != null ? `<div class="m">Ta note ${rating}/10 · outil ${fmt(t.score)}/10 · écart ${rating - t.score >= 0 ? "+" : ""}${fmt(rating - t.score)}</div>` : ""}</div>` : `<p class="m">Prévision indisponible pour cette heure (au-delà de 3 mois, ou pas encore de données).</p>`;
  const meas = [];
  if (m.wind) meas.push(`Vent ${fmt(m.wind.v, 0)} km/h (rafales ${fmt(m.wind.g, 0)}) ${arrow(m.wind.d)} ${card(m.wind.d)} à ${esc(m.wind.station)} (${m.wind.dist} km)`);
  if (m.beacon) meas.push(`Balise ${esc(m.beacon.station)} (${m.beacon.dist} km) : ${fmt(m.beacon.v, 0)} km/h ${card(m.beacon.d)}`);
  if (m.buoys.length) meas.push("Houle mesurée : " + m.buoys.map(b => `${esc(b.name)} ${fmt(b.hs)} m ${fmt(b.tp, 0)} s${b.dir != null ? " " + card(b.dir) : ""}`).join(" · "));
  return tool + `<div class="cond"><div class="eyebrow">Mesuré à cette heure</div>${meas.length ? meas.map(x => `<div class="m">${x}</div>`).join("") : `<div class="m">Aucune mesure archivée pour cette heure (l'archive démarre le 18 novembre 2026).</div>`}</div>`;
}
async function refreshList() {
  const box = $("#rv-list");
  if (!RV_OK()) { box.innerHTML = `<div class="skel">Les reviews apparaîtront ici une fois le stockage branché.</div>`; $("#rv-bilan").innerHTML = ""; return; }
  if (RV.loading) return; RV.loading = true;
  try { RV.list = await loadReviews(); } catch (e) { box.innerHTML = `<p class="m">Impossible de lire les reviews : ${esc(e.message)}</p>`; RV.loading = false; return; }
  RV.loading = false;
  const name = id => S.cfg.spots.find(s => s.id === id)?.name || id;
  box.innerHTML = RV.list.length ? RV.list.map(r => {
    const d = new Date(r.session_at);
    return `<article class="card rv">
      <div class="rvhead"><span class="sc big2" style="background:${scoreColor(r.rating)};color:${scoreInk(r.rating)}">${r.rating}</span>
        <div><h3>${esc(name(r.spot))}</h3><div class="m">${d.toLocaleString("fr-FR", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}${r.author ? " · " + esc(r.author) : ""}</div></div></div>
      ${r.description ? `<p class="rvtext">${esc(r.description)}</p>` : ""}
      ${r.photos?.length ? `<div class="rvphotos">${r.photos.map(u => `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="Photo de la session" loading="lazy"></a>`).join("")}</div>` : ""}
      <details><summary>Conditions de la session</summary>${condBlock(r.conditions, r.rating)}</details>
    </article>`;
  }).join("") : `<div class="skel">Aucune review pour l'instant. Sois le premier !</div>`;
  renderBilan();
}
function renderBilan() {
  const by = {};
  RV.list.forEach(r => { const t = r.conditions?.tool?.score; (by[r.spot] ||= []).push({ u: r.rating, t }); });
  const rows = S.cfg.spots.map(s => {
    const v = by[s.id] || [], withT = v.filter(x => x.t != null);
    const dU = mean(v.map(x => x.u)), dT = mean(withT.map(x => x.t)), gap = withT.length ? mean(withT.map(x => x.u - x.t)) : null;
    const hint = gap == null ? "pas encore de données" : withT.length < 3 ? "trop peu de sessions pour conclure" : gap > 1.5 ? "l'outil sous-note ce spot : critères trop sévères" : gap < -1.5 ? "l'outil surnote ce spot : critères trop larges" : "l'outil est en phase avec vos sessions";
    return `<tr><td>${esc(s.name)}</td><td>${v.length}</td><td>${fmt(dU)}</td><td>${fmt(dT)}</td><td>${gap == null ? "–" : (gap >= 0 ? "+" : "") + fmt(gap)}</td><td>${hint}</td></tr>`;
  }).join("");
  $("#rv-bilan").innerHTML = `<table class="htable"><thead><tr><th>Spot</th><th>Sessions</th><th>Vos notes</th><th>Outil</th><th>Écart</th><th>Lecture</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="m">Écart = votre note moins celle de l'outil à la même heure.</p>
    <h3 style="margin-top:14px">Recalage des critères</h3>${S.cfg.spots.map(s => calibCard(s, RV.list.filter(r => r.spot === s.id && r.conditions?.tool))).join("")}`;
}
/* propositions de réglages à partir des bonnes sessions (note >= 7) et des sessions ratées (note <= 3) */
function calibCard(spot, rv) {
  const good = rv.filter(r => r.rating >= 7), ok = rv.filter(r => r.rating >= 4), bad = rv.filter(r => r.rating <= 3);
  if (good.length < 3) return `<details class="calib"><summary>${esc(spot.name)} · ${rv.length} session${rv.length > 1 ? "s" : ""} analysable${rv.length > 1 ? "s" : ""}</summary><p class="m">Il faut au moins 3 sessions notées 7 ou plus pour proposer des réglages (${good.length} pour l'instant).</p></details>`;
  const T = r => r.conditions.tool, q = (arr, p) => { const v = arr.filter(x => x != null).sort((a, b) => a - b); if (!v.length) return null; const i = (v.length - 1) * p, lo = Math.floor(i); return v[lo] + (v[Math.ceil(i)] - v[lo]) * (i - lo); };
  const dirs = good.map(r => T(r).swell.d).filter(d => d != null);
  const sx = mean(dirs.map(d => Math.sin(d * Math.PI / 180))), cx = mean(dirs.map(d => Math.cos(d * Math.PI / 180)));
  const dIdeal = Math.round((Math.atan2(sx, cx) * 180 / Math.PI + 360) % 360), dWin = Math.round(clamp(Math.max(...dirs.map(d => angDiff(d, dIdeal))) + 10, 20, 60));
  const H = good.map(r => T(r).heff), Hok = ok.map(r => T(r).heff), P = good.map(r => T(r).swell.p), N = good.map(r => T(r).tide.n);
  const windOk = good.map(r => T(r).wind), onshoreGood = windOk.filter(w => /onshore|side-on/.test(w.label)).length;
  const prop = [
    ["Houle idéale", `${card(spot.swell.ideal)} ${spot.swell.ideal}° ± ${spot.swell.window}°`, `${card(dIdeal)} ${dIdeal}° ± ${dWin}°`],
    ["Taille idéale (houle vue du spot)", `${fmt(spot.size[1])}–${fmt(spot.size[2])} m`, `${fmt(q(H, 0.15))}–${fmt(q(H, 0.85))} m`],
    ["Taille mini", `${fmt(spot.size[0])} m`, `${fmt(q(Hok, 0) ?? q(H, 0))} m`],
    ["Période mini", `${spot.periodMin ?? "–"} s`, `${fmt(q(P, 0.1), 0)} s`],
    ["Marée", `${Math.round(spot.tide.lo * 100)}–${Math.round(spot.tide.hi * 100)} %`, `${Math.round((q(N, 0.1) ?? 0) * 100)}–${Math.round((q(N, 0.9) ?? 1) * 100)} %`],
    ["Vent pendant les bonnes sessions", `offshore ${card(spot.wind_.offshore)}`, `jusqu'à ${fmt(Math.max(...windOk.map(w => w.v ?? 0)), 0)} km/h${onshoreGood ? `, ${onshoreGood} fois avec vent de mer` : ", jamais de vent de mer"}`]
  ];
  const badTxt = bad.length ? `Sessions ratées (${bad.length}) : houle vue du spot ${fmt(mean(bad.map(r => T(r).heff)))} m en moyenne, vent ${[...new Set(bad.map(r => T(r).wind.label))].join(", ")}.` : "";
  return `<details class="calib" open><summary>${esc(spot.name)} · ${good.length} bonnes sessions sur ${rv.length}</summary>
    <table class="htable"><thead><tr><th>Critère</th><th>Actuel</th><th>D'après vos sessions</th></tr></thead><tbody>${prop.map(p => `<tr><td>${p[0]}</td><td>${p[1]}</td><td><b>${p[2]}</b></td></tr>`).join("")}</tbody></table>
    <p class="m">${badTxt} Ce sont des propositions : on les valide dans le doc des critères avant de les appliquer.</p></details>`;
}

/* ---------- envoi ---------- */
async function onSubmit(e) {
  e.preventDefault();
  const st = $("#rv-status"), btn = $("#rv-submit");
  if (!RV_OK()) return;
  const spot = $("#rv-spot").value, local = `${$("#rv-date").value}T${$("#rv-time").value}`, files = [...$("#rv-photos").files].slice(0, 6);
  const code = $("#rv-code").value.trim(), author = $("#rv-author").value.trim();
  if (!code) { st.textContent = "Il faut le code de publication (demande-le à la personne qui gère le site)."; return; }
  btn.disabled = true;
  try {
    try { localStorage.setItem("rv-author", author); localStorage.setItem("rv-code", code); } catch (er) {}
    st.textContent = "Calcul des conditions de la session…";
    const sp = S.cfg.spots.find(s => s.id === spot);
    const cond = RV.previewKey === spot + local && RV.preview ? RV.preview : await conditionsFor(sp, local).catch(() => null);
    const folder = `${local.slice(0, 10)}-${spot}-${Math.random().toString(36).slice(2, 8)}`, urls = [];
    for (let i = 0; i < files.length; i++) { st.textContent = `Envoi des photos (${i + 1}/${files.length})…`; urls.push(await uploadPhoto(await shrinkImage(files[i]), folder, i)); }
    st.textContent = "Publication…";
    await submitReview({ p_code: code, p_spot: spot, p_session_at: new Date(local + ":00").toISOString(), p_rating: +$("#rv-rating").value, p_author: author, p_description: $("#rv-desc").value.trim(), p_photos: urls, p_conditions: cond });
    st.textContent = "Review publiée. Merci !";
    $("#rv-desc").value = ""; $("#rv-photos").value = ""; $("#rv-files").textContent = "";
    refreshList();
  } catch (er) { st.textContent = er.message; }
  finally { btn.disabled = !RV_OK(); }
}
document.addEventListener("input", e => {
  if (e.target.id === "rv-rating") updateRating();
  if (["rv-spot", "rv-date", "rv-time"].includes(e.target.id)) schedulePreview();
  if (e.target.id === "rv-photos") { const n = e.target.files.length; $("#rv-files").textContent = n ? `${Math.min(n, 6)} photo${n > 1 ? "s" : ""} sélectionnée${n > 1 ? "s" : ""}${n > 6 ? " (6 maximum)" : ""}` : ""; }
});
document.addEventListener("change", e => { if (["rv-spot", "rv-date", "rv-time"].includes(e.target.id)) schedulePreview(); });
document.addEventListener("submit", e => { if (e.target.id === "rvform") onSubmit(e); });
