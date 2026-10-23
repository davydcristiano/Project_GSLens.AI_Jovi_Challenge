/* GSLens.AI — js/app/live-fx.js
   Aba Efeitos: efeitos animados ao vivo.
   Scripts clássicos carregados em ordem pelo index.html; compartilham o
   escopo global (estado em core.js). */
'use strict';

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
