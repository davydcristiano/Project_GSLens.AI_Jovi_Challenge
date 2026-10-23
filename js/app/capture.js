/* GSLens.AI — js/app/capture.js
   Captura de fotos (inclui o empilhamento do modo Noite).
   Scripts clássicos carregados em ordem pelo index.html; compartilham o
   escopo global (estado em core.js). */
'use strict';

/* ══════════════════════════════════════
   14. CAPTURA
══════════════════════════════════════ */
async function capture() {
  const video  = document.getElementById('video');
  const canvas = document.getElementById('processCanvas');
  const vw=video.videoWidth, vh=video.videoHeight;
  if (!stream || !vw||!vh) { toast('⚠️ Câmera não pronta'); return; }
  if (nightBusy) return;
  const mode = currentMode;

  canvas.width=vw; canvas.height=vh;
  const ctx=canvas.getContext('2d', { willReadFrequently:true });

  /* CORREÇÃO: com zoom digital (sem zoom de hardware) a prévia mostrava a
     imagem ampliada mas a foto saía sem zoom. Recorta a mesma região. */
  const z = hwZoom ? 1 : zoomLevel;
  const sw = vw / z, sh = vh / z, sx = (vw - sw) / 2, sy = (vh - sh) / 2;
  const grab = () => {
    if (useFront) { ctx.translate(vw,0); ctx.scale(-1,1); }
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, vw, vh);
    ctx.setTransform(1,0,0,1,0,0);
  };

  let nightInfo = null;
  if (mode==='noite' && window.GSNight) {
    /* Modo Noite real: vários quadros alinhados e mesclados (menos ruído)
       + ganho adaptativo. Antes era só um ganho fixo de brilho. */
    nightBusy = true;
    const sh = document.querySelector('.shutter'); if (sh) sh.classList.add('busy');
    showCamProc('🌙 Modo Noite', 'Segure firme…', 0, false);
    try {
      nightInfo = await GSNight.capture({ video, ctx, w: vw, h: vh, grab,
        onProgress: (k, n) => showCamProc('🌙 Modo Noite', `Segure firme… quadro ${k} de ${n}`, k / n, false) });
    } catch (e) {
      console.warn('Noite:', e); grab();
    } finally {
      nightBusy = false; hideCamProc();
      if (sh) sh.classList.remove('busy');
    }
  } else grab();

  /* Modo Retrato: segmenta a pessoa nesta foto e desfoca o fundo (IA local) */
  let portraitInfo = null;
  if (mode === 'retrato' && window.GSPortrait) {
    nightBusy = true;
    showCamProc('🤳 Retrato', 'Separando a pessoa do fundo…', 0.5, false);
    try { portraitInfo = await GSPortrait.renderStill(canvas, +document.getElementById('portraitSlider').value); }
    catch (e) { console.warn('Retrato:', e); }
    finally { nightBusy = false; hideCamProc(); }
  }

  /* Modo Foto/Noite/Retrato: procura QR Code e link (https) na foto tirada */
  if (window.LinkScan && LinkScan.enabled && ['foto','noite','retrato'].includes(mode)) {
    const copy=document.createElement('canvas'); copy.width=vw; copy.height=vh;
    copy.getContext('2d').drawImage(canvas,0,0);
    setTimeout(()=>LinkScan.scanCapture(copy),50);
  }
  /* O filtro (como na prévia CSS) afeta só a imagem da câmera, não o efeito */
  applyFilter(ctx,vw,vh,currentFilter,1);
  /* CORREÇÃO: o efeito era esticado do tamanho do visor para o quadro
     inteiro do vídeo, ficando deslocado/deformado (o visor usa object-fit:
     cover e mostra só parte do quadro). Agora é posicionado sobre a mesma
     região visível — o resultado fica igual ao que se vê na tela. */
  if (fxRunning && mode === 'efeitos') {
    const fxc = document.getElementById('fxCanvas');
    const m = getVideoMapping();
    if (fxc && fxc.width && fxc.height && m) ctx.drawImage(fxc, -m.ox0 / m.s0, -m.oy0 / m.s0, m.W / m.s0, m.H / m.s0);
  }

  const dataUrl=canvas.toDataURL('image/jpeg',.93);
  const fl=document.getElementById('flashOverlay');
  fl.classList.add('flash'); setTimeout(()=>fl.classList.remove('flash'),350);

  const id=Date.now();
  const photo={ id, dataUrl, w:vw, h:vh, filter:currentFilter, mode, fx: mode==='efeitos'?currentFx:undefined, type:'photo' };
  if (nightInfo) photo.night = nightInfo;
  if (portraitInfo) photo.portrait = { applied: portraitInfo.applied, person: +portraitInfo.person.toFixed(3) };
  photos.unshift(photo);
  savePhotoToDB(photo).catch(err => { console.warn(err); toast('⚠️ Foto não salva no armazenamento local'); });

  updateThumbFromPhotos();
  toast(nightInfo ? `🌙 Foto noturna · ${nightInfo.used} quadros mesclados`
    : portraitInfo ? (portraitInfo.applied ? '🤳 Retrato com fundo desfocado' : '📸 Foto salva (nenhuma pessoa detectada)')
    : t('captured'));
  renderGallery();
}
