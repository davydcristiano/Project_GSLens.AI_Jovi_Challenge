/* GSLens.AI — js/app/gallery.js
   Galeria, álbuns, seleção múltipla e PDF em lote.
   Scripts clássicos carregados em ordem pelo index.html; compartilham o
   escopo global (estado em core.js). */
'use strict';

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
