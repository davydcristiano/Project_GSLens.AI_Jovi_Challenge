/* ═══════════════════════════════════════════════════
   GSLens.AI — script.js
   Câmera · Filtros · Efeitos ao vivo · AR (Scanner 3D,
   ver js/scan3d/) · Vídeo · Slow-Mo · PWA · IndexedDB ·
   Web Share · Temporizador · Exposição · Pinch Zoom ·
   Desenho · Texto · Molduras · Análise automática ·
   Lote PDF · Dashboard · Tema · Álbuns · Seleção múltipla
═══════════════════════════════════════════════════ */
'use strict';

/* CORREÇÃO: antes era `const { jsPDF } = window.jspdf;` no topo do arquivo.
   Se a biblioteca não carregasse (offline, bloqueio de rede), essa linha
   lançava TypeError e TODO o script parava — câmera, galeria, tudo.
   Agora a biblioteca é obtida só no momento do uso, com mensagem clara. */
function getJsPDF() {
  const lib = window.jspdf && window.jspdf.jsPDF;
  if (!lib) { toast('⚠️ Biblioteca de PDF indisponível — recarregue a página.'); return null; }
  return lib;
}

/* localStorage pode lançar exceção (modo privado, armazenamento bloqueado) */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignora */ } }
};

/* ══════════════════════════════════════
   ESTADO GLOBAL
══════════════════════════════════════ */
let stream         = null;
let useFront       = true;
let currentFilter  = 'none';
let currentMode    = 'foto';
let currentFx      = 'grid';
let afEnabled      = true;
let gridEnabled    = false;
let flashEnabled   = false;
let zoomLevel      = 1;
let hwZoom         = false;   /* zoom óptico/hardware em uso (vs. digital via CSS) */
let timerDelay     = 0;
let timerInterval  = null;
let evLevel        = 0;
let evStripVisible = false;
let cameraBusy     = false;

/* Efeitos ao vivo (antes ficavam dentro da aba AR) */
let fxAnimId    = null;
let fxRunning   = false;
let fxParticles = [];
let fxMatrix    = [];
let fxRain      = [];
let fxConfetti  = [];

/* Vídeo */
let mediaRecorder   = null;
let recordedChunks  = [];
let isRecording     = false;
let recordTimer     = null;
let recordSeconds   = 0;
let recordMode      = 'video';
let recordMime      = 'video/webm';
let recordSize      = { w:0, h:0 };
let hasAudio        = false;

/* Pinch */
let pinchStartDist = 0;
let pinchStartZoom = 1;

/* Edição */
let photos         = [];
let editingIdx     = -1;
let originalDataUrl= null;
let cropRatio      = { w:0, h:0 };
let cropState      = { down:false, sx:0, sy:0, ex:0, ey:0 };
let drawTool       = 'brush';
let isDrawing      = false;
let lastDraw       = { x:0, y:0 };
let currentFrame   = 'none';
let currentEffect  = 'none';
let wbGains        = null;   /* balanço de branco calculado pela análise automática */
let currentTab     = 'adjust';

/* Galeria */
let albumFilter    = 'all';
let selectMode     = false;
let selectedIds    = new Set();
let galFrom        = 'camera';
let galEmptyEl     = null;

/* DB */
let db = null;

/* PWA */
let deferredPrompt = null;

/* Toast */
let toastTimer = null;

/* Tema */
let isDark = true;

/* Gráficos do dashboard (destruídos ao re-renderizar — evita vazamento) */
let dashCharts = [];

/* i18n simples */
const i18n = {
  'pt-BR': {
    cameraReady:'📷 Câmera pronta!',
    captured:'📸 Foto capturada!',
    videoStart:'🎬 Gravando vídeo...',
    videoStop:'🎬 Vídeo salvo!',
    filterApplied:'🎨 ',
    noShare:'Seu navegador não suporta compartilhamento de arquivos.',
    pdfSaved:'✅ PDF salvo!',
    jpgSaved:'⬇️ JPG salvo!',
    deleted:'🗑️ Excluído',
    cropApplied:'✂️ Recorte aplicado!',
    drawApplied:'✏️ Desenho aplicado!',
    textApplied:'💬 Texto adicionado!',
    frameApplied:'🖼️ Moldura aplicada!',
    aiDone:'🤖 Análise concluída!',
  }
};
const t = k => (i18n['pt-BR'][k] || k);

const MODE_LABELS = { noite:'NOITE', retrato:'RETRATO', foto:'FOTO', video:'VÍDEO', slowmo:'SLOW-MO', ar:'AR · 3D', efeitos:'EFEITOS' };
const MODE_NAMES  = { noite:'Noite', retrato:'Retrato', foto:'Foto', video:'Vídeo', slowmo:'Slow-Mo', ar:'AR', efeitos:'Efeitos' };


/* ══════════════════════════════════════
   1. IndexedDB — PERSISTÊNCIA LOCAL
══════════════════════════════════════ */
function initDB() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('IndexedDB indisponível')); return; }
    const req = indexedDB.open('CameraStudioV2', 2);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('photos')) {
        d.createObjectStore('photos', { keyPath: 'id' });
      }
    };
    req.onsuccess = e => { db = e.target.result; resolve(db); };
    req.onerror   = () => reject(req.error);
  });
}

/* Vídeos são guardados como Blob (o IndexedDB suporta Blob nativamente).
   CORREÇÃO: antes os vídeos só existiam como blob: URL em memória e sumiam
   ao recarregar a página. A URL de exibição não é persistida. */
function dbRecord(photo) {
  const rec = Object.assign({}, photo);
  if (rec.type === 'video') delete rec.dataUrl;
  return rec;
}

async function savePhotoToDB(photo) {
  if (!db) return;
  return new Promise((res, rej) => {
    const tx = db.transaction('photos','readwrite');
    tx.objectStore('photos').put(dbRecord(photo));
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}

async function deletePhotoFromDB(id) {
  if (!db) return;
  return new Promise((res, rej) => {
    const tx = db.transaction('photos','readwrite');
    tx.objectStore('photos').delete(id);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}

async function loadPhotosFromDB() {
  if (!db) return [];
  return new Promise((res, rej) => {
    const tx  = db.transaction('photos','readonly');
    const req = tx.objectStore('photos').getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror   = () => rej(req.error);
  });
}

function releaseMedia(p) {
  if (p && p.type === 'video' && p.dataUrl && p.dataUrl.startsWith('blob:')) URL.revokeObjectURL(p.dataUrl);
}


/* ══════════════════════════════════════
   2. PWA — INSTALAÇÃO
══════════════════════════════════════ */
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  const el = document.getElementById('installBtn2');
  if (el) el.style.display = '';
});

function installPWA() {
  if (!deferredPrompt) { toast('📱 Use "Adicionar à tela inicial" no menu do navegador'); return; }
  deferredPrompt.prompt();
  deferredPrompt.userChoice.then(r => {
    if (r.outcome === 'accepted') toast('📲 App instalado!');
    deferredPrompt = null;
    const el = document.getElementById('installBtn2');
    if (el) el.style.display = 'none';
  });
}

/* Service Worker — CORREÇÃO: registrava 'sw.js', arquivo que não existia
   (erro 404 a cada carregamento e PWA nunca instalável). O arquivo agora
   existe; só registra em contexto seguro http(s). */
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service worker:', err));
  });
}


/* ══════════════════════════════════════
   3. TEMA CLARO / ESCURO
══════════════════════════════════════ */
function applyTheme() {
  document.body.classList.toggle('theme-dark',  isDark);
  document.body.classList.toggle('theme-light', !isDark);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', isDark ? '#0b0d12' : '#f2f4f8');
}
function toggleTheme() {
  isDark = !isDark;
  applyTheme();
  store.set('cs_theme', isDark ? 'dark' : 'light');
  toast(isDark ? '🌙 Tema Escuro' : '☀️ Tema Claro');
  /* gráficos usam cores do tema: redesenha se o dashboard estiver aberto */
  if (!document.getElementById('dashboardScreen').classList.contains('screen-hidden')) renderDashboard();
}

function loadTheme() {
  isDark = store.get('cs_theme', 'dark') === 'dark';
  applyTheme();
}


/* ══════════════════════════════════════
   4. INICIALIZAÇÃO
══════════════════════════════════════ */
window.addEventListener('DOMContentLoaded', async () => {
  loadTheme();
  galEmptyEl = document.getElementById('galEmpty');
  /* CORREÇÃO: estados iniciais coerentes com as variáveis (AF ligado,
     temporizador OFF) — antes os botões apareciam desmarcados. */
  document.getElementById('afBtn').classList.toggle('active', afEnabled);
  document.getElementById('ts0').classList.add('active');
  try { buildFilterUI(); buildFrameUI(); } catch (e) { console.error('Filtros/molduras:', e); }
  if (window.LinkScan) LinkScan.start();
  try {
    await initDB();
    const saved = await loadPhotosFromDB();
    photos = saved.sort((a,b) => b.id - a.id);
    photos.forEach(p => { if (p.type === 'video' && p.blob) p.dataUrl = URL.createObjectURL(p.blob); });
    photos = photos.filter(p => p.dataUrl);
    updateThumbFromPhotos();
  } catch(e) { console.warn('IndexedDB:', e); }

  // Pinch zoom e foco por toque
  const vf = document.getElementById('viewfinder');
  vf.addEventListener('touchstart', onPinchStart, { passive:true });
  vf.addEventListener('touchmove',  onPinchMove,  { passive:false });
  vf.addEventListener('click', onTapFocus);
  window.addEventListener('resize', onViewportResize);
  document.addEventListener('keydown', onKeyDown);
});

function onKeyDown(e) {
  if (e.key !== 'Escape') return;
  const help = document.getElementById('scanHelpModal');
  if (help && !help.classList.contains('hidden')) { Scan3D.hideHelp(); return; }
  if (!document.getElementById('webSheet').classList.contains('hidden')) return;   /* tratado pelo leitor de links */
  if (!document.getElementById('batchModal').classList.contains('hidden')) { closeBatchModal(); return; }
  if (!document.getElementById('editModal').classList.contains('hidden')) closeModal();
}

/* CORREÇÃO: miniatura não era limpa quando a última foto era excluída, e
   vídeos (blob de vídeo) eram atribuídos a um <img>, que não os exibe. */
function updateThumbFromPhotos() {
  const thumb = document.getElementById('lastThumb');
  const ph    = document.getElementById('thumbPlaceholder');
  const badge = document.getElementById('countBadge');
  const firstPhoto = photos.find(p => p.type !== 'video');
  if (firstPhoto) {
    thumb.src = firstPhoto.dataUrl;
    thumb.classList.remove('hidden');
    ph.style.display = 'none';
  } else {
    thumb.removeAttribute('src');
    thumb.classList.add('hidden');
    ph.style.display = '';
  }
  badge.classList.toggle('hidden', !photos.length);
  badge.textContent = photos.length;
}


/* ══════════════════════════════════════
   5. CÂMERA
══════════════════════════════════════ */
/* Mensagens claras para cada falha de getUserMedia */
function cameraErrorMessage(e) {
  const n = e && e.name;
  if (!window.isSecureContext && location.protocol !== 'file:') return 'A câmera só funciona em conexão segura (HTTPS) ou em localhost.';
  if (n === 'NotAllowedError' || n === 'PermissionDeniedError') return 'Permissão da câmera negada. Libere o acesso nas configurações do navegador (ícone de cadeado na barra de endereço) e tente novamente.';
  if (n === 'NotFoundError' || n === 'DevicesNotFoundError' || n === 'OverconstrainedError') return 'Nenhuma câmera compatível foi encontrada neste dispositivo.';
  if (n === 'NotReadableError' || n === 'TrackStartError') return 'A câmera está em uso por outro aplicativo. Feche-o e tente novamente.';
  if (n === 'SecurityError') return 'O navegador bloqueou o acesso à câmera por política de segurança.';
  if (n === 'AbortError') return 'O acesso à câmera foi interrompido. Tente novamente.';
  if (n === 'NotSupportedError' || n === 'TypeError') return 'Este navegador não oferece acesso à câmera. Use uma versão atual do Chrome, Edge, Safari ou Firefox.';
  return 'Não foi possível acessar a câmera' + (e && e.message ? ': ' + e.message : '.');
}

/* CORREÇÃO: antes pedia vídeo + áudio juntos; sem microfone (ou com o
   microfone negado) a câmera inteira falhava. Agora o áudio é opcional. */
async function openStream(front) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const err = new Error('getUserMedia indisponível'); err.name = window.isSecureContext ? 'NotSupportedError' : 'SecurityError'; throw err;
  }
  const video = { facingMode: { ideal: front ? 'user' : 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } };
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video, audio: true });
    hasAudio = s.getAudioTracks().length > 0;
    return s;
  } catch (e) {
    if (e && (e.name === 'NotAllowedError' || e.name === 'NotFoundError' || e.name === 'NotReadableError' || e.name === 'OverconstrainedError')) {
      const s = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      hasAudio = false;
      return s;
    }
    throw e;
  }
}

function showHomeError(msg) {
  const el = document.getElementById('homeError');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}

async function initCamera() {
  if (cameraBusy) return;
  cameraBusy = true;
  showHomeError('');
  try {
    stopStream();
    stream = await openStream(useFront);
    const video = document.getElementById('video');
    video.srcObject = stream;
    await video.play();

    hideAllScreens();
    document.getElementById('cameraScreen').classList.remove('screen-hidden');
    document.getElementById('statusDot').classList.add('active');
    detectFacing();
    applyVideoTransform();
    /* o visor só ganha tamanho depois que a tela aparece */
    requestAnimationFrame(resizeFxCanvas);
    applyLivePreview(currentFilter);
    applyContinuousAF();
    if (flashEnabled) applyTorch(true);
    if (zoomLevel !== 1) setZoom(zoomLevel);
    showPinchHint();
    toast(hasAudio ? t('cameraReady') : '📷 Câmera pronta (sem microfone — vídeos sem áudio)');
    if (currentMode === 'ar' && window.Scan3D) Scan3D.enter();
    if (currentMode === 'efeitos') startFx(currentFx);
    if (window.LinkScan) LinkScan.wake();
  } catch(e) {
    console.error('Câmera:', e);
    stopStream();
    showHomeError(cameraErrorMessage(e));
    toast('⚠️ Câmera indisponível');
  } finally { cameraBusy = false; }
}

/* Em notebooks/desktop facingMode é ignorado: espelha conforme a câmera real */
function detectFacing() {
  const tr = stream && stream.getVideoTracks()[0];
  const fm = tr && tr.getSettings ? tr.getSettings().facingMode : null;
  if (fm === 'user') useFront = true;
  else if (fm === 'environment') useFront = false;
}

function goHome() {
  cancelTimer();
  if (isRecording) stopRecording();
  if (window.Scan3D) Scan3D.release();
  stopFx(); stopStream();
  hideAllScreens();
  document.getElementById('homeScreen').style.display = '';
  document.getElementById('statusDot').classList.remove('active');
}

function stopStream() {
  if (window.GSFilters) GSFilters.stopPreview();
  if (stream) { stream.getTracks().forEach(tr => tr.stop()); stream = null; }
  const v = document.getElementById('video');
  if (v) v.srcObject = null;
}

async function flipCamera() {
  if (cameraBusy) return;
  if (isRecording) stopRecording();
  cameraBusy = true;
  const prev = useFront;
  useFront = !useFront;
  stopStream();
  try {
    stream = await openStream(useFront);
  } catch(e) {
    useFront = prev;
    try { stream = await openStream(useFront); }
    catch (e2) { cameraBusy = false; toast('⚠️ ' + cameraErrorMessage(e2)); return; }
    toast('Não há outra câmera disponível');
  }
  const v = document.getElementById('video');
  v.srcObject = stream;
  try { await v.play(); } catch (e) { /* autoplay já liberado pelo gesto */ }
  detectFacing();
  applyVideoTransform();
  applyLivePreview(currentFilter);
  applyContinuousAF();
  if (flashEnabled) applyTorch(true);
  if (zoomLevel !== 1) setZoom(zoomLevel);
  if (window.Scan3D) Scan3D.onCameraChanged();
  cameraBusy = false;
  toast(useFront ? '🤳 Câmera frontal' : '📷 Câmera traseira');
}

/* Espelhamento (frontal) + zoom digital num único transform */
function applyVideoTransform() {
  const v = document.getElementById('video');
  const z = hwZoom ? 1 : zoomLevel;
  v.style.transform = `scaleX(${useFront ? -1 : 1})` + (z !== 1 ? ` scale(${z})` : '');
  const fc = document.getElementById('filterCanvas');
  if (fc) fc.style.transform = v.style.transform;
}

/* Mapeamento pixel-do-vídeo → pixel-do-visor (object-fit: cover, espelho, zoom
   digital). Usado pela sobreposição AR e pela composição dos efeitos. */
function getVideoMapping() {
  const v = document.getElementById('video'), vf = document.getElementById('viewfinder');
  const vw = v.videoWidth, vh = v.videoHeight, W = vf.clientWidth, H = vf.clientHeight;
  if (!vw || !vh || !W || !H) return null;
  const s0 = Math.max(W / vw, H / vh);
  const z = hwZoom ? 1 : zoomLevel;
  const s = s0 * z;
  return { s, s0, ox: W / 2 - vw * s / 2, oy: H / 2 - vh * s / 2, ox0: (W - vw * s0) / 2, oy0: (H - vh * s0) / 2, W, H, vw, vh, mirror: useFront, zoom: z };
}

function openGalleryDirect() {
  galFrom = 'home';
  hideAllScreens();
  goGallery();
}

/* Telas */
const SCREENS = ['cameraScreen', 'galleryScreen', 'dashboardScreen', 'scanScreen'];
function hideAllScreens() {
  document.getElementById('homeScreen').style.display = 'none';
  SCREENS.forEach(id => { const el = document.getElementById(id); if (el) el.classList.add('screen-hidden'); });
}
function showScreen(id) {
  hideAllScreens();
  document.getElementById(id).classList.remove('screen-hidden');
  window.scrollTo(0, 0);
}
function returnToCamera() {
  if (window.LinkScan) setTimeout(() => LinkScan.wake(), 50);
  if (stream) showScreen('cameraScreen');
  else { hideAllScreens(); document.getElementById('homeScreen').style.display = ''; }
}

function onViewportResize() {
  resizeFxCanvas();
}


/* ══════════════════════════════════════
   6. FLASH / GRADE / AF
══════════════════════════════════════ */
function toggleFlash() {
  flashEnabled = !flashEnabled;
  const btn = document.getElementById('flashBtn');
  const svg = document.getElementById('flashSvg');
  btn.classList.toggle('active', flashEnabled);
  if (flashEnabled) {
    svg.innerHTML = '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor"/>';
    const ok = applyTorch(true);
    toast(ok ? '⚡ Lanterna ON' : '⚡ Flash de tela ON (sem lanterna nesta câmera)');
  } else {
    svg.innerHTML = '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/><line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" stroke-width="2"/>';
    applyTorch(false);
    toast('Flash OFF');
  }
}

function applyTorch(on) {
  if (!stream) return false;
  const track = stream.getVideoTracks()[0];
  if (!track) return false;
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  if (caps.torch) { track.applyConstraints({ advanced:[{ torch:on }] }).catch(()=>{}); return true; }
  return false;
}

function toggleGrid() {
  gridEnabled = !gridEnabled;
  document.getElementById('gridOverlay').classList.toggle('hidden', !gridEnabled);
  document.getElementById('gridBtn').classList.toggle('active', gridEnabled);
  toast(gridEnabled ? '📐 Grade ON' : 'Grade OFF');
}

function toggleAF() {
  afEnabled = !afEnabled;
  document.getElementById('afBtn').classList.toggle('active', afEnabled);
  updateAFBadge();
  if (afEnabled) { applyContinuousAF(); toast('🎯 Auto Foco ON'); }
  else toast('Foco manual');
}

/* CORREÇÃO: o selo "AF" ficava preso visível ao sair do modo Retrato para
   Vídeo/Noite (só o modo Foto o escondia). Agora segue uma regra única. */
function updateAFBadge() {
  document.getElementById('afBadge').classList.toggle('hidden', !(afEnabled && currentMode === 'retrato'));
}

function applyContinuousAF() {
  if (!stream || !afEnabled) return;
  const track = stream.getVideoTracks()[0];
  if (!track || !track.getCapabilities) return;
  const caps = track.getCapabilities();
  if (caps.focusMode && caps.focusMode.includes('continuous'))
    track.applyConstraints({ advanced:[{ focusMode:'continuous' }] }).catch(()=>{});
}

function onTapFocus(e) {
  if (currentMode === 'ar' || currentMode === 'efeitos') return;
  const vf = document.getElementById('viewfinder');
  const rect = vf.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  showFocusRing(x, y);
  applyPointFocus(x / rect.width, y / rect.height);
}

function showFocusRing(x, y) {
  const ring = document.getElementById('focusRing');
  ring.style.left = x + 'px'; ring.style.top = y + 'px';
  ring.classList.remove('show'); void ring.offsetWidth;
  ring.classList.add('show');
  clearTimeout(ring._t);
  ring._t = setTimeout(() => ring.classList.remove('show'), 1800);
}

/* CORREÇÃO: usava focusMode 'manual' (que exige focusDistance e falhava) e
   não espelhava X na câmera frontal. Usa 'single-shot' quando suportado. */
function applyPointFocus(nx, ny) {
  if (!stream) return;
  const track = stream.getVideoTracks()[0];
  if (!track || !track.getCapabilities) return;
  const caps = track.getCapabilities();
  if (!caps.focusMode) return;
  const x = useFront ? 1 - nx : nx;
  const mode = caps.focusMode.includes('single-shot') ? 'single-shot' : (caps.focusMode.includes('continuous') ? 'continuous' : null);
  if (!mode) return;
  track.applyConstraints({ advanced:[{ focusMode: mode, pointsOfInterest:[{ x, y: ny }] }] }).catch(()=>{});
  if (afEnabled && mode !== 'continuous') setTimeout(applyContinuousAF, 3000);
}


/* ══════════════════════════════════════
   7. ZOOM + PINCH
══════════════════════════════════════ */
function setZoom(val) {
  zoomLevel = Math.min(5, Math.max(1, parseFloat(val) || 1));
  document.getElementById('zoomPill').textContent = zoomLevel.toFixed(1) + '×';
  hwZoom = false;
  if (stream) {
    const track = stream.getVideoTracks()[0];
    if (track && track.getCapabilities) {
      const caps = track.getCapabilities();
      if (caps.zoom && caps.zoom.max > caps.zoom.min) {
        hwZoom = true;
        track.applyConstraints({ advanced:[{ zoom: Math.min(caps.zoom.max, Math.max(caps.zoom.min, zoomLevel)) }] }).catch(()=>{});
      }
    }
  }
  applyVideoTransform();
}

function resetZoom() {
  document.getElementById('zoomSlider').value = 1;
  setZoom(1);
}

function onPinchStart(e) {
  if (e.touches.length < 2) return;
  pinchStartDist = Math.hypot(
    e.touches[0].clientX - e.touches[1].clientX,
    e.touches[0].clientY - e.touches[1].clientY
  );
  pinchStartZoom = zoomLevel;
}

function onPinchMove(e) {
  if (e.touches.length < 2 || !pinchStartDist) return;
  if (currentMode === 'ar') return;            /* zoom travado durante o escaneamento 3D */
  e.preventDefault();
  const dist = Math.hypot(
    e.touches[0].clientX - e.touches[1].clientX,
    e.touches[0].clientY - e.touches[1].clientY
  );
  const newZoom = Math.min(5, Math.max(1, pinchStartZoom * (dist / pinchStartDist)));
  document.getElementById('zoomSlider').value = newZoom;
  setZoom(newZoom);
}

function showPinchHint() {
  const h = document.getElementById('pinchHint');
  h.classList.remove('hidden');
  setTimeout(() => h.classList.add('hidden'), 2500);
}


/* ══════════════════════════════════════
   8. EXPOSIÇÃO
══════════════════════════════════════ */
function toggleEvStrip() {
  evStripVisible = !evStripVisible;
  document.getElementById('evStrip').classList.toggle('hidden', !evStripVisible);
}

function setExposure(val) {
  evLevel = parseFloat(val) || 0;
  document.getElementById('evVal').textContent = evLevel > 0 ? '+'+evLevel.toFixed(1) : evLevel.toFixed(1);
  document.getElementById('evBadge').textContent = 'EV ' + (evLevel > 0 ? '+' : '') + evLevel.toFixed(1);
  document.getElementById('evBadge').classList.toggle('hidden', evLevel === 0);
  if (stream) {
    const track = stream.getVideoTracks()[0];
    if (!track || !track.getCapabilities) return;
    const caps = track.getCapabilities();
    if (caps.exposureCompensation) {
      const v = Math.min(caps.exposureCompensation.max, Math.max(caps.exposureCompensation.min, evLevel));
      track.applyConstraints({ advanced:[{ exposureCompensation: v }] }).catch(()=>{});
    }
  }
}


/* ══════════════════════════════════════
   9. TEMPORIZADOR
══════════════════════════════════════ */
function setTimerDelay(s) {
  timerDelay = s;
  document.querySelectorAll('.timer-sel').forEach(b => b.classList.remove('active'));
  document.getElementById('ts' + s).classList.add('active');
  if (s > 0) toast(`⏱️ Temporizador: ${s}s`);
}

/* CORREÇÃO: tocar no obturador durante a contagem criava um segundo
   setInterval (duas fotos); sair da câmera não cancelava a contagem. */
function cancelTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  const ov = document.getElementById('timerOverlay');
  if (ov) ov.classList.add('hidden');
}

function triggerCapture() {
  if (currentMode === 'ar') { if (window.Scan3D) Scan3D.shutter(); return; }
  if (currentMode === 'video' || currentMode === 'slowmo') { toggleRecording(); return; }
  if (timerInterval) { cancelTimer(); toast('⏱️ Temporizador cancelado'); return; }
  if (timerDelay === 0) { capture(); return; }
  let count = timerDelay;
  const overlay = document.getElementById('timerOverlay');
  const num     = document.getElementById('timerNumber');
  overlay.classList.remove('hidden');
  num.textContent = count;
  timerInterval = setInterval(() => {
    count--;
    if (count <= 0) {
      cancelTimer();
      capture();
    } else {
      num.textContent = count;
    }
  }, 1000);
}


/* ══════════════════════════════════════
   10. FILTROS
══════════════════════════════════════ */
/* Pré-visualização ao vivo dos filtros (CSS) — o processamento real
   por pixel continua sendo feito em applyFilter() na captura. */
const CSS_FILTER_PREVIEW = {
  none:       'none',
  vivid:      'saturate(1.7) contrast(1.12)',
  dramatic:   'contrast(1.5) grayscale(.18) brightness(.92)',
  noir:       'grayscale(1) contrast(1.3) brightness(.9)',
  silvertone: 'grayscale(.85) brightness(1.06) contrast(1.05)',
  fade:       'saturate(.65) brightness(1.15) contrast(.85)',
  chrome:     'saturate(1.1) contrast(1.15) brightness(1.05)',
  warm:       'sepia(.28) saturate(1.35) hue-rotate(-6deg)',
  cool:       'saturate(1.15) hue-rotate(9deg) brightness(1.03)',
  process:    'sepia(.25) saturate(1.5) hue-rotate(15deg)',
  tonal:      'grayscale(1) contrast(1.1)',
  transfer:   'sepia(.4) saturate(1.6) contrast(1.05)',
  sepia:      'sepia(.85)'
};

function setFilter(fx, el) {
  currentFilter = fx;
  document.querySelectorAll('.fi').forEach(f => f.classList.remove('active'));
  if (el) el.classList.add('active');
  applyLivePreview(fx);
  toast(t('filterApplied') + filterName(fx));
}

/* Prévia do filtro na câmera: CSS para os filtros originais; WebGL
   (resultado idêntico ao da foto) para os clássicos/modernos. */
function applyLivePreview(fx) {
  const video = document.getElementById('video');
  if (!video) return;
  if (window.GSFilters && GSFilters.has(fx)) {
    const ok = stream && GSFilters.startPreview(document.getElementById('filterCanvas'), video, fx);
    video.style.filter = ok ? 'none' : GSFilters.cssFallback(fx);
  } else {
    if (window.GSFilters) GSFilters.stopPreview();
    video.style.filter = CSS_FILTER_PREVIEW[fx] || 'none';
  }
}

function filterName(fx) {
  if (fx === 'none') return 'Normal';
  if (window.GSFilters && GSFilters.has(fx)) return GSFilters.get(fx).name;
  const el = document.querySelector(`.fi[data-f="${fx}"] span`);
  return el ? el.textContent : fx;
}

/* Miniaturas dos filtros: uma cena de exemplo processada pelo próprio
   filtro (antes eram quadrados cinza com CSS, quase iguais entre si). */
function sampleThumbCanvas() {
  const c = document.createElement('canvas'); c.width = c.height = 96;
  const x = c.getContext('2d', { willReadFrequently: true });
  const sky = x.createLinearGradient(0, 0, 0, 60); sky.addColorStop(0, '#3d7fd9'); sky.addColorStop(1, '#f2b880');
  x.fillStyle = sky; x.fillRect(0, 0, 96, 60);
  x.fillStyle = '#ffd36b'; x.beginPath(); x.arc(66, 40, 13, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#3f7a3a'; x.beginPath(); x.moveTo(0, 62); x.quadraticCurveTo(30, 40, 60, 60); x.quadraticCurveTo(80, 52, 96, 58); x.lineTo(96, 96); x.lineTo(0, 96); x.fill();
  x.fillStyle = '#2b5d8a'; x.fillRect(0, 74, 96, 22);
  x.fillStyle = '#d9483b'; x.fillRect(16, 52, 18, 16); x.fillStyle = '#f4f1ea'; x.fillRect(19, 56, 5, 5);
  x.fillStyle = 'rgba(255,255,255,.35)'; x.fillRect(0, 80, 96, 2);
  return c;
}

function buildFilterUI() {
  const strip = document.getElementById('filtersInner');
  if (window.GSFilters && strip && !strip.dataset.built) {
    strip.dataset.built = '1';
    const groups = [['classic', 'Clássicos'], ['modern', 'Modernos']];
    for (const [g, label] of groups) {
      const h = document.createElement('div'); h.className = 'fi-group'; h.textContent = label; h.setAttribute('aria-hidden', 'true');
      strip.appendChild(h);
      for (const d of GSFilters.DEFS.filter(f => f.group === g)) {
        const el = document.createElement('div');
        el.className = 'fi'; el.dataset.f = d.id; el.setAttribute('role', 'button'); el.tabIndex = 0;
        el.innerHTML = '<div class="ft"></div><span></span>';
        el.querySelector('span').textContent = d.name;
        el.onclick = () => setFilter(d.id, el);
        el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFilter(d.id, el); } };
        strip.appendChild(el);
      }
    }
    /* mesmos filtros na aba Efeitos do editor */
    const grid = document.querySelector('#panelEffects .fx-grid');
    for (const [g, label] of groups) {
      const h = document.createElement('div'); h.className = 'grid-group'; h.textContent = label; grid.appendChild(h);
      for (const d of GSFilters.DEFS.filter(f => f.group === g)) {
        const b = document.createElement('button'); b.className = 'btn fxchip'; b.dataset.e = d.id; b.textContent = d.name;
        b.onclick = () => applyEffect(d.id, b); grid.appendChild(b);
      }
    }
  }
  /* miniaturas reais para todos os filtros (originais + novos) */
  const base = sampleThumbCanvas();
  document.querySelectorAll('.fi').forEach(el => {
    const fx = el.dataset.f, c = document.createElement('canvas'); c.width = c.height = 96;
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(base, 0, 0);
    try { applyFilter(x, 96, 96, fx, 1); } catch (e) { /* mantém a cena original */ }
    const ft = el.querySelector('.ft');
    ft.style.backgroundImage = `url(${c.toDataURL('image/jpeg', .85)})`;
    ft.classList.add('has-thumb');
  });
}

function buildFrameUI() {
  if (!window.GSFrames) return;
  const grid = document.querySelector('#panelFrame .frame-grid');
  if (!grid || grid.dataset.built) return;
  grid.dataset.built = '1';
  const first = document.createElement('div'); first.className = 'grid-group'; first.textContent = 'Básicas';
  grid.insertBefore(first, grid.firstChild);
  for (const [g, label] of [['classic', 'Clássicas'], ['modern', 'Modernas']]) {
    const h = document.createElement('div'); h.className = 'grid-group'; h.textContent = label; grid.appendChild(h);
    for (const f of GSFrames.LIST.filter(x => x.group === g)) {
      const b = document.createElement('button'); b.className = 'btn frame-btn'; b.dataset.frame = f.id; b.textContent = f.name;
      b.onclick = () => applyFrame(f.id, b); grid.appendChild(b);
    }
  }
}

function applyFilter(ctx, w, h, fx, alpha) {
  if (fx === 'none' || !alpha) return;
  /* filtros clássicos/modernos: mesmo modelo da prévia WebGL (js/filters.js) */
  if (window.GSFilters && GSFilters.has(fx)) { GSFilters.apply(ctx, w, h, fx, alpha); return; }
  const id = ctx.getImageData(0, 0, w, h);
  const d  = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i+1], b = d[i+2];
    const lv = lum(r,g,b);
    let nr=r, ng=g, nb=b;
    switch(fx) {
      case 'vivid':      nr=cl(lv+(r-lv)*2.5); ng=cl(lv+(g-lv)*2.5); nb=cl(lv+(b-lv)*2.5); break;
      case 'dramatic':   nr=ng=nb=cl((lv-128)*1.8+128); break;
      case 'noir':       nr=ng=nb=cl(((lv-128)*2+128)*.82); break;
      case 'silvertone': nr=cl(lv*.97+8); ng=cl(lv*.97+8); nb=cl(lv*1.05+10); break;
      case 'fade':       nr=cl(r*.75+50); ng=cl(g*.75+42); nb=cl(b*.70+50); break;
      case 'chrome':     nr=cl(lv+(r-lv)*.4+20); ng=cl(lv+(g-lv)*.4+25); nb=cl(lv+(b-lv)*.4+50); break;
      case 'warm':       nr=cl(r*1.12+18); ng=cl(g*1.02+4); nb=cl(b*.82); break;
      case 'cool':       nr=cl(r*.82); ng=cl(g*1.0+4); nb=cl(b*1.18+22); break;
      case 'process':    nr=cl(r+10); ng=cl(g+18); nb=cl(b*.85+10); break;
      case 'tonal':      { const t2=lv/255; nr=cl(lv+(t2>.5?12:-12)); ng=cl(lv+(t2>.5?10:-10)); nb=cl(lv+(t2>.5?8:-8)); break; }
      case 'transfer':   nr=cl(r*.9+g*.1+15); ng=cl(g*.9+b*.1+5); nb=cl(b*.8+r*.2+20); break;
      case 'sepia':      nr=cl(r*.393+g*.769+b*.189); ng=cl(r*.349+g*.686+b*.168); nb=cl(r*.272+g*.534+b*.131); break;
    }
    d[i]=lerp(r,nr,alpha); d[i+1]=lerp(g,ng,alpha); d[i+2]=lerp(b,nb,alpha);
  }
  ctx.putImageData(id, 0, 0);
}

const lum  = (r,g,b) => 0.299*r+0.587*g+0.114*b;
const cl   = v => Math.max(0, Math.min(255, Math.round(v)));
const lerp = (a,b,t) => Math.round(a+(b-a)*t);


/* ══════════════════════════════════════
   11. MODOS (inclui as abas AR e Efeitos)
══════════════════════════════════════ */
function setMode(mode) {
  if (!MODE_LABELS[mode]) return;
  const prev = currentMode;
  cancelTimer();
  if (isRecording) stopRecording();
  currentMode = mode;
  document.querySelectorAll('.mode-btn').forEach(b => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    if (on) { const row=b.parentElement; row.scrollLeft = b.offsetLeft - row.clientWidth/2 + b.offsetWidth/2; }
  });
  document.getElementById('modeBadge').textContent = MODE_LABELS[mode];

  /* Abas independentes: Efeitos (sobreposições animadas) e AR (scanner 3D) */
  const isFx = mode === 'efeitos', isAR = mode === 'ar';
  document.getElementById('fxPanel').classList.toggle('hidden', !isFx);
  document.getElementById('fxBadge').classList.toggle('hidden', !isFx);
  document.getElementById('scanPanel').classList.toggle('hidden', !isAR);
  document.getElementById('arBadge').classList.toggle('hidden', !isAR);
  document.getElementById('cameraScreen').classList.toggle('mode-ar', isAR);
  document.getElementById('cameraScreen').classList.toggle('mode-fx', isFx);

  if (isFx) startFx(currentFx); else stopFx();
  if (prev === 'ar' && !isAR && window.Scan3D) Scan3D.exit();
  if (isAR) {
    if (window.Scan3D) Scan3D.enter();
    else toast('⚠️ Módulo de escaneamento 3D não carregado');
  }

  document.querySelector('.shutter').classList.remove('recording');
  updateAFBadge();
  if (window.LinkScan) LinkScan.wake();
  const msgs = {
    ar:'🔮 AR · Scanner 3D', efeitos:'✨ Efeitos ao vivo', noite:'🌙 Modo Noite', retrato:'🤳 Modo Retrato',
    video:'🎬 Toque para gravar', slowmo:'🐌 Slow Motion — Toque para gravar', foto:'📷 Modo Foto'
  };
  toast(msgs[mode]);
}


/* ══════════════════════════════════════
   12. GRAVAÇÃO DE VÍDEO
══════════════════════════════════════ */
function toggleRecording() {
  if (isRecording) stopRecording();
  else startRecording();
}

/* CORREÇÃO: forçava 'video/webm', que o Safari/iOS não grava; agora escolhe
   um formato suportado (webm ou mp4) e trata a ausência de MediaRecorder. */
function pickRecorderMime() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  const opts = ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm','video/mp4;codecs=avc1','video/mp4'];
  return opts.find(m => MediaRecorder.isTypeSupported(m)) || '';
}

function startRecording() {
  if (!stream) { toast('⚠️ Câmera não está ativa'); return; }
  if (!window.MediaRecorder) { toast('⚠️ Este navegador não grava vídeo'); return; }
  recordedChunks = [];
  recordMode = currentMode;     /* CORREÇÃO: o modo era lido só ao parar (podia já ter mudado) */
  const v = document.getElementById('video');
  recordSize = { w: v.videoWidth, h: v.videoHeight };

  if (currentMode === 'slowmo') {
    const track = stream.getVideoTracks()[0];
    if (track && track.getCapabilities) {
      const caps = track.getCapabilities();
      if (caps.frameRate && caps.frameRate.max >= 60)
        track.applyConstraints({ frameRate:{ ideal:Math.min(120, caps.frameRate.max) } }).catch(()=>{});
    }
  }

  const mime = pickRecorderMime();
  try {
    mediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  } catch(e) {
    try { mediaRecorder = new MediaRecorder(stream); }
    catch (e2) { toast('⚠️ Não foi possível iniciar a gravação'); return; }
  }
  recordMime = (mediaRecorder.mimeType || mime || 'video/webm').split(';')[0];

  mediaRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.onstop = saveVideo;
  mediaRecorder.onerror = e => { console.error('MediaRecorder:', e); toast('⚠️ Erro na gravação'); };
  mediaRecorder.start(250);
  isRecording = true;

  document.querySelector('.shutter').classList.add('recording');
  const badge = document.getElementById('recBadge');
  badge.innerHTML = '<span class="rec-dot"></span>REC 00:00';
  badge.classList.remove('hidden');
  recordSeconds = 0;
  recordTimer = setInterval(() => {
    recordSeconds++;
    badge.innerHTML =
      `<span class="rec-dot"></span>REC ${String(Math.floor(recordSeconds/60)).padStart(2,'0')}:${String(recordSeconds%60).padStart(2,'0')}`;
  }, 1000);
  toast(t('videoStart'));
}

function stopRecording() {
  if (!mediaRecorder || !isRecording) return;
  isRecording = false;
  try { mediaRecorder.stop(); } catch (e) { console.warn(e); }
  clearInterval(recordTimer);
  document.querySelector('.shutter').classList.remove('recording');
  document.getElementById('recBadge').classList.add('hidden');
  /* restaura a taxa de quadros normal após o slow-mo */
  const track = stream && stream.getVideoTracks()[0];
  if (track && recordMode === 'slowmo') track.applyConstraints({ frameRate:{ ideal:30 } }).catch(()=>{});
}

async function saveVideo() {
  if (!recordedChunks.length) { toast('⚠️ Nenhum dado de vídeo gravado'); return; }
  const blob = new Blob(recordedChunks, { type: recordMime });
  recordedChunks = [];
  const id   = Date.now();
  const photo = {
    id, blob, dataUrl: URL.createObjectURL(blob), type:'video', mode: recordMode, mime: recordMime,
    filter: currentFilter, w: recordSize.w || 1280, h: recordSize.h || 720, seconds: recordSeconds
  };
  photos.unshift(photo);
  savePhotoToDB(photo).catch(err => { console.warn('Vídeo não persistido:', err); toast('⚠️ Vídeo salvo só nesta sessão (armazenamento cheio?)'); });
  updateThumbFromPhotos();
  toast(t('videoStop'));
  renderGallery();
}


/* ══════════════════════════════════════
   13. EFEITOS AO VIVO (nova aba "Efeitos")
   Antes estes efeitos ficavam dentro da aba AR; agora têm aba própria
   e não interferem no scanner 3D (canvas, laço e estado separados).
══════════════════════════════════════ */
function resizeFxCanvas() {
  const vf = document.getElementById('viewfinder');
  const c  = document.getElementById('fxCanvas');
  if (!vf || !c) return;
  if (document.getElementById('cameraScreen').classList.contains('screen-hidden')) return;
  const w = vf.offsetWidth, h = vf.offsetHeight;
  if (!w || !h) { requestAnimationFrame(resizeFxCanvas); return; }
  if (c.width === w && c.height === h) return;
  c.width = w; c.height = h;
  /* Redimensionar o canvas limpa o conteúdo — reinicia a animação em andamento. */
  if (fxRunning) { stopFx(); startFx(currentFx); }
}

function setFx(type, el) {
  currentFx = type;
  document.querySelectorAll('.fx-opt').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
  if (el) { el.classList.add('active'); el.setAttribute('aria-pressed', 'true'); }
  stopFx(); resizeFxCanvas(); startFx(type);
}

function stopFx() {
  fxRunning = false;
  cancelAnimationFrame(fxAnimId);
  const c = document.getElementById('fxCanvas');
  if (c) c.getContext('2d').clearRect(0,0,c.width,c.height);
  fxParticles=[]; fxMatrix=[]; fxRain=[]; fxConfetti=[];
}

function startFx(type) {
  const canvas = document.getElementById('fxCanvas');
  if (!canvas || currentMode !== 'efeitos') return;
  if (!canvas.width || !canvas.height) {
    const vf = document.getElementById('viewfinder');
    if (vf && vf.offsetWidth) { canvas.width = vf.offsetWidth; canvas.height = vf.offsetHeight; }
    else { requestAnimationFrame(() => startFx(type)); return; }
  }
  cancelAnimationFrame(fxAnimId);
  fxRunning = true;
  const ctx = canvas.getContext('2d');
  const W=canvas.width, H=canvas.height;

  if (['particles','neon','bokeh','hearts','stars'].includes(type)) {
    const n = type==='bokeh'?22:(type==='hearts'||type==='stars')?15:55;
    fxParticles = Array.from({length:n},()=>({ x:Math.random()*W, y:Math.random()*H, vx:(Math.random()-.5)*1.2, vy:(Math.random()-.5)*1.2, size:Math.random()*(type==='bokeh'?44:14)+4, alpha:Math.random()*.7+.2, hue:Math.random()*360, phase:Math.random()*Math.PI*2 }));
  }
  if (type==='matrix') {
    const cols=Math.floor(W/14);
    fxMatrix=Array.from({length:cols},(_,i)=>({x:i*14,y:Math.random()*H,speed:Math.random()*3+1}));
  }
  if (type==='rain') {
    fxRain=Array.from({length:80},()=>({x:Math.random()*W,y:Math.random()*H,len:Math.random()*18+8,speed:Math.random()*5+3,alpha:Math.random()*.5+.2,hue:180+Math.random()*40}));
  }
  if (type==='confetti') {
    fxConfetti=Array.from({length:100},()=>({x:Math.random()*W,y:Math.random()*H-H,vx:(Math.random()-.5)*3,vy:Math.random()*4+2,rot:Math.random()*360,rotV:Math.random()*5-2.5,size:Math.random()*10+6,color:`hsl(${Math.random()*360},90%,65%)`}));
  }

  function loop(ts) {
    if (!fxRunning) return;
    /* Matrix usa rastro (fade) em vez de limpar o quadro */
    if (type !== 'matrix') ctx.clearRect(0,0,W,H);
    const tt=ts*.001;
    switch(type) {
      case 'grid':      drawFxGrid(ctx,W,H,tt);           break;
      case 'particles': drawFxParticles(ctx,W,H,tt);      break;
      case 'neon':      drawFxNeon(ctx,W,H,tt);           break;
      case 'bokeh':     drawFxBokeh(ctx,W,H,tt);          break;
      case 'matrix':    drawFxMatrix(ctx,W,H);            break;
      case 'hearts':    drawFxEmoji(ctx,W,H,tt,'❤️');     break;
      case 'stars':     drawFxEmoji(ctx,W,H,tt,'⭐');      break;
      case 'rain':      drawFxRain(ctx,W,H,tt);           break;
      case 'confetti':  drawFxConfetti(ctx,W,H);          break;
    }
    fxAnimId=requestAnimationFrame(loop);
  }
  fxAnimId=requestAnimationFrame(loop);
}

function drawFxGrid(ctx,W,H,t){
  ctx.strokeStyle=`rgba(245,166,35,${.18+Math.sin(t)*.06})`;ctx.lineWidth=.8;
  for(let x=0;x<W;x+=40){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
  for(let y=0;y<H;y+=40){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}
  const cx=W/2,cy=H/2,p=.5+Math.sin(t*2)*.2;
  ctx.strokeStyle=`rgba(0,229,255,${p})`;ctx.lineWidth=1.5;
  ctx.beginPath();ctx.arc(cx,cy,34,0,Math.PI*2);ctx.stroke();
}
function drawFxParticles(ctx,W,H,t){
  fxParticles.forEach(p=>{p.x+=p.vx;p.y+=p.vy;if(p.x<0)p.x=W;if(p.x>W)p.x=0;if(p.y<0)p.y=H;if(p.y>H)p.y=0;ctx.beginPath();ctx.arc(p.x,p.y,p.size/2,0,Math.PI*2);ctx.fillStyle=`hsla(${p.hue},100%,70%,${p.alpha*(.7+Math.sin(t+p.phase)*.3)})`;ctx.fill();});
}
function drawFxNeon(ctx,W,H,t){
  fxParticles.forEach(p=>{p.x+=p.vx;p.y+=p.vy;if(p.x<0)p.x=W;if(p.x>W)p.x=0;if(p.y<0)p.y=H;if(p.y>H)p.y=0;const a=Math.max(0,.4+Math.sin(t+p.phase)*.35),h=(p.hue+t*30)%360,g=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,p.size*2.5);g.addColorStop(0,`hsla(${h},100%,70%,${a})`);g.addColorStop(1,`hsla(${h},100%,50%,0)`);ctx.beginPath();ctx.arc(p.x,p.y,p.size*2.5,0,Math.PI*2);ctx.fillStyle=g;ctx.fill();});
}
function drawFxBokeh(ctx,W,H,t){
  fxParticles.forEach(p=>{p.x+=p.vx*.3;p.y+=p.vy*.3;if(p.x<-p.size)p.x=W+p.size;if(p.x>W+p.size)p.x=-p.size;if(p.y<-p.size)p.y=H+p.size;if(p.y>H+p.size)p.y=-p.size;const a=Math.max(0,.06+Math.sin(t+p.phase)*.05);ctx.beginPath();ctx.arc(p.x,p.y,p.size,0,Math.PI*2);ctx.strokeStyle=`hsla(${p.hue},80%,80%,${a*3})`;ctx.lineWidth=1.5;ctx.stroke();ctx.fillStyle=`hsla(${p.hue},80%,80%,${a})`;ctx.fill();});
}
/* CORREÇÃO: o efeito Matrix pintava preto translúcido sobre um canvas que
   nunca era limpo — em poucos segundos a câmera ficava totalmente coberta
   de preto. Agora o rastro é apagado com destination-out (canvas continua
   transparente sobre o vídeo). */
function drawFxMatrix(ctx,W,H){
  ctx.save();ctx.globalCompositeOperation='destination-out';ctx.fillStyle='rgba(0,0,0,0.12)';ctx.fillRect(0,0,W,H);ctx.restore();
  ctx.fillStyle='#0f0';ctx.font='13px monospace';
  fxMatrix.forEach(c=>{ctx.fillText(String.fromCharCode(0x30A0+Math.floor(Math.random()*96)),c.x,c.y);c.y+=c.speed*4;if(c.y>H+14)c.y=0;});
}
function drawFxEmoji(ctx,W,H,t,emoji){
  ctx.font='26px serif';
  fxParticles.forEach(p=>{p.y-=.6+p.vy*.2;p.x+=Math.sin(t*.8+p.phase)*.6;if(p.y<-30){p.y=H+30;p.x=Math.random()*W;}ctx.globalAlpha=Math.max(0,.5+Math.sin(t+p.phase)*.3);ctx.fillText(emoji,p.x,p.y);});
  ctx.globalAlpha=1;
}
function drawFxRain(ctx,W,H,t){
  fxRain.forEach(d=>{d.y+=d.speed*2;if(d.y>H+d.len)d.y=-d.len;ctx.strokeStyle=`hsla(${d.hue},80%,70%,${d.alpha*(.7+Math.sin(t+d.x)*.2)})`;ctx.lineWidth=1.2;ctx.beginPath();ctx.moveTo(d.x,d.y);ctx.lineTo(d.x-2,d.y+d.len);ctx.stroke();});
}
function drawFxConfetti(ctx,W,H){
  fxConfetti.forEach(c=>{c.x+=c.vx;c.y+=c.vy;c.rot+=c.rotV;if(c.y>H+10){c.y=-10;c.x=Math.random()*W;}ctx.save();ctx.translate(c.x,c.y);ctx.rotate(c.rot*Math.PI/180);ctx.fillStyle=c.color;ctx.fillRect(-c.size/2,-c.size/4,c.size,c.size/2);ctx.restore();});
}


/* ══════════════════════════════════════
   14. CAPTURA
══════════════════════════════════════ */
function capture() {
  const video  = document.getElementById('video');
  const canvas = document.getElementById('processCanvas');
  const vw=video.videoWidth, vh=video.videoHeight;
  if (!stream || !vw||!vh) { toast('⚠️ Câmera não pronta'); return; }

  canvas.width=vw; canvas.height=vh;
  const ctx=canvas.getContext('2d', { willReadFrequently:true });

  /* CORREÇÃO: com zoom digital (sem zoom de hardware) a prévia mostrava a
     imagem ampliada mas a foto saía sem zoom. Recorta a mesma região. */
  const z = hwZoom ? 1 : zoomLevel;
  const sw = vw / z, sh = vh / z, sx = (vw - sw) / 2, sy = (vh - sh) / 2;
  if (useFront) { ctx.translate(vw,0); ctx.scale(-1,1); }
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, vw, vh);
  ctx.setTransform(1,0,0,1,0,0);

  /* Modo Foto/Noite/Retrato: procura QR Code e link (https) na foto tirada */
  if (window.LinkScan && LinkScan.enabled && ['foto','noite','retrato'].includes(currentMode)) {
    const copy=document.createElement('canvas'); copy.width=vw; copy.height=vh;
    copy.getContext('2d').drawImage(canvas,0,0);
    setTimeout(()=>LinkScan.scanCapture(copy),50);
  }
  if (currentMode==='noite') {
    const id=ctx.getImageData(0,0,vw,vh);
    for(let i=0;i<id.data.length;i+=4){id.data[i]=cl(id.data[i]*1.4+18);id.data[i+1]=cl(id.data[i+1]*1.3+12);id.data[i+2]=cl(id.data[i+2]*1.2+8);}
    ctx.putImageData(id,0,0);
  }
  /* O filtro (como na prévia CSS) afeta só a imagem da câmera, não o efeito */
  applyFilter(ctx,vw,vh,currentFilter,1);
  /* CORREÇÃO: o efeito era esticado do tamanho do visor para o quadro
     inteiro do vídeo, ficando deslocado/deformado (o visor usa object-fit:
     cover e mostra só parte do quadro). Agora é posicionado sobre a mesma
     região visível — o resultado fica igual ao que se vê na tela. */
  if (fxRunning && currentMode === 'efeitos') {
    const fxc = document.getElementById('fxCanvas');
    const m = getVideoMapping();
    if (fxc && fxc.width && fxc.height && m) ctx.drawImage(fxc, -m.ox0 / m.s0, -m.oy0 / m.s0, m.W / m.s0, m.H / m.s0);
  }

  const dataUrl=canvas.toDataURL('image/jpeg',.93);
  const fl=document.getElementById('flashOverlay');
  fl.classList.add('flash'); setTimeout(()=>fl.classList.remove('flash'),350);

  const id=Date.now();
  const photo={ id, dataUrl, w:vw, h:vh, filter:currentFilter, mode:currentMode, fx: currentMode==='efeitos'?currentFx:undefined, type:'photo' };
  photos.unshift(photo);
  savePhotoToDB(photo).catch(err => { console.warn(err); toast('⚠️ Foto não salva no armazenamento local'); });

  updateThumbFromPhotos();
  toast(t('captured'));
  renderGallery();
}


/* ══════════════════════════════════════
   15. GALERIA
══════════════════════════════════════ */
function goGallery() {
  if (!galFrom) galFrom = 'camera';
  showScreen('galleryScreen');
  renderGallery();
}

function backToCamera() {
  if (selectMode) cancelSelectMode();
  if (galFrom === 'home') {
    galFrom = 'camera';
    if (stream) showScreen('cameraScreen');
    else { hideAllScreens(); document.getElementById('homeScreen').style.display = ''; }
  } else {
    returnToCamera();
  }
}

function galBack() { backToCamera(); }

function filterAlbum(filter, el) {
  albumFilter = filter;
  document.querySelectorAll('.album-chip').forEach(c => c.classList.remove('active'));
  if (el) el.classList.add('active');
  renderGallery();
}

/* CORREÇÃO (crítico): `grid.innerHTML=''` removia o elemento #galEmpty do
   DOM e em seguida `document.getElementById('galEmpty')` retornava null →
   appendChild(null) lançava TypeError sempre que a galeria ficava vazia
   (inclusive ao excluir a última foto). Agora a referência é guardada. */
function renderGallery() {
  const grid  = document.getElementById('galGrid');
  const count = document.getElementById('galCount');
  const list  = getFilteredPhotos();
  const nv = list.filter(p => p.type === 'video').length, np = list.length - nv;
  count.textContent = np + (np===1?' foto':' fotos') + (nv ? ` · ${nv} ${nv===1?'vídeo':'vídeos'}` : '');
  grid.innerHTML='';
  grid.classList.toggle('select-mode', selectMode);
  if (!list.length) {
    if (galEmptyEl) { galEmptyEl.style.display=''; grid.appendChild(galEmptyEl); }
    return;
  }
  list.forEach((p,idx)=>{
    const cell=document.createElement('div');
    cell.className='gal-cell'+(selectedIds.has(p.id)?' selected':'');
    cell.setAttribute('role','button');
    cell.tabIndex=0;
    const isVideo = p.type==='video';
    const media=document.createElement(isVideo?'video':'img');
    if (isVideo) { media.muted=true; media.playsInline=true; media.preload='metadata'; media.src=(p.dataUrl||'')+'#t=0.1'; }
    else { media.loading='lazy'; media.src=p.dataUrl||''; }
    media.setAttribute('aria-label', (isVideo?'vídeo ':'foto ')+(idx+1));

    const ov=document.createElement('div');
    ov.className='gal-cell-overlay';
    ov.textContent=(isVideo?'🎬 ':'')+(MODE_NAMES[p.mode]||'')+(p.filter&&p.filter!=='none'?' · '+filterName(p.filter):'');

    const check=document.createElement('div');
    check.className='gal-cell-check';
    check.textContent='✓';

    cell.appendChild(media); cell.appendChild(ov); cell.appendChild(check);
    const act=()=>{ if(selectMode) toggleSelect(p.id,cell); else openEditModal(photos.findIndex(x=>x.id===p.id)); };
    cell.onclick=act;
    cell.onkeydown=e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); act(); } };
    grid.appendChild(cell);
  });
}

function getFilteredPhotos() {
  if (albumFilter==='all') return photos;
  if (albumFilter==='video') return photos.filter(p => p.type==='video');
  if (albumFilter==='efeitos') return photos.filter(p => p.mode==='efeitos' || p.mode==='ar');   /* fotos antigas "AR" eram efeitos */
  if (albumFilter==='foto') return photos.filter(p => p.mode==='foto' && p.type!=='video');
  return photos.filter(p => p.mode===albumFilter);
}

/* Seleção múltipla */
function updateSelectedCount() {
  document.getElementById('selectedCount').textContent=selectedIds.size+' selecionado'+(selectedIds.size!==1?'s':'');
}
function toggleSelectMode() {
  selectMode=!selectMode;
  if (!selectMode) { selectedIds.clear(); }
  document.getElementById('selectModeBtn').classList.toggle('active',selectMode);
  document.getElementById('batchBar').classList.toggle('hidden',!selectMode);
  updateSelectedCount();
  renderGallery();
}
function cancelSelectMode() {
  selectMode=false; selectedIds.clear();
  document.getElementById('selectModeBtn').classList.remove('active');
  document.getElementById('batchBar').classList.add('hidden');
  updateSelectedCount();
  renderGallery();
}

function toggleSelect(id,cell) {
  if (selectedIds.has(id)) { selectedIds.delete(id); cell.classList.remove('selected'); }
  else { selectedIds.add(id); cell.classList.add('selected'); }
  updateSelectedCount();
}

function batchDelete() {
  if (!selectedIds.size) { toast('Selecione itens primeiro'); return; }
  if (!confirm(`Excluir ${selectedIds.size} item(ns)? Esta ação não pode ser desfeita.`)) return;
  selectedIds.forEach(id => {
    const idx=photos.findIndex(p=>p.id===id);
    if (idx!==-1) { releaseMedia(photos[idx]); photos.splice(idx,1); }
    deletePhotoFromDB(id).catch(()=>{});
  });
  cancelSelectMode();
  updateThumbFromPhotos();
  toast(t('deleted'));
}

function batchPDF() {
  if (!selectedIds.size) { toast('Selecione fotos primeiro'); return; }
  const n = photos.filter(p=>selectedIds.has(p.id) && p.type!=='video').length;
  if (!n) { toast('Vídeos não entram no PDF — selecione fotos'); return; }
  document.getElementById('batchInfo').textContent=n+(n===1?' foto selecionada':' fotos selecionadas')+(n<selectedIds.size?' (vídeos ignorados)':'');
  document.getElementById('batchModal').classList.remove('hidden');
}
function closeBatchModal() { document.getElementById('batchModal').classList.add('hidden'); }


/* ══════════════════════════════════════
   16. EXPORT EM LOTE PDF
══════════════════════════════════════ */
function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('Falha ao carregar imagem'));
    img.src = src;
  });
}

/* CORREÇÃO: no layout 2×2, se um grupo de 4 tivesse só vídeos, a página
   era refeita sem avançar o índice → laço infinito (travava o navegador).
   No layout 1 por página, um vídeo na 1ª posição gerava página em branco.
   Agora os vídeos são filtrados antes e o fluxo é sequencial (async). */
async function generateBatchPDF(layout) {
  const jsPDF = getJsPDF(); if (!jsPDF) return;
  const selected = photos.filter(p=>selectedIds.has(p.id) && p.type!=='video');
  if (!selected.length) { toast('Nenhuma foto selecionada'); return; }
  toast('📄 Gerando PDF...');
  try {
    const pdf=new jsPDF({orientation:'p',unit:'mm',format:'a4'});
    const pw=210,ph=297;
    if (layout==='onepage') {
      for (let i=0;i<selected.length;i++) {
        const img=await loadImage(selected[i].dataUrl);
        if (i>0) pdf.addPage();
        const ratio=Math.min((pw-20)/img.width,(ph-20)/img.height);
        const iw=img.width*ratio,ih=img.height*ratio;
        pdf.addImage(selected[i].dataUrl,'JPEG',(pw-iw)/2,(ph-ih)/2,iw,ih);
      }
    } else {
      for (let i=0;i<selected.length;i++) {
        const bi=i%4;
        if (i>0 && bi===0) pdf.addPage();
        const img=await loadImage(selected[i].dataUrl);
        const col=bi%2,row=Math.floor(bi/2);
        const cx=10+col*95,cy=10+row*138,cw=90,ch=133;
        const ratio=Math.min(cw/img.width,ch/img.height);
        const iw=img.width*ratio,ih=img.height*ratio;
        pdf.addImage(selected[i].dataUrl,'JPEG',cx+(cw-iw)/2,cy+(ch-ih)/2,iw,ih);
      }
    }
    pdf.save('GSLens-lote.pdf');
    closeBatchModal(); cancelSelectMode();
    toast('✅ PDF em lote salvo!');
  } catch (e) {
    console.error('PDF em lote:', e);
    toast('⚠️ Falha ao gerar o PDF');
  }
}


/* ══════════════════════════════════════
   17. MODAL EDIÇÃO
══════════════════════════════════════ */
function openEditModal(idx) {
  if (idx<0 || !photos[idx]) return;
  editingIdx=idx;
  _fxToken++;            /* cancela qualquer processamento pendente da foto anterior */
  const p=photos[idx];
  originalDataUrl=p.dataUrl;
  _fxCache={url:null,img:null};
  document.getElementById('editModal').classList.remove('hidden');
  const isVideo=p.type==='video';
  document.getElementById('modalImg').classList.toggle('hidden',isVideo);
  document.getElementById('modalVideo').classList.toggle('hidden',!isVideo);
  document.getElementById('editModal').classList.toggle('is-video',isVideo);
  if (isVideo) { document.getElementById('modalVideo').src=p.dataUrl; }
  else { document.getElementById('modalImg').src=originalDataUrl; }
  document.getElementById('modalMeta').textContent=p.w+'×'+p.h+(isVideo&&p.seconds?' · '+p.seconds+'s':'');
  document.getElementById('jpgLabel').textContent = isVideo ? 'Baixar vídeo' : 'Baixar JPG';
  resetEditState();
  openTab(isVideo?'export':'adjust',document.querySelector(`.etab[data-tab="${isVideo?'export':'adjust'}"]`));
  document.getElementById('aiResult').classList.add('hidden');
  clearDrawCanvas();
  setupCropEvents();
}

/* Zera sliders, efeito, moldura e balanço — sem re-renderizar */
function resetEditState() {
  ['slBrightness','slContrast','slSaturation','slSharpness','slBlur','slVignette'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=0; });
  ['vBrightness','vContrast','vSaturation','vSharpness','vBlur','vVignette'].forEach(id=>{ const el=document.getElementById(id); if(el) el.textContent=0; });
  currentEffect='none'; currentFrame='none'; wbGains=null;
  document.querySelectorAll('.fxchip').forEach(c=>c.classList.toggle('active', c.dataset.e==='none'));
  document.querySelectorAll('.frame-btn').forEach(c=>c.classList.toggle('active', c.dataset.frame==='none'));
  resetCropUI();
}

/* CORREÇÃO: fechar o modal deixava o vídeo tocando (com áudio) ao fundo
   e mantinha as edições pendentes. */
function closeModal() {
  flushSave();
  const mv=document.getElementById('modalVideo');
  mv.pause(); mv.removeAttribute('src'); mv.load();
  document.getElementById('editModal').classList.add('hidden');
  cleanupCropEvents(); cleanupDrawEvents(); clearDrawCanvas();
  editingIdx=-1;
}

function openTab(tab,el) {
  currentTab=tab;
  document.querySelectorAll('.etab').forEach(b=>{ b.classList.remove('active'); b.setAttribute('aria-selected','false'); });
  if(el){ el.classList.add('active'); el.setAttribute('aria-selected','true'); }
  const panelMap={adjust:'panelAdjust',effects:'panelEffects',crop:'panelCrop',draw:'panelDraw',text:'panelText',frame:'panelFrame',ai:'panelAI',export:'panelExport'};
  Object.values(panelMap).forEach(id=>document.getElementById(id).classList.add('hidden'));
  document.getElementById(panelMap[tab]).classList.remove('hidden');
  const cropOv=document.getElementById('cropOverlay');
  const drawCv=document.getElementById('drawCanvas');
  if(tab==='crop'){cropOv.classList.remove('hidden');drawCv.classList.add('hidden');}
  else if(tab==='draw'||tab==='text'){cropOv.classList.add('hidden');setupDrawCanvas(tab);drawCv.classList.remove('hidden');resetCropUI();}
  else{cropOv.classList.add('hidden');drawCv.classList.add('hidden');resetCropUI();}
}


/* ══════════════════════════════════════
   18. PIPELINE DE EDIÇÃO (Ajustes → Balanço → Efeito → Moldura)
   CORREÇÃO: antes os ajustes (brilho/contraste...) só mudavam a prévia e
   NUNCA eram salvos — o download/PDF/galeria saíam sem eles. Efeito e
   moldura também se anulavam (aplicar moldura apagava o efeito). Agora
   tudo é composto a partir da imagem original e salvo na foto.
   Também foi implementado o controle "Nitidez", que não fazia nada.
══════════════════════════════════════ */
let _fxCache = { url:null, img:null };
let _fxToken = 0;
let _saveTimer = null;

function carregarOrigemEfeito(url){
  return new Promise((resolve,reject)=>{
    if(_fxCache.url===url && _fxCache.img && _fxCache.img.complete && _fxCache.img.naturalWidth){
      resolve(_fxCache.img); return;
    }
    const img=new Image();
    img.onload =()=>{ _fxCache={url,img}; resolve(img); };
    img.onerror=()=>reject(new Error('Falha ao carregar a imagem de origem'));
    img.src=url;
  });
}

function readAdjust() {
  const g=id=>+document.getElementById(id).value;
  return { B:g('slBrightness'), C:g('slContrast'), S:g('slSaturation'), SH:g('slSharpness'), BL:g('slBlur'), V:g('slVignette') };
}

function liveAdjust() {
  ['Brightness','Contrast','Saturation','Sharpness','Blur','Vignette'].forEach(k=>{
    const el=document.getElementById('sl'+k);
    if(el) document.getElementById('v'+k).textContent=el.value;
  });
  /* agrupa os eventos do slider num único processamento por quadro */
  if(_adjPending) return;
  _adjPending=true;
  requestAnimationFrame(()=>{ _adjPending=false; renderEdits(); });
}
let _adjPending=false;

function renderEdits(doneMsg) {
  const p=photos[editingIdx]; if(!p||p.type==='video') return Promise.resolve();
  const meuToken=++_fxToken;
  const a=readAdjust(), fx=currentEffect, frame=currentFrame, wb=wbGains;
  return carregarOrigemEfeito(originalDataUrl).then(img=>{
    if(meuToken!==_fxToken) return;
    const W=img.naturalWidth, H=img.naturalHeight;
    const canvas=document.createElement('canvas');
    canvas.width=W; canvas.height=H;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    ctx.filter=a.BL>0?`blur(${a.BL}px)`:'none';
    ctx.drawImage(img,0,0);
    ctx.filter='none';
    if(a.B||a.C||a.S||wb) {
      const id=ctx.getImageData(0,0,W,H), d=id.data;
      const bv=a.B/255, cv=(a.C+100)/100, sf=(a.S+100)/100;
      const gr=wb?wb[0]:1, gg=wb?wb[1]:1, gb=wb?wb[2]:1;
      for(let i=0;i<d.length;i+=4){
        let r=d[i]*gr/255,g=d[i+1]*gg/255,b=d[i+2]*gb/255;
        r+=bv;g+=bv;b+=bv;
        r=(r-.5)*cv+.5;g=(g-.5)*cv+.5;b=(b-.5)*cv+.5;
        const lv2=r*.299+g*.587+b*.114;
        r=lv2+(r-lv2)*sf;g=lv2+(g-lv2)*sf;b=lv2+(b-lv2)*sf;
        d[i]=cl(r*255);d[i+1]=cl(g*255);d[i+2]=cl(b*255);
      }
      ctx.putImageData(id,0,0);
    }
    if(a.SH>0) applySharpen(ctx,W,H,a.SH/100);
    if(a.V>0) applyVignette(ctx,W,H,a.V/100);
    let out=canvas;
    if(fx!=='none') out=renderEffect(out,fx);
    if(frame!=='none') out=renderFrame(out,frame);
    if(meuToken!==_fxToken) return;
    p.dataUrl=out.toDataURL('image/jpeg',.93);
    p.w=out.width; p.h=out.height;
    document.getElementById('modalImg').src=p.dataUrl;
    document.getElementById('modalMeta').textContent=p.w+'×'+p.h;
    scheduleSave(p);
    if(doneMsg) toast(doneMsg);
  }).catch(err=>{
    console.error('Edição:',err);
    toast('⚠️ Não foi possível aplicar a edição');
  });
}

/* Salva com atraso (os sliders disparam dezenas de eventos por segundo) */
function scheduleSave(p) {
  clearTimeout(_saveTimer);
  _saveTimer=setTimeout(()=>{ _saveTimer=null; savePhotoToDB(p).catch(()=>{}); renderGallery(); updateThumbFromPhotos(); },350);
}
function flushSave() {
  if(_saveTimer){ clearTimeout(_saveTimer); _saveTimer=null; const p=photos[editingIdx]; if(p){ savePhotoToDB(p).catch(()=>{}); renderGallery(); updateThumbFromPhotos(); } }
}

/* Máscara de nitidez (unsharp) com kernel 3×3 */
function applySharpen(ctx,w,h,amount){
  const src=ctx.getImageData(0,0,w,h), s=src.data;
  const out=ctx.createImageData(w,h), d=out.data;
  const k=amount*1.5;
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      const i=(y*w+x)*4;
      if(x===0||y===0||x===w-1||y===h-1){ d[i]=s[i];d[i+1]=s[i+1];d[i+2]=s[i+2];d[i+3]=255; continue; }
      for(let c=0;c<3;c++){
        const v=s[i+c], blur=(s[i+c-4]+s[i+c+4]+s[i+c-w*4]+s[i+c+w*4])/4;
        d[i+c]=cl(v+(v-blur)*k);
      }
      d[i+3]=255;
    }
  }
  ctx.putImageData(out,0,0);
}

function applyVignette(ctx,w,h,strength){
  const grad=ctx.createRadialGradient(w/2,h/2,0,w/2,h/2,Math.max(w,h)*.7);
  grad.addColorStop(0,'transparent');
  grad.addColorStop(1,`rgba(0,0,0,${strength})`);
  ctx.fillStyle=grad; ctx.fillRect(0,0,w,h);
}

function resetAdjust() {
  ['slBrightness','slContrast','slSaturation','slSharpness','slBlur','slVignette'].forEach(id=>{
    const el=document.getElementById(id);if(el)el.value=0;
  });
  ['vBrightness','vContrast','vSaturation','vSharpness','vBlur','vVignette'].forEach(id=>{
    const el=document.getElementById(id);if(el)el.textContent=0;
  });
  wbGains=null;
  renderEdits();
}


/* ══════════════════════════════════════
   19. EFEITOS PÓS / MOLDURAS
══════════════════════════════════════ */
function applyEffect(fx,el) {
  const p=photos[editingIdx];
  if(!p||p.type==='video') return;
  currentEffect=fx;
  document.querySelectorAll('.fxchip').forEach(c=>c.classList.remove('active'));
  if(el) el.classList.add('active');
  return renderEdits(fx==='none'?null:'🎨 Efeito aplicado!');
}

function renderEffect(src,fx){
  const W=src.width,H=src.height;
  const canvas=document.createElement('canvas');
  canvas.width=W; canvas.height=H;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  if(fx==='whitebg'){
    ctx.drawImage(src,0,0);
    whitenBackground(ctx,W,H);
  } else if(fx==='bokeh'){
    const cv2=document.createElement('canvas');
    cv2.width=W; cv2.height=H;
    const c2=cv2.getContext('2d');
    c2.filter='blur(8px)';
    c2.drawImage(src,0,0);
    c2.filter='none';
    ctx.drawImage(cv2,0,0);
    const gr=ctx.createRadialGradient(W/2,H/2,0,W/2,H/2,Math.max(W,H)*.45);
    gr.addColorStop(0,'rgba(0,0,0,0)');
    gr.addColorStop(1,'rgba(0,0,0,.55)');
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(W/2,H/2,W*.36,H*.36,0,0,Math.PI*2);
    ctx.clip();
    ctx.drawImage(src,0,0);
    ctx.restore();
    ctx.fillStyle=gr; ctx.fillRect(0,0,W,H);
  } else {
    ctx.drawImage(src,0,0);
    applyFilter(ctx,W,H,fx,1);
  }
  return canvas;
}

/* Converte o fundo claro em branco puro, mantendo o conteúdo escuro
   (texto, objeto) em primeiro plano. Usado pelo efeito "Fundo Branco". */
function whitenBackground(ctx,w,h){
  const id=ctx.getImageData(0,0,w,h);
  const d=id.data;
  let soma=0,n=0;
  const passo=Math.max(1,Math.floor(w/100));
  for(let x=0;x<w;x+=passo){
    for(const y of [0,h-1]){
      const i=(y*w+x)*4;
      soma+=lum(d[i],d[i+1],d[i+2]); n++;
    }
  }
  for(let y=0;y<h;y+=passo){
    for(const x of [0,w-1]){
      const i=(y*w+x)*4;
      soma+=lum(d[i],d[i+1],d[i+2]); n++;
    }
  }
  const fundo=n?soma/n:200;
  const limite=Math.max(90,fundo-70);
  const suave=40;
  for(let i=0;i<d.length;i+=4){
    const lv=lum(d[i],d[i+1],d[i+2]);
    if(lv>=limite+suave){
      d[i]=d[i+1]=d[i+2]=255;
    } else if(lv>limite){
      const k=(lv-limite)/suave;
      d[i]=cl(d[i]+(255-d[i])*k);
      d[i+1]=cl(d[i+1]+(255-d[i+1])*k);
      d[i+2]=cl(d[i+2]+(255-d[i+2])*k);
    }
  }
  ctx.putImageData(id,0,0);
}

function applyFrame(frame,el) {
  const p=photos[editingIdx]; if(!p||p.type==='video') return;
  currentFrame=frame;
  document.querySelectorAll('.frame-btn').forEach(c=>c.classList.remove('active'));
  if(el) el.classList.add('active');
  return renderEdits(frame==='none'?null:t('frameApplied'));
}

/* CORREÇÃO: a moldura "Filme" desenhava os furos e DEPOIS pintava o fundo
   por cima (furos invisíveis); "Sombra" desenhava a foto duas vezes. */
function renderFrame(src,frame){
  if(window.GSFrames && GSFrames.has(frame)){
    const p=photos[editingIdx];
    const out=GSFrames.render(src,frame,{date:p?p.id:Date.now()});
    if(out) return out;
  }
  const iw=src.width,ih=src.height;
  const canvas=document.createElement('canvas');
  const pad=frame==='polaroid'?Math.round(iw*.08):Math.round(iw*.04);
  const bpad=frame==='polaroid'?Math.round(iw*.22):pad;
  canvas.width=iw+pad*2; canvas.height=ih+pad+bpad;
  const ctx=canvas.getContext('2d');
  const bg={white:'#fff',polaroid:'#fff',black:'#111',gold:'#f5a623',film:'#111',rounded:'#fff',shadow:'#fff'}[frame]||'#fff';
  ctx.fillStyle=bg;
  ctx.fillRect(0,0,canvas.width,canvas.height);
  if(frame==='film') applyFilmBorder(ctx,canvas.width,canvas.height,pad);
  if(frame==='rounded'){ctx.save();roundRect(ctx,pad,pad,iw,ih,iw*.06);ctx.clip();ctx.drawImage(src,pad,pad,iw,ih);ctx.restore();}
  else if(frame==='shadow'){ctx.shadowColor='rgba(0,0,0,.4)';ctx.shadowBlur=Math.max(12,iw*.02);ctx.shadowOffsetY=Math.max(4,iw*.007);ctx.drawImage(src,pad,pad,iw,ih);ctx.shadowColor='transparent';}
  else ctx.drawImage(src,pad,pad,iw,ih);
  return canvas;
}

function roundRect(ctx,x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.lineTo(x+w-r,y);ctx.arcTo(x+w,y,x+w,y+r,r);ctx.lineTo(x+w,y+h-r);ctx.arcTo(x+w,y+h,x+w-r,y+h,r);ctx.lineTo(x+r,y+h);ctx.arcTo(x,y+h,x,y+h-r,r);ctx.lineTo(x,y+r);ctx.arcTo(x,y,x+r,y,r);ctx.closePath();}

function applyFilmBorder(ctx,w,h,pad){
  const hole=Math.max(6,Math.round(pad*.45)), spacing=Math.round(hole*2.2);
  const x1=Math.round((pad-hole)/2), x2=w-pad+x1;
  ctx.fillStyle='#f5f5f5';
  for(let y=spacing/2;y<h-hole;y+=spacing){
    ctx.fillRect(x1,y,hole,hole); ctx.fillRect(x2,y,hole,hole);
  }
}


/* ══════════════════════════════════════
   20. RECORTE
══════════════════════════════════════ */
function setupCropEvents() {
  const overlay=document.getElementById('cropOverlay');
  overlay.addEventListener('mousedown',onCropDown);
  overlay.addEventListener('touchstart',onCropDownT,{passive:true});
  document.addEventListener('mousemove',onCropMove);
  document.addEventListener('touchmove',onCropMoveT,{passive:true});
  document.addEventListener('mouseup',onCropUp);
  document.addEventListener('touchend',onCropUp);
}
function cleanupCropEvents() {
  const overlay=document.getElementById('cropOverlay');
  overlay.removeEventListener('mousedown',onCropDown);
  overlay.removeEventListener('touchstart',onCropDownT);
  document.removeEventListener('mousemove',onCropMove);
  document.removeEventListener('touchmove',onCropMoveT);
  document.removeEventListener('mouseup',onCropUp);
  document.removeEventListener('touchend',onCropUp);
}
function getRelPos(e,el){const r=el.getBoundingClientRect(),cx=e.touches?e.touches[0].clientX:e.clientX,cy=e.touches?e.touches[0].clientY:e.clientY;return{x:cx-r.left,y:cy-r.top};}
function onCropDown(e){const p=getRelPos(e,document.getElementById('modalPreview'));cropState={down:true,sx:p.x,sy:p.y,ex:p.x,ey:p.y};document.getElementById('cropBox').classList.remove('visible');}
function onCropDownT(e){onCropDown(e);}
function onCropMove(e){if(!cropState.down)return;if(document.getElementById('cropOverlay').classList.contains('hidden'))return;if(e.touches&&!e.touches.length)return;const p=getRelPos(e,document.getElementById('modalPreview'));cropState.ex=p.x;cropState.ey=p.y;if(cropRatio.w&&cropRatio.h){const dw=p.x-cropState.sx,sign=Math.sign(p.y-cropState.sy)||1;cropState.ey=cropState.sy+sign*Math.abs(dw)/(cropRatio.w/cropRatio.h);}renderCropBox();}
function onCropMoveT(e){onCropMove(e);}
function onCropUp(){cropState.down=false;}
function renderCropBox(){const box=document.getElementById('cropBox');const x=Math.min(cropState.sx,cropState.ex),y=Math.min(cropState.sy,cropState.ey),w=Math.abs(cropState.ex-cropState.sx),h=Math.abs(cropState.ey-cropState.sy);box.style.cssText=`left:${x}px;top:${y}px;width:${w}px;height:${h}px`;box.classList.add('visible');}
function setCropRatio(w,h,silent){
  cropRatio={w,h};resetCropUI();
  document.querySelectorAll('.ratio-btn').forEach(b=>b.classList.toggle('active', b.dataset.ratio===`${w}:${h}`));
  if(!silent) toast(w===0?'Recorte livre':`Proporção ${w}:${h}`);
}
function resetCropUI(){cropState={down:false,sx:0,sy:0,ex:0,ey:0};const b=document.getElementById('cropBox');if(b){b.classList.remove('visible');b.style.cssText='';}}
function resetCrop(){resetCropUI();}

/* Retângulo do conteúdo visível da <img> (object-fit: contain) em relação ao
   contêiner #modalPreview, e a escala exibida/real. */
function imageContentRect(){
  const preview=document.getElementById('modalPreview'),img=document.getElementById('modalImg');
  const prevRect=preview.getBoundingClientRect(), imgRect=img.getBoundingClientRect();
  const scale=Math.min(imgRect.width/img.naturalWidth, imgRect.height/img.naturalHeight);
  const drawW=img.naturalWidth*scale, drawH=img.naturalHeight*scale;
  return { offX:(imgRect.left-prevRect.left)+(imgRect.width-drawW)/2, offY:(imgRect.top-prevRect.top)+(imgRect.height-drawH)/2, drawW, drawH, scale, prevRect };
}

/* Aplica um novo "original" (recorte/desenho/texto incorporados) e zera os
   ajustes para que não sejam aplicados duas vezes. */
function commitBaked(p,dataUrl,w,h,msg){
  _fxToken++;
  p.dataUrl=dataUrl; p.w=w; p.h=h;
  originalDataUrl=dataUrl;
  _fxCache={url:null,img:null};
  resetEditState();
  document.getElementById('modalImg').src=dataUrl;
  document.getElementById('modalMeta').textContent=w+'×'+h;
  savePhotoToDB(p).catch(()=>{});
  renderGallery(); updateThumbFromPhotos();
  toast(msg);
}

function applyCrop(){
  const p=photos[editingIdx];if(!p||p.type==='video')return;
  const img=document.getElementById('modalImg');
  if(!img.naturalWidth){toast('Imagem ainda carregando');return;}
  if(!document.getElementById('cropBox').classList.contains('visible')){toast('Arraste sobre a imagem para selecionar a área');return;}
  const r=imageContentRect();
  let sx=(Math.min(cropState.sx,cropState.ex)-r.offX)/r.scale;
  let sy=(Math.min(cropState.sy,cropState.ey)-r.offY)/r.scale;
  let sw=Math.abs(cropState.ex-cropState.sx)/r.scale;
  let sh=Math.abs(cropState.ey-cropState.sy)/r.scale;
  sx=Math.max(0,Math.min(sx,img.naturalWidth-1));
  sy=Math.max(0,Math.min(sy,img.naturalHeight-1));
  sw=Math.max(1,Math.min(sw,img.naturalWidth-sx));
  sh=Math.max(1,Math.min(sh,img.naturalHeight-sy));
  if(sw<10||sh<10){toast('Área muito pequena');return;}
  const canvas=document.createElement('canvas');
  canvas.width=Math.round(sw);canvas.height=Math.round(sh);
  canvas.getContext('2d').drawImage(img,sx,sy,sw,sh,0,0,canvas.width,canvas.height);
  commitBaked(p,canvas.toDataURL('image/jpeg',.93),canvas.width,canvas.height,t('cropApplied'));
}


/* ══════════════════════════════════════
   21. DESENHO E TEXTO
   CORREÇÃO: (1) a função que posiciona o texto nunca era ligada ao canvas —
   tocar na imagem na aba Texto não fazia nada (e desenhava traços);
   (2) o desenho era esticado do tamanho do contêiner para a foto,
   desalinhando quando a foto não preenchia o contêiner.
══════════════════════════════════════ */
function setupDrawCanvas(mode) {
  const preview=document.getElementById('modalPreview');
  const dc=document.getElementById('drawCanvas');
  const rect=preview.getBoundingClientRect();
  if(dc.width!==Math.round(rect.width)||dc.height!==Math.round(rect.height)){ dc.width=Math.round(rect.width); dc.height=Math.round(rect.height); }
  dc.dataset.mode=mode;
  dc.onclick = mode==='text' ? onTextPlace : null;
  dc.style.cursor = mode==='text' ? 'text' : 'crosshair';
  dc.removeEventListener('mousedown',onDrawStart);
  dc.removeEventListener('touchstart',onDrawStartT);
  dc.addEventListener('mousedown',onDrawStart);
  dc.addEventListener('touchstart',onDrawStartT,{passive:false});
  document.addEventListener('mousemove',onDrawMove);
  document.addEventListener('touchmove',onDrawMoveT,{passive:false});
  document.addEventListener('mouseup',onDrawEnd);
  document.addEventListener('touchend',onDrawEnd);
}
function cleanupDrawEvents() {
  document.removeEventListener('mousemove',onDrawMove);
  document.removeEventListener('touchmove',onDrawMoveT);
  document.removeEventListener('mouseup',onDrawEnd);
  document.removeEventListener('touchend',onDrawEnd);
  isDrawing=false;
}

function setDrawTool(tool,el) {
  drawTool=tool;
  document.querySelectorAll('.draw-tool').forEach(b=>b.classList.remove('active')); if(el) el.classList.add('active');
}

const isDrawMode=()=>document.getElementById('drawCanvas').dataset.mode==='draw';
function onDrawStart(e){if(!isDrawMode())return;isDrawing=true;lastDraw=getDrawPos(e);drawStroke(lastDraw,lastDraw);}
function onDrawStartT(e){if(!isDrawMode())return;e.preventDefault();isDrawing=true;lastDraw=getDrawPos(e.touches[0]);drawStroke(lastDraw,lastDraw);}
function onDrawMove(e){if(!isDrawing)return;const pos=getDrawPos(e);drawStroke(lastDraw,pos);lastDraw=pos;}
function onDrawMoveT(e){if(!isDrawing)return;e.preventDefault();const pos=getDrawPos(e.touches[0]);drawStroke(lastDraw,pos);lastDraw=pos;}
function onDrawEnd(){isDrawing=false;}

function getDrawPos(e){const dc=document.getElementById('drawCanvas'),r=dc.getBoundingClientRect();return{x:(e.clientX-r.left)*dc.width/r.width,y:(e.clientY-r.top)*dc.height/r.height};}

function drawStroke(from,to){
  const dc=document.getElementById('drawCanvas');
  const ctx=dc.getContext('2d');
  const size=+document.getElementById('brushSize').value;
  const color=document.getElementById('brushColor').value;
  ctx.lineWidth=size; ctx.lineCap='round'; ctx.lineJoin='round';
  if(drawTool==='eraser'){ctx.globalCompositeOperation='destination-out';ctx.strokeStyle='rgba(0,0,0,1)';}
  else{ctx.globalCompositeOperation='source-over';ctx.strokeStyle=color;}
  ctx.beginPath(); ctx.moveTo(from.x,from.y); ctx.lineTo(to.x+0.01,to.y); ctx.stroke();
  ctx.globalCompositeOperation='source-over';
}

function clearDraw(){clearDrawCanvas();}
function clearDrawCanvas(){const dc=document.getElementById('drawCanvas');if(dc)dc.getContext('2d').clearRect(0,0,dc.width,dc.height);}

function applyDraw(msg){
  const p=photos[editingIdx];if(!p||p.type==='video')return;
  const dc=document.getElementById('drawCanvas');
  const img=document.getElementById('modalImg');
  if(!img.naturalWidth){toast('Imagem ainda carregando');return;}
  const r=imageContentRect();
  const sxs=dc.width/r.prevRect.width, sys=dc.height/r.prevRect.height;
  const canvas=document.createElement('canvas');
  canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;
  const ctx=canvas.getContext('2d');
  ctx.drawImage(img,0,0);
  ctx.drawImage(dc, r.offX*sxs, r.offY*sys, r.drawW*sxs, r.drawH*sys, 0,0,canvas.width,canvas.height);
  clearDrawCanvas();
  commitBaked(p,canvas.toDataURL('image/jpeg',.93),canvas.width,canvas.height,msg||t('drawApplied'));
}

/* Texto: toque/clique posiciona o texto no canvas de pré-visualização */
function onTextPlace(e){
  const text=document.getElementById('textInput').value.trim();
  if(!text){toast('Digite o texto primeiro');document.getElementById('textInput').focus();return;}
  const pos=getDrawPos(e);
  const size=+document.getElementById('textSize').value;
  const color=document.getElementById('textColor').value;
  const font=document.getElementById('textFont').value;
  const ctx=document.getElementById('drawCanvas').getContext('2d');
  /* tamanho proporcional à imagem exibida (fica igual no arquivo final) */
  const r=imageContentRect();
  const px=Math.max(10,Math.round(size*Math.min(1,r.drawW/600)));
  ctx.font=`700 ${px}px "${font}", sans-serif`;
  ctx.fillStyle=color;
  ctx.textBaseline='middle';
  ctx.shadowColor='rgba(0,0,0,.5)';ctx.shadowBlur=4;
  ctx.fillText(text,pos.x,pos.y);
  ctx.shadowBlur=0;
  toast('Texto posicionado — toque em "Aplicar Texto" para salvar');
}

function applyText(){applyDraw(t('textApplied'));}
function clearText(){clearDrawCanvas();}


/* ══════════════════════════════════════
   22. ANÁLISE AUTOMÁTICA (local, no dispositivo)
   CORREÇÃO: antes estas ações eram simuladas — esperavam um tempo fixo e
   aplicavam valores pré-definidos, iguais para qualquer foto. Agora cada
   uma mede a imagem de verdade (histograma, médias por canal, energia de
   bordas) e calcula os ajustes a partir dela.
══════════════════════════════════════ */
async function analysisPixels(maxDim) {
  const img=await carregarOrigemEfeito(originalDataUrl);
  const sc=Math.min(1,(maxDim||256)/Math.max(img.naturalWidth,img.naturalHeight));
  const w=Math.max(1,Math.round(img.naturalWidth*sc)),h=Math.max(1,Math.round(img.naturalHeight*sc));
  const c=document.createElement('canvas');c.width=w;c.height=h;
  const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0,w,h);
  return { d:ctx.getImageData(0,0,w,h).data, w, h, sc };
}

async function aiAutoEnhance() {
  const p=photos[editingIdx];if(!p||p.type==='video')return;
  showAIResult('Analisando luminosidade, contraste e saturação...');
  try {
    const { d }=await analysisPixels(256);
    let s=0,s2=0,sat=0,n=0;
    for(let i=0;i<d.length;i+=4){
      const L=lum(d[i],d[i+1],d[i+2]);s+=L;s2+=L*L;n++;
      const mx=Math.max(d[i],d[i+1],d[i+2]),mn=Math.min(d[i],d[i+1],d[i+2]);sat+=mx?(mx-mn)/mx:0;
    }
    const mean=s/n,std=Math.sqrt(Math.max(0,s2/n-mean*mean)),ms=sat/n;
    const B=Math.round(Math.max(-40,Math.min(40,(118-mean)*0.6)));
    const C=Math.round(Math.max(-30,Math.min(45,(58/Math.max(8,std)-1)*55)));
    const S=Math.round(Math.max(-25,Math.min(45,(0.32/Math.max(0.05,ms)-1)*40)));
    document.getElementById('slBrightness').value=B;
    document.getElementById('slContrast').value=C;
    document.getElementById('slSaturation').value=S;
    liveAdjust();
    showAIResult(`✨ Medido: luminância média ${mean.toFixed(0)}, desvio ${std.toFixed(0)}, saturação ${(ms*100).toFixed(0)}% → brilho ${B>0?'+':''}${B}, contraste ${C>0?'+':''}${C}, saturação ${S>0?'+':''}${S}. Ajuste fino na aba Ajustes.`);
    toast(t('aiDone'));
  } catch(e){ console.error(e); showAIResult('⚠️ Não foi possível analisar a imagem.'); }
}

async function aiAutoCrop() {
  const p=photos[editingIdx];if(!p||p.type==='video')return;
  showAIResult('Detectando a área principal da cena (energia de bordas)...');
  try {
    const { d,w,h,sc }=await analysisPixels(320);
    const g=new Float32Array(w*h);
    for(let i=0;i<w*h;i++) g[i]=lum(d[4*i],d[4*i+1],d[4*i+2]);
    const colE=new Float64Array(w),rowE=new Float64Array(h);
    for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
      const i=y*w+x,e=Math.abs(g[i+1]-g[i-1])+Math.abs(g[i+w]-g[i-w]);
      colE[x]+=e;rowE[y]+=e;
    }
    const bounds=(arr,frac)=>{const tot=arr.reduce((a,b)=>a+b,0);let a=0,lo=0,hi=arr.length-1;
      while(lo<arr.length&&a+arr[lo]<tot*frac){a+=arr[lo];lo++;} a=0; while(hi>0&&a+arr[hi]<tot*frac){a+=arr[hi];hi--;} return [lo,Math.max(lo+1,hi)];};
    let [x0,x1]=bounds(colE,0.06),[y0,y1]=bounds(rowE,0.06);
    const padX=(x1-x0)*0.08,padY=(y1-y0)*0.08;
    x0=Math.max(0,x0-padX);x1=Math.min(w,x1+padX);y0=Math.max(0,y0-padY);y1=Math.min(h,y1+padY);
    /* abre a aba Recortar com a área sugerida desenhada, para o usuário confirmar */
    openTab('crop',document.querySelector('.etab[data-tab="crop"]'));
    setCropRatio(0,0,true);
    const r=imageContentRect(), k=r.scale/sc;
    cropState={down:false,sx:r.offX+x0*k,sy:r.offY+y0*k,ex:r.offX+x1*k,ey:r.offY+y1*k};
    renderCropBox();
    const pct=Math.round((x1-x0)*(y1-y0)/(w*h)*100);
    showAIResult(`📐 Área de interesse encontrada (${pct}% da foto). Ajuste se quiser e toque em "✓ Aplicar".`);
    toast('Enquadramento sugerido');
  } catch(e){ console.error(e); showAIResult('⚠️ Não foi possível analisar a imagem.'); }
}

async function aiColorBalance() {
  const p=photos[editingIdx];if(!p||p.type==='video')return;
  showAIResult('Analisando a temperatura de cor (mundo cinza)...');
  try {
    const { d }=await analysisPixels(256);
    let r=0,g=0,b=0,n=0;
    for(let i=0;i<d.length;i+=4){
      const L=lum(d[i],d[i+1],d[i+2]);
      if(L<20||L>240) continue;   /* ignora sombras e realces estourados */
      r+=d[i];g+=d[i+1];b+=d[i+2];n++;
    }
    if(!n){showAIResult('Imagem muito escura ou estourada para estimar o balanço.');return;}
    r/=n;g/=n;b/=n;
    const m=(r+g+b)/3;
    wbGains=[m/r,m/g,m/b].map(v=>Math.max(0.7,Math.min(1.4,v)));
    await renderEdits();
    showAIResult(`🎨 Médias R/G/B: ${r.toFixed(0)} / ${g.toFixed(0)} / ${b.toFixed(0)} → ganhos ${wbGains.map(v=>v.toFixed(2)).join(' / ')} (neutraliza o tom dominante).`);
    toast('Balanço de cores aplicado');
  } catch(e){ console.error(e); showAIResult('⚠️ Não foi possível analisar a imagem.'); }
}

async function aiRemoveBg() {
  const p=photos[editingIdx];if(!p||p.type==='video')return;
  showAIResult('Clareando o fundo (limiar adaptativo pelas bordas)...');
  await applyEffect('whitebg',document.querySelector('.fxchip[data-e="whitebg"]'));
  showAIResult('⬜ Fundo claro convertido em branco puro, preservando o conteúdo escuro. Ideal para documentos e objetos sobre fundo claro (processamento local, sem envio da foto).');
}

/* Lê QR Code ou link impresso numa foto da galeria e abre no mini navegador */
async function aiScanLinks() {
  const p=photos[editingIdx];if(!p||p.type==='video')return;
  if(!window.LinkScan){showAIResult('⚠️ Leitor de links indisponível.');return;}
  try {
    const img=await loadImage(p.dataUrl);
    const r=await LinkScan.scanImage(img,msg=>showAIResult('🔎 '+msg));
    if(!r.parsed){showAIResult('Nenhum QR Code ou link encontrado nesta foto.'+(r.text&&r.text.trim()?' Texto lido: "'+r.text.trim().slice(0,140)+'"':''));return;}
    const extra=r.all&&r.all.length>1?' (outros: '+r.all.slice(1).join(', ')+')':'';
    showAIResult('🔗 '+r.source+' encontrado'+(r.parsed.url?': '+r.parsed.url:'')+extra);
    LinkScan.open(r.parsed,r.source);
  } catch(e){ console.error(e); showAIResult('⚠️ '+(e.message||'Falha na leitura')); }
}

function showAIResult(msg){
  const r=document.getElementById('aiResult');
  r.classList.remove('hidden');
  document.getElementById('aiResultText').textContent=msg;
}


/* ══════════════════════════════════════
   WEB SHARE API
══════════════════════════════════════ */
async function shareItem(p) {
  if(!p){toast('Nada para compartilhar');return;}
  if(!navigator.share){toast(t('noShare'));return;}
  try {
    const blob = p.type==='video' && p.blob ? p.blob : await (await fetch(p.dataUrl)).blob();
    const ext = p.type==='video' ? ((p.mime||blob.type||'').includes('mp4')?'mp4':'webm') : 'jpg';
    const file=new File([blob],`GSLens-${p.id}.${ext}`,{type:blob.type||(p.type==='video'?'video/webm':'image/jpeg')});
    if(navigator.canShare && !navigator.canShare({files:[file]})){toast(t('noShare'));return;}
    await navigator.share({title:'GSLens.AI',files:[file]});
    toast('📤 Compartilhado!');
  } catch(e) { if(e.name!=='AbortError'){ console.warn(e); toast('Erro ao compartilhar'); } }
}
function sharePhoto() { flushSave(); shareItem(photos[editingIdx]); }
function shareLastPhoto() {
  if(!photos.length){toast('Nenhuma foto capturada');return;}
  shareItem(photos[0]);
}


/* ══════════════════════════════════════
   EXPORTAR
══════════════════════════════════════ */
/* CORREÇÃO: "PDF + Fundo Branco" pintava branco e desenhava a foto opaca
   por cima — o resultado era idêntico ao PDF normal. Agora aplica o mesmo
   algoritmo real de fundo branco. */
async function exportPDF(addWhiteBg) {
  const p=photos[editingIdx];if(!p||p.type==='video'){toast('Vídeos não podem ser exportados como PDF');return;}
  const jsPDF=getJsPDF(); if(!jsPDF) return;
  flushSave();
  toast('📄 Gerando PDF...');
  try {
    const img=await loadImage(p.dataUrl);
    const landscape=img.width>img.height;
    const pdf=new jsPDF({orientation:landscape?'l':'p',unit:'mm',format:'a4'});
    const pw=landscape?297:210,ph=landscape?210:297;
    let src=p.dataUrl;
    if(addWhiteBg){
      const c2=document.createElement('canvas');c2.width=img.width;c2.height=img.height;
      const ctx2=c2.getContext('2d',{willReadFrequently:true});ctx2.drawImage(img,0,0);
      whitenBackground(ctx2,c2.width,c2.height);
      src=c2.toDataURL('image/jpeg',.95);
    }
    const ratio=Math.min((pw-20)/img.width,(ph-20)/img.height);
    const iw=img.width*ratio,ih=img.height*ratio;
    pdf.addImage(src,'JPEG',(pw-iw)/2,(ph-ih)/2,iw,ih);
    pdf.save(`GSLens-${p.id}.pdf`);
    toast(t('pdfSaved'));
  } catch(e){ console.error('PDF:',e); toast('⚠️ Falha ao gerar o PDF'); }
}

function downloadJPG() {
  const p=photos[editingIdx];if(!p)return;
  flushSave();
  const a=document.createElement('a');
  if(p.type==='video'){
    const ext=(p.mime||'').includes('mp4')?'mp4':'webm';
    a.href=p.dataUrl;a.download=`GSLens-${p.id}.${ext}`;document.body.appendChild(a);a.click();a.remove();toast('⬇️ Vídeo salvo!');return;
  }
  a.href=p.dataUrl;a.download=`GSLens-${p.id}.jpg`;document.body.appendChild(a);a.click();a.remove();toast(t('jpgSaved'));
}

function deletePhoto() {
  if(editingIdx<0||!photos[editingIdx])return;
  if(!confirm('Excluir este item? Esta ação não pode ser desfeita.')) return;
  clearTimeout(_saveTimer); _saveTimer=null;
  const p=photos[editingIdx];
  photos.splice(editingIdx,1);
  deletePhotoFromDB(p.id).catch(()=>{});
  closeModal();
  releaseMedia(p);
  renderGallery();
  updateThumbFromPhotos();
  toast(t('deleted'));
}


/* ══════════════════════════════════════
   DASHBOARD / ESTATÍSTICAS
══════════════════════════════════════ */
let dashFrom = 'home';
function openDashboard() {
  dashFrom = document.getElementById('cameraScreen').classList.contains('screen-hidden') ? 'home' : 'camera';
  showScreen('dashboardScreen');
  renderDashboard();
}

function closeDashboard() {
  dashCharts.forEach(c=>c.destroy()); dashCharts=[];
  if(dashFrom==='camera' && stream) showScreen('cameraScreen');
  else { hideAllScreens(); document.getElementById('homeScreen').style.display=''; }
}

function renderDashboard() {
  const body=document.getElementById('dashboardBody');
  dashCharts.forEach(c=>c.destroy()); dashCharts=[];
  const total=photos.length;
  const videos=photos.filter(p=>p.type==='video').length;

  const filterCounts={};
  photos.forEach(p=>{const k=p.filter||'none';filterCounts[k]=(filterCounts[k]||0)+1;});
  const topFilters=Object.entries(filterCounts).sort((a,b)=>b[1]-a[1]).slice(0,5);

  const modeCounts={};
  photos.forEach(p=>{const k=MODE_NAMES[p.mode==='ar'?'efeitos':p.mode]||p.mode||'Foto';modeCounts[k]=(modeCounts[k]||0)+1;});

  /* CORREÇÃO: agrupava por dia da semana ("seg", "ter"...), somando fotos de
     semanas anteriores ao dia atual. Agora usa a data completa. */
  const days=[];
  const today=new Date(); today.setHours(0,0,0,0);
  for(let i=6;i>=0;i--){const d=new Date(today);d.setDate(d.getDate()-i);days.push({key:d.toDateString(),label:d.toLocaleDateString('pt-BR',{weekday:'short',day:'2-digit'}),n:0});}
  photos.forEach(p=>{const k=new Date(p.id).toDateString();const day=days.find(d=>d.key===k);if(day)day.n++;});

  body.innerHTML=`
    <div class="stat-cards">
      <div class="stat-card"><div class="stat-num">${total}</div><div class="stat-lbl">Total de itens</div></div>
      <div class="stat-card"><div class="stat-num">${total-videos}</div><div class="stat-lbl">Fotos</div></div>
      <div class="stat-card"><div class="stat-num">${videos}</div><div class="stat-lbl">Vídeos</div></div>
      <div class="stat-card"><div class="stat-num">${Object.keys(filterCounts).filter(k=>k!=='none').length}</div><div class="stat-lbl">Filtros usados</div></div>
    </div>
    <div class="chart-card">
      <h4>📅 Capturas por dia (últimos 7 dias)</h4>
      <div class="chart-wrap"><canvas id="chartDays"></canvas></div>
    </div>
    <div class="chart-card">
      <h4>🎨 Filtros mais usados</h4>
      <div class="chart-wrap"><canvas id="chartFilters"></canvas></div>
    </div>
    <div class="chart-card">
      <h4>📷 Modos de captura</h4>
      <div class="chart-wrap"><canvas id="chartModes"></canvas></div>
    </div>
  `;

  /* CORREÇÃO: sem Chart.js (offline) a tela quebrava com ReferenceError */
  if(typeof window.Chart==='undefined'){
    const list=(title,entries)=>`<ul class="dash-list">${entries.map(([k,v])=>`<li><span>${k}</span><strong>${v}</strong></li>`).join('')||'<li><span>Sem dados</span></li>'}</ul>`;
    body.querySelectorAll('.chart-wrap')[0].outerHTML=list('',days.map(d=>[d.label,d.n]));
    body.querySelectorAll('.chart-wrap')[0].outerHTML=list('',topFilters);
    body.querySelectorAll('.chart-wrap')[0].outerHTML=list('',Object.entries(modeCounts));
    body.insertAdjacentHTML('beforeend','<p class="text-muted small">Gráficos indisponíveis (biblioteca de gráficos não carregou — verifique a conexão). Exibindo os dados em lista.</p>');
    return;
  }
  const txt=isDark?'#f0f0ff':'#1a1a2e', tick=isDark?'#8b93a7':'#444', gridc=isDark?'rgba(255,255,255,.06)':'rgba(0,0,0,.06)';
  const chartOpts={responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:txt,font:{size:11}}}}};
  try {
    dashCharts.push(new Chart(document.getElementById('chartDays'),{type:'bar',data:{labels:days.map(d=>d.label),datasets:[{label:'Capturas',data:days.map(d=>d.n),backgroundColor:'rgba(0,229,255,.6)',borderColor:'rgba(0,229,255,1)',borderWidth:1,borderRadius:4}]},options:{...chartOpts,scales:{y:{beginAtZero:true,ticks:{color:tick,precision:0},grid:{color:gridc}},x:{ticks:{color:tick},grid:{display:false}}}}}));
    dashCharts.push(new Chart(document.getElementById('chartFilters'),{type:'doughnut',data:{labels:topFilters.map(f=>f[0]==='none'?'original':f[0]),datasets:[{data:topFilters.map(f=>f[1]),backgroundColor:['rgba(0,229,255,.8)','rgba(245,166,35,.8)','rgba(50,215,75,.8)','rgba(255,69,58,.8)','rgba(160,100,255,.8)']}]},options:chartOpts}));
    dashCharts.push(new Chart(document.getElementById('chartModes'),{type:'polarArea',data:{labels:Object.keys(modeCounts),datasets:[{data:Object.values(modeCounts),backgroundColor:['rgba(0,229,255,.6)','rgba(245,166,35,.6)','rgba(50,215,75,.6)','rgba(255,69,58,.6)','rgba(10,132,255,.6)','rgba(160,100,255,.6)']}]},options:{...chartOpts,scales:{r:{ticks:{color:tick,backdropColor:'transparent',precision:0},grid:{color:gridc}}}}}));
  } catch(e){ console.error('Gráficos:',e); }
}


/* ══════════════════════════════════════
   TOAST
══════════════════════════════════════ */
function toast(msg) {
  const el=document.getElementById('toast');
  if(!el||!msg) return;
  el.textContent=msg;el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>el.classList.remove('show'),2600);
}


/* ══════════════════════════════════════
   PONTE PARA O MÓDULO AR / SCANNER 3D (js/scan3d/app.js)
══════════════════════════════════════ */
window.GSApp = {
  getStream: () => stream,
  getVideoMapping,
  resetZoom,
  toast,
  showScreen,
  returnToCamera,
  getMode: () => currentMode,
  setMode
};
