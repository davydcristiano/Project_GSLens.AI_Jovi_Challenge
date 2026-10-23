/* GSLens.AI — js/app/modes.js
   Modos da câmera (Noite, Retrato, Foto, Vídeo, Slow-Mo, Efeitos, AR).
   Scripts clássicos carregados em ordem pelo index.html; compartilham o
   escopo global (estado em core.js). */
'use strict';

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
  if (mode === 'noite') startNightPreview();
  else if (prev === 'noite') { stopNightPreview(); setTrackExposure(evLevel); }
  if (mode === 'retrato') startPortraitPreview();
  else if (prev === 'retrato') stopPortraitPreview();
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
