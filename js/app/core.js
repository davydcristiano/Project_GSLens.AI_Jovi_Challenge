/* GSLens.AI — js/app/core.js
   Núcleo: estado global, utilitários, armazenamento (IndexedDB), PWA, tema e avisos (toast).
   Scripts clássicos carregados em ordem pelo index.html; compartilham o
   escopo global (estado em core.js). */
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
let useFront       = false;   /* abre com a câmera TRASEIRA */
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
