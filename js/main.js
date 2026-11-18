"use strict";
/* Navigation par onglets (#classement, #spot-<id>, #carte, #direct) et démarrage. */

const VIEWS = ["classement", "spot", "carte", "direct", "reviews"];
let LOADED = false;
function route() {
  const h = (location.hash || "#classement").slice(1);
  const view = h.startsWith("spot-") ? "spot" : VIEWS.includes(h) ? h : "classement";
  VIEWS.forEach(v => { $("#v-" + v).hidden = v !== view; });
  document.querySelectorAll(".tabs a").forEach(a => a.setAttribute("aria-current", a.dataset.v === view || (view === "spot" && a.dataset.v === "classement") ? "page" : "false"));
  if (view !== "carte") hideForecastMap();
  if (!LOADED) return;
  if (view === "classement") renderHome();
  if (view === "spot") { renderSpot(h.slice(5)); window.scrollTo(0, 0); }
  if (view === "carte") showForecastMap();
  if (view === "direct") renderDirect();
  if (view === "reviews") renderReviews();
}
window.addEventListener("hashchange", route);

document.addEventListener("click", e => {
  const r = e.target.closest("[data-rank]"); if (r) { V.rankMode = r.dataset.rank; renderHome(); return; }
  const d = e.target.closest("[data-sday]"); if (d) { V.spotDay = +d.dataset.sday; V.spotSel = null; renderSpot(location.hash.slice(6)); return; }
  const ht = e.target.closest("[data-ht]"); if (ht && ht.closest("#v-spot")) { V.spotSel = ht.dataset.ht; renderSpot(location.hash.slice(6)); return; }
  const fm = e.target.closest("[data-fmode]"); if (fm) { setMapMode(fm.dataset.fmode); return; }
});
document.addEventListener("mousemove", e => {
  const ht = e.target.closest?.(".hc [data-ht]");
  if (!ht) { hideTip(); return; }
  const id = location.hash.slice(6), ser = S.spots.find(s => s.spot.id === id), h = ser?.hours.find(x => x.t === ht.dataset.ht); if (!h) return;
  showTip(e, `<b>${hourOf(h.t)} h · ${fmt(h.raw)}/10</b><br>Surf ${surfTxt(h.surf)}<br>Houle ${fmt(h.sw.h)} m ${fmt(h.sw.p, 0)} s ${card(h.sw.d)}<br>Vent ${fmt(h.wind.v, 0)} km/h ${card(h.wind.d)} · ${h.parts.wind.label}<br>Marée ${tideState(h)} · confiance ${h.conf?.v ?? "–"} %`);
});
$("#fhour").addEventListener("input", e => setMapHour(+e.target.value));
$("#fplay").addEventListener("click", togglePlay);
$("#fpart").addEventListener("click", toggleParticles);
$("#fnow").addEventListener("click", () => { const k = MV.times.indexOf(S.nowKey); if (k >= 0) setMapHour(k); });

async function boot() {
  $("#refresh").disabled = true; $("#stamp").textContent = "Mise à jour…";
  try { await loadAll(); } catch (e) { S.errors.push("Chargement impossible : " + e.message); }
  LOADED = true;
  const eb = $("#errors"); eb.hidden = !S.errors.length; eb.textContent = S.errors.join(" ");
  $("#stamp").textContent = "Mis à jour à " + new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  $("#refresh").disabled = false;
  if (MV.ready) drawSpots();
  route();
}
$("#refresh").addEventListener("click", () => { try { sessionStorage.removeItem("grid-wave-v5"); sessionStorage.removeItem("grid-wind-v5"); } catch (e) {} MV.grid = null; boot(); });
route();
boot();
setInterval(boot, 15 * 60e3);

/* appli installable et lisible hors réseau */
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
window.addEventListener("offline", () => { const eb = $("#errors"); eb.hidden = false; eb.textContent = "Pas de réseau : affichage des dernières données chargées."; });
