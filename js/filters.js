/* ═══════════════════════════════════════════════════
   GSLens.AI — Filtros Clássicos e Modernos
   Cada filtro = matriz de cor 3×4 + curvas por canal (LUT)
   + vinheta + granulação opcionais. O MESMO modelo é usado
   na prévia ao vivo (WebGL) e na foto final (JavaScript),
   então o que se vê na câmera é o que sai no arquivo.
═══════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  /* ── Construtores de matriz (3×4: [r g b | offset] por linha, valores 0..1) ── */
  const I = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  function mul(A, B) {            /* A ∘ B (aplica B, depois A) */
    const C = new Array(12);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) C[r * 4 + c] = A[r * 4] * B[c] + A[r * 4 + 1] * B[4 + c] + A[r * 4 + 2] * B[8 + c];
      C[r * 4 + 3] = A[r * 4] * B[3] + A[r * 4 + 1] * B[7] + A[r * 4 + 2] * B[11] + A[r * 4 + 3];
    }
    return C;
  }
  const chain = (...ms) => ms.reduce((acc, m) => mul(m, acc), I());
  const LW = [0.2126, 0.7152, 0.0722];
  function sat(s) { const a = (1 - s); return [a * LW[0] + s, a * LW[1], a * LW[2], 0, a * LW[0], a * LW[1] + s, a * LW[2], 0, a * LW[0], a * LW[1], a * LW[2] + s, 0]; }
  const contrast = c => [c, 0, 0, 0.5 * (1 - c), 0, c, 0, 0.5 * (1 - c), 0, 0, c, 0.5 * (1 - c)];
  const bright = b => [b, 0, 0, 0, 0, b, 0, 0, 0, 0, b, 0];
  const gains = (r, g, b) => [r, 0, 0, 0, 0, g, 0, 0, 0, 0, b, 0];
  const offset = (r, g, b) => [1, 0, 0, r, 0, 1, 0, g, 0, 0, 1, b];
  const mono = (w) => { w = w || LW; return [w[0], w[1], w[2], 0, w[0], w[1], w[2], 0, w[0], w[1], w[2], 0]; };
  const raw = (m) => m.slice();
  /* mistura com a identidade (intensidade 0..1) */
  const mix = (m, t) => I().map((v, i) => v * (1 - t) + m[i] * t);
  /* matrizes clássicas de referência (offsets já em 0..1) */
  const M = {
    kodachrome: [1.1286, -0.3967, -0.0399, 0.2499, -0.1640, 1.0835, -0.0550, 0.0970, -0.1679, -0.5603, 1.6015, 0.1397],
    polaroid: [1.438, -0.062, -0.062, 0, -0.122, 1.378, -0.122, 0, -0.016, -0.016, 1.483, 0],
    technicolor: [1.9125, -0.8545, -0.0916, 0.0462, -0.3088, 1.7659, -0.1060, -0.2759, -0.2311, -0.7502, 1.8476, 0.1214],
    vintage: [0.6279, 0.3202, -0.0397, 0.0378, 0.0258, 0.6441, 0.0326, 0.0293, 0.0466, -0.0851, 0.5242, 0.0202],
    browni: [0.5997, 0.3455, -0.2708, 0.1860, -0.0377, 0.8610, 0.1506, -0.1450, 0.2411, -0.0744, 0.4497, -0.0297]
  };

  /* Curva = pontos igualmente espaçados de 0 a 1 (interpolação linear) */
  const S_SOFT = [0, 0.06, 0.22, 0.5, 0.78, 0.94, 1];
  const S_HARD = [0, 0.02, 0.15, 0.5, 0.85, 0.98, 1];

  const DEFS = [
    /* ── Clássicos ── */
    { id: 'kodachrome', name: 'Kodachrome', group: 'classic', m: chain(raw(M.kodachrome), contrast(1.04)), curves: { all: S_SOFT } },
    { id: 'polaroid', name: 'Polaroid', group: 'classic', m: chain(raw(M.polaroid), sat(0.8), offset(0.02, 0.01, 0.0)), curves: { r: [0.08, 0.3, 0.55, 0.78, 0.96], g: [0.06, 0.28, 0.53, 0.77, 0.95], b: [0.14, 0.33, 0.55, 0.74, 0.9] }, vignette: 0.18 },
    { id: 'anos70', name: 'Anos 70', group: 'classic', m: chain(mix(M.browni, 0.55), sat(1.05)), curves: { all: [0.08, 0.27, 0.5, 0.73, 0.93] }, vignette: 0.25, grain: 0.03 },
    { id: 'lomo', name: 'Lomo', group: 'classic', m: chain(sat(1.4), contrast(1.18)), curves: { r: S_HARD, g: [0, 0.04, 0.2, 0.5, 0.82, 0.97, 1], b: [0.08, 0.22, 0.42, 0.62, 0.8, 0.9, 0.95] }, vignette: 0.6 },
    { id: 'technicolor', name: 'Technicolor', group: 'classic', m: chain(mix(M.technicolor, 0.7), sat(0.9)), curves: { all: [0.02, 0.26, 0.52, 0.77, 0.98] } },
    { id: 'crossproc', name: 'Cross Process', group: 'classic', m: chain(sat(1.25)), curves: { r: S_HARD, g: [0, 0.05, 0.24, 0.52, 0.8, 0.96, 1], b: [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.78] } },
    { id: 'ilford', name: 'P&B Ilford', group: 'classic', m: chain(mono([0.25, 0.65, 0.1]), contrast(1.15)), curves: { all: S_HARD }, grain: 0.04 },
    { id: 'cianotipia', name: 'Cianotipia', group: 'classic', m: chain(mono(), [0.35, 0, 0, 0.02, 0, 0.6, 0, 0.08, 0, 0, 0.75, 0.25]), curves: { all: S_SOFT }, vignette: 0.2 },
    { id: 'vintage', name: 'Vintage', group: 'classic', m: chain(raw(M.vintage), bright(1.25)), curves: { r: [0.1, 0.32, 0.56, 0.8, 0.98], b: [0.12, 0.3, 0.5, 0.7, 0.86] }, vignette: 0.35, grain: 0.04 },

    /* ── Modernos ── */
    { id: 'tealorange', name: 'Teal & Orange', group: 'modern', m: chain(sat(1.15), contrast(1.08)), curves: { r: [0, 0.17, 0.48, 0.82, 1], g: [0.02, 0.24, 0.5, 0.76, 0.97], b: [0.1, 0.33, 0.5, 0.66, 0.85] } },
    { id: 'cyberpunk', name: 'Cyberpunk', group: 'modern', m: chain(gains(1.12, 0.82, 1.28), offset(0.02, 0, 0.06), contrast(1.2), sat(1.3)), curves: { g: [0, 0.12, 0.4, 0.74, 0.95], b: [0.12, 0.38, 0.62, 0.86, 1] } },
    { id: 'vaporwave', name: 'Vaporwave', group: 'modern', m: chain(sat(1.15)), curves: { r: [0.16, 0.4, 0.62, 0.86, 1], g: [0.04, 0.22, 0.45, 0.7, 0.88], b: [0.26, 0.46, 0.66, 0.86, 1] } },
    { id: 'moody', name: 'Moody', group: 'modern', m: chain(sat(0.7), contrast(1.1), bright(0.94)), curves: { r: [0.06, 0.2, 0.45, 0.72, 0.92], g: [0.07, 0.22, 0.47, 0.73, 0.92], b: [0.1, 0.27, 0.5, 0.73, 0.9] }, vignette: 0.35 },
    { id: 'clarendon', name: 'Clarendon', group: 'modern', m: chain(sat(1.35), contrast(1.2), gains(0.98, 1.0, 1.06)), curves: { all: [0, 0.04, 0.2, 0.52, 0.8, 0.95, 1] } },
    { id: 'juno', name: 'Juno', group: 'modern', m: chain(sat(1.3), gains(1.06, 1.04, 0.9), contrast(1.1)), curves: { all: S_SOFT } },
    { id: 'lark', name: 'Lark', group: 'modern', m: chain(bright(1.08), sat(0.88), gains(0.95, 1.02, 1.05)), curves: { all: [0.05, 0.3, 0.56, 0.8, 1] } },
    { id: 'goldenhour', name: 'Golden Hour', group: 'modern', m: chain(gains(1.12, 1.02, 0.84), offset(0.03, 0.015, 0), contrast(1.05), sat(1.1)), curves: { all: S_SOFT }, vignette: 0.25 },
    { id: 'matte', name: 'Matte', group: 'modern', m: chain(sat(0.85)), curves: { all: [0.12, 0.3, 0.52, 0.75, 0.94] } },
    { id: 'neonnoir', name: 'Neon Noir', group: 'modern', m: chain(mono(), contrast(1.3)), curves: { r: [0.02, 0.16, 0.42, 0.78, 1], g: [0, 0.08, 0.32, 0.66, 0.92], b: [0.12, 0.34, 0.58, 0.86, 1] }, vignette: 0.4 }
  ];
  const BY_ID = new Map(DEFS.map(d => [d.id, d]));

  /* LUT de 256 entradas por canal */
  function curveLUT(pts) {
    const lut = new Uint8ClampedArray(256);
    if (!pts) { for (let i = 0; i < 256; i++) lut[i] = i; return lut; }
    const n = pts.length - 1;
    for (let i = 0; i < 256; i++) {
      const x = i / 255 * n, k = Math.min(n - 1, Math.floor(x)), t = x - k;
      lut[i] = Math.round((pts[k] * (1 - t) + pts[k + 1] * t) * 255);
    }
    return lut;
  }
  for (const d of DEFS) {
    const c = d.curves || {};
    d.lut = [curveLUT(c.r || c.all), curveLUT(c.g || c.all), curveLUT(c.b || c.all)];
  }

  /* Ruído determinístico (mesma granulação na prévia e na foto) */
  function hash(x, y) { let h = (x * 374761393 + y * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177 | 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967295; }

  /* Aplica no ImageData do contexto (alpha = intensidade 0..1) */
  function apply(ctx, w, h, id, alpha) {
    const d0 = BY_ID.get(id);
    if (!d0 || !alpha) return false;
    const img = ctx.getImageData(0, 0, w, h), d = img.data, m = d0.m, [lr, lg, lb] = d0.lut;
    const vig = d0.vignette || 0, gr = d0.grain || 0;
    const cx = w / 2, cy = h / 2, rmax = Math.hypot(cx, cy);
    const gs = Math.max(1, Math.round(Math.max(w, h) / 900));     /* tamanho do grão acompanha a resolução */
    for (let y = 0, i = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i += 4) {
        const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
        let nr = m[0] * r + m[1] * g + m[2] * b + m[3];
        let ng = m[4] * r + m[5] * g + m[6] * b + m[7];
        let nb = m[8] * r + m[9] * g + m[10] * b + m[11];
        nr = lr[Math.max(0, Math.min(255, Math.round(nr * 255)))] / 255;
        ng = lg[Math.max(0, Math.min(255, Math.round(ng * 255)))] / 255;
        nb = lb[Math.max(0, Math.min(255, Math.round(nb * 255)))] / 255;
        if (vig) {
          const dd = Math.hypot(x - cx, y - cy) / rmax;
          const f = 1 - vig * smooth(0.45, 1.05, dd);
          nr *= f; ng *= f; nb *= f;
        }
        if (gr) { const n = (hash((x / gs) | 0, (y / gs) | 0) - 0.5) * 2 * gr; nr += n; ng += n; nb += n; }
        d[i] = Math.round((r + (nr - r) * alpha) * 255);
        d[i + 1] = Math.round((g + (ng - g) * alpha) * 255);
        d[i + 2] = Math.round((b + (nb - b) * alpha) * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    return true;
  }
  function smooth(a, b, x) { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

  /* ── Prévia ao vivo em WebGL ── */
  const VS = 'attribute vec2 p;varying vec2 uv;void main(){uv=vec2(p.x*.5+.5,.5-p.y*.5);gl_Position=vec4(p,0.,1.);}';
  const FS = [
    'precision mediump float;varying vec2 uv;uniform sampler2D v;uniform sampler2D lut;uniform mat3 m;uniform vec3 o;',
    'uniform float vig;uniform float grain;uniform vec2 res;uniform float gs;',
    'float h(vec2 q){return fract(sin(dot(q,vec2(12.9898,78.233)))*43758.5453);}',
    'void main(){vec3 c=texture2D(v,uv).rgb;c=clamp(m*c+o,0.,1.);',
    'c=vec3(texture2D(lut,vec2(c.r*255./256.+.5/256.,.5/3.)).r,texture2D(lut,vec2(c.g*255./256.+.5/256.,1.5/3.)).r,texture2D(lut,vec2(c.b*255./256.+.5/256.,2.5/3.)).r);',
    'if(vig>0.){vec2 d=(uv-.5)*res;float dd=length(d)/length(res*.5);c*=1.-vig*smoothstep(.45,1.05,dd);}',
    'if(grain>0.){c+=(h(floor(uv*res/gs))-.5)*2.*grain;}',
    'gl_FragColor=vec4(clamp(c,0.,1.),1.);}'
  ].join('\n');

  const P = { canvas: null, gl: null, prog: null, tex: null, lutTex: null, raf: 0, id: null, video: null, ok: null, loc: {} };

  function initGL(canvas) {
    const o = { premultipliedAlpha: false, preserveDrawingBuffer: true };   /* mantém o último quadro (desenho só em quadros novos da câmera) */
    const gl = canvas.getContext('webgl2', o) || canvas.getContext('webgl', o) || canvas.getContext('experimental-webgl', o);
    if (!gl) return false;
    const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const ap = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(ap); gl.vertexAttribPointer(ap, 2, gl.FLOAT, false, 0, 0);
    const mk = () => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t; };
    P.tex = mk(); P.lutTex = mk();
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    for (const n of ['v', 'lut', 'm', 'o', 'vig', 'grain', 'res', 'gs']) P.loc[n] = gl.getUniformLocation(prog, n);
    gl.uniform1i(P.loc.v, 0); gl.uniform1i(P.loc.lut, 1);
    P.gl = gl; P.prog = prog;
    P.pacer = root.GSGpuPacer ? new root.GSGpuPacer(gl) : null;
    return true;
  }

  function setUniforms(def) {
    const gl = P.gl, m = def.m;
    /* mat3 do GLSL é coluna-maior */
    gl.uniformMatrix3fv(P.loc.m, false, new Float32Array([m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]]));
    gl.uniform3f(P.loc.o, m[3], m[7], m[11]);
    gl.uniform1f(P.loc.vig, def.vignette || 0);
    gl.uniform1f(P.loc.grain, def.grain || 0);
    const data = new Uint8Array(256 * 3 * 4);
    for (let c = 0; c < 3; c++) for (let i = 0; i < 256; i++) { const o = (c * 256 + i) * 4; data[o] = data[o + 1] = data[o + 2] = def.lut[c][i]; data[o + 3] = 255; }
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, P.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 3, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.activeTexture(gl.TEXTURE0);
  }

  /* DESEMPENHO: processa só quando a câmera entrega um quadro novo
     (requestVideoFrameCallback) — antes reenviava o mesmo quadro à GPU a cada
     atualização da tela (60×/s para uma câmera de 30 quadros/s). */
  function clockOf(v) { const c = v.tagName === 'VIDEO' ? v : document.getElementById('video'); return c && c.requestVideoFrameCallback ? c : null; }
  function schedule() {
    const clk = P.video && clockOf(P.video);
    if (clk) { P.clk = clk; P.raf = -1; P.vfc = clk.requestVideoFrameCallback(frame); }
    else P.raf = requestAnimationFrame(frame);
  }
  function frame() {
    P.raf = 0; P.vfc = 0;
    if (!P.id || !P.video) return;
    const v = P.video, gl = P.gl, c = P.canvas;
    /* fonte: o <video> ou a camada processada ao vivo (canvas do Noite/Retrato) */
    const isVid = v.tagName === 'VIDEO', vw = isVid ? v.videoWidth : v.width, vh = isVid ? v.videoHeight : v.height;
    /* controle de fluxo: só desenha se a GPU já terminou o quadro anterior */
    if (vw && (!isVid || v.readyState >= 2) && (!P.pacer || P.pacer.ready())) {
      const sc = Math.min(1, ((window.GSPerf && GSPerf.previewMax) || 1280) / Math.max(vw, vh));
      const w = Math.round(vw * sc), h = Math.round(vh * sc);
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      gl.viewport(0, 0, w, h);
      gl.uniform2f(P.loc.res, vw, vh);
      gl.uniform1f(P.loc.gs, Math.max(1, Math.round(Math.max(vw, vh) / 900)));
      gl.bindTexture(gl.TEXTURE_2D, P.tex);
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, v); } catch (e) { stopPreview(); return; }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (P.pacer) P.pacer.submitted();
    }
    schedule();
  }

  /* Ativa a prévia do filtro sobre o vídeo. Retorna false se não houver WebGL. */
  function startPreview(canvas, video, id) {
    const def = BY_ID.get(id);
    if (!def) { stopPreview(); return false; }
    if (P.ok === null || P.canvas !== canvas) {
      P.canvas = canvas;
      try { P.ok = initGL(canvas); } catch (e) { console.warn('Filtro WebGL:', e); P.ok = false; }
    }
    if (!P.ok) return false;
    P.video = video; P.id = id;
    setUniforms(def);
    canvas.classList.remove('hidden');
    /* sempre reagenda (a câmera pode ter sido trocada e o callback antigo nunca disparar) */
    if (P.raf > 0) cancelAnimationFrame(P.raf);
    if (P.vfc && P.clk && P.clk.cancelVideoFrameCallback) P.clk.cancelVideoFrameCallback(P.vfc);
    schedule();
    return true;
  }
  function stopPreview() {
    P.id = null;
    if (P.raf > 0) cancelAnimationFrame(P.raf);
    if (P.vfc && P.clk && P.clk.cancelVideoFrameCallback) P.clk.cancelVideoFrameCallback(P.vfc);
    P.raf = 0; P.vfc = 0;
    if (P.canvas) P.canvas.classList.add('hidden');
  }

  /* Aproximação em CSS (sem WebGL) — só para a prévia */
  const CSS_FALLBACK = {
    kodachrome: 'saturate(1.3) contrast(1.15) sepia(.12)', polaroid: 'contrast(.92) brightness(1.08) saturate(.85) hue-rotate(-5deg)',
    anos70: 'sepia(.45) saturate(1.2) contrast(.9) brightness(1.05)', lomo: 'saturate(1.5) contrast(1.3)', technicolor: 'saturate(1.8) contrast(1.1)',
    crossproc: 'saturate(1.3) contrast(1.2) hue-rotate(-12deg)', ilford: 'grayscale(1) contrast(1.4)', cianotipia: 'grayscale(1) sepia(1) hue-rotate(180deg) saturate(2.2)',
    vintage: 'sepia(.6) contrast(.85) brightness(1.1)', tealorange: 'saturate(1.25) contrast(1.1) hue-rotate(-8deg)', cyberpunk: 'saturate(1.6) hue-rotate(25deg) contrast(1.2)',
    vaporwave: 'saturate(1.3) hue-rotate(-30deg) brightness(1.1)', moody: 'saturate(.65) contrast(1.15) brightness(.9)', clarendon: 'saturate(1.35) contrast(1.2)',
    juno: 'saturate(1.35) sepia(.1) contrast(1.1)', lark: 'brightness(1.1) saturate(.85) contrast(.95)', goldenhour: 'sepia(.35) saturate(1.3) brightness(1.05)',
    matte: 'contrast(.82) brightness(1.08) saturate(.85)', neonnoir: 'grayscale(1) sepia(1) hue-rotate(220deg) saturate(2) contrast(1.3)'
  };

  /* prepara o WebGL dos filtros num momento ocioso (o 1º toque num filtro fica instantâneo) */
  function prewarm(canvas) {
    if (P.ok !== null) return;
    P.canvas = canvas;
    try { P.ok = initGL(canvas); } catch (e) { P.ok = false; }
  }

  root.GSFilters = { prewarm, DEFS, has: id => BY_ID.has(id), get: id => BY_ID.get(id), apply, startPreview, stopPreview, cssFallback: id => CSS_FALLBACK[id] || 'none' };
})(window);
