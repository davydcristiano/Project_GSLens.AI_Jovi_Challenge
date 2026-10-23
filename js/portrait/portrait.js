/* GSLens.AI — Modo Retrato com desfoque real do fundo
   ─────────────────────────────────────────────────────────────
   1. Segmentação: o modelo Selfie Segmentation do MediaPipe (Apache 2.0),
      executado no próprio aparelho por js/portrait/tflite.js num Worker,
      diz para cada pixel a probabilidade de ser pessoa (máscara 256×144 ou
      256×256, conforme a proporção da câmera).
   2. Composição em WebGL:
      • o fundo é desfocado só com pixels de fundo (desfoque "pré-multiplicado"
        pela máscara) — a pessoa não vaza como um halo para o fundo;
      • a máscara de baixa resolução é refinada na resolução da imagem com um
        filtro bilateral guiado pelas cores (bordas de cabelo/ombro seguem a
        imagem real);
      • resultado = mistura entre a imagem nítida e o fundo desfocado.
   3. Foto: a mesma composição em resolução cheia, com uma inferência nova
      sobre o quadro capturado.
   Nenhuma imagem sai do dispositivo. */
(function (root) {
  'use strict';
  const VER = '20261022d';
  const BASE = (function () {
    const s = document.currentScript && document.currentScript.src;
    return s ? new URL('.', s).href : 'js/portrait/';
  })();

  /* ═════════════ SEGMENTAÇÃO ═════════════ */
  const Seg = {
    worker: null, ready: null, busy: false, seq: 0, pending: new Map(), mainNets: null, lastMs: 0,
    init() {
      if (this.ready) return this.ready;
      this.ready = new Promise((resolve, reject) => {
        try {
          const w = new Worker(BASE + 'seg-worker.js?v=' + VER);
          const fail = err => { w.terminate(); this.worker = null; this.initMain().then(resolve, reject); console.warn('Retrato: worker indisponível, usando a thread principal', err); };
          w.onerror = e => { e.preventDefault && e.preventDefault(); fail(e.message || e); };
          w.onmessage = e => {
            const m = e.data;
            if (m.type === 'ready') { this.worker = w; w.onerror = null; resolve(); }
            else if (m.type === 'error' && m.id === undefined) fail(m.error);
            else if (this.pending.has(m.id)) {
              const p = this.pending.get(m.id); this.pending.delete(m.id);
              if (m.type === 'mask') { this.lastMs = m.ms; p.resolve(m); } else p.reject(new Error(m.error));
            }
          };
          w.postMessage({ type: 'init' });
        } catch (e) { this.initMain().then(resolve, reject); }
      });
      this.ready.catch(() => { this.ready = null; });
      return this.ready;
    },
    /* reserva: executa na thread principal (abrindo o app direto do disco, por exemplo) */
    async initMain() {
      if (!root.GSTFLite) throw new Error('executor de modelos (tflite.js) não carregado');
      const get = async f => { const r = await fetch(BASE + 'models/' + f); if (!r.ok) throw new Error('modelo não encontrado'); return new GSTFLite.Interpreter(GSTFLite.parse(await r.arrayBuffer())); };
      this.mainNets = { square: await get('selfie_segmentation.tflite'), landscape: await get('selfie_segmentation_landscape.tflite') };
    },
    /* modelo paisagem (256×144) para câmeras deitadas; quadrado (256×256) para as demais */
    modelFor(w, h) { return w / h > 1.25 ? 'landscape' : 'square'; },
    canvas: null,
    async run(source, sw, sh) {
      await this.init();
      const model = this.modelFor(sw, sh), W = 256, H = model === 'landscape' ? 144 : 256;
      if (!this.canvas) { this.canvas = document.createElement('canvas'); }
      const c = this.canvas; c.width = W; c.height = H;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(source, 0, 0, W, H);
      const rgba = x.getImageData(0, 0, W, H).data;
      if (this.worker) {
        const id = ++this.seq;
        return new Promise((resolve, reject) => {
          this.pending.set(id, { resolve, reject });
          this.worker.postMessage({ type: 'run', id, model, rgba }, [rgba.buffer]);
        });
      }
      const net = this.mainNets[model], inp = new Float32Array(W * H * 3);
      for (let i = 0, j = 0; i < W * H; i++, j += 4) { inp[i * 3] = rgba[j] / 255; inp[i * 3 + 1] = rgba[j + 1] / 255; inp[i * 3 + 2] = rgba[j + 2] / 255; }
      const t0 = performance.now(), mask = new Float32Array(net.run(inp)); this.lastMs = performance.now() - t0;
      return { mask, w: W, h: H, ms: this.lastMs };
    }
  };

  /* fração da imagem ocupada por pessoa (decide se há alguém para recortar) */
  function personFraction(mask) { let n = 0; for (let i = 0; i < mask.length; i++) if (mask[i] > 0.5) n++; return n / mask.length; }

  /* ═════════════ COMPOSIÇÃO (WebGL) ═════════════ */
  const VS = 'attribute vec2 p;varying vec2 uv;void main(){uv=p*.5+.5;gl_Position=vec4(p,0.,1.);}';
  /* 1) reduz para 1/4 e pré-multiplica pelo "quanto é fundo" */
  const FS_DOWN = [
    'precision mediump float;varying vec2 uv;uniform sampler2D img;uniform sampler2D msk;uniform vec2 px;',
    'void main(){vec3 c=vec3(0.);',
    /* 4 amostras bilineares em ±1 px = média 4×4 (redução para 1/4 sem serrilhado) */
    ' for(int j=0;j<2;j++)for(int i=0;i<2;i++)c+=texture2D(img,uv+(vec2(float(i),float(j))*2.-1.)*px).rgb;',
    ' c*=.25; float bg=1.-smoothstep(.15,.55,texture2D(msk,uv).r);',
    ' gl_FragColor=vec4(c*bg,bg);}'
  ].join('\n');
  /* 2) desfoque gaussiano separável (13 amostras) */
  const FS_BLUR = [
    'precision mediump float;varying vec2 uv;uniform sampler2D src;uniform vec2 dir;',
    'void main(){vec4 s=vec4(0.);float ws=0.;',
    ' for(int k=-6;k<=6;k++){float t=float(k);float w=exp(-t*t/18.);s+=texture2D(src,uv+dir*t)*w;ws+=w;}',
    ' gl_FragColor=s/ws;}'
  ].join('\n');
  /* 3) máscara refinada (bilateral guiado pela imagem) + mistura final */
  const FS_COMP = [
    'precision mediump float;varying vec2 uv;uniform sampler2D img;uniform sampler2D msk;uniform sampler2D blr;uniform vec2 mpx;uniform float on;uniform float hl;',
    'void main(){',
    ' vec3 c0=texture2D(img,uv).rgb;',
    ' float s=0.,ws=0.;',
    ' for(int j=-2;j<=2;j++)for(int i=-2;i<=2;i++){',
    '  vec2 o=vec2(float(i),float(j))*mpx*.75;',
    '  vec3 ci=texture2D(img,uv+o).rgb; vec3 d=ci-c0;',
    '  float w=exp(-float(i*i+j*j)/5.-dot(d,d)*40.);',
    '  s+=texture2D(msk,uv+o).r*w; ws+=w;}',
    ' float a=smoothstep(.3,.7,s/ws);',
    ' vec4 b=texture2D(blr,uv); vec3 bg=b.a>.02?b.rgb/b.a:c0;',
    ' bg+=max(bg-.75,0.)*hl;',                          /* realce leve das luzes do fundo (bokeh) */
    ' vec3 o=mix(bg,c0,on>.5?a:1.);',
    ' gl_FragColor=vec4(o,1.);}'
  ].join('\n');

  class Compositor {
    constructor(canvas) {
      const gl = canvas.getContext('webgl', { premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: true });
      if (!gl) throw new Error('WebGL indisponível');
      this.gl = gl; this.canvas = canvas;
      const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
      const prog = (fs, names) => {
        const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
        const loc = {}; for (const n of names) loc[n] = gl.getUniformLocation(p, n); return { p, loc, ap: gl.getAttribLocation(p, 'p') };
      };
      this.pDown = prog(FS_DOWN, ['img', 'msk', 'px']);
      this.pBlur = prog(FS_BLUR, ['src', 'dir']);
      this.pComp = prog(FS_COMP, ['img', 'msk', 'blr', 'mpx', 'on', 'hl']);
      this.buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const tex = () => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t; };
      this.tImg = tex(); this.tMsk = tex();
      this.tA = tex(); this.tB = tex(); this.fA = gl.createFramebuffer(); this.fB = gl.createFramebuffer();
      this.qw = 0; this.qh = 0; this.mask8 = null;
    }
    setMask(mask, w, h) {
      const gl = this.gl;
      if (!this.mask8 || this.mask8.length !== w * h) this.mask8 = new Uint8Array(w * h);
      for (let i = 0; i < mask.length; i++) this.mask8[i] = mask[i] * 255;
      gl.bindTexture(gl.TEXTURE_2D, this.tMsk);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, w, h, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, this.mask8);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      this.mw = w; this.mh = h;
    }
    draw(source, w, h, amount, enabled) {
      const gl = this.gl, c = this.canvas;
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      const qw = Math.max(8, Math.round(w / 4)), qh = Math.max(8, Math.round(h / 4));
      if (qw !== this.qw || qh !== this.qh) {
        for (const [t, f] of [[this.tA, this.fA], [this.tB, this.fB]]) {
          gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, qw, qh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
        }
        this.qw = qw; this.qh = qh;
      }
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tImg);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      const quad = pr => { gl.useProgram(pr.p); gl.bindBuffer(gl.ARRAY_BUFFER, this.buf); gl.enableVertexAttribArray(pr.ap); gl.vertexAttribPointer(pr.ap, 2, gl.FLOAT, false, 0, 0); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); };
      const bind = (unit, t) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); };
      if (enabled) {
        /* 1/4 de resolução, fundo pré-multiplicado */
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fA); gl.viewport(0, 0, qw, qh);
        bind(0, this.tImg); bind(1, this.tMsk);
        gl.useProgram(this.pDown.p); gl.uniform1i(this.pDown.loc.img, 0); gl.uniform1i(this.pDown.loc.msk, 1); gl.uniform2f(this.pDown.loc.px, 1 / w, 1 / h);
        quad(this.pDown);
        /* desfoque gaussiano separável, 3 passadas: σ ≈ 3·r·√3 (em pixels de 1/4).
           Espaçamento r ≤ 1,6 px evita listras. σ cresce com "amount". */
        const r = 0.12 + amount * 1.45;
        gl.useProgram(this.pBlur.p); gl.uniform1i(this.pBlur.loc.src, 0);
        for (let it = 0; it < 3; it++) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.fB); bind(0, this.tA); gl.uniform2f(this.pBlur.loc.dir, r / qw, 0); quad(this.pBlur);
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.fA); bind(0, this.tB); gl.uniform2f(this.pBlur.loc.dir, 0, r / qh); quad(this.pBlur);
        }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, w, h);
      bind(0, this.tImg); bind(1, this.tMsk); bind(2, this.tA);
      gl.useProgram(this.pComp.p);
      gl.uniform1i(this.pComp.loc.img, 0); gl.uniform1i(this.pComp.loc.msk, 1); gl.uniform1i(this.pComp.loc.blr, 2);
      gl.uniform2f(this.pComp.loc.mpx, 1 / (this.mw || 256), 1 / (this.mh || 256));
      gl.uniform1f(this.pComp.loc.on, enabled ? 1 : 0);
      gl.uniform1f(this.pComp.loc.hl, 0.5 * amount);
      quad(this.pComp);
    }
  }

  /* ═════════════ PRÉVIA AO VIVO ═════════════ */
  const L = { on: false, comp: null, canvas: null, video: null, amount: 0.6, mask: null, mw: 0, mh: 0, person: 0, vfc: 0, raf: 0, onStatus: null, err: null, inferences: 0 };

  function liveFrame() {
    if (!L.on) return;
    const v = L.video;
    if (v.videoWidth && v.readyState >= 2) {
      const sc = Math.min(1, 960 / Math.max(v.videoWidth, v.videoHeight));
      const w = Math.round(v.videoWidth * sc), h = Math.round(v.videoHeight * sc);
      try { L.comp.draw(v, w, h, L.amount, !!L.mask && L.person > 0.01); } catch (e) { console.warn('Retrato:', e); }
      if (!Seg.busy) {
        Seg.busy = true;
        Seg.run(v, v.videoWidth, v.videoHeight).then(r => {
          Seg.busy = false;
          if (!L.on) return;
          /* suavização temporal da máscara (evita tremulação nas bordas) */
          if (L.mask && L.mask.length === r.mask.length) for (let i = 0; i < r.mask.length; i++) L.mask[i] = L.mask[i] * 0.35 + r.mask[i] * 0.65;
          else L.mask = r.mask;
          L.mw = r.w; L.mh = r.h; L.inferences++;
          L.comp.setMask(L.mask, r.w, r.h);
          const pf = personFraction(L.mask), had = L.person > 0.01;
          L.person = pf;
          if (L.onStatus && (had !== pf > 0.01 || L.inferences === 1)) L.onStatus({ person: pf > 0.01, ms: r.ms });
        }).catch(e => { Seg.busy = false; L.err = e; if (L.onStatus) L.onStatus({ error: e.message }); });
      }
    }
    if (v.requestVideoFrameCallback) L.vfc = v.requestVideoFrameCallback(liveFrame);
    else L.raf = requestAnimationFrame(liveFrame);
  }

  function startLive(canvas, video, opts) {
    opts = opts || {};
    try {
      if (!L.comp || L.canvas !== canvas) { L.comp = new Compositor(canvas); L.canvas = canvas; }
    } catch (e) { console.warn('Retrato:', e); return false; }
    L.video = video; L.on = true; L.mask = null; L.person = 0; L.inferences = 0; L.err = null;
    if (opts.amount != null) L.amount = opts.amount;
    L.onStatus = opts.onStatus || null;
    canvas.classList.remove('hidden');
    Seg.init().catch(e => { L.err = e; if (L.onStatus) L.onStatus({ error: e.message }); });
    if (video.requestVideoFrameCallback) L.vfc = video.requestVideoFrameCallback(liveFrame);
    else L.raf = requestAnimationFrame(liveFrame);
    return true;
  }
  function stopLive() {
    L.on = false;
    if (L.vfc && L.video && L.video.cancelVideoFrameCallback) L.video.cancelVideoFrameCallback(L.vfc);
    if (L.raf) cancelAnimationFrame(L.raf);
    L.vfc = L.raf = 0;
    if (L.canvas) L.canvas.classList.add('hidden');
  }

  /* ═════════════ FOTO ═════════════
     Recebe o canvas da foto (já com zoom/espelhamento aplicados), segmenta
     esse mesmo quadro e devolve a foto com o fundo desfocado. */
  let stillComp = null, stillCanvas = null;
  async function renderStill(srcCanvas, amount) {
    const W = srcCanvas.width, H = srcCanvas.height;
    const r = await Seg.run(srcCanvas, W, H);
    const pf = personFraction(r.mask);
    if (pf <= 0.01) return { applied: false, person: pf };
    if (!stillComp) { stillCanvas = document.createElement('canvas'); stillComp = new Compositor(stillCanvas); }
    const maxTex = stillComp.gl.getParameter(stillComp.gl.MAX_TEXTURE_SIZE);
    const sc = Math.min(1, maxTex / Math.max(W, H));
    const w = Math.round(W * sc), h = Math.round(H * sc);
    stillComp.setMask(r.mask, r.w, r.h);
    /* o desfoque é proporcional ao tamanho: mesma aparência da prévia */
    stillComp.draw(srcCanvas, w, h, (amount == null ? L.amount : amount), true);
    const ctx = srcCanvas.getContext('2d');
    ctx.drawImage(stillCanvas, 0, 0, W, H);
    return { applied: true, person: pf, ms: r.ms, model: Seg.modelFor(W, H) };
  }

  root.GSPortrait = {
    startLive, stopLive, renderStill,
    setAmount(v) { L.amount = Math.max(0, Math.min(1, v)); },
    get amount() { return L.amount; },
    liveActive: () => L.on,
    preload: () => Seg.init(),
    segment: (src, w, h) => Seg.run(src, w, h),
    _live: L, _seg: Seg
  };
})(window);
