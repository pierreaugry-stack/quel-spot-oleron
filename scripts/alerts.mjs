// Alerte du soir : réutilise le moteur de notation du site (js/core.js) pour trouver les créneaux
// de demain à SEUIL/10 ou plus, puis envoie un message Telegram.
// Secrets attendus : TELEGRAM_TOKEN (jeton du bot) et TELEGRAM_CHAT_ID (groupe ou personne).
// Sans jeton, le message est seulement affiché dans le journal (essai à blanc).
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SEUIL = Number(process.env.ALERT_MIN_SCORE || 7);
const SITE = "https://pierreaugry-stack.github.io/quel-spot-oleron/";

const ctx = vm.createContext({ fetch, AbortController, setTimeout, clearTimeout, console, Intl, URLSearchParams, Math, Date, JSON, Promise, Map, Set,
  document: undefined, sessionStorage: { getItem: () => null, setItem: () => {} } });
vm.runInContext(readFileSync(new URL("../js/core.js", import.meta.url), "utf8"), ctx, { filename: "core.js" });
ctx.__cfg = JSON.parse(readFileSync(new URL("../spots.json", import.meta.url), "utf8"));

const result = await vm.runInContext(`(async () => {
  S.cfg = __cfg; S.nowKey = parisKey();
  S.tide = await loadTide();
  S.spots = await loadSpotForecasts(S.cfg.spots);
  scoreAll();
  const d = dates(); const demain = d[1];
  const wins = windowsFor(S.spots).filter(w => w.peak.t.slice(0, 10) === demain);
  return { demain, wins: wins.map(w => ({ spot: w.spot.name, id: w.spot.id, from: hourOf(w.from.t), to: hourOf(w.to.t) + 1, score: w.peak.score,
    surf: surfTxt(w.peak.surf), houle: fmt(w.peak.sw.h) + " m " + fmt(w.peak.sw.p, 0) + " s " + card(w.peak.sw.d),
    vent: fmt(w.peak.wind.v, 0) + " km/h " + card(w.peak.wind.d) + " (" + w.peak.parts.wind.label + ")", maree: tideState(w.peak), conf: w.peak.conf?.v })) };
})()`, ctx);

const jour = new Date(result.demain + "T12:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
const bons = result.wins.filter(w => w.score >= SEUIL).sort((a, b) => b.score - a.score);
if (!bons.length) { console.log(`Pas de créneau à ${SEUIL}/10 ou plus ${jour} : pas d'alerte.`); process.exit(0); }

const lignes = bons.slice(0, 5).map(w => `• ${w.spot} : ${w.score.toFixed(1).replace(".", ",")}/10 de ${w.from} h à ${w.to} h\n   surf ${w.surf}, houle ${w.houle}, vent ${w.vent}, marée ${w.maree}, confiance ${w.conf ?? "–"} %`);
const texte = `Demain, ${jour} : ça vaut le coup !\n\n${lignes.join("\n")}\n\nDétail : ${SITE}#spot-${bons[0].id}`;
console.log(texte);

const token = process.env.TELEGRAM_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
if (!token || !chat) { console.log("(essai à blanc : secrets TELEGRAM_TOKEN / TELEGRAM_CHAT_ID absents)"); process.exit(0); }
const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ chat_id: chat, text: texte, disable_web_page_preview: true }) });
const j = await r.json();
if (!j.ok) { console.error("Telegram a refusé le message :", j.description); process.exit(1); }
console.log("Alerte envoyée.");
