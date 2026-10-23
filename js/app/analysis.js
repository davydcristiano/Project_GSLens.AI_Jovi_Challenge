/* GSLens.AI — js/app/analysis.js
   Análise automática local (no dispositivo).
   Scripts clássicos carregados em ordem pelo index.html; compartilham o
   escopo global (estado em core.js). */
'use strict';

/* ══════════════════════════════════════
   22. ANÁLISE AUTOMÁTICA (local, no dispositivo)
   CORREÇÃO: antes estas ações eram simuladas — esperavam um tempo fixo e
   aplicavam valores pré-definidos, iguais para qualquer foto. Agora cada
   uma mede a imagem de verdade (histograma, médias por canal, energia de
   bordas) e calcula os ajustes a partir dela.
══════════════════════════════════════ */
async function analysisPixels(maxDim) {
  const img=await carregarOrigemEfeito(originalDataUrl);
  const sc=Math.min(1,(maxDim||256)/Math.max(img.naturalWidth,img.naturalHeight));
  const w=Math.max(1,Math.round(img.naturalWidth*sc)),h=Math.max(1,Math.round(img.naturalHeight*sc));
  const c=document.createElement('canvas');c.width=w;c.height=h;
  const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0,w,h);
  return { d:ctx.getImageData(0,0,w,h).data, w, h, sc };
}

async function aiAutoEnhance() {
  const p=photos[editingIdx];if(!p||p.type==='video')return;
  showAIResult('Analisando luminosidade, contraste e saturação...');
  try {
    const { d }=await analysisPixels(256);
    let s=0,s2=0,sat=0,n=0;
    for(let i=0;i<d.length;i+=4){
      const L=lum(d[i],d[i+1],d[i+2]);s+=L;s2+=L*L;n++;
      const mx=Math.max(d[i],d[i+1],d[i+2]),mn=Math.min(d[i],d[i+1],d[i+2]);sat+=mx?(mx-mn)/mx:0;
    }
    const mean=s/n,std=Math.sqrt(Math.max(0,s2/n-mean*mean)),ms=sat/n;
    const B=Math.round(Math.max(-40,Math.min(40,(118-mean)*0.6)));
    const C=Math.round(Math.max(-30,Math.min(45,(58/Math.max(8,std)-1)*55)));
    const S=Math.round(Math.max(-25,Math.min(45,(0.32/Math.max(0.05,ms)-1)*40)));
    document.getElementById('slBrightness').value=B;
    document.getElementById('slContrast').value=C;
    document.getElementById('slSaturation').value=S;
    liveAdjust();
    showAIResult(`✨ Medido: luminância média ${mean.toFixed(0)}, desvio ${std.toFixed(0)}, saturação ${(ms*100).toFixed(0)}% → brilho ${B>0?'+':''}${B}, contraste ${C>0?'+':''}${C}, saturação ${S>0?'+':''}${S}. Ajuste fino na aba Ajustes.`);
    toast(t('aiDone'));
  } catch(e){ console.error(e); showAIResult('⚠️ Não foi possível analisar a imagem.'); }
}

async function aiAutoCrop() {
  const p=photos[editingIdx];if(!p||p.type==='video')return;
  showAIResult('Detectando a área principal da cena (energia de bordas)...');
  try {
    const { d,w,h,sc }=await analysisPixels(320);
    const g=new Float32Array(w*h);
    for(let i=0;i<w*h;i++) g[i]=lum(d[4*i],d[4*i+1],d[4*i+2]);
    const colE=new Float64Array(w),rowE=new Float64Array(h);
    for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
      const i=y*w+x,e=Math.abs(g[i+1]-g[i-1])+Math.abs(g[i+w]-g[i-w]);
      colE[x]+=e;rowE[y]+=e;
    }
    const bounds=(arr,frac)=>{const tot=arr.reduce((a,b)=>a+b,0);let a=0,lo=0,hi=arr.length-1;
      while(lo<arr.length&&a+arr[lo]<tot*frac){a+=arr[lo];lo++;} a=0; while(hi>0&&a+arr[hi]<tot*frac){a+=arr[hi];hi--;} return [lo,Math.max(lo+1,hi)];};
    let [x0,x1]=bounds(colE,0.06),[y0,y1]=bounds(rowE,0.06);
    const padX=(x1-x0)*0.08,padY=(y1-y0)*0.08;
    x0=Math.max(0,x0-padX);x1=Math.min(w,x1+padX);y0=Math.max(0,y0-padY);y1=Math.min(h,y1+padY);
    /* abre a aba Recortar com a área sugerida desenhada, para o usuário confirmar */
    openTab('crop',document.querySelector('.etab[data-tab="crop"]'));
    setCropRatio(0,0,true);
    const r=imageContentRect(), k=r.scale/sc;
    cropState={down:false,sx:r.offX+x0*k,sy:r.offY+y0*k,ex:r.offX+x1*k,ey:r.offY+y1*k};
    renderCropBox();
    const pct=Math.round((x1-x0)*(y1-y0)/(w*h)*100);
    showAIResult(`📐 Área de interesse encontrada (${pct}% da foto). Ajuste se quiser e toque em "✓ Aplicar".`);
    toast('Enquadramento sugerido');
  } catch(e){ console.error(e); showAIResult('⚠️ Não foi possível analisar a imagem.'); }
}

async function aiColorBalance() {
  const p=photos[editingIdx];if(!p||p.type==='video')return;
  showAIResult('Analisando a temperatura de cor (mundo cinza)...');
  try {
    const { d }=await analysisPixels(256);
    let r=0,g=0,b=0,n=0;
    for(let i=0;i<d.length;i+=4){
      const L=lum(d[i],d[i+1],d[i+2]);
      if(L<20||L>240) continue;   /* ignora sombras e realces estourados */
      r+=d[i];g+=d[i+1];b+=d[i+2];n++;
    }
    if(!n){showAIResult('Imagem muito escura ou estourada para estimar o balanço.');return;}
    r/=n;g/=n;b/=n;
    const m=(r+g+b)/3;
    wbGains=[m/r,m/g,m/b].map(v=>Math.max(0.7,Math.min(1.4,v)));
    await renderEdits();
    showAIResult(`🎨 Médias R/G/B: ${r.toFixed(0)} / ${g.toFixed(0)} / ${b.toFixed(0)} → ganhos ${wbGains.map(v=>v.toFixed(2)).join(' / ')} (neutraliza o tom dominante).`);
    toast('Balanço de cores aplicado');
  } catch(e){ console.error(e); showAIResult('⚠️ Não foi possível analisar a imagem.'); }
}

async function aiRemoveBg() {
  const p=photos[editingIdx];if(!p||p.type==='video')return;
  showAIResult('Clareando o fundo (limiar adaptativo pelas bordas)...');
  await applyEffect('whitebg',document.querySelector('.fxchip[data-e="whitebg"]'));
  showAIResult('⬜ Fundo claro convertido em branco puro, preservando o conteúdo escuro. Ideal para documentos e objetos sobre fundo claro (processamento local, sem envio da foto).');
}

/* Lê QR Code ou link impresso numa foto da galeria e abre no mini navegador */
async function aiScanLinks() {
  const p=photos[editingIdx];if(!p||p.type==='video')return;
  if(!window.LinkScan){showAIResult('⚠️ Leitor de links indisponível.');return;}
  try {
    const img=await loadImage(p.dataUrl);
    const r=await LinkScan.scanImage(img,msg=>showAIResult('🔎 '+msg));
    if(!r.parsed){showAIResult('Nenhum QR Code ou link encontrado nesta foto.'+(r.text&&r.text.trim()?' Texto lido: "'+r.text.trim().slice(0,140)+'"':''));return;}
    const extra=r.all&&r.all.length>1?' (outros: '+r.all.slice(1).join(', ')+')':'';
    showAIResult('🔗 '+r.source+' encontrado'+(r.parsed.url?': '+r.parsed.url:'')+extra);
    LinkScan.open(r.parsed,r.source);
  } catch(e){ console.error(e); showAIResult('⚠️ '+(e.message||'Falha na leitura')); }
}

function showAIResult(msg){
  const r=document.getElementById('aiResult');
  r.classList.remove('hidden');
  document.getElementById('aiResultText').textContent=msg;
}
