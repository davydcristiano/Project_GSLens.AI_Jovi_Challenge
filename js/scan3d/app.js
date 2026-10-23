/* ═══════════════════════════════════════════════════
   GSLens.AI — Scanner 3D · app.js
   Controlador da aba AR:
   - rastreamento ao vivo da prancha + sobreposição AR
     (volume 3D ancorado na folha, anel de cobertura)
   - captura automática de quadros-chave
   - iniciar / pausar / cancelar / reiniciar
   - processamento com progresso e cancelamento
   - tela de resultado (visualizador) e exportação
   Integra-se ao app (js/app/main.js) via window.GSApp.
═══════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const GS3D = root.GS3D;
  const M = GS3D.math, B = GS3D.board, S3 = GS3D.surface, F = GS3D.features;
  const $ = id => document.getElementById(id);

  const LIVE_MAX = 640;          /* resolução de rastreamento ao vivo */
  const KF_MAX = 960;            /* resolução dos quadros-chave */
  const MAX_KF = 36;
  const AZ_BINS = 24;
  const MIN_KF = 8;

  const S = {
    active: false,
    state: 'idle',               /* idle | scanning | paused | processing */
    tracker: null,
    loopTimer: null,
    liveCanvas: null, liveCtx: null, kfCanvas: null, kfCtx: null,
    keyframes: [],
    sharpRef: [],
    lastDet: null, lastPose: null, lastC: null,
    fLive: null, liveDims: null, Hhist: [],
    hint: '', cancelProcessing: false,
    result: null, viewer: null,
    detectFails: 0,
    /* modo: 'board' (prancha impressa) ou 'surface' (sem prancha: mesa com textura) */
    mode: (function () { try { return localStorage.getItem('gs3d-mode') === 'surface' ? 'surface' : 'board'; } catch (e) { return 'board'; } })(),
    surf: null          /* { live, kf, refBig, liveW, kfW, f, ax, ay, lastPts } */
  };
  const isSurf = () => S.mode === 'surface';
  const volume = () => isSurf() ? S3.VOLUME : B.VOLUME;

  /* ───────── utilidades de UI ───────── */
  function setStatus(msg, kind) {
    const el = $('scanStatus');
    if (!el) return;
    el.textContent = msg;
    el.className = 'scan-status' + (kind ? ' ' + kind : '');
  }
  function toast(m) { if (root.GSApp && root.GSApp.toast) root.GSApp.toast(m); }
  function fmtBytes(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

  function coverage() {
    const az = new Set(), bands = [0, 0, 0];
    for (const k of S.keyframes) {
      az.add(Math.floor(((k.az % 360) + 360) % 360 / (360 / AZ_BINS)));
      bands[k.el < 35 ? 0 : k.el < 60 ? 1 : 2]++;
    }
    const azFrac = az.size / AZ_BINS;
    const bandScore = bands.reduce((s, b) => s + Math.min(1, b / 4), 0) / 3;
    return { azSet: az, azFrac, bands, progress: Math.min(1, 0.7 * azFrac + 0.3 * bandScore) };
  }

  function refreshUI() {
    const n = S.keyframes.length, cov = coverage();
    const st = S.state;
    if ($('scanCount')) $('scanCount').textContent = n + (n === 1 ? ' vista' : ' vistas');
    if ($('scanProgressBar')) {
      $('scanProgressBar').style.width = Math.round(cov.progress * 100) + '%';
      $('scanProgressBar').parentElement.setAttribute('aria-valuenow', Math.round(cov.progress * 100));
    }
    const ready = n >= MIN_KF && cov.azSet.size >= AZ_BINS / 2;
    const set = (id, en) => { const b = $(id); if (b) b.disabled = !en; };
    set('scanStartBtn', (st === 'idle' || st === 'paused') && (!isSurf() || !!(S.surf && S.surf.refBig)));
    set('scanRefBtn', st === 'idle' && S.active);
    const rb = $('scanRefBtn');
    if (rb) rb.textContent = S.surf && S.surf.refBig ? '📷 Refazer mesa' : '📷 Mesa vazia';
    document.querySelectorAll('.scan-mode-opt').forEach(b => { const on = b.dataset.mode === S.mode; b.classList.toggle('active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.disabled = st === 'scanning' || st === 'processing' || (st === 'paused' && S.keyframes.length > 0); });
    const panel = $('scanPanel'); if (panel) panel.classList.toggle('surface-mode', isSurf());
    set('scanPauseBtn', st === 'scanning');
    set('scanCancelBtn', st === 'scanning' || st === 'paused');
    set('scanRestartBtn', (st === 'scanning' || st === 'paused') && n > 0);
    set('scanBuildBtn', (st === 'scanning' || st === 'paused') && ready);
    const sb = $('scanStartBtn');
    if (sb) sb.textContent = st === 'paused' ? '▶ Retomar' : '▶ Iniciar';
    const vb = $('scanViewLastBtn');
    if (vb) vb.classList.toggle('hidden', !S.result);
    const sh = document.querySelector('#cameraScreen .shutter');
    if (sh) sh.classList.toggle('scanning', st === 'scanning');
  }

  /* ───────── ciclo de rastreamento ───────── */
  function ensureCanvases() {
    if (!S.liveCanvas) {
      S.liveCanvas = document.createElement('canvas');
      S.liveCtx = S.liveCanvas.getContext('2d', { willReadFrequently: true });
      S.kfCanvas = document.createElement('canvas');
      S.kfCtx = S.kfCanvas.getContext('2d', { willReadFrequently: true });
    }
  }

  function grabFrame(video, maxDim, canvas, ctx) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const sc = Math.min(1, maxDim / Math.max(vw, vh));
    const w = Math.round(vw * sc), h = Math.round(vh * sc);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx.drawImage(video, 0, 0, w, h);
    return { img: ctx.getImageData(0, 0, w, h), scale: sc, w, h };
  }

  function liveK(w, h) {
    if (!S.liveDims || S.liveDims[0] !== w || S.liveDims[1] !== h) {
      S.liveDims = [w, h]; S.fLive = 0.82 * Math.max(w, h); S.Hhist = [];
    }
    return M.kForImage(S.fLive, w, h);
  }

  /* autocalibração contínua da focal a partir de vistas inclinadas variadas */
  function updateFocal(det, w, h) {
    const last = S.Hhist[S.Hhist.length - 1];
    if (last && Math.abs(last.n - det.H[6]) + Math.abs(last.m - det.H[7]) < 2e-4) return;
    S.Hhist.push({ H: det.H, n: det.H[6], m: det.H[7] });
    if (S.Hhist.length > 40) S.Hhist.shift();
    if (S.Hhist.length >= 8 && S.Hhist.length % 4 === 0) {
      const e = M.estimateFocal(S.Hhist.map(x => x.H), (w - 1) / 2, (h - 1) / 2);
      const md = Math.max(w, h);
      if (e && e.f > 0.45 * md && e.f < 3 * md) S.fLive = 0.6 * S.fLive + 0.4 * e.f;
    }
  }

  function tick() {
    S.loopTimer = null;
    if (!S.active || S.state === 'processing') return;
    const t0 = performance.now();
    try { trackOnce(); } catch (e) { console.error('Rastreamento AR:', e); }
    const dt = performance.now() - t0;
    /* ~12 fps no máximo; se o aparelho for lento, dá folga à UI */
    S.loopTimer = setTimeout(() => requestAnimationFrame(tick), Math.max(15, 80 - dt));
  }

  function trackOnce() {
    const video = $('video');
    ensureCanvases();
    const fr = grabFrame(video, LIVE_MAX, S.liveCanvas, S.liveCtx);
    if (!fr) { drawOverlay(null); setStatus('Aguardando a imagem da câmera…'); return; }
    if (isSurf()) { trackSurface(video, fr); return; }
    const det = S.tracker.detect(fr.img, { minMarkers: 4 });
    if (!det.ok) {
      S.detectFails++;
      S.lastDet = null; S.lastPose = null; S.lastC = null;
      drawOverlay({ fr, det: null, markers: det.markers });
      if (S.detectFails > 3) setStatus(S.state === 'scanning'
        ? 'Prancha não encontrada — enquadre a folha inteira com os marcadores.'
        : 'Aponte a câmera para a prancha impressa (folha A4 com marcadores).', 'warn');
      return;
    }
    S.detectFails = 0;
    updateFocal(det, fr.w, fr.h);
    const K = liveK(fr.w, fr.h);
    const pose = GS3D.tracking.solvePose(det, K);
    if (!pose) return;
    S.lastDet = det;
    afterPose(video, fr, K, pose, { det, nUsed: det.used.length });
  }

  /* comum aos dois modos, depois que a pose da câmera é conhecida */
  function afterPose(video, fr, K, pose, info) {
    const det = info.det;
    const C = pose.C;
    const horiz = Math.hypot(C[0], C[1]);
    const el = Math.atan2(C[2], horiz) * 180 / Math.PI;
    const az = (Math.atan2(C[1], C[0]) * 180 / Math.PI + 360) % 360;
    const now = performance.now();
    const speed = S.lastC && S.lastT ? Math.hypot(C[0] - S.lastC[0], C[1] - S.lastC[1], C[2] - S.lastC[2]) / Math.max(0.03, (now - S.lastT) / 1000) : 0;
    S.lastC = C; S.lastT = now; S.lastPose = pose;
    /* volume inteiro visível? */
    const V = volume();
    let inside = true;
    for (const x of [V.xmin, V.xmax]) for (const y of [V.ymin, V.ymax]) for (const z of [V.zmin, V.zmax]) {
      const q = M.project(K, pose.R, pose.t, [x, y, z]);
      if (!(q[2] > 0) || q[0] < -0.02 * fr.w || q[1] < -0.02 * fr.h || q[0] > fr.w * 1.02 || q[1] > fr.h * 1.02) inside = false;
    }
    let hint = '';
    if (!isSurf() && info.nUsed < 6) hint = 'Poucos marcadores visíveis — enquadre a folha inteira.';
    else if (isSurf() && info.inliers < 30) hint = 'Pouca textura da mesa à vista — mostre mais da superfície ao redor do objeto.';
    else if (!inside) hint = 'Afaste um pouco a câmera: o volume de escaneamento precisa caber na tela.';
    else if (el < 12) hint = 'Câmera muito baixa — eleve um pouco o ângulo.';
    else if (speed > 180) hint = 'Mova mais devagar para evitar imagem tremida.';
    S.hint = hint;

    let captured = false;
    if (S.state === 'scanning' && !hint) captured = maybeCapture(video, { az, el, C, H: info.H });
    drawOverlay({ fr, det, pose, K, az, el, ok: !hint, points: info.points });

    if (S.state === 'scanning') {
      const cov = coverage();
      if (hint) setStatus(hint, 'warn');
      else if (captured) setStatus('📸 Vista capturada (' + S.keyframes.length + '). Continue contornando o objeto.', 'ok');
      else if (S.keyframes.length >= MAX_KF) setStatus('Limite de vistas atingido. Toque em "Gerar 3D".', 'ok');
      else if (cov.progress >= 0.999) setStatus('Cobertura completa! Toque em "Gerar 3D".', 'ok');
      else {
        const need = [];
        if (cov.bands[0] < 4) need.push('baixas (~25°)');
        if (cov.bands[1] < 4) need.push('médias (~45°)');
        if (cov.bands[2] < 4) need.push('de cima (~70°)');
        setStatus('Contorne o objeto devagar' + (need.length ? ' — faltam vistas ' + need.join(', ') : '') + '. Cobertura: ' + Math.round(cov.progress * 100) + '%.');
      }
    } else if (S.state === 'paused') {
      setStatus('Escaneamento pausado (' + S.keyframes.length + ' vistas). Toque em "Retomar" ou "Gerar 3D".');
    } else if (S.state === 'idle') {
      setStatus(hint || (isSurf() ? 'Mesa registrada ✓ Coloque o objeto dentro da caixa marcada e toque em "Iniciar".' : 'Prancha detectada ✓ Coloque o objeto no quadrado central e toque em "Iniciar".'), hint ? 'warn' : 'ok');
    }
  }

  /* ───────── modo sem prancha ───────── */
  function trackSurface(video, fr) {
    const su = S.surf;
    if (!su || !su.refBig) {
      drawOverlay(null);
      if (S.state === 'idle') setStatus('Sem prancha: aponte a câmera de cima para a mesa VAZIA (com textura: madeira, toalha estampada, revista…) e toque em "📷 Mesa vazia".');
      return;
    }
    if (su.liveW !== fr.w) { setStatus('A resolução da câmera mudou — fotografe a mesa vazia novamente.', 'warn'); resetSurface(); return; }
    const r = su.live.track(fr.img);
    if (!r.ok) {
      S.lastPose = null; S.lastC = null;
      drawOverlay({ fr, det: null });
      if (r.lost) setStatus('Rastreamento da mesa perdido — volte a enquadrar a mesa como na foto inicial e mova mais devagar.', 'warn');
      return;
    }
    /* pose: H (referência→quadro) · A (mesa→referência), com a calibração atual */
    const K = M.kForImage(su.f * fr.w / su.kfW, fr.w, fr.h);
    const A = S3.planeToRef(K, su.ax, su.ay);
    const G = M.mul3(r.H, A);
    const p0 = M.poseFromHomography(G, K);
    if (!p0) return;
    const pose = { R: p0.R, t: p0.t, C: M.cameraCenter(p0.R, p0.t) };
    S.lastDet = null;
    const pts = r.matches.map(m => [m[1], m[2]]);
    afterPose(video, fr, K, pose, { inliers: r.inliers, H: r.H, points: pts });
  }

  function resetSurface() {
    S.surf = null;
    refreshUI();
  }

  /* fotografa a mesa vazia (referência) */
  function captureReference() {
    if (!S.active || S.state !== 'idle') return;
    const video = $('video');
    ensureCanvases();
    const fr = grabFrame(video, LIVE_MAX, S.liveCanvas, S.liveCtx);
    const big = fr && grabFrame(video, KF_MAX, S.kfCanvas, S.kfCtx);
    if (!fr || !big) { setStatus('Aguardando a imagem da câmera…', 'warn'); return; }
    const live = new S3.SurfaceTracker(), kf = new S3.SurfaceTracker();
    const a = live.setReference(fr.img), b = kf.setReference(big.img);
    if (!a.ok || !b.ok) { setStatus('⚠️ ' + (a.reason || b.reason), 'warn'); toast('⚠️ Superfície com pouca textura'); return; }
    clearKeyframes();
    const md = Math.max(big.w, big.h);
    S.surf = { live, kf, refBig: big.img, liveW: fr.w, kfW: big.w, f: 0.82 * md, ax: 0, ay: 0, calibN: 0 };
    const vf = $('flashOverlay');
    if (vf) { vf.classList.remove('flash'); void vf.offsetWidth; vf.classList.add('flash', 'soft'); setTimeout(() => vf.classList.remove('flash', 'soft'), 350); }
    toast('📷 Mesa registrada (' + b.n + ' pontos de textura)');
    setStatus('Mesa registrada ✓ Coloque o objeto dentro da caixa marcada e toque em "Iniciar".', 'ok');
    refreshUI();
  }

  /* recalibra a focal/inclinação com as vistas já capturadas (melhora a sobreposição AR e a cobertura) */
  function liveCalibrate() {
    const su = S.surf;
    if (!su || S.keyframes.length < 8 || S.keyframes.length - su.calibN < 4) return;
    su.calibN = S.keyframes.length;
    setTimeout(() => {
      try {
        const kb = S.keyframes[0];
        const z = S3.calibrateZhang(S.keyframes.map(k => k.H), kb.w, kb.h, { f: su.f, tilt: [su.ax, su.ay] });
        if (z.cost < 0.01) { su.f = z.f; su.ax = z.ax; su.ay = z.ay; }
      } catch (e) { console.warn('Calibração ao vivo:', e); }
    }, 0);
  }

  function setScanMode(mode) {
    if (mode !== 'board' && mode !== 'surface') return;
    if (S.state === 'scanning' || S.state === 'processing' || (S.state === 'paused' && S.keyframes.length)) { toast('Termine ou cancele o escaneamento atual antes de trocar o modo.'); return; }
    S.mode = mode;
    try { localStorage.setItem('gs3d-mode', mode); } catch (e) { }
    if (mode === 'board' && !S.tracker) { try { S.tracker = new GS3D.Tracker(); } catch (e) { setStatus('⚠️ ' + e.message, 'err'); } }
    clearKeyframes();
    S.state = 'idle';
    S.lastPose = null; S.lastC = null; S.detectFails = 0;
    if (mode === 'board') setStatus('Aponte a câmera para a prancha impressa (folha A4 com marcadores).');
    else setStatus(S.surf && S.surf.refBig ? 'Mesa registrada ✓ Coloque o objeto dentro da caixa marcada e toque em "Iniciar".' : 'Sem prancha: aponte a câmera de cima para a mesa VAZIA e toque em "📷 Mesa vazia".');
    refreshUI();
  }

  function maybeCapture(video, info) {
    if (S.keyframes.length >= MAX_KF) return false;
    /* novidade: direção da câmera diferente das já capturadas */
    const dir = M.normalize3(info.C);
    let minAng = 180;
    for (const k of S.keyframes) {
      const a = Math.acos(Math.max(-1, Math.min(1, M.dot3(dir, k.dir)))) * 180 / Math.PI;
      if (a < minAng) minAng = a;
    }
    if (minAng < 11) return false;
    /* quadro-chave em resolução maior, com nova detecção (mais precisa) */
    const fr = grabFrame(video, KF_MAX, S.kfCanvas, S.kfCtx);
    if (!fr) return false;
    if (isSurf()) {
      const su = S.surf, k = fr.w / su.liveW, Sm = [k, 0, 0, 0, k, 0, 0, 0, 1], Si = [1 / k, 0, 0, 0, 1 / k, 0, 0, 0, 1];
      const rk = su.kf.refineImage(fr.img, M.mul3(Sm, M.mul3(info.H, Si)));
      if (!rk || rk.inliers < 25) return false;
      const g = F.gray(fr.img);
      const sharp = GS3D.tracking.sharpness({ width: g.w, height: g.h, data: g.d });
      if (S.sharpRef.length >= 3 && sharp < 0.45 * M.median(S.sharpRef)) { S.hint = 'Imagem tremida — segure firme por um instante.'; return false; }
      S.sharpRef.push(sharp);
      if (S.sharpRef.length > 15) S.sharpRef.shift();
      S.keyframes.push({ rgba: fr.img.data, w: fr.w, h: fr.h, H: rk.H, matches: rk.matches, az: info.az, el: info.el, dir });
      flashSoft();
      liveCalibrate();
      refreshUI();
      return true;
    }
    const det = S.tracker.detect(fr.img, { minMarkers: 6 });
    if (!det.ok || det.used.length < 6 || det.meanErr > 2) return false;
    const sharp = GS3D.tracking.sharpness(S.tracker.detector.grey);
    if (S.sharpRef.length >= 3 && sharp < 0.45 * M.median(S.sharpRef)) { S.hint = 'Imagem tremida — segure firme por um instante.'; return false; }
    S.sharpRef.push(sharp);
    if (S.sharpRef.length > 15) S.sharpRef.shift();
    S.keyframes.push({ rgba: fr.img.data, w: fr.w, h: fr.h, det, az: info.az, el: info.el, dir });
    flashSoft();
    refreshUI();
    return true;
  }
  function flashSoft() {
    const vf = $('flashOverlay');
    if (vf) { vf.classList.remove('flash'); void vf.offsetWidth; vf.classList.add('flash', 'soft'); setTimeout(() => vf.classList.remove('flash', 'soft'), 350); }
  }

  /* ───────── sobreposição AR ───────── */
  function drawOverlay(o) {
    const cv = $('scanCanvas');
    if (!cv) return;
    const vf = $('viewfinder');
    const dpr = Math.min(2, root.devicePixelRatio || 1);
    const W = vf.clientWidth, H = vf.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!o || !o.fr) return;
    const map = root.GSApp.getVideoMapping();
    if (!map) return;
    const sc = o.fr.scale;
    const toScreen = (p) => {
      let X = map.ox + (p[0] / sc) * map.s, Y = map.oy + (p[1] / sc) * map.s;
      if (map.mirror) X = W - X;
      return [X * dpr, Y * dpr];
    };
    ctx.lineJoin = 'round';
    /* marcadores detectados */
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeStyle = 'rgba(0,229,255,.75)';
    const mk = o.det ? o.det.markers : (o.markers || []);
    for (const m of mk) {
      ctx.beginPath();
      m.img.forEach((p, i) => { const q = toScreen(p); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); });
      ctx.closePath(); ctx.stroke();
    }
    if (o.points) {
      ctx.fillStyle = 'rgba(0,229,255,.7)';
      for (let k = 0; k < o.points.length; k += 2) { const q = toScreen(o.points[k]); ctx.fillRect(q[0] - 1.5 * dpr, q[1] - 1.5 * dpr, 3 * dpr, 3 * dpr); }
    }
    if (!o.pose) return;
    const P = X => { const q = M.project(o.K, o.pose.R, o.pose.t, X); return q[2] > 0 ? toScreen(q) : null; };
    const V = volume();
    /* anel de cobertura no plano da prancha */
    const cov = coverage();
    const r0 = 64, r1 = 74;
    for (let s = 0; s < AZ_BINS; s++) {
      const a0 = (s / AZ_BINS) * 2 * Math.PI + 0.02, a1 = ((s + 1) / AZ_BINS) * 2 * Math.PI - 0.02;
      const pts = [];
      for (let k = 0; k <= 4; k++) { const a = a0 + (a1 - a0) * k / 4; pts.push(P([r1 * Math.cos(a), r1 * Math.sin(a), 0])); }
      for (let k = 4; k >= 0; k--) { const a = a0 + (a1 - a0) * k / 4; pts.push(P([r0 * Math.cos(a), r0 * Math.sin(a), 0])); }
      if (pts.some(p => !p)) continue;
      ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath();
      ctx.fillStyle = cov.azSet.has(s) ? 'rgba(50,215,75,.75)' : 'rgba(255,255,255,.18)';
      ctx.fill();
    }
    /* posição atual da câmera no anel */
    if (o.az != null) {
      const a = o.az * Math.PI / 180, p = P([(r1 + 6) * Math.cos(a), (r1 + 6) * Math.sin(a), 0]);
      if (p) { ctx.beginPath(); ctx.arc(p[0], p[1], 5 * dpr, 0, Math.PI * 2); ctx.fillStyle = '#f5a623'; ctx.fill(); }
    }
    /* caixa do volume de escaneamento (wireframe 3D ancorado na prancha) */
    const corners = [];
    for (const z of [V.zmin, V.zmax]) for (const [x, y] of [[V.xmin, V.ymin], [V.xmax, V.ymin], [V.xmax, V.ymax], [V.xmin, V.ymax]]) corners.push(P([x, y, z]));
    if (corners.every(Boolean)) {
      const E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = o.ok ? 'rgba(0,229,255,.95)' : 'rgba(245,166,35,.95)';
      ctx.beginPath();
      for (const [a, b] of E) { ctx.moveTo(corners[a][0], corners[a][1]); ctx.lineTo(corners[b][0], corners[b][1]); }
      ctx.stroke();
      ctx.fillStyle = o.ok ? 'rgba(0,229,255,.08)' : 'rgba(245,166,35,.08)';
      ctx.beginPath(); [0, 1, 2, 3].forEach((i, k) => k ? ctx.lineTo(corners[i][0], corners[i][1]) : ctx.moveTo(corners[i][0], corners[i][1])); ctx.closePath(); ctx.fill();
    }
    /* eixos da prancha */
    const O = P([0, 0, 0]), AX = [[[30, 0, 0], '#ff4a5e'], [[0, 30, 0], '#32d74b'], [[0, 0, 30], '#00e5ff']];
    if (O) for (const [v, col] of AX) { const q = P(v); if (!q) continue; ctx.strokeStyle = col; ctx.lineWidth = 2.5 * dpr; ctx.beginPath(); ctx.moveTo(O[0], O[1]); ctx.lineTo(q[0], q[1]); ctx.stroke(); }
  }

  /* ───────── controle do escaneamento ───────── */
  function checkSupport() {
    const probs = [];
    if (!root.isSecureContext && location.protocol !== 'file:') probs.push('A câmera exige HTTPS (ou localhost). Abra o sistema por um endereço seguro.');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) probs.push('Este navegador não permite acesso à câmera.');
    if (!isSurf() && (!root.AR || !root.AR.Detector)) probs.push('A biblioteca de rastreamento de marcadores não foi carregada.');
    try { document.createElement('canvas').getContext('2d').getImageData(0, 0, 1, 1); } catch (e) { probs.push('O navegador bloqueia a leitura de pixels da câmera.'); }
    return probs;
  }

  function enter() {
    S.active = true;
    const probs = checkSupport();
    if (probs.length) { setStatus('⚠️ ' + probs.join(' '), 'err'); refreshUI(); return; }
    if (!root.GSApp.getStream()) { setStatus('⚠️ Câmera indisponível. Volte e permita o acesso à câmera.', 'err'); refreshUI(); return; }
    try { if (!S.tracker && !isSurf()) S.tracker = new GS3D.Tracker(); }
    catch (e) { setStatus('⚠️ ' + e.message, 'err'); return; }
    root.GSApp.resetZoom();
    if (S.state === 'scanning') S.state = 'paused';
    setStatus(isSurf() ? 'Sem prancha: aponte a câmera de cima para a mesa VAZIA e toque em "📷 Mesa vazia".' : 'Aponte a câmera para a prancha impressa (folha A4 com marcadores).');
    refreshUI();
    if (!S.loopTimer) tick();
  }

  function exit() {
    S.active = false;
    if (S.loopTimer) { clearTimeout(S.loopTimer); S.loopTimer = null; }
    if (S.state === 'scanning') S.state = 'paused';
    if (S.state === 'processing') S.cancelProcessing = true;
    drawOverlay(null);
    refreshUI();
  }

  /* Saída completa da câmera: libera as imagens capturadas (dezenas de MB) */
  function release() {
    exit();
    clearKeyframes();
    if (S.state !== 'processing') S.state = 'idle';
    S.liveDims = null; S.Hhist = [];
    S.surf = null;
    refreshUI();
  }

  function clearKeyframes() {
    S.keyframes = [];          /* libera os buffers de imagem para o GC */
    S.sharpRef = [];
  }

  function start() {
    if (!S.active) return;
    if (!root.GSApp.getStream()) { setStatus('⚠️ Câmera indisponível.', 'err'); return; }
    if (isSurf() && !(S.surf && S.surf.refBig)) { setStatus('Primeiro fotografe a mesa vazia ("📷 Mesa vazia").', 'warn'); return; }
    if (S.state === 'idle') clearKeyframes();
    S.state = 'scanning';
    setStatus(isSurf() ? 'Escaneando… contorne o objeto devagar, mostrando a mesa ao redor dele.' : 'Escaneando… contorne o objeto devagar, mantendo a folha inteira na tela.', 'ok');
    refreshUI();
  }
  function pause() { if (S.state === 'scanning') { S.state = 'paused'; refreshUI(); setStatus('Escaneamento pausado.'); } }
  function cancel() {
    if (S.state !== 'scanning' && S.state !== 'paused') return;
    if (S.keyframes.length && !confirm('Cancelar o escaneamento e descartar ' + S.keyframes.length + ' vistas capturadas?')) return;
    clearKeyframes();
    S.state = 'idle';
    refreshUI();
    setStatus('Escaneamento cancelado.');
  }
  function restart() {
    clearKeyframes();
    S.state = 'scanning';
    refreshUI();
    setStatus('Reiniciado — capture novamente as vistas ao redor do objeto.', 'ok');
  }
  /* obturador no modo AR: inicia/pausa */
  function shutter() {
    if (S.state === 'scanning') pause();
    else if (S.state === 'idle' || S.state === 'paused') start();
  }
  function onCameraChanged() {
    /* outra câmera = outra óptica: as vistas anteriores deixam de ser válidas */
    S.liveDims = null; S.Hhist = [];
    if (S.surf) { S.surf = null; toast('Câmera trocada — fotografe a mesa vazia novamente.'); }
    if (S.keyframes.length) { clearKeyframes(); toast('Câmera trocada — vistas anteriores descartadas.'); }
    if (S.state === 'scanning' || S.state === 'paused') S.state = 'idle';
    refreshUI();
  }

  /* ───────── processamento ───────── */
  const STAGES = {
    calib: ['Calibrando a câmera e refinando as poses…', 0, 0.06],
    segment: ['Separando o objeto do fundo em cada foto…', 0.06, 0.3],
    carve: ['Esculpindo o volume 3D a partir das silhuetas…', 0.3, 0.55],
    mesh: ['Gerando a malha da superfície…', 0.55, 0.65],
    texture: ['Projetando a textura das fotos no modelo…', 0.65, 0.99],
    done: ['Concluído!', 1, 1]
  };
  function showProc(show) { const o = $('scanProc'); if (o) o.classList.toggle('hidden', !show); }
  function procUpdate(msg, frac, isErr) {
    if ($('scanProcMsg')) $('scanProcMsg').textContent = msg;
    if ($('scanProcBar')) $('scanProcBar').style.width = Math.round(frac * 100) + '%';
    if ($('scanProcPct')) $('scanProcPct').textContent = Math.round(frac * 100) + '%';
    const o = $('scanProc');
    if (o) o.classList.toggle('error', !!isErr);
  }

  async function build() {
    if (S.state === 'processing') return;
    if (S.keyframes.length < MIN_KF) { setStatus('Capture pelo menos ' + MIN_KF + ' vistas ao redor do objeto.', 'warn'); return; }
    if (isSurf() && !(S.surf && S.surf.refBig)) { setStatus('Fotografe a mesa vazia antes de escanear.', 'warn'); return; }
    const prev = S.state;
    S.state = 'processing';
    S.cancelProcessing = false;
    if (S.loopTimer) { clearTimeout(S.loopTimer); S.loopTimer = null; }
    drawOverlay(null);
    refreshUI();
    showProc(true);
    if ($('scanProcCancel')) $('scanProcCancel').classList.remove('hidden');
    if ($('scanProcClose')) $('scanProcClose').classList.add('hidden');
    procUpdate('Preparando…', 0);
    setStatus('⏳ Processando ' + S.keyframes.length + ' vistas no dispositivo…');
    const t0 = performance.now();
    try {
      const kfW = S.keyframes[0].w, liveW = S.liveDims ? S.liveDims[0] : kfW;
      const su = isSurf() ? S.surf : null;
      const res = await GS3D.pipeline.buildModel(S.keyframes, {
        resolution: +(($('scanQuality') && $('scanQuality').value) || 96),
        fGuess: su ? su.f : (S.fLive ? S.fLive * kfW / liveW : null),
        surface: su ? { ref: { rgba: su.refBig.data, w: su.refBig.width, h: su.refBig.height }, refPts: su.kf.ref.pts, tilt: [su.ax, su.ay], volume: S3.VOLUME } : null
      }, (stage, f) => {
        const d = STAGES[stage]; if (!d) return;
        procUpdate(d[0], d[1] + (d[2] - d[1]) * f);
      }, () => S.cancelProcessing || !S.active);
      res.stats.seconds = (performance.now() - t0) / 1000;
      S.result = res;
      S.state = 'paused';
      showProc(false);
      refreshUI();
      setStatus('✅ Modelo 3D gerado (' + res.stats.triangles.toLocaleString('pt-BR') + ' triângulos).', 'ok');
      openResult();
    } catch (e) {
      S.state = prev === 'idle' ? 'idle' : 'paused';
      const aborted = e && e.name === 'AbortError';
      console[aborted ? 'info' : 'error']('Processamento 3D:', e);
      procUpdate(aborted ? 'Processamento cancelado.' : '⚠️ ' + (e.message || e), 0, !aborted);
      if ($('scanProcCancel')) $('scanProcCancel').classList.add('hidden');
      if ($('scanProcClose')) $('scanProcClose').classList.remove('hidden');
      if (aborted) showProc(false);
      setStatus(aborted ? 'Processamento cancelado. As vistas foram mantidas.' : 'Não foi possível gerar o modelo. Você pode capturar mais vistas e tentar de novo.', aborted ? '' : 'err');
      refreshUI();
      if (S.active && !S.loopTimer) tick();
    }
  }
  function cancelBuild() { S.cancelProcessing = true; procUpdate('Cancelando…', 0); }
  function closeProc() { showProc(false); }

  /* ───────── tela de resultado ───────── */
  function renderStats() {
    const r = S.result; if (!r) return;
    const s = r.stats, z = s.sizeMm;
    const rows = [
      ['Dimensões (L × P × A)', (s.approxScale ? '≈ ' : '') + z[0].toFixed(1) + ' × ' + z[1].toFixed(1) + ' × ' + z[2].toFixed(1) + ' mm'],
      ['Modo', s.mode === 'surface' ? (s.scaleFixed ? 'Sem prancha · escala corrigida por medida real' : 'Sem prancha · escala aproximada') : 'Prancha impressa · escala real'],
      ['Malha', s.vertices.toLocaleString('pt-BR') + ' vértices · ' + s.triangles.toLocaleString('pt-BR') + ' triângulos'],
      ['Vistas usadas', s.views + ' de ' + s.captured],
      ['Erro de reprojeção', s.reprojRms.toFixed(2) + ' px (rastreamento)'],
      ['Resolução', s.voxelMm.toFixed(2) + ' mm/voxel · textura ' + r.textureSize + '×' + r.textureSize],
      ['Superfície texturizada', Math.round(s.coverage * 100) + '%'],
      ['Tempo de processamento', (s.seconds || 0).toFixed(1) + ' s']
    ];
    $('scanStats').innerHTML = rows.map(([k, v]) => `<div class="stat-row"><span>${k}</span><strong>${v}</strong></div>`).join('');
    const sc = $('scaleFix');
    if (sc) sc.classList.toggle('hidden', s.mode !== 'surface');
    const warn = $('scanWarnings');
    warn.innerHTML = '';
    for (const w of r.warnings) { const li = document.createElement('li'); li.textContent = w; warn.appendChild(li); }
    warn.classList.toggle('hidden', !r.warnings.length);
  }

  async function openResult() {
    if (!S.result) { toast('Nenhum modelo gerado ainda.'); return; }
    root.GSApp.showScreen('scanScreen');
    renderStats();
    setExportMsg('', '');
    const box = $('scanViewer'), msg = $('viewerMsg');
    msg.textContent = 'Carregando visualizador 3D…'; msg.classList.remove('hidden', 'err');
    if (S.viewer) { S.viewer.dispose(); S.viewer = null; }
    const v = new GS3D.Viewer(box);
    S.viewer = v;
    try {
      await v.init();
      if (S.viewer !== v) return;
      v.setModel(S.result);
      msg.classList.add('hidden');
      document.querySelectorAll('.viewer-tool[data-toggle]').forEach(b => {
        const k = b.dataset.toggle;
        b.classList.toggle('active', k === 'texture');
      });
    } catch (e) {
      console.error('Visualizador 3D:', e);
      msg.textContent = '⚠️ ' + e.message; msg.classList.add('err');
    }
  }
  function closeResult() {
    if (S.viewer) { S.viewer.dispose(); S.viewer = null; }
    root.GSApp.returnToCamera();
    /* o rastreamento é suspenso durante o processamento/visualização: retoma */
    if (S.active && root.GSApp.getMode() === 'ar' && root.GSApp.getStream() && !S.loopTimer && S.state !== 'processing') tick();
  }
  function scanAgain() {
    closeResult();
    if (root.GSApp.getMode() !== 'ar') root.GSApp.setMode('ar');
    restart();
  }
  function viewerTool(kind, btn) {
    const v = S.viewer; if (!v) return;
    if (kind === 'reset') v.resetView();
    else if (kind === 'zoomIn') v.zoom(0.8);
    else if (kind === 'zoomOut') v.zoom(1.25);
    else {
      const on = !btn.classList.contains('active');
      btn.classList.toggle('active', on);
      if (kind === 'rotate') v.setAutoRotate(on);
      if (kind === 'wire') v.setWireframe(on);
      if (kind === 'texture') v.setTextured(on);
    }
  }

  /* Sem prancha a escala é aproximada: o usuário informa uma medida real
     (altura, largura ou profundidade) e o modelo inteiro é reescalado. */
  function applyRealSize() {
    const r = S.result; if (!r) return;
    const axis = +$('scaleAxis').value, mm = parseFloat(String($('scaleValue').value).replace(',', '.'));
    const cur = r.stats.sizeMm[axis];
    if (!(mm > 0.5 && mm < 5000) || !(cur > 0)) { toast('Informe uma medida válida em milímetros.'); return; }
    const k = mm / cur;
    for (let i = 0; i < r.positions.length; i++) r.positions[i] *= k;
    r.stats.sizeMm = r.stats.sizeMm.map(v => v * k);
    r.stats.voxelMm *= k; r.stats.scaleFixed = true;
    renderStats();
    if (S.viewer) S.viewer.setModel(r);
    toast('📏 Escala corrigida (×' + k.toFixed(3) + ')');
  }

  /* ───────── exportação ───────── */
  function setExportMsg(msg, kind) {
    const el = $('exportMsg'); if (!el) return;
    el.textContent = msg;
    el.className = 'export-msg' + (kind ? ' ' + kind : '');
  }
  async function exportModel() {
    if (!S.result) { setExportMsg('Gere um modelo antes de exportar.', 'err'); return; }
    const sel = document.querySelector('input[name="exportFmt"]:checked');
    const fmt = sel ? sel.value : 'glb';
    const def = GS3D.exporters.FORMATS[fmt];
    if (!def) { setExportMsg('Formato desconhecido.', 'err'); return; }
    const btn = $('exportBtn');
    btn.disabled = true;
    setExportMsg('⏳ Gerando arquivo ' + def.label + '…', 'busy');
    await new Promise(r => setTimeout(r, 30));   /* deixa a mensagem aparecer */
    try {
      const v = GS3D.recon.validateMesh(S.result);
      if (!v.ok) throw new Error('Modelo inválido: ' + v.errors.join(', '));
      const out = def.fn(S.result);
      if (!out || !out.blob || !out.blob.size) throw new Error('O arquivo gerado está vazio.');
      B.downloadBlob(out.blob, out.name);
      setExportMsg('✅ ' + out.name + ' (' + fmtBytes(out.blob.size) + ') pronto para download.', 'ok');
    } catch (e) {
      console.error('Exportação:', e);
      setExportMsg('⚠️ Falha ao exportar: ' + (e.message || e), 'err');
    } finally { btn.disabled = false; }
  }

  async function downloadBoard() {
    try {
      const kind = await B.downloadPrintable();
      toast(kind === 'pdf' ? '🖨️ Prancha (PDF A4) baixada — imprima em 100%' : '🖨️ Prancha (PNG 300 dpi) baixada — imprima em tamanho real');
    } catch (e) { console.error(e); toast('⚠️ Não foi possível gerar a prancha: ' + e.message); }
  }
  function showHelp() { $('scanHelpModal').classList.remove('hidden'); }
  function hideHelp() { $('scanHelpModal').classList.add('hidden'); }

  root.Scan3D = {
    enter, exit, release, start, pause, cancel, restart, shutter, build, cancelBuild, closeProc,
    openResult, closeResult, scanAgain, viewerTool, exportModel, downloadBoard, showHelp, hideHelp,
    onCameraChanged, setScanMode, captureReference, applyRealSize,
    get mode() { return S.mode; },
    get state() { return S.state; },
    _debug: S
  };
})(window);
