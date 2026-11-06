/* Fa aprire il sito anche senza rete: tiene una copia dei suoi file.
   Quando si aggiorna il sito, alzare il numero di VERSIONE. */
const VERSIONE = "sopralluoghi-v2";
const FILE = ["./", "index.html", "app.js", "config.js", "manifest.webmanifest", "modello-scheda.pdf",
  "icona-192.png", "icona-512.png", "lib/supabase.js", "lib/pdf.min.js", "lib/pdf.worker.min.js",
  "lib/pdf-lib.min.js", "lib/jszip.min.js", "lib/exifr.js"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSIONE).then(c => c.addAll(FILE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSIONE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return; // Supabase e il resto passano diretti
  const fisso = /\/lib\/|icona-|modello-scheda\.pdf/.test(url.pathname);
  if (fisso) {
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => {
      const copia = res.clone(); caches.open(VERSIONE).then(c => c.put(req, copia)); return res;
    })));
    return;
  }
  // pagina, app e configurazione: prima la rete (così gli aggiornamenti arrivano), senza rete la copia
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copia = res.clone(); caches.open(VERSIONE).then(c => c.put(req, copia)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || (req.mode === "navigate" ? caches.match("index.html") : undefined))));
});
