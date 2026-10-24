/* GSLens.AI — js/app/main.js
   Inicialização do app e ponte para o módulo AR / Scanner 3D.
   Scripts clássicos carregados em ordem pelo index.html; compartilham o
   escopo global (estado em core.js). */
'use strict';

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
  if (window.WText && WText.isComposing()) { WText.done(); return; }
  if (typeof exportMenuOpen==='function' && exportMenuOpen()) return;   /* tratado pelo menu Export */   /* Esc conclui o texto em edição */
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
