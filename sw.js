/* Service worker : l'appli s'ouvre sans réseau et affiche la dernière prévision chargée.
   - fichiers de l'appli (pages, scripts, icônes, fonds, bathymétrie) : servis du cache, mis à jour en arrière-plan ;
   - données (prévisions, mesures, grille) : réseau d'abord, cache si pas de réseau ;
   - envois (reviews, photos) : jamais mis en cache. */
const VERSION = "v4-3";
const SHELL = `shell-${VERSION}`, DATA = `data-${VERSION}`;
const DATA_HOSTS = ["api.open-meteo.com", "marine-api.open-meteo.com", "api.pioupiou.fr", "services.data.shom.fr"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(["./", "./index.html", "./manifest.json", "./icons/icon-192.png"]).catch(() => {})));
  self.skipWaiting();
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== DATA).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith("supabase.co") && !url.pathname.includes("/object/public/")) return;
  const isData = DATA_HOSTS.includes(url.hostname) || /\/data\/(obs|grid)\.json$/.test(url.pathname) || url.pathname.includes("/archive/obs/") || url.pathname.endsWith("spots.json");
  const key = isData ? new Request(url.origin + url.pathname + stripTs(url.search)) : req;
  if (isData) {
    e.respondWith(fetch(req).then(r => { if (r.ok) { const c = r.clone(); caches.open(DATA).then(ca => ca.put(key, c)); } return r; })
      .catch(() => caches.match(key).then(m => m || Response.error())));
    return;
  }
  e.respondWith(caches.match(req).then(m => {
    const net = fetch(req).then(r => { if (r.ok || r.type === "opaque") { const c = r.clone(); caches.open(SHELL).then(ca => ca.put(req, c)); } return r; }).catch(() => m || caches.match("./index.html"));
    return m || net;
  }));
});
function stripTs(search) { const p = new URLSearchParams(search); p.delete("ts"); p.delete("x"); const s = p.toString(); return s ? "?" + s : ""; }
