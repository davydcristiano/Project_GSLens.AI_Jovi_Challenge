/* GSLens.AI — js/app/text-story.js
   Texto livre no estilo dos status do WhatsApp (aba "Aa Texto" do editor).
   - Toque na foto (ou em "Adicionar texto") abre o compositor em tela cheia:
     digitação com várias linhas, barra vertical de cores à direita, troca de
     fonte, fundo do texto (nenhum / caixa colorida / caixa escura) e
     alinhamento.
   - Ao concluir, o texto vira um adesivo sobre a foto: arraste para mover,
     dois dedos para girar e mudar o tamanho (no computador: roda do mouse
     muda o tamanho, Shift + roda gira), toque para editar e arraste até a
     lixeira para apagar.
   - Os textos são incorporados à foto em resolução cheia ao tocar em
     "Aplicar na foto", ao trocar de aba ou ao fechar o editor.
   Um único desenhista (drawItem) gera tanto a prévia quanto o arquivo final,
   então o resultado salvo é idêntico ao que aparece na tela. */
'use strict';

const WText = (() => {
  const FONTS = [
    { name: 'Simples',    family: 'system-ui, -apple-system, Roboto, "Segoe UI", sans-serif', weight: 700 },
    { name: 'Título',     family: 'Impact, "Arial Black", "Roboto Condensed", sans-serif', weight: 900, upper: true },
    { name: 'Clássica',   family: 'Georgia, "Noto Serif", "Times New Roman", serif', weight: 700, style: 'italic' },
    { name: 'Manuscrita', family: '"Dancing Script", "Segoe Script", "Brush Script MT", "Comic Sans MS", cursive', weight: 700 },
    { name: 'Máquina',    family: '"Space Mono", "Roboto Mono", Menlo, Consolas, monospace', weight: 700 },
  ];
  const BGS = ['none', 'solid', 'dark'];
  const ALIGNS = ['center', 'left', 'right'];
  const COLORS = ['#ffffff', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00e5ff', '#007aff', '#af52de', '#ff2d92', '#000000'];
  /* tamanho-base da fonte = 7% da largura da foto; quebra de linha a 12 "em" */
  const FS_REL = 0.07, WRAP_EM = 12.2, LH = 1.22;

  let items = [];          /* { id, text, font, color, bg, align, x, y, scale, rot, el } */
  let nextId = 1;
  let editing = null;      /* item em edição no compositor (null = novo) */
  let draft = null;        /* estilo atual do compositor */
  let colorPos = 0;        /* posição 0..1 na barra de cores */
  let lastStyle = { font: 0, color: '#ffffff', bg: 'none', align: 'center', colorPos: 0 };
  let active = false;      /* aba Texto aberta */

  const $ = id => document.getElementById(id);

  /* ───────── cores ───────── */
  function hex(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  function colorAt(t) {
    t = Math.max(0, Math.min(1, t));
    const f = t * (COLORS.length - 1), i = Math.min(COLORS.length - 2, Math.floor(f)), u = f - i;
    const a = hex(COLORS[i]), b = hex(COLORS[i + 1]);
    return '#' + a.map((v, k) => Math.round(v + (b[k] - v) * u).toString(16).padStart(2, '0')).join('');
  }
  function isLight(c) { const [r, g, b] = hex(c); return r * .299 + g * .587 + b * .114 > 150; }

  /* ───────── desenho (prévia e arquivo final) ───────── */
  function fontCss(it, fs) { const f = FONTS[it.font] || FONTS[0]; return `${f.style || 'normal'} ${f.weight} ${fs}px ${f.family}`; }
  function shownText(it) { return (FONTS[it.font] || FONTS[0]).upper ? it.text.toUpperCase() : it.text; }

  /* quebra por palavras, respeitando as quebras de linha digitadas */
  function wrap(ctx, text, maxW) {
    const out = [];
    for (const para of text.split('\n')) {
      const words = para.split(/(\s+)/);
      let line = '';
      for (const w of words) {
        const test = line + w;
        if (line && ctx.measureText(test.trimEnd()).width > maxW && w.trim()) { out.push(line.trimEnd()); line = w.trimStart(); }
        else line = test;
      }
      out.push(line.trimEnd());
    }
    return out;
  }

  function layout(ctx, it, fs) {
    ctx.font = fontCss(it, fs);
    const lines = wrap(ctx, shownText(it), WRAP_EM * fs);
    const widths = lines.map(l => ctx.measureText(l).width);
    const tw = Math.max(fs * 0.4, ...widths), lh = fs * LH;
    const pad = it.bg === 'none' ? fs * 0.2 : fs * 0.42;
    return { lines, widths, tw, lh, pad, w: tw + pad * 2, h: lines.length * lh + pad * 2 - (it.bg === 'none' ? 0 : fs * 0.1) };
  }

  /* desenha centrado em (0,0) */
  function drawItem(ctx, it, fs) {
    const L = layout(ctx, it, fs);
    let fill = it.color;
    if (it.bg !== 'none') {
      const r = Math.min(fs * 0.45, L.h / 2);
      ctx.fillStyle = it.bg === 'solid' ? it.color : 'rgba(0,0,0,.55)';
      roundRect(ctx, -L.w / 2, -L.h / 2, L.w, L.h, r);
      ctx.fill();
      if (it.bg === 'solid') fill = isLight(it.color) ? '#111111' : '#ffffff';
    }
    ctx.font = fontCss(it, fs);
    ctx.textBaseline = 'middle';
    ctx.fillStyle = fill;
    if (it.bg === 'none') { ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = fs * 0.12; ctx.shadowOffsetY = fs * 0.03; }
    const top = -L.h / 2 + L.pad + L.lh / 2 - (it.bg === 'none' ? 0 : fs * 0.05);
    L.lines.forEach((ln, i) => {
      let x;
      if (it.align === 'left') { ctx.textAlign = 'left'; x = -L.tw / 2; }
      else if (it.align === 'right') { ctx.textAlign = 'right'; x = L.tw / 2; }
      else { ctx.textAlign = 'center'; x = 0; }
      ctx.fillText(ln, x, top + i * L.lh);
    });
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    return L;
  }

  /* ───────── camada sobre a foto ───────── */
  function layer() { return $('wtLayer'); }

  /* posiciona a camada exatamente sobre o conteúdo visível da foto */
  function fitLayer() {
    const ly = layer(), img = $('modalImg');
    if (!ly || !img.naturalWidth) return null;
    const r = imageContentRect();
    Object.assign(ly.style, { left: r.offX + 'px', top: r.offY + 'px', width: r.drawW + 'px', height: r.drawH + 'px' });
    return r;
  }

  function renderEl(it) {
    const ly = layer(); if (!ly) return;
    const W = ly.clientWidth || 1, H = ly.clientHeight || 1;
    if (!it.el) {
      it.el = document.createElement('canvas');
      it.el.className = 'wt-item';
      it.el.dataset.id = it.id;
      it.el.setAttribute('role', 'button');
      it.el.setAttribute('aria-label', 'Texto: ' + it.text);
      ly.appendChild(it.el);
    }
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const fs = FS_REL * W * it.scale;
    const c = it.el, ctx = c.getContext('2d');
    const L = layout(ctx, it, fs);
    const cw = Math.ceil(L.w + fs * 0.4), ch = Math.ceil(L.h + fs * 0.4);
    c.width = Math.max(1, Math.round(cw * dpr)); c.height = Math.max(1, Math.round(ch * dpr));
    c.style.width = cw + 'px'; c.style.height = ch + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, c.width / 2, c.height / 2);
    drawItem(ctx, it, fs);
    it._rs = it.scale;
    place(it, W, H);
  }

  function place(it, W, H) {
    const ly = layer();
    W = W || ly.clientWidth; H = H || ly.clientHeight;
    const k = it.scale / (it._rs || it.scale);
    it.el.style.left = (it.x * W) + 'px';
    it.el.style.top = (it.y * H) + 'px';
    it.el.style.transform = `translate(-50%,-50%) rotate(${it.rot}rad) scale(${k})`;
  }

  function renderAll() { if (!fitLayer()) return; items.forEach(renderEl); updateUI(); }

  function updateUI() {
    const n = items.length;
    const hint = $('wtHint'); if (hint) hint.classList.toggle('hidden', !active || n > 0 || !$('wtComposer').classList.contains('hidden'));
    const ap = $('wtApply'); if (ap) ap.disabled = !n;
    const cl = $('wtClear'); if (cl) cl.disabled = !n;
  }

  /* ───────── gestos ───────── */
  const ptrs = new Map();
  let g = null;            /* gesto em curso */

  function onDown(e) {
    if (!active) return;
    const ly = layer();
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { ly.setPointerCapture(e.pointerId); } catch (_) {}
    const target = e.target.closest && e.target.closest('.wt-item');
    if (ptrs.size === 1) {
      const it = target ? items.find(i => i.id === +target.dataset.id) : null;
      g = { it, start: { x: e.clientX, y: e.clientY }, t0: performance.now(), moved: false, ox: it && it.x, oy: it && it.y };
      if (it) { ly.appendChild(it.el); it.el.classList.add('grab'); }    /* traz para frente */
    } else if (ptrs.size === 2 && g) {
      if (!g.it) {
        /* segundo dedo sem texto escolhido: usa o texto mais próximo do centro do gesto */
        const p = [...ptrs.values()], cx = (p[0].x + p[1].x) / 2, cy = (p[0].y + p[1].y) / 2;
        g.it = nearest(cx, cy);
        if (!g.it) return;
      }
      startPinch();
    }
    e.preventDefault();
  }

  function nearest(cx, cy) {
    let best = null, bd = Infinity;
    for (const it of items) {
      const r = it.el.getBoundingClientRect(), d = Math.hypot(r.left + r.width / 2 - cx, r.top + r.height / 2 - cy);
      if (d < bd) { bd = d; best = it; }
    }
    return best;
  }

  function startPinch() {
    const p = [...ptrs.values()];
    g.pinch = { d0: Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y) || 1, a0: Math.atan2(p[1].y - p[0].y, p[1].x - p[0].x), s0: g.it.scale, r0: g.it.rot };
    g.moved = true;
    showTrash(false);
  }

  function onMove(e) {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!g || !g.it) return;
    const ly = layer(), W = ly.clientWidth, H = ly.clientHeight;
    if (g.pinch && ptrs.size >= 2) {
      const p = [...ptrs.values()];
      const d = Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y), a = Math.atan2(p[1].y - p[0].y, p[1].x - p[0].x);
      g.it.scale = Math.max(0.25, Math.min(6, g.pinch.s0 * d / g.pinch.d0));
      g.it.rot = g.pinch.r0 + (a - g.pinch.a0);
      place(g.it, W, H);
    } else if (ptrs.size === 1 && !g.pinch) {
      const dx = e.clientX - g.start.x, dy = e.clientY - g.start.y;
      if (!g.moved && Math.hypot(dx, dy) > 6) { g.moved = true; showTrash(true); }
      if (g.moved) {
        g.it.x = Math.max(-0.1, Math.min(1.1, g.ox + dx / W));
        g.it.y = Math.max(-0.1, Math.min(1.1, g.oy + dy / H));
        place(g.it, W, H);
        const over = overTrash(e.clientX, e.clientY);
        $('wtTrash').classList.toggle('over', over);
        g.it.el.classList.toggle('doomed', over);
      }
    }
    e.preventDefault();
  }

  function onUp(e) {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId);
    if (!g) return;
    if (ptrs.size === 1 && g.pinch) {
      /* sobrou um dedo depois da pinça: continua arrastando a partir dele */
      const p = [...ptrs.values()][0];
      g.pinch = null; g.start = { x: p.x, y: p.y }; g.ox = g.it.x; g.oy = g.it.y;
      if (g.it._rs !== g.it.scale) renderEl(g.it);
      return;
    }
    if (ptrs.size) return;
    const it = g.it;
    const tap = !g.moved && performance.now() - g.t0 < 450;
    if (it) {
      it.el.classList.remove('grab', 'doomed');
      if (g.moved && !g.pinch && overTrash(e.clientX, e.clientY)) remove(it);
      else if (tap) compose(it);
      else if (it._rs !== it.scale) renderEl(it);
    } else if (tap) {
      /* toque numa área vazia da foto: novo texto (como no WhatsApp) */
      compose(null);
    }
    showTrash(false);
    g = null;
  }

  function onWheel(e) {
    if (!active) return;
    const el = e.target.closest && e.target.closest('.wt-item'); if (!el) return;
    const it = items.find(i => i.id === +el.dataset.id); if (!it) return;
    e.preventDefault();
    if (e.shiftKey) it.rot += (e.deltaY || e.deltaX) > 0 ? 0.08 : -0.08;
    else it.scale = Math.max(0.25, Math.min(6, it.scale * (e.deltaY > 0 ? 0.92 : 1.08)));
    place(it);
    clearTimeout(it._wt); it._wt = setTimeout(() => renderEl(it), 160);
  }

  function showTrash(on) { const t = $('wtTrash'); t.classList.toggle('show', on); if (!on) t.classList.remove('over'); }
  function overTrash(x, y) {
    const r = $('wtTrash').getBoundingClientRect();
    return x > r.left - 16 && x < r.right + 16 && y > r.top - 16 && y < r.bottom + 16;
  }

  function remove(it) {
    items = items.filter(i => i !== it);
    if (it.el) it.el.remove();
    updateUI();
    toast('🗑️ Texto apagado');
  }

  /* ───────── compositor (tela cheia) ───────── */
  function compose(it) {
    if (!$('modalImg').naturalWidth) { toast('Imagem ainda carregando'); return; }
    editing = it || null;
    draft = it ? { font: it.font, color: it.color, bg: it.bg, align: it.align } : { font: lastStyle.font, color: lastStyle.color, bg: lastStyle.bg, align: lastStyle.align };
    colorPos = it ? (it.colorPos != null ? it.colorPos : 0) : lastStyle.colorPos;
    if (it && it.el) it.el.classList.add('hidden');
    $('wtHint').classList.add('hidden');
    const inp = $('wtInput');
    inp.value = it ? it.text : '';
    $('wtComposer').classList.remove('hidden');
    styleInput();
    /* foco imediato (dentro do toque): no iPhone o teclado só abre assim */
    inp.focus(); const n = inp.value.length; inp.setSelectionRange(n, n);
    setTimeout(styleInput, 0);
  }

  function styleInput() {
    const inp = $('wtInput'), f = FONTS[draft.font] || FONTS[0];
    const len = inp.value.length;
    const size = Math.round(Math.max(22, Math.min(38, 38 - Math.max(0, len - 20) * 0.25)));
    inp.style.fontFamily = f.family;
    inp.style.fontWeight = f.weight;
    inp.style.fontStyle = f.style || 'normal';
    inp.style.textTransform = f.upper ? 'uppercase' : 'none';
    inp.style.fontSize = size + 'px';
    inp.style.textAlign = draft.align;
    if (draft.bg === 'solid') { inp.style.background = draft.color; inp.style.color = isLight(draft.color) ? '#111' : '#fff'; inp.style.textShadow = 'none'; }
    else if (draft.bg === 'dark') { inp.style.background = 'rgba(0,0,0,.55)'; inp.style.color = draft.color; inp.style.textShadow = 'none'; }
    else { inp.style.background = 'transparent'; inp.style.color = draft.color; inp.style.textShadow = '0 1px 4px rgba(0,0,0,.45)'; }
    inp.style.caretColor = draft.bg === 'solid' ? inp.style.color : draft.color;
    /* a caixa abraça o texto (como no WhatsApp) até a largura máxima */
    const mc = styleInput._c || (styleInput._c = document.createElement('canvas').getContext('2d'));
    mc.font = `${f.style || 'normal'} ${f.weight} ${size}px ${f.family}`;
    const raw = f.upper ? inp.value.toUpperCase() : inp.value;
    const longest = Math.max(mc.measureText(inp.placeholder).width * (inp.value ? 0 : 1), ...raw.split('\n').map(l => mc.measureText(l + 'W').width));
    const maxW = inp.parentElement.clientWidth - 88;
    inp.style.width = Math.max(size * 1.6, Math.min(maxW, longest + size * 0.9)) + 'px';
    inp.style.height = 'auto';
    inp.style.height = Math.min(inp.scrollHeight + 2, window.innerHeight * 0.45) + 'px';
    $('wtFontBtn').style.fontFamily = f.family;
    $('wtFontBtn').style.fontStyle = f.style || 'normal';
    $('wtFontName').textContent = f.name;
    const bgBtn = $('wtBgBtn');
    bgBtn.dataset.bg = draft.bg;
    bgBtn.setAttribute('aria-label', { none: 'Fundo do texto: nenhum', solid: 'Fundo do texto: caixa colorida', dark: 'Fundo do texto: caixa escura' }[draft.bg]);
    $('wtAlignBtn').dataset.align = draft.align;
    const AL = { center: ['M4 6h16', 'M7 12h10', 'M5 18h14'], left: ['M4 6h16', 'M4 12h10', 'M4 18h14'], right: ['M4 6h16', 'M10 12h10', 'M6 18h14'] }[draft.align];
    $('wtAlignBtn').querySelectorAll('path').forEach((p, i) => p.setAttribute('d', AL[i]));
    $('wtAlignBtn').setAttribute('aria-label', 'Alinhamento: ' + { center: 'centro', left: 'esquerda', right: 'direita' }[draft.align]);
    const th = $('wtColorThumb');
    th.style.top = (colorPos * 100) + '%';
    th.style.background = draft.color;
    $('wtColors').setAttribute('aria-valuenow', Math.round(colorPos * 100));
  }

  function nextFont() { draft.font = (draft.font + 1) % FONTS.length; styleInput(); $('wtInput').focus(); }
  function nextBg() { draft.bg = BGS[(BGS.indexOf(draft.bg) + 1) % BGS.length]; styleInput(); $('wtInput').focus(); }
  function nextAlign() { draft.align = ALIGNS[(ALIGNS.indexOf(draft.align) + 1) % ALIGNS.length]; styleInput(); $('wtInput').focus(); }

  function pickColor(clientY) {
    const r = $('wtColors').getBoundingClientRect();
    colorPos = Math.max(0, Math.min(1, (clientY - r.top) / r.height));
    draft.color = colorAt(colorPos);
    styleInput();
  }
  function setColorPos(t) { colorPos = Math.max(0, Math.min(1, t)); draft.color = colorAt(colorPos); styleInput(); }

  function done() {
    const comp = $('wtComposer');
    if (comp.classList.contains('hidden')) return;
    const text = $('wtInput').value.replace(/\s+$/, '').replace(/^\n+/, '');
    comp.classList.add('hidden');
    $('wtInput').blur();
    lastStyle = { font: draft.font, color: draft.color, bg: draft.bg, align: draft.align, colorPos };
    if (editing) {
      const it = editing; editing = null;
      if (!text.trim()) { remove(it); return; }
      Object.assign(it, draft, { text, colorPos });
      it.el.classList.remove('hidden');
      it.el.setAttribute('aria-label', 'Texto: ' + text);
      renderEl(it);
    } else if (text.trim()) {
      fitLayer();
      const it = { id: nextId++, text, ...draft, colorPos, x: 0.5, y: 0.42, scale: 1, rot: 0, el: null };
      items.push(it);
      renderEl(it);
    }
    updateUI();
  }

  function cancel() {
    const comp = $('wtComposer');
    if (comp.classList.contains('hidden')) return false;
    comp.classList.add('hidden');
    $('wtInput').blur();
    if (editing && editing.el) editing.el.classList.remove('hidden');
    editing = null;
    updateUI();
    return true;
  }

  /* ───────── incorporar à foto ───────── */
  function bakeTo(ctx, W, H) {
    for (const it of items) {
      ctx.save();
      ctx.translate(it.x * W, it.y * H);
      ctx.rotate(it.rot);
      drawItem(ctx, it, FS_REL * W * it.scale);
      ctx.restore();
    }
  }

  function apply(silent) {
    if (!items.length) { if (!silent) toast('Toque na foto para escrever um texto'); return false; }
    const p = photos[editingIdx]; if (!p || p.type === 'video') return false;
    const img = $('modalImg');
    if (!img.naturalWidth) { toast('Imagem ainda carregando'); return false; }
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    bakeTo(ctx, canvas.width, canvas.height);
    clearItems();
    commitBaked(p, canvas.toDataURL('image/jpeg', .93), canvas.width, canvas.height, t('textApplied'));
    return true;
  }

  function clearItems() { items.forEach(i => i.el && i.el.remove()); items = []; updateUI(); }
  function clear() { if (items.length) { clearItems(); toast('Textos removidos'); } }

  /* ───────── ciclo de vida da aba ───────── */
  function open() {
    active = true;
    layer().classList.remove('hidden');
    requestAnimationFrame(renderAll);
    updateUI();
    /* como no WhatsApp: abrir a ferramenta já começa a escrever */
    if (!items.length) compose(null);
  }
  function close(opts) {
    cancel();
    if (items.length && !(opts && opts.discard)) apply(true);
    active = false;            /* antes de limpar: senão o aviso "Toque na foto" voltava a aparecer */
    clearItems();
    const ly = layer(); if (ly) ly.classList.add('hidden');
    showTrash(false);
    ptrs.clear(); g = null;
  }

  function init() {
    const ly = layer(); if (!ly) return;
    ly.addEventListener('pointerdown', onDown);
    ly.addEventListener('pointermove', onMove);
    ly.addEventListener('pointerup', onUp);
    ly.addEventListener('pointercancel', onUp);
    ly.addEventListener('wheel', onWheel, { passive: false });

    const inp = $('wtInput');
    inp.addEventListener('input', styleInput);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); done(); }
    });
    /* tocar fora do texto (no fundo escurecido) conclui */
    $('wtComposer').addEventListener('pointerdown', e => { if (e.target.id === 'wtComposer' || e.target.classList.contains('wt-stage')) { e.preventDefault(); done(); } });

    const bar = $('wtColors');
    let picking = false;
    bar.addEventListener('pointerdown', e => { picking = true; try { bar.setPointerCapture(e.pointerId); } catch (_) {} pickColor(e.clientY); e.preventDefault(); });
    bar.addEventListener('pointermove', e => { if (picking) { pickColor(e.clientY); e.preventDefault(); } });
    const stop = () => { if (picking) { picking = false; $('wtInput').focus(); } };
    bar.addEventListener('pointerup', stop); bar.addEventListener('pointercancel', stop);
    bar.addEventListener('keydown', e => {
      const step = { ArrowDown: .05, ArrowRight: .05, ArrowUp: -.05, ArrowLeft: -.05 }[e.key];
      if (step) { e.preventDefault(); setColorPos(colorPos + step); }
    });

    window.addEventListener('resize', () => { if (active) renderAll(); });
    $('modalImg').addEventListener('load', () => { if (active) renderAll(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  return {
    open, close, compose, done, cancel, apply, clear, nextFont, nextBg, nextAlign, setColorPos,
    get count() { return items.length; },
    isComposing: () => !$('wtComposer').classList.contains('hidden'),
    _debug: { get items() { return items; }, colorAt, FONTS },
  };
})();
