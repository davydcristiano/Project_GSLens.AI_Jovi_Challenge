/* GSLens.AI — js/app/editor.js
   Editor: modal, pipeline de edição, efeitos, molduras, recorte, desenho e texto.
   Scripts clássicos carregados em ordem pelo index.html; compartilham o
   escopo global (estado em core.js). */
'use strict';

/* ══════════════════════════════════════
   17. MODAL EDIÇÃO
══════════════════════════════════════ */
function openEditModal(idx) {
  if (idx<0 || !photos[idx]) return;
  if (_fullTimer) { clearTimeout(_fullTimer); _fullTimer=null; }
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
  if (isVideo) {
    const mv=document.getElementById('modalVideo');
    mv.src=p.dataUrl;
    /* Slow-Mo sem arquivo reprocessado (navegador sem captureStream): toca desacelerado */
    const r = p.slow && !p.slow.baked ? p.slow.rate : 1;
    mv.defaultPlaybackRate = r; mv.playbackRate = r;
    mv.onloadedmetadata = () => { mv.playbackRate = r; };
  }
  else { document.getElementById('modalImg').src=originalDataUrl; }
  document.getElementById('modalMeta').textContent=p.w+'×'+p.h+(isVideo&&p.seconds?' · '+p.seconds+'s':'')
    +(p.slow?` · Slow-Mo ${p.slow.rate===0.25?'¼×':'½×'} (${p.slow.fps} fps)`:'')
    +(p.night?` · Noite: ${p.night.used} quadros, ganho ${p.night.gain}×`:'');
  document.getElementById('jpgLabel').textContent = isVideo ? 'Baixar vídeo' : 'Baixar JPG';
  resetEditState();
  openTab(isVideo?'export':'adjust',document.querySelector(`.etab[data-tab="${isVideo?'export':'adjust'}"]`));
  document.getElementById('aiResult').classList.add('hidden');
  clearDrawCanvas();
  setupCropEvents();
  if (!(history.state && history.state.gsEdit)) { try { history.pushState({gsEdit:1},''); } catch(_){} }
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
function closeModal(fromHistory) {
  if (document.getElementById('editModal').classList.contains('hidden')) return;
  /* textos ainda soltos sobre a foto são incorporados antes de fechar */
  if (currentTab==='text') WText.close();
  /* ajuste feito há menos de 280 ms: aplica em resolução cheia antes de fechar */
  if (_fullTimer) { clearTimeout(_fullTimer); _fullTimer=null; renderEdits(); }
  flushSave();
  const mv=document.getElementById('modalVideo');
  mv.pause(); mv.removeAttribute('src'); mv.load();
  document.getElementById('editModal').classList.add('hidden');
  cleanupCropEvents(); cleanupDrawEvents(); clearDrawCanvas();
  editingIdx=-1;
  /* o editor ocupa uma entrada do histórico: o "voltar" do celular fecha só o editor */
  if (!fromHistory && history.state && history.state.gsEdit) { _editHistSkip=true; history.back(); }
}

/* Botão "voltar" do celular / navegador com o editor aberto: fecha o editor
   e volta para a galeria em vez de sair do app. */
let _editHistSkip=false;
window.addEventListener('popstate', ()=>{
  if (_editHistSkip) { _editHistSkip=false; return; }
  if (WText.isComposing()) { WText.done(); history.pushState({gsEdit:1},''); return; }
  if (!document.getElementById('editModal').classList.contains('hidden')) closeModal(true);
});

function openTab(tab,el) {
  /* saindo da aba Texto: os textos são incorporados à foto */
  if (currentTab==='text' && tab!=='text') WText.close();
  currentTab=tab;
  document.querySelectorAll('.etab').forEach(b=>{ b.classList.remove('active'); b.setAttribute('aria-selected','false'); });
  if(el){ el.classList.add('active'); el.setAttribute('aria-selected','true'); }
  const panelMap={adjust:'panelAdjust',effects:'panelEffects',crop:'panelCrop',draw:'panelDraw',text:'panelText',frame:'panelFrame',ai:'panelAI',export:'panelExport'};
  Object.values(panelMap).forEach(id=>document.getElementById(id).classList.add('hidden'));
  document.getElementById(panelMap[tab]).classList.remove('hidden');
  const cropOv=document.getElementById('cropOverlay');
  const drawCv=document.getElementById('drawCanvas');
  if(tab==='crop'){cropOv.classList.remove('hidden');drawCv.classList.add('hidden');}
  else if(tab==='draw'){cropOv.classList.add('hidden');setupDrawCanvas(tab);drawCv.classList.remove('hidden');resetCropUI();}
  else{cropOv.classList.add('hidden');drawCv.classList.add('hidden');resetCropUI();}
  if(tab==='text') WText.open();
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
  /* DESEMPENHO: enquanto o controle é arrastado, só uma prévia reduzida
     (até 720 px) por quadro; a foto em resolução cheia é processada uma vez,
     quando o dedo para. Antes cada movimento reprocessava a foto inteira. */
  clearTimeout(_fullTimer);
  _fullTimer=setTimeout(()=>{ _fullTimer=null; renderEdits(); }, 280);
  if(_adjPending) return;
  _adjPending=true;
  requestAnimationFrame(()=>{ _adjPending=false; if(_fullTimer) renderEdits(null, { preview:true }); });
}
let _adjPending=false, _fullTimer=null;

function renderEdits(doneMsg, opts) {
  const preview=!!(opts&&opts.preview);
  const p=photos[editingIdx]; if(!p||p.type==='video') return Promise.resolve();
  const meuToken=++_fxToken;
  const a=readAdjust(), fx=currentEffect, frame=currentFrame, wb=wbGains;
  return carregarOrigemEfeito(originalDataUrl).then(img=>{
    if(meuToken!==_fxToken) return;
    const sc=preview?Math.min(1,720/Math.max(img.naturalWidth,img.naturalHeight)):1;
    const W=Math.round(img.naturalWidth*sc), H=Math.round(img.naturalHeight*sc);
    const canvas=document.createElement('canvas');
    canvas.width=W; canvas.height=H;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    ctx.filter=a.BL>0?`blur(${a.BL*sc}px)`:'none';
    ctx.drawImage(img,0,0,W,H);
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
    if(preview){ document.getElementById('modalImg').src=out.toDataURL('image/jpeg',.82); return; }
    return encodeJpeg(out,.93).then(url=>{
    if(meuToken!==_fxToken) return;
    p.dataUrl=url;
    p.w=out.width; p.h=out.height;
    document.getElementById('modalImg').src=p.dataUrl;
    document.getElementById('modalMeta').textContent=p.w+'×'+p.h;
    scheduleSave(p);
    if(doneMsg) toast(doneMsg);
    });
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
   21. DESENHO
   CORREÇÃO: o desenho era esticado do tamanho do contêiner para a foto,
   desalinhando quando a foto não preenchia o contêiner.
══════════════════════════════════════ */
function setupDrawCanvas(mode) {
  const preview=document.getElementById('modalPreview');
  const dc=document.getElementById('drawCanvas');
  const rect=preview.getBoundingClientRect();
  if(dc.width!==Math.round(rect.width)||dc.height!==Math.round(rect.height)){ dc.width=Math.round(rect.width); dc.height=Math.round(rect.height); }
  dc.dataset.mode=mode;
  dc.style.cursor = 'crosshair';
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

/* Texto: ver js/app/text-story.js (texto livre no estilo dos status do WhatsApp) */
