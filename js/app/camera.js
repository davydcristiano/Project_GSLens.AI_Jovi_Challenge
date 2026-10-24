/* GSLens.AI — js/app/camera.js
   Câmera: abertura do stream, flash/grade/AF, zoom e pinça, exposição, temporizador.
   Scripts clássicos carregados em ordem pelo index.html; compartilham o
   escopo global (estado em core.js). */
'use strict';

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
  const facing = front ? 'user' : 'environment';
  const video = { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } };
  /* Traseira: pede "exact" primeiro — com "ideal" alguns celulares ainda
     abriam a frontal. Sem câmera traseira (notebook), cai para o "ideal". */
  if (!front) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: Object.assign({}, video, { facingMode: { exact: 'environment' } }), audio: true });
      hasAudio = s.getAudioTracks().length > 0;
      return s;
    } catch (e) {
      if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
        /* microfone negado: tenta só vídeo, ainda com a traseira */
        try { const s = await navigator.mediaDevices.getUserMedia({ video: Object.assign({}, video, { facingMode: { exact: 'environment' } }), audio: false }); hasAudio = false; return s; }
        catch (e2) { if (e2 && e2.name === 'NotAllowedError') throw e2; }
      }
      /* OverconstrainedError/NotFoundError: não há traseira — segue abaixo */
    }
  }
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
    /* DESEMPENHO: prepara o WebGL dos filtros quando o aparelho estiver ocioso */
    if (window.GSFilters && GSFilters.prewarm) {
      const pw = () => GSFilters.prewarm(document.getElementById('filterCanvas'));
      if (window.requestIdleCallback) requestIdleCallback(pw, { timeout: 3000 }); else setTimeout(pw, 1500);
    }
    toast(hasAudio ? t('cameraReady') : '📷 Câmera pronta (sem microfone — vídeos sem áudio)');
    if (currentMode === 'ar' && window.Scan3D) Scan3D.enter();
    if (currentMode === 'efeitos') startFx(currentFx);
    if (currentMode === 'noite') startNightPreview();
    if (currentMode === 'retrato') startPortraitPreview();
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
  stopFx(); stopNightPreview(); stopPortraitPreview(); stopStream();
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
  if (currentMode === 'noite') setTrackExposure(Math.max(evLevel, 1.5));
  cameraBusy = false;
  toast(useFront ? '🤳 Câmera frontal' : '📷 Câmera traseira');
}

/* Espelhamento (frontal) + zoom digital num único transform */
function applyVideoTransform() {
  const v = document.getElementById('video');
  const z = hwZoom ? 1 : zoomLevel;
  v.style.transform = `scaleX(${useFront ? -1 : 1})` + (z !== 1 ? ` scale(${z})` : '');
  for (const id of ['filterCanvas', 'liveCanvas']) {
    const c = document.getElementById(id);
    if (c) c.style.transform = v.style.transform;
  }
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
const SCREENS = ['cameraScreen', 'galleryScreen', 'dashboardScreen', 'scanScreen', 'reelScreen'];
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
