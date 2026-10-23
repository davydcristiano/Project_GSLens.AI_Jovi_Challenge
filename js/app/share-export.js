/* GSLens.AI — js/app/share-export.js
   Compartilhar (Web Share) e exportar (JPG/PDF).
   Scripts clássicos carregados em ordem pelo index.html; compartilham o
   escopo global (estado em core.js). */
'use strict';

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
