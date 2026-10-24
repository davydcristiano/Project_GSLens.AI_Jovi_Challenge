/* GSLens.AI — Service Worker
   Estratégia "rede primeiro, cache como reserva": sempre busca a versão
   mais nova quando há conexão (evita servir código desatualizado após
   atualizações) e permite abrir o app offline com o que já foi carregado. */
const CACHE = 'gslens-v15';
const CORE = [
  './', './index.html', './manifest.webmanifest',
  './css/style.css', './css/vendor/bootstrap4.local.css',
  './js/app/core.js', './js/app/camera.js', './js/app/camera-filters.js', './js/app/modes.js', './js/app/recording.js', './js/app/live-fx.js', './js/app/capture.js', './js/app/gallery.js', './js/app/editor.js', './js/app/analysis.js', './js/app/share-export.js', './js/app/dashboard.js', './js/app/main.js', './js/vendor/jspdf/jspdf.umd.min.js',
  './js/vendor/aruco/cv.js', './js/vendor/aruco/aruco.js',
  './js/scan3d/math.js', './js/scan3d/board.js', './js/scan3d/tracker.js', './js/scan3d/features.js', './js/scan3d/surface.js', './js/scan3d/segment.js',
  './js/scan3d/reconstruct.js', './js/scan3d/texture.js', './js/scan3d/pipeline.js',
  './js/scan3d/exporters.js', './js/scan3d/viewer.js', './js/scan3d/app.js',
  './js/vendor/three/three.min.js', './js/vendor/three/OrbitControls.js',
  './js/gpuframe.js', './js/filters.js', './js/nightslow.js', './js/portrait/tflite.js', './js/portrait/portrait.js', './js/portrait/seg-worker.js',
  './js/portrait/models/selfie_segmentation.tflite', './js/portrait/models/selfie_segmentation_landscape.tflite', './js/frames.js', './js/links/linkscan.js', './js/links/ocr-worker.js', './js/vendor/jsqr/jsQR.js',
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
  /* CORREÇÃO: revalida sempre com o servidor (cache:'no-cache'). Antes o
     fetch podia receber do cache HTTP um script.js antigo junto com o
     index.html novo após publicar uma atualização — o leitor de QR/links
     simplesmente não iniciava. */
  const sameOrigin = url.origin === location.origin;
  e.respondWith(
    /* requisições de navegação não podem ser recriadas com new Request(req, …) */
    fetch(!sameOrigin ? req
      : req.mode === 'navigate' ? new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' })
      : new Request(req, { cache: 'no-cache' })).then(res => {
      if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req).then(r => r || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});
