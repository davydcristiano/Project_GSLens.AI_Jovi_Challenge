/* GSLens.AI — Service Worker
   Estratégia "rede primeiro, cache como reserva": sempre busca a versão
   mais nova quando há conexão (evita servir código desatualizado após
   atualizações) e permite abrir o app offline com o que já foi carregado. */
const CACHE = 'gslens-v3';
const CORE = [
  './', './index.html', './manifest.webmanifest',
  './css/style.css', './css/vendor/bootstrap4.local.css',
  './js/script.js', './js/vendor/jspdf/jspdf.umd.min.js',
  './js/vendor/aruco/cv.js', './js/vendor/aruco/aruco.js',
  './js/scan3d/math.js', './js/scan3d/board.js', './js/scan3d/tracker.js', './js/scan3d/segment.js',
  './js/scan3d/reconstruct.js', './js/scan3d/texture.js', './js/scan3d/pipeline.js',
  './js/scan3d/exporters.js', './js/scan3d/viewer.js', './js/scan3d/app.js',
  './js/vendor/three/three.min.js', './js/vendor/three/OrbitControls.js',
  './assets/icons/icon-192.png', './assets/icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin && !url.hostname.endsWith('cdnjs.cloudflare.com')) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req).then(r => r || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});
