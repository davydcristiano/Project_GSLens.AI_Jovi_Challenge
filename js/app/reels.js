/* GSLens.AI — js/app/reels.js
   Montagem (estilo Reels do Instagram): várias fotos numa timeline, com
   música, duração por foto, transições, movimento (Ken Burns), prévia e
   exportação para um vídeo que vai para a galeria.

   - Timeline horizontal com a agulha fixa no centro: arrastar a timeline
     avança/volta no tempo (como no Instagram e no CapCut).
   - Cada foto é um bloco proporcional à duração; a alça da direita estica ou
     encolhe a foto; tocar seleciona e abre as ferramentas (duração,
     transição de entrada, movimento, mover, duplicar, excluir).
   - Música: arquivo do aparelho, com escolha do trecho, volume e onda sonora;
     a música termina suave no último segundo.
   - Exportar: o mesmo desenhista da prévia gera os quadros num canvas, que é
     gravado (MediaRecorder) junto com a música (Web Audio) em tempo real.
   Tudo roda no aparelho. */
'use strict';

const GSReel = (() => {
  const PX = 56;                       /* px por segundo na timeline */
  const TD = 0.5;                      /* duração da transição (s) */
  const MIN_D = 0.5, MAX_D = 15;
  const ASPECTS = { '9:16': [720, 1280], '1:1': [960, 960], '16:9': [1280, 720] };
  const TRANS = { none: 'Corte seco', fade: 'Esmaecer', slide: 'Deslizar', zoom: 'Zoom' };

  const R = {
    clips: [],                         /* { id, src, img, dur, trans, motion } */
    music: null,                       /* { name, buffer, start, vol, peaks } */
    aspect: '9:16',
    t: 0, playing: false, sel: -1, panel: null,
    exporting: false, cancelExport: false,
  };
  let nextId = 1, ac = null, src = null, gain = null, raf = 0, clock0 = 0, progScroll = -1;
  const $ = id => document.getElementById(id);
  const total = () => R.clips.reduce((s, c) => s + c.dur, 0);
  const fmt = s => { s = Math.max(0, s); const m = Math.floor(s / 60), r = Math.floor(s % 60); return m + ':' + String(r).padStart(2, '0'); };
  const fmt1 = s => (Math.round(s * 10) / 10).toFixed(1).replace('.', ',') + ' s';

  /* ───────── fotos ───────── */
  function loadImg(srcUrl) {
    return new Promise((res, rej) => { const im = new Image(); im.decoding = 'async'; im.onload = () => res(im); im.onerror = () => rej(new Error('imagem')); im.src = srcUrl; });
  }
  async function addSources(list) {
    let added = 0;
    for (const s of list) {
      try {
        const img = await loadImg(s);
        R.clips.push({ id: nextId++, src: s, img, dur: 3, trans: R.clips.length ? 'fade' : 'none', motion: true });
        added++;
      } catch (e) { /* imagem inválida: ignora */ }
    }
    if (added) { R.sel = -1; R.panel = null; }
    renderAll();
    return added;
  }

  /* ───────── desenho de um instante (prévia e exportação) ───────── */
  function startOf(i) { let s = 0; for (let k = 0; k < i; k++) s += R.clips[k].dur; return s; }
  function clipAt(t) {
    let s = 0;
    for (let i = 0; i < R.clips.length; i++) { const d = R.clips[i].dur; if (t < s + d || i === R.clips.length - 1) return { i, local: Math.min(d, Math.max(0, t - s)) }; s += d; }
    return null;
  }
  function drawClip(ctx, W, H, c, i, local, extraScale) {
    const im = c.img; if (!im) return;
    const p = c.dur > 0 ? Math.min(1, local / c.dur) : 0;
    const kb = c.motion ? 1 + 0.09 * (i % 2 ? 1 - p : p) : 1;
    const sc = Math.max(W / im.naturalWidth, H / im.naturalHeight) * kb * (extraScale || 1);
    const w = im.naturalWidth * sc, h = im.naturalHeight * sc;
    /* panorâmica leve alternando o lado */
    const pan = c.motion ? (i % 3 === 1 ? 1 : i % 3 === 2 ? -1 : 0) * (w - W) * 0.5 * (p - 0.5) : 0;
    ctx.drawImage(im, (W - w) / 2 + pan, (H - h) / 2, w, h);
  }
  function draw(ctx, W, H, t) {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    const at = clipAt(t); if (!at) return;
    const c = R.clips[at.i];
    if (at.i > 0 && c.trans !== 'none' && at.local < TD) {
      const prev = R.clips[at.i - 1], q = at.local / TD, e = q * q * (3 - 2 * q);
      drawClip(ctx, W, H, prev, at.i - 1, prev.dur);
      ctx.save();
      if (c.trans === 'fade') { ctx.globalAlpha = e; drawClip(ctx, W, H, c, at.i, at.local); }
      else if (c.trans === 'slide') { ctx.translate((1 - e) * W, 0); drawClip(ctx, W, H, c, at.i, at.local); }
      else if (c.trans === 'zoom') { ctx.globalAlpha = e; drawClip(ctx, W, H, c, at.i, at.local, 1 + 0.35 * (1 - e)); }
      ctx.restore();
    } else drawClip(ctx, W, H, c, at.i, at.local);
  }

  /* ───────── prévia ───────── */
  function canvas() { return $('reelCanvas'); }
  function sizeCanvas() {
    const [W, H] = ASPECTS[R.aspect], cv = canvas();
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    /* cabe na área disponível mantendo a proporção */
    const stage = $('reelStage'), sw = stage.clientWidth - 24, sh = stage.clientHeight - 16;
    const k = Math.min(sw / W, sh / H);
    cv.style.width = Math.max(40, Math.floor(W * k)) + 'px';
    cv.style.height = Math.max(40, Math.floor(H * k)) + 'px';
  }
  function paint() {
    const cv = canvas(), ctx = cv.getContext('2d');
    if (!R.clips.length) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height); return; }
    draw(ctx, cv.width, cv.height, Math.min(R.t, Math.max(0, total() - 1e-3)));
  }
  function updateTime() {
    $('reelTime').textContent = fmt(R.t) + ' / ' + fmt(total());
    const tl = $('reelTimeline');
    if (tl) { tl.scrollLeft = R.t * PX; progScroll = tl.scrollLeft; }
  }

  /* ───────── áudio ───────── */
  function audioCtx() {
    if (!ac) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) ac = new AC(); }
    if (ac && ac.state === 'suspended') ac.resume();
    return ac;
  }
  function startMusic(t, dest) {
    stopMusic();
    if (!R.music || !audioCtx()) return;
    const m = R.music, T = total();
    src = ac.createBufferSource(); src.buffer = m.buffer;
    gain = ac.createGain();
    const now = ac.currentTime, rest = Math.max(0, T - t);
    gain.gain.setValueAtTime(m.vol, now);
    /* termina suave no último segundo do vídeo */
    const fadeAt = now + Math.max(0, rest - 1);
    gain.gain.setValueAtTime(m.vol, fadeAt);
    gain.gain.linearRampToValueAtTime(0.0001, now + rest);
    src.connect(gain); gain.connect(dest || ac.destination);
    const off = (m.start + t) % m.buffer.duration;
    src.start(now, off, rest);
  }
  function stopMusic() {
    if (src) { try { src.stop(); } catch (e) {} try { src.disconnect(); } catch (e) {} src = null; }
    if (gain) { try { gain.disconnect(); } catch (e) {} gain = null; }
  }

  /* ───────── reprodução ───────── */
  /* relógio da imagem: sempre o do sistema (o do áudio para se o navegador
     ainda não liberou o som); a música é agendada no relógio do áudio */
  function nowS() { return performance.now() / 1000; }
  function play() {
    if (!R.clips.length) { toast('Adicione fotos primeiro'); return; }
    if (R.t >= total() - 0.05) R.t = 0;
    audioCtx();
    R.playing = true;
    clock0 = nowS() - R.t;
    startMusic(R.t);
    $('reelPlay').classList.add('playing');
    $('reelPlay').setAttribute('aria-label', 'Pausar');
    const loop = () => {
      if (!R.playing) return;
      R.t = nowS() - clock0;
      if (R.t >= total()) { R.t = total(); pause(); paint(); updateTime(); return; }
      paint(); updateTime();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  }
  function pause() {
    R.playing = false; cancelAnimationFrame(raf); stopMusic();
    const b = $('reelPlay'); if (b) { b.classList.remove('playing'); b.setAttribute('aria-label', 'Reproduzir'); }
  }
  function togglePlay() { if (R.playing) pause(); else play(); }
  function seek(t) { R.t = Math.max(0, Math.min(total(), t)); if (R.playing) { clock0 = nowS() - R.t; startMusic(R.t); } paint(); $('reelTime').textContent = fmt(R.t) + ' / ' + fmt(total()); }

  /* ───────── timeline ───────── */
  function renderTimeline() {
    const tl = $('reelTimeline'), inner = $('reelTlInner'), track = $('reelTrack'), ruler = $('reelRuler'), aud = $('reelAudio');
    const half = Math.round(tl.clientWidth / 2), T = total();
    inner.style.paddingLeft = half + 'px'; inner.style.paddingRight = half + 'px';
    inner.style.width = (T * PX + half * 2) + 'px';
    /* régua */
    ruler.innerHTML = '';
    for (let s = 0; s <= Math.ceil(T); s++) {
      const tick = document.createElement('span');
      tick.className = 'reel-tick' + (s % 5 === 0 ? ' major' : '');
      tick.style.left = (s * PX) + 'px';
      if (s % 2 === 0) tick.textContent = fmt(s);
      ruler.appendChild(tick);
    }
    ruler.style.width = (T * PX) + 'px';
    /* fotos */
    track.innerHTML = '';
    R.clips.forEach((c, i) => {
      const el = document.createElement('div');
      el.className = 'reel-clip' + (i === R.sel ? ' sel' : '');
      el.style.width = Math.max(8, c.dur * PX - 3) + 'px';
      el.style.backgroundImage = `url("${c.src}")`;
      el.setAttribute('role', 'button');
      el.tabIndex = 0;
      el.dataset.i = i;
      el.setAttribute('aria-label', `Foto ${i + 1}, ${fmt1(c.dur)}`);
      const lab = document.createElement('span'); lab.className = 'reel-clip-dur'; lab.textContent = fmt1(c.dur);
      el.appendChild(lab);
      if (i > 0 && c.trans !== 'none') {
        const tr = document.createElement('span'); tr.className = 'reel-trans'; tr.title = 'Transição: ' + TRANS[c.trans];
        tr.setAttribute('aria-hidden', 'true');
        el.appendChild(tr);
      }
      const h = document.createElement('span'); h.className = 'reel-handle'; h.setAttribute('aria-hidden', 'true');
      el.appendChild(h);
      track.appendChild(el);
    });
    /* música */
    if (R.music) {
      aud.classList.remove('hidden');
      aud.style.width = (T * PX) + 'px';
      $('reelAudioName').textContent = '♪ ' + R.music.name;
      drawWave();
    } else aud.classList.add('hidden');
    $('reelAddMusic').classList.toggle('hidden', !!R.music);
  }

  function drawWave() {
    const cv = $('reelWave'), m = R.music; if (!cv || !m) return;
    const T = total(), w = Math.max(1, Math.round(T * PX)), h = 30, dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = w * dpr; cv.height = h * dpr; cv.style.width = w + 'px'; cv.style.height = h + 'px';
    const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    const per = m.peaks.length / m.buffer.duration;   /* picos por segundo */
    for (let x = 0; x < w; x += 3) {
      const s = (m.start + x / PX) % m.buffer.duration;
      const v = m.peaks[Math.min(m.peaks.length - 1, Math.floor(s * per))] || 0;
      const bh = Math.max(2, v * (h - 4));
      ctx.fillRect(x, (h - bh) / 2, 2, bh);
    }
  }

  function computePeaks(buf) {
    const n = Math.min(4000, Math.ceil(buf.duration * 20)), ch = buf.getChannelData(0), step = Math.floor(ch.length / n) || 1;
    const out = new Float32Array(n); let mx = 1e-6;
    for (let i = 0; i < n; i++) { let p = 0; for (let k = i * step, e = Math.min(ch.length, k + step); k < e; k += 8) { const a = Math.abs(ch[k]); if (a > p) p = a; } out[i] = p; if (p > mx) mx = p; }
    for (let i = 0; i < n; i++) out[i] /= mx;
    return out;
  }

  /* ───────── painel contextual ───────── */
  function renderPanel() {
    const P = $('reelPanel');
    if (R.panel === 'clip' && R.clips[R.sel]) {
      const c = R.clips[R.sel], i = R.sel;
      P.innerHTML = `
        <div class="reel-panel-head"><b>Foto ${i + 1} de ${R.clips.length}</b><button class="btn reel-x" onclick="GSReel.closePanel()" aria-label="Fechar ferramentas">✕</button></div>
        <label class="reel-row"><span>Duração</span><input type="range" id="reelDur" class="custom-range" min="${MIN_D}" max="${MAX_D}" step="0.5" value="${c.dur}" aria-label="Duração da foto"><output id="reelDurV">${fmt1(c.dur)}</output></label>
        <div class="reel-row"><span>Entrada</span><div class="reel-chips" role="group" aria-label="Transição de entrada">${Object.entries(TRANS).map(([k, v]) => `<button class="btn reel-chip${c.trans === k ? ' active' : ''}" data-tr="${k}" aria-pressed="${c.trans === k}" ${i === 0 && k !== 'none' ? 'disabled' : ''}>${v}</button>`).join('')}</div></div>
        <div class="reel-row"><span>Movimento</span><button class="btn reel-chip${c.motion ? ' active' : ''}" id="reelMotion" aria-pressed="${c.motion}">${c.motion ? 'Ligado' : 'Desligado'}</button></div>
        <div class="reel-actions">
          <button class="btn reel-act" id="reelLeft" ${i === 0 ? 'disabled' : ''}>◀ Mover</button>
          <button class="btn reel-act" id="reelRight" ${i === R.clips.length - 1 ? 'disabled' : ''}>Mover ▶</button>
          <button class="btn reel-act" id="reelDup">Duplicar</button>
          <button class="btn reel-act danger" id="reelDel">Excluir</button>
        </div>`;
      P.classList.remove('hidden');
      $('reelDur').oninput = e => { c.dur = +e.target.value; $('reelDurV').textContent = fmt1(c.dur); renderTimeline(); R.t = Math.min(R.t, total()); updateTime(); paint(); };
      P.querySelectorAll('[data-tr]').forEach(b => b.onclick = () => { c.trans = b.dataset.tr; renderPanel(); renderTimeline(); seek(startOf(i)); });
      $('reelMotion').onclick = () => { c.motion = !c.motion; renderPanel(); paint(); };
      $('reelLeft').onclick = () => move(i, -1);
      $('reelRight').onclick = () => move(i, 1);
      $('reelDup').onclick = () => { R.clips.splice(i + 1, 0, { ...c, id: nextId++ }); R.sel = i + 1; renderAll(); };
      $('reelDel').onclick = () => { R.clips.splice(i, 1); if (R.clips[0]) R.clips[0].trans = 'none'; R.sel = -1; R.panel = null; R.t = Math.min(R.t, total()); renderAll(); toast('Foto removida da montagem'); };
    } else if (R.panel === 'music' && R.music) {
      const m = R.music, maxStart = Math.max(0, m.buffer.duration - Math.min(total(), m.buffer.duration));
      P.innerHTML = `
        <div class="reel-panel-head"><b>♪ ${escapeHtml(m.name)}</b><button class="btn reel-x" onclick="GSReel.closePanel()" aria-label="Fechar ferramentas">✕</button></div>
        <label class="reel-row"><span>Trecho</span><input type="range" id="reelMStart" class="custom-range" min="0" max="${maxStart.toFixed(1)}" step="0.1" value="${Math.min(m.start, maxStart)}" aria-label="Início da música" ${maxStart ? '' : 'disabled'}><output id="reelMStartV">${fmt(m.start)}</output></label>
        <label class="reel-row"><span>Volume</span><input type="range" id="reelMVol" class="custom-range" min="0" max="1" step="0.05" value="${m.vol}" aria-label="Volume da música"><output id="reelMVolV">${Math.round(m.vol * 100)}%</output></label>
        <div class="reel-actions">
          <button class="btn reel-act" onclick="document.getElementById('reelMusicInput').click()">Trocar música</button>
          <button class="btn reel-act danger" id="reelMDel">Remover música</button>
        </div>`;
      P.classList.remove('hidden');
      $('reelMStart').oninput = e => { m.start = +e.target.value; $('reelMStartV').textContent = fmt(m.start); drawWave(); if (R.playing) startMusic(R.t); };
      $('reelMVol').oninput = e => { m.vol = +e.target.value; $('reelMVolV').textContent = Math.round(m.vol * 100) + '%'; if (gain && ac) gain.gain.setValueAtTime(m.vol, ac.currentTime); };
      $('reelMDel').onclick = () => { pause(); R.music = null; R.panel = null; renderAll(); toast('Música removida'); };
    } else { P.classList.add('hidden'); P.innerHTML = ''; }
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function move(i, d) {
    const j = i + d; if (j < 0 || j >= R.clips.length) return;
    [R.clips[i], R.clips[j]] = [R.clips[j], R.clips[i]];
    R.clips[0].trans = 'none';
    if (R.clips[j].trans === 'none' && j > 0) R.clips[j].trans = 'fade';
    R.sel = j; renderAll(); seek(startOf(j) + 0.01);
  }
  function selectClip(i) {
    R.sel = i; R.panel = 'clip';
    renderTimeline(); renderPanel();
    if (!R.playing) seek(startOf(i) + Math.min(0.6, R.clips[i].dur / 2)), updateTime();
  }
  function closePanel() { R.sel = -1; R.panel = null; renderTimeline(); renderPanel(); }

  function renderAll() {
    const has = R.clips.length > 0;
    $('reelEmpty').classList.toggle('hidden', has);
    $('reelExportBtn').disabled = !has;
    $('reelPlay').disabled = !has;
    document.querySelectorAll('.reel-aspect').forEach(b => { const on = b.dataset.a === R.aspect; b.classList.toggle('active', on); b.setAttribute('aria-pressed', on); });
    sizeCanvas(); renderTimeline(); renderPanel(); paint(); updateTime();
  }

  /* ───────── gestos na timeline ───────── */
  function initTimeline() {
    const tl = $('reelTimeline'), track = $('reelTrack');
    tl.addEventListener('scroll', () => {
      /* rolagem feita pelo próprio app (reprodução/seleção): ignora */
      if (R.exporting || Math.abs(tl.scrollLeft - progScroll) < 1.5) return;
      if (R.playing) pause();
      seek(tl.scrollLeft / PX);
    }, { passive: true });
    /* tocar numa foto seleciona; arrastar a alça muda a duração */
    let drag = null;
    track.addEventListener('pointerdown', e => {
      const h = e.target.closest('.reel-handle'), el = e.target.closest('.reel-clip'); if (!el) return;
      const i = +el.dataset.i;
      if (h) {
        e.preventDefault(); e.stopPropagation();
        if (R.playing) pause();
        drag = { i, x0: e.clientX, d0: R.clips[i].dur };
        try { h.setPointerCapture(e.pointerId); } catch (_) {}
        R.sel = i; R.panel = 'clip';
        return;
      }
      el._down = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    track.addEventListener('pointermove', e => {
      if (!drag) return;
      const c = R.clips[drag.i];
      c.dur = Math.max(MIN_D, Math.min(MAX_D, Math.round((drag.d0 + (e.clientX - drag.x0) / PX) * 10) / 10));
      const el = track.children[drag.i];
      if (el) { el.style.width = Math.max(8, c.dur * PX - 3) + 'px'; el.querySelector('.reel-clip-dur').textContent = fmt1(c.dur); }
      $('reelTime').textContent = fmt(R.t) + ' / ' + fmt(total());
    });
    const endDrag = () => { if (drag) { drag = null; renderTimeline(); renderPanel(); paint(); updateTime(); } };
    track.addEventListener('pointerup', e => {
      if (drag) { endDrag(); return; }
      const el = e.target.closest('.reel-clip'); if (!el || !el._down) return;
      const d = el._down; el._down = null;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 8 && performance.now() - d.t < 500) selectClip(+el.dataset.i);
    });
    track.addEventListener('pointercancel', endDrag);
    track.addEventListener('keydown', e => {
      const el = e.target.closest('.reel-clip'); if (!el) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectClip(+el.dataset.i); }
    });
    $('reelAudio').addEventListener('click', () => { R.sel = -1; R.panel = 'music'; renderTimeline(); renderPanel(); });
    window.addEventListener('resize', () => { if (isOpen()) { sizeCanvas(); renderTimeline(); paint(); updateTime(); } });
  }

  /* ───────── seletor de fotos (galeria + aparelho) ───────── */
  const pick = [];
  function openPicker() {
    pick.length = 0;
    const grid = $('reelPickGrid'); grid.innerHTML = '';
    const list = photos.filter(p => p.type !== 'video' && p.dataUrl);
    $('reelPickEmpty').classList.toggle('hidden', list.length > 0);
    list.forEach(p => {
      const b = document.createElement('button');
      b.className = 'btn reel-pick-cell'; b.type = 'button';
      b.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-label', 'Foto de ' + new Date(p.id).toLocaleString('pt-BR'));
      const im = document.createElement('img'); im.src = p.dataUrl; im.alt = ''; im.loading = 'lazy'; im.decoding = 'async';
      const n = document.createElement('span'); n.className = 'reel-pick-n';
      b.appendChild(im); b.appendChild(n);
      b.onclick = () => {
        const k = pick.indexOf(p.dataUrl);
        if (k >= 0) pick.splice(k, 1); else pick.push(p.dataUrl);
        updatePickNums();
      };
      b._src = p.dataUrl;
      grid.appendChild(b);
    });
    updatePickNums();
    $('reelPicker').classList.remove('hidden');
  }
  function updatePickNums() {
    document.querySelectorAll('#reelPickGrid .reel-pick-cell').forEach(b => {
      const k = pick.indexOf(b._src);
      b.classList.toggle('on', k >= 0); b.setAttribute('aria-pressed', k >= 0);
      b.querySelector('.reel-pick-n').textContent = k >= 0 ? k + 1 : '';
    });
    const btn = $('reelPickAdd'); btn.disabled = !pick.length;
    btn.textContent = pick.length ? `Adicionar (${pick.length})` : 'Adicionar';
  }
  function closePicker() { $('reelPicker').classList.add('hidden'); }
  async function confirmPicker() { const list = pick.slice(); closePicker(); const n = await addSources(list); if (n) toast(`${n} foto${n > 1 ? 's' : ''} na montagem`); }
  function readFileUrl(f) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); }); }
  async function onDeviceFiles(files) {
    const urls = [];
    for (const f of files) if (/^image\//.test(f.type)) urls.push(await readFileUrl(f));
    closePicker();
    const n = await addSources(urls);
    if (n) toast(`${n} foto${n > 1 ? 's' : ''} na montagem`);
  }

  async function onMusicFile(f) {
    if (!f) return;
    if (!audioCtx()) { toast('⚠️ Este navegador não reproduz áudio'); return; }
    toast('🎵 Carregando música…');
    try {
      const buf = await ac.decodeAudioData(await f.arrayBuffer());
      pause();
      R.music = { name: f.name.replace(/\.[^.]+$/, '') || 'Música', buffer: buf, start: 0, vol: 0.9, peaks: computePeaks(buf) };
      R.sel = -1; R.panel = 'music';
      renderAll();
      toast('🎵 Música adicionada');
    } catch (e) {
      console.warn('Música:', e);
      toast('⚠️ Não foi possível ler esse arquivo de áudio');
    }
  }

  function setAspect(a) { if (!ASPECTS[a]) return; R.aspect = a; renderAll(); }

  /* ───────── exportar ───────── */
  async function exportVideo() {
    if (!R.clips.length || R.exporting) return;
    const cv = canvas();
    if (!window.MediaRecorder || !cv.captureStream) { toast('⚠️ Este navegador não consegue gerar vídeo'); return; }
    pause(); closePanel();
    const T = total(), [W, H] = ASPECTS[R.aspect];
    cv.width = W; cv.height = H;
    const vstream = cv.captureStream(30);
    const tracks = [...vstream.getVideoTracks()];
    let dest = null;
    if (R.music && audioCtx()) { dest = ac.createMediaStreamDestination(); tracks.push(...dest.stream.getAudioTracks()); }
    const mime = typeof pickRecorderMime === 'function' ? pickRecorderMime() : '';
    let rec;
    try { rec = mime ? new MediaRecorder(new MediaStream(tracks), { mimeType: mime, videoBitsPerSecond: 6e6 }) : new MediaRecorder(new MediaStream(tracks)); }
    catch (e) { toast('⚠️ Não foi possível iniciar a gravação do vídeo'); return; }
    const chunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise(res => { rec.onstop = res; });

    if (dest && ac.state !== 'running') { try { await ac.resume(); } catch (e) {} }
    R.exporting = true; R.cancelExport = false;
    const ov = $('reelProc'); ov.classList.remove('hidden');
    const setP = p => { $('reelProcBar').style.width = Math.round(p * 100) + '%'; $('reelProcPct').textContent = Math.round(p * 100) + '%'; };
    setP(0);
    const ctx = cv.getContext('2d');
    draw(ctx, W, H, 0);
    rec.start(250);
    const t0 = nowS();
    if (dest) startMusic(0, dest);
    await new Promise(res => {
      const step = () => {
        if (R.cancelExport) return res();
        const t = nowS() - t0;
        if (t >= T) { draw(ctx, W, H, T - 1e-3); return res(); }
        draw(ctx, W, H, t); setP(t / T);
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    /* dá tempo ao último quadro antes de parar */
    await new Promise(r => setTimeout(r, 120));
    rec.stop(); stopMusic();
    await done;
    vstream.getTracks().forEach(tk => tk.stop());
    ov.classList.add('hidden');
    R.exporting = false;
    if (R.cancelExport) { toast('Exportação cancelada'); renderAll(); return; }
    const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
    const blob = new Blob(chunks, { type });
    if (!blob.size) { toast('⚠️ O vídeo saiu vazio'); renderAll(); return; }
    const item = { id: Date.now(), blob, dataUrl: URL.createObjectURL(blob), type: 'video', mode: 'montagem', mime: type, filter: 'none', w: W, h: H, seconds: Math.round(T) };
    photos.unshift(item);
    savePhotoToDB(item).catch(() => toast('⚠️ Vídeo salvo só nesta sessão (armazenamento cheio?)'));
    updateThumbFromPhotos(); renderGallery();
    renderAll();
    toast('🎬 Vídeo da montagem salvo na galeria');
    lastExport = item;
    $('reelDone').classList.remove('hidden');
  }
  let lastExport = null;
  function cancelExport() { R.cancelExport = true; }

  /* ───────── abrir / fechar ───────── */
  let from = 'gallery';
  function isOpen() { const s = $('reelScreen'); return s && !s.classList.contains('screen-hidden'); }
  async function open(srcs, origin) {
    from = origin || (document.getElementById('galleryScreen').classList.contains('screen-hidden') ? 'home' : 'gallery');
    showScreen('reelScreen');
    $('reelDone').classList.add('hidden');
    requestAnimationFrame(() => renderAll());
    if (srcs && srcs.length) await addSources(srcs);
    else if (!R.clips.length) openPicker();
  }
  function openFromGallery() {
    const sel = (typeof selectMode !== 'undefined' && selectMode) ? photos.filter(p => selectedIds.has(p.id) && p.type !== 'video').map(p => p.dataUrl) : [];
    if (typeof selectMode !== 'undefined' && selectMode) cancelSelectMode();
    open(sel, 'gallery');
  }
  function close() {
    if (R.exporting) return;
    pause(); closePicker();
    if (from === 'gallery') { showScreen('galleryScreen'); renderGallery(); }
    else { hideAllScreens(); document.getElementById('homeScreen').style.display = ''; }
  }
  function viewExport() {
    $('reelDone').classList.add('hidden');
    showScreen('galleryScreen'); renderGallery();
    const idx = photos.indexOf(lastExport); if (idx >= 0) openEditModal(idx);
  }
  function clearAll() {
    if (!R.clips.length && !R.music) return;
    if (!confirm('Começar uma montagem nova? As fotos e a música desta serão removidas.')) return;
    pause(); R.clips = []; R.music = null; R.sel = -1; R.panel = null; R.t = 0; renderAll();
  }

  function init() {
    if (!$('reelScreen')) return;
    initTimeline();
    $('reelMusicInput').addEventListener('change', e => { onMusicFile(e.target.files[0]); e.target.value = ''; });
    $('reelFileInput').addEventListener('change', e => { onDeviceFiles([...e.target.files]); e.target.value = ''; });
    document.addEventListener('keydown', e => {
      if (!isOpen() || R.exporting) return;
      if (e.key === 'Escape') {
        if (!$('reelPicker').classList.contains('hidden')) { closePicker(); e.preventDefault(); }
        else if (R.panel) { closePanel(); e.preventDefault(); }
      } else if (e.key === ' ' && !/INPUT|TEXTAREA|BUTTON|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); togglePlay(); }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  return {
    open, openFromGallery, close, togglePlay, play, pause, seek, setAspect, openPicker, closePicker, confirmPicker,
    exportVideo, cancelExport, closePanel, viewExport, clearAll, addSources,
    openMusic: () => { if (R.music) { R.sel = -1; R.panel = 'music'; renderTimeline(); renderPanel(); } else $('reelMusicInput').click(); },
    get state() { return R; }, total, _draw: draw,
  };
})();
