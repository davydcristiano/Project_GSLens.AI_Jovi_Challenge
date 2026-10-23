/* GSLens.AI — js/app/recording.js
   Gravação de vídeo e Slow-Mo.
   Scripts clássicos carregados em ordem pelo index.html; compartilham o
   escopo global (estado em core.js). */
'use strict';

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

let recordFps = 30, recordStartT = 0, slowBusy = false, slowSignal = null;
async function startRecording() {
  if (!stream) { toast('⚠️ Câmera não está ativa'); return; }
  if (!window.MediaRecorder) { toast('⚠️ Este navegador não grava vídeo'); return; }
  if (slowBusy) { toast('⏳ Aguarde o processamento do Slow-Mo'); return; }
  recordedChunks = [];
  recordMode = currentMode;     /* CORREÇÃO: o modo era lido só ao parar (podia já ter mudado) */
  const v = document.getElementById('video');

  let recStream = stream;
  if (recordMode === 'slowmo') {
    /* pede a maior taxa de quadros da câmera ANTES de gravar (antes não
       esperava a mudança) e grava só a imagem — o áudio desacelerado
       ficaria distorcido */
    recordFps = window.GSSlowMo ? await GSSlowMo.prepare(stream.getVideoTracks()[0]) : 30;
    recStream = new MediaStream(stream.getVideoTracks());
  }
  recordSize = { w: v.videoWidth, h: v.videoHeight };

  const mime = pickRecorderMime();
  try {
    mediaRecorder = mime ? new MediaRecorder(recStream, { mimeType: mime }) : new MediaRecorder(recStream);
  } catch(e) {
    try { mediaRecorder = new MediaRecorder(recStream); }
    catch (e2) { toast('⚠️ Não foi possível iniciar a gravação'); return; }
  }
  recordMime = (mediaRecorder.mimeType || mime || 'video/webm').split(';')[0];

  mediaRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.onstop = saveVideo;
  mediaRecorder.onerror = e => { console.error('MediaRecorder:', e); toast('⚠️ Erro na gravação'); };
  mediaRecorder.start(250);
  isRecording = true;
  recordStartT = performance.now();

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
  toast(recordMode === 'slowmo' ? `🐌 Gravando a ${Math.round(recordFps)} fps` : t('videoStart'));
}

function stopRecording() {
  if (!mediaRecorder || !isRecording) return;
  isRecording = false;
  recordDur = (performance.now() - recordStartT) / 1000;
  try { mediaRecorder.stop(); } catch (e) { console.warn(e); }
  clearInterval(recordTimer);
  document.querySelector('.shutter').classList.remove('recording');
  document.getElementById('recBadge').classList.add('hidden');
  /* restaura a taxa de quadros normal após o slow-mo */
  const track = stream && stream.getVideoTracks()[0];
  if (track && recordMode === 'slowmo') track.applyConstraints({ frameRate:{ ideal:30 } }).catch(()=>{});
}

let recordDur = 0;
async function saveVideo() {
  if (!recordedChunks.length) { toast('⚠️ Nenhum dado de vídeo gravado'); return; }
  let blob = new Blob(recordedChunks, { type: recordMime });
  recordedChunks = [];
  let mime = recordMime, seconds = recordSeconds, w = recordSize.w || 1280, h = recordSize.h || 720, slow = null;

  /* Slow-Mo: gera o arquivo desacelerado de verdade (antes o vídeo era
     salvo na velocidade normal — igual ao modo Vídeo) */
  if (recordMode === 'slowmo') {
    if (window.GSSlowMo && GSSlowMo.supported()) {
      slowBusy = true; slowSignal = { cancel: false };
      showCamProc('🐌 Slow-Mo', 'Criando câmera lenta…', 0, true);
      try {
        const r = await GSSlowMo.process(blob, { fps: recordFps, seconds: recordDur, signal: slowSignal,
          onProgress: p => showCamProc('🐌 Slow-Mo', `Criando câmera lenta ${recordFps >= 100 ? '¼×' : '½×'} (gravado a ${Math.round(recordFps)} fps)…`, p, true) });
        if (r.blob.size > 0) { blob = r.blob; mime = r.mime; seconds = r.seconds; w = r.w; h = r.h; slow = { rate: r.rate, fps: Math.round(recordFps), baked: true, srcSeconds: +recordDur.toFixed(2) }; }
      } catch (e) {
        console.warn('Slow-Mo:', e);
        /* sem reprocessamento: guarda o original e toca desacelerado no app */
        slow = { rate: recordFps >= 100 ? 0.25 : 0.5, fps: Math.round(recordFps), baked: false };
        seconds = Math.round(recordDur / slow.rate);
        if (e.message !== 'cancelado') toast('⚠️ Não foi possível gerar o arquivo lento — reprodução lenta no app');
      } finally { slowBusy = false; slowSignal = null; hideCamProc(); }
    } else {
      slow = { rate: recordFps >= 100 ? 0.25 : 0.5, fps: Math.round(recordFps), baked: false };
      seconds = Math.round(recordDur / slow.rate);
    }
  }

  const id   = Date.now();
  const photo = {
    id, blob, dataUrl: URL.createObjectURL(blob), type:'video', mode: recordMode, mime,
    filter: currentFilter, w, h, seconds
  };
  if (slow) photo.slow = slow;
  photos.unshift(photo);
  savePhotoToDB(photo).catch(err => { console.warn('Vídeo não persistido:', err); toast('⚠️ Vídeo salvo só nesta sessão (armazenamento cheio?)'); });
  updateThumbFromPhotos();
  toast(t('videoStop'));
  renderGallery();
}
