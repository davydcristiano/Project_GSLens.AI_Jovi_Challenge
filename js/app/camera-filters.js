/* GSLens.AI — js/app/camera-filters.js
   Filtros ao vivo, faixa de filtros/molduras e prévia do modo Noite.
   Scripts clássicos carregados em ordem pelo index.html; compartilham o
   escopo global (estado em core.js). */
'use strict';

/* ══════════════════════════════════════
   10. FILTROS
══════════════════════════════════════ */
/* Pré-visualização ao vivo dos filtros (CSS) — o processamento real
   por pixel continua sendo feito em applyFilter() na captura. */
const CSS_FILTER_PREVIEW = {
  none:       'none',
  vivid:      'saturate(1.7) contrast(1.12)',
  dramatic:   'contrast(1.5) grayscale(.18) brightness(.92)',
  noir:       'grayscale(1) contrast(1.3) brightness(.9)',
  silvertone: 'grayscale(.85) brightness(1.06) contrast(1.05)',
  fade:       'saturate(.65) brightness(1.15) contrast(.85)',
  chrome:     'saturate(1.1) contrast(1.15) brightness(1.05)',
  warm:       'sepia(.28) saturate(1.35) hue-rotate(-6deg)',
  cool:       'saturate(1.15) hue-rotate(9deg) brightness(1.03)',
  process:    'sepia(.25) saturate(1.5) hue-rotate(15deg)',
  tonal:      'grayscale(1) contrast(1.1)',
  transfer:   'sepia(.4) saturate(1.6) contrast(1.05)',
  sepia:      'sepia(.85)'
};

function setFilter(fx, el) {
  currentFilter = fx;
  document.querySelectorAll('.fi').forEach(f => f.classList.remove('active'));
  if (el) el.classList.add('active');
  applyLivePreview(fx);
  toast(t('filterApplied') + filterName(fx));
}

/* Prévia do filtro na câmera: CSS para os filtros originais; WebGL
   (resultado idêntico ao da foto) para os clássicos/modernos.
   Camada processada ao vivo (#liveCanvas): modo Noite (redução de ruído) ou
   Retrato (fundo desfocado). Quando ativa, o filtro de cor é aplicado sobre
   ela, e não sobre o vídeo cru. */
let previewBaseCss = 'none', nightCss = '', liveLayer = null;
function liveSource() {
  return liveLayer ? document.getElementById('liveCanvas') : document.getElementById('video');
}
function applyLivePreview(fx) {
  const video = document.getElementById('video');
  if (!video) return;
  if (window.GSFilters && GSFilters.has(fx)) {
    const ok = stream && GSFilters.startPreview(document.getElementById('filterCanvas'), liveSource(), fx);
    previewBaseCss = ok ? 'none' : GSFilters.cssFallback(fx);
  } else {
    if (window.GSFilters) GSFilters.stopPreview();
    previewBaseCss = CSS_FILTER_PREVIEW[fx] || 'none';
  }
  paintPreviewCss();
}

/* combina o filtro escolhido com o clareamento do modo Noite */
function paintPreviewCss() {
  const video = document.getElementById('video'), fc = document.getElementById('filterCanvas'), lc = document.getElementById('liveCanvas');
  const base = previewBaseCss === 'none' ? '' : previewBaseCss;
  if (liveLayer) {
    video.style.filter = 'none';
    if (lc) lc.style.filter = base;
    if (fc) fc.style.filter = '';
  } else {
    video.style.filter = (nightCss + ' ' + base).trim() || 'none';
    if (lc) lc.style.filter = '';
    if (fc) fc.style.filter = nightCss || '';
  }
}

function setLiveLayer(kind) {
  liveLayer = kind;
  document.getElementById('cameraScreen').classList.toggle('live-layer', !!kind);
  applyLivePreview(currentFilter);
}

/* ── Modo Noite: prévia com redução de ruído ao vivo (WebGL) ou, sem WebGL
   de ponto flutuante, clareamento simples por CSS ── */
let nightTimer = null, nightBusy = false;
function startNightPreview() {
  stopNightPreview();
  if (!window.GSNight) return;
  GSNight.resetGain();
  const v = document.getElementById('video');
  if (stream && GSNight.startLive(document.getElementById('liveCanvas'), v)) {
    setLiveLayer('noite');
  } else {
    const tick = () => {
      if (currentMode !== 'noite') { stopNightPreview(); return; }
      if (stream && v.videoWidth) {
        const g = GSNight.liveGain(v);
        nightCss = `brightness(${g.toFixed(2)}) contrast(1.06) saturate(${(1 - (g - 1) * 0.08).toFixed(2)})`;
        paintPreviewCss();
      }
      nightTimer = setTimeout(tick, 250);
    };
    tick();
  }
  /* exposição de hardware mais alta, quando a câmera permite (Android/Chrome) */
  setTrackExposure(Math.max(evLevel, 1.5));
}
function stopNightPreview() {
  if (nightTimer) { clearTimeout(nightTimer); nightTimer = null; }
  if (window.GSNight && GSNight.liveActive()) GSNight.stopLive();
  if (liveLayer === 'noite') setLiveLayer(null);
  if (nightCss) { nightCss = ''; paintPreviewCss(); }
}
/* ── Modo Retrato: fundo desfocado com segmentação de pessoas por IA local ── */
function startPortraitPreview() {
  stopPortraitPreview();
  if (!window.GSPortrait || !stream) return;
  const badge = document.getElementById('portraitBadge');
  badge.textContent = '⏳ Carregando IA de retrato…'; badge.className = 'portrait-badge';
  const ok = GSPortrait.startLive(document.getElementById('liveCanvas'), document.getElementById('video'), {
    amount: +document.getElementById('portraitSlider').value,
    onStatus: st => {
      if (currentMode !== 'retrato') return;
      if (st.error) { badge.textContent = '⚠️ Retrato indisponível'; badge.className = 'portrait-badge'; return; }
      badge.textContent = st.person ? '🤳 Pessoa detectada · fundo desfocado' : '👤 Aponte para uma pessoa';
      badge.className = 'portrait-badge' + (st.person ? ' ok' : '');
    }
  });
  if (ok) setLiveLayer('retrato');
  else { badge.textContent = '⚠️ Retrato precisa de WebGL'; }
  document.getElementById('portraitStrip').classList.remove('hidden');
}
function stopPortraitPreview() {
  if (window.GSPortrait && GSPortrait.liveActive()) GSPortrait.stopLive();
  if (liveLayer === 'retrato') setLiveLayer(null);
  const b = document.getElementById('portraitBadge'); if (b) b.className = 'portrait-badge hidden';
  const st = document.getElementById('portraitStrip'); if (st) st.classList.add('hidden');
}
function setPortraitAmount(v) {
  v = +v;
  if (window.GSPortrait) GSPortrait.setAmount(v);
  /* rótulo no estilo "abertura": mais desfoque = f/ menor */
  const f = [8, 5.6, 4, 2.8, 2, 1.4][Math.min(5, Math.round(v * 5))];
  document.getElementById('portraitVal').textContent = 'f/' + f;
}

function setTrackExposure(ev) {
  const track = stream && stream.getVideoTracks()[0];
  if (!track || !track.getCapabilities) return;
  const caps = track.getCapabilities();
  if (!caps.exposureCompensation) return;
  const v = Math.min(caps.exposureCompensation.max, Math.max(caps.exposureCompensation.min, ev));
  track.applyConstraints({ advanced:[{ exposureCompensation: v }] }).catch(()=>{});
}

function showCamProc(title, msg, pct, cancellable) {
  const el = document.getElementById('camProc');
  el.classList.remove('hidden');
  document.getElementById('camProcTitle').textContent = title;
  document.getElementById('camProcMsg').textContent = msg;
  document.getElementById('camProcBar').style.width = Math.round(pct * 100) + '%';
  document.getElementById('camProcPct').textContent = Math.round(pct * 100) + '%';
  document.getElementById('camProcCancel').classList.toggle('hidden', !cancellable);
}
function hideCamProc() { document.getElementById('camProc').classList.add('hidden'); }

function filterName(fx) {
  if (fx === 'none') return 'Normal';
  if (window.GSFilters && GSFilters.has(fx)) return GSFilters.get(fx).name;
  const el = document.querySelector(`.fi[data-f="${fx}"] span`);
  return el ? el.textContent : fx;
}

/* Capas dos filtros: um degradê (claro → médio → escuro) de um cinza‑azulado
   neutro, passado pelo PRÓPRIO filtro — a capa mostra o tom que o filtro dá.
   DESEMPENHO: calculado direto nos números (ImageData de 3 pixels), sem
   desenhar nem ler canvas; antes cada capa custava uma leitura de canvas
   na abertura do app. */
const SWATCH_BASE = [[164, 170, 186], [98, 104, 122], [40, 44, 54]];
function filterSwatch(fx) {
  const id = new ImageData(3, 1);
  SWATCH_BASE.forEach((c, i) => { id.data[i * 4] = c[0]; id.data[i * 4 + 1] = c[1]; id.data[i * 4 + 2] = c[2]; id.data[i * 4 + 3] = 255; });
  const fake = { getImageData: () => id, putImageData: () => {} };
  try { if (fx !== 'none') applyFilter(fake, 3, 1, fx, 1); } catch (e) { /* mantém o neutro */ }
  const c = i => `rgb(${id.data[i * 4]},${id.data[i * 4 + 1]},${id.data[i * 4 + 2]})`;
  return `linear-gradient(135deg, ${c(0)} 0%, ${c(1)} 52%, ${c(2)} 100%)`;
}

function buildFilterUI() {
  const strip = document.getElementById('filtersInner');
  if (window.GSFilters && strip && !strip.dataset.built) {
    strip.dataset.built = '1';
    const groups = [['classic', 'Clássicos'], ['modern', 'Modernos']];
    for (const [g, label] of groups) {
      const h = document.createElement('div'); h.className = 'fi-group'; h.textContent = label; h.setAttribute('aria-hidden', 'true');
      strip.appendChild(h);
      for (const d of GSFilters.DEFS.filter(f => f.group === g)) {
        const el = document.createElement('div');
        el.className = 'fi'; el.dataset.f = d.id; el.setAttribute('role', 'button'); el.tabIndex = 0;
        el.innerHTML = '<div class="ft"></div><span></span>';
        el.querySelector('span').textContent = d.name;
        el.onclick = () => setFilter(d.id, el);
        el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFilter(d.id, el); } };
        strip.appendChild(el);
      }
    }
    /* mesmos filtros na aba Efeitos do editor */
    const grid = document.querySelector('#panelEffects .fx-grid');
    for (const [g, label] of groups) {
      const h = document.createElement('div'); h.className = 'grid-group'; h.textContent = label; grid.appendChild(h);
      for (const d of GSFilters.DEFS.filter(f => f.group === g)) {
        const b = document.createElement('button'); b.className = 'btn fxchip'; b.dataset.e = d.id; b.textContent = d.name;
        b.onclick = () => applyEffect(d.id, b); grid.appendChild(b);
      }
    }
  }
  /* capas: degradê com o tom de cada filtro */
  document.querySelectorAll('.fi').forEach(el => {
    const ft = el.querySelector('.ft');
    ft.style.backgroundImage = filterSwatch(el.dataset.f);
    ft.classList.add('has-thumb');
  });
}

function buildFrameUI() {
  if (!window.GSFrames) return;
  const grid = document.querySelector('#panelFrame .frame-grid');
  if (!grid || grid.dataset.built) return;
  grid.dataset.built = '1';
  const first = document.createElement('div'); first.className = 'grid-group'; first.textContent = 'Básicas';
  grid.insertBefore(first, grid.firstChild);
  for (const [g, label] of [['classic', 'Clássicas'], ['modern', 'Modernas']]) {
    const h = document.createElement('div'); h.className = 'grid-group'; h.textContent = label; grid.appendChild(h);
    for (const f of GSFrames.LIST.filter(x => x.group === g)) {
      const b = document.createElement('button'); b.className = 'btn frame-btn'; b.dataset.frame = f.id; b.textContent = f.name;
      b.onclick = () => applyFrame(f.id, b); grid.appendChild(b);
    }
  }
}

function applyFilter(ctx, w, h, fx, alpha) {
  if (fx === 'none' || !alpha) return;
  /* filtros clássicos/modernos: mesmo modelo da prévia WebGL (js/filters.js) */
  if (window.GSFilters && GSFilters.has(fx)) { GSFilters.apply(ctx, w, h, fx, alpha); return; }
  const id = ctx.getImageData(0, 0, w, h);
  const d  = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i+1], b = d[i+2];
    const lv = lum(r,g,b);
    let nr=r, ng=g, nb=b;
    switch(fx) {
      case 'vivid':      nr=cl(lv+(r-lv)*2.5); ng=cl(lv+(g-lv)*2.5); nb=cl(lv+(b-lv)*2.5); break;
      case 'dramatic':   nr=ng=nb=cl((lv-128)*1.8+128); break;
      case 'noir':       nr=ng=nb=cl(((lv-128)*2+128)*.82); break;
      case 'silvertone': nr=cl(lv*.97+8); ng=cl(lv*.97+8); nb=cl(lv*1.05+10); break;
      case 'fade':       nr=cl(r*.75+50); ng=cl(g*.75+42); nb=cl(b*.70+50); break;
      case 'chrome':     nr=cl(lv+(r-lv)*.4+20); ng=cl(lv+(g-lv)*.4+25); nb=cl(lv+(b-lv)*.4+50); break;
      case 'warm':       nr=cl(r*1.12+18); ng=cl(g*1.02+4); nb=cl(b*.82); break;
      case 'cool':       nr=cl(r*.82); ng=cl(g*1.0+4); nb=cl(b*1.18+22); break;
      case 'process':    nr=cl(r+10); ng=cl(g+18); nb=cl(b*.85+10); break;
      case 'tonal':      { const t2=lv/255; nr=cl(lv+(t2>.5?12:-12)); ng=cl(lv+(t2>.5?10:-10)); nb=cl(lv+(t2>.5?8:-8)); break; }
      case 'transfer':   nr=cl(r*.9+g*.1+15); ng=cl(g*.9+b*.1+5); nb=cl(b*.8+r*.2+20); break;
      case 'sepia':      nr=cl(r*.393+g*.769+b*.189); ng=cl(r*.349+g*.686+b*.168); nb=cl(r*.272+g*.534+b*.131); break;
    }
    d[i]=lerp(r,nr,alpha); d[i+1]=lerp(g,ng,alpha); d[i+2]=lerp(b,nb,alpha);
  }
  ctx.putImageData(id, 0, 0);
}

const lum  = (r,g,b) => 0.299*r+0.587*g+0.114*b;
const cl   = v => Math.max(0, Math.min(255, Math.round(v)));
const lerp = (a,b,t) => Math.round(a+(b-a)*t);
