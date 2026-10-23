/* GSLens.AI — Modo Noite e Slow-Mo
   ─────────────────────────────────────────────────────────────
   GSNight
     • liveGain(video): mede a luminosidade da cena (amostra 48×27) e devolve
       o ganho usado na prévia ao vivo (CSS brightness) — a tela clareia
       conforme o ambiente escurece, como no modo Noite dos celulares.
     • capture(): fotografia noturna por EMPILHAMENTO de quadros: captura
       vários quadros seguidos, alinha cada um ao de referência (busca de
       deslocamento em pirâmide, para compensar a mão tremendo), mescla com
       peso por semelhança (evita "fantasmas" de quem se mexe) e aplica
       ganho adaptativo + curva de tons com proteção de altas luzes.
       A média de N quadros reduz o ruído em ≈ √N.
   GSSlowMo
     • prepare(track): pede a maior taxa de quadros que a câmera oferece.
     • process(blob): gera o vídeo em câmera lenta de verdade — reproduz a
       gravação a 0,5× (ou 0,25× se a câmera gravou ≥ 100 fps) num canvas e
       grava de novo a 30 fps, interpolando quadros (fusão) quando a câmera
       não tem quadros suficientes. O arquivo final fica mais longo e toca
       lento em qualquer player. */
(function (root) {
  'use strict';

  /* ═════════════ NOITE ═════════════ */
  const probe = document.createElement('canvas'); probe.width = 48; probe.height = 27;
  const px = probe.getContext('2d', { willReadFrequently: true });
  let smoothGain = 1;

  function sceneStats(video) {
    if (!video || !video.videoWidth) return null;
    px.drawImage(video, 0, 0, 48, 27);
    const d = px.getImageData(0, 0, 48, 27).data;
    let s = 0; const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) { const l = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8; s += l; hist[l]++; }
    const n = d.length / 4;
    let acc = 0, p97 = 255;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.97) { p97 = v; break; } }
    return { mean: s / n, p97 };
  }

  /* ganho para a prévia: alvo de luminância média ≈ 0,40; limitado a 3× */
  function liveGain(video, maxGain) {
    const st = sceneStats(video);
    if (!st) return smoothGain;
    const target = Math.min(maxGain || 3, Math.max(1, 102 / Math.max(st.mean, 4)));
    smoothGain += (target - smoothGain) * 0.35;
    return smoothGain;
  }

  /* espera um quadro NOVO da câmera */
  function nextFrame(video) {
    return new Promise(res => {
      if (video.requestVideoFrameCallback) {
        let done = false;
        const t = setTimeout(() => { if (!done) { done = true; res(); } }, 120);
        video.requestVideoFrameCallback(() => { if (!done) { done = true; clearTimeout(t); res(); } });
      } else setTimeout(res, 34);
    });
  }

  /* reduz imagem cinza pela metade (média 2×2) */
  function half(g, w, h) {
    const W = w >> 1, H = h >> 1, o = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (2 * y) * w + 2 * x;
      o[y * W + x] = (g[i] + g[i + 1] + g[i + w] + g[i + w + 1]) >> 2;
    }
    return { g: o, w: W, h: H };
  }

  function grayOf(d, w, h) {
    const g = new Uint8Array(w * h);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    return g;
  }

  /* erro médio absoluto entre ref e img deslocada (dx,dy), na região central */
  function sad(a, b, w, h, dx, dy, step) {
    const mx = Math.ceil(w * 0.12) + Math.abs(dx), my = Math.ceil(h * 0.12) + Math.abs(dy);
    let s = 0, n = 0;
    for (let y = my; y < h - my; y += step) {
      const ra = y * w, rb = (y + dy) * w + dx;
      for (let x = mx; x < w - mx; x += step) { s += Math.abs(a[ra + x] - b[rb + x]); n++; }
    }
    return n ? s / n : 1e9;
  }

  function bestShift(a, b, w, h, cx, cy, r, step) {
    let best = { dx: cx, dy: cy, e: sad(a, b, w, h, cx, cy, step) };
    for (let dy = cy - r; dy <= cy + r; dy++) for (let dx = cx - r; dx <= cx + r; dx++) {
      if (dx === cx && dy === cy) continue;
      const e = sad(a, b, w, h, dx, dy, step);
      if (e < best.e) best = { dx, dy, e };
    }
    return best;
  }

  /* pirâmide: 1/8 (±5 → ±40 px), 1/4, 1/2, 1/1 (±1 em cada nível) */
  function align(refPyr, img, w, h) {
    const pyr = [{ g: grayOf(img, w, h), w, h }];
    while (pyr.length < 4) { const p = pyr[pyr.length - 1]; pyr.push(half(p.g, p.w, p.h)); }
    let dx = 0, dy = 0, e = 0;
    for (let L = 3; L >= 0; L--) {
      const R = refPyr[L], P = pyr[L];
      const b = bestShift(R.g, P.g, R.w, R.h, dx, dy, L === 3 ? 5 : 1, L === 0 ? 3 : (L === 1 ? 2 : 1));
      dx = b.dx; dy = b.dy; e = b.e;
      if (L) { dx *= 2; dy *= 2; }
    }
    return { dx, dy, err: e };
  }

  function pyramid(d, w, h) {
    const pyr = [{ g: grayOf(d, w, h), w, h }];
    while (pyr.length < 4) { const p = pyr[pyr.length - 1]; pyr.push(half(p.g, p.w, p.h)); }
    return pyr;
  }

  /* grab: desenha o quadro atual no ctx (já com recorte de zoom e espelhamento) */
  async function capture(opts) {
    /* congela a prévia ao vivo durante a captura (libera o processador) */
    const live = NL.on;
    if (live) suspendLive();
    try { return await captureStack(opts); }
    finally { if (live) resumeLive(); }
  }

  async function captureStack(opts) {
    const { video, ctx, w, h, grab, onProgress } = opts;
    const st = sceneStats(video) || { mean: 60 };
    /* cenas mais escuras → mais quadros */
    const N = st.mean < 25 ? 12 : st.mean < 60 ? 10 : 6;
    const ref = (grab(), ctx.getImageData(0, 0, w, h));
    const refPyr = pyramid(ref.data, w, h);
    const n = w * h;
    const accR = new Float32Array(n), accG = new Float32Array(n), accB = new Float32Array(n), accW = new Float32Array(n);
    const rd = ref.data;
    for (let i = 0, j = 0; j < n; i += 4, j++) { accR[j] = rd[i]; accG[j] = rd[i + 1]; accB[j] = rd[i + 2]; accW[j] = 1; }
    let used = 1;
    if (onProgress) onProgress(1, N);
    for (let k = 1; k < N; k++) {
      await nextFrame(video);
      grab();
      const d = ctx.getImageData(0, 0, w, h).data;
      const a = align(refPyr, d, w, h);
      const { dx, dy } = a;
      /* ruído real medido: mediana da diferença ao quadro de referência
         (já alinhado) — a maioria dos pixels é cena parada + ruído */
      const hd = new Uint32Array(256); let cnt = 0;
      for (let y = 8; y < h - 8; y += 7) {
        const sy = Math.min(h - 1, Math.max(0, y + dy));
        for (let x = 8; x < w - 8; x += 7) {
          const sx = Math.min(w - 1, Math.max(0, x + dx)), i = (sy * w + sx) * 4, r0 = (y * w + x) * 4;
          hd[Math.min(255, Math.abs(d[i + 1] - rd[r0 + 1]))]++; cnt++;
        }
      }
      let med = 0; for (let v = 0, acc = 0; v < 256; v++) { acc += hd[v]; if (acc >= cnt / 2) { med = v; break; } }
      const sdiff = Math.max(1.5, med * 1.4826);
      if (a.err > sdiff * 3 + 6) { if (onProgress) onProgress(k + 1, N); continue; } /* quadro tremido demais */
      used++;
      /* peso de Tukey: diferença dentro do ruído → peso ~1; acima de T
         (algo se moveu) → 0. Evita "fantasmas" de objetos em movimento. */
      const T = sdiff * 3.5 + 4, iT2 = 1 / (T * T);
      for (let y = 0; y < h; y++) {
        const sy = Math.min(h - 1, Math.max(0, y + dy));
        for (let x = 0; x < w; x++) {
          const sx = Math.min(w - 1, Math.max(0, x + dx));
          const j = y * w + x, i = (sy * w + sx) * 4, r0 = j * 4;
          let m = Math.abs(d[i] - rd[r0]), t2 = Math.abs(d[i + 1] - rd[r0 + 1]), t3 = Math.abs(d[i + 2] - rd[r0 + 2]);
          if (t2 > m) m = t2; if (t3 > m) m = t3;
          const q = 1 - m * m * iT2;
          if (q <= 0) continue;
          const wt = q * q;
          accR[j] += d[i] * wt; accG[j] += d[i + 1] * wt; accB[j] += d[i + 2] * wt; accW[j] += wt;
        }
      }
      if (onProgress) onProgress(k + 1, N);
      await new Promise(r => setTimeout(r, 0));
    }

    /* ── tons: ganho adaptativo + ombro suave nas altas luzes ── */
    const out = ctx.createImageData(w, h), od = out.data;
    const L = new Float32Array(n);
    let sum = 0;
    const hist = new Uint32Array(256);
    for (let j = 0; j < n; j++) {
      const iw = 1 / accW[j];
      accR[j] *= iw; accG[j] *= iw; accB[j] *= iw;
      const l = 0.299 * accR[j] + 0.587 * accG[j] + 0.114 * accB[j];
      L[j] = l; sum += l; hist[Math.min(255, l | 0)]++;
    }
    const mean = sum / n;
    let acc = 0, p99 = 255;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.99) { p99 = v; break; } }
    /* ganho: média → ~0,42; quanto menos quadros úteis, menor o ganho (mais ruído) */
    const maxGain = Math.min(6, 1.6 + used * 0.4);
    const gain = Math.min(maxGain, Math.max(1, 107 / Math.max(mean, 3)));
    const shoulder = v => v < 0.78 ? v : 0.78 + 0.22 * (1 - Math.exp(-(v - 0.78) / 0.22));
    const curve = new Float32Array(1024);   /* tabela L(0..255,1/4) → saída */
    for (let i = 0; i < 1024; i++) {
      const x = i / 1023;
      let v = shoulder(x * gain);
      v = Math.pow(v, 0.92);                /* leve abertura de sombras */
      curve[i] = v * 255;
    }
    void p99;
    for (let j = 0, i = 0; j < n; j++, i += 4) {
      const l = L[j];
      const lo = curve[Math.min(1023, (l * 4.0118) | 0)];
      const k = l > 0.5 ? lo / l : gain;
      /* nas sombras muito amplificadas, reduz a saturação (ruído de cor) */
      const sat = l < 30 ? 0.75 + l / 120 : 1;
      let r = lo + (accR[j] - l) * k * sat, g = lo + (accG[j] - l) * k * sat, b = lo + (accB[j] - l) * k * sat;
      od[i] = r < 0 ? 0 : r > 255 ? 255 : r;
      od[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      od[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      od[i + 3] = 255;
    }
    /* nitidez leve (a média suaviza um pouco) — unsharp 3×3 na luminância */
    sharpen(od, w, h, 0.35);
    ctx.putImageData(out, 0, 0);
    return { frames: N, used, gain: +gain.toFixed(2), mean: +mean.toFixed(1) };
  }

  function sharpen(d, w, h, amt) {
    const g = grayOf(d, w, h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const j = y * w + x;
      const blur = (g[j - w - 1] + 2 * g[j - w] + g[j - w + 1] + 2 * g[j - 1] + 4 * g[j] + 2 * g[j + 1] + g[j + w - 1] + 2 * g[j + w] + g[j + w + 1]) >> 4;
      const dl = (g[j] - blur) * amt, i = j * 4;
      let v = d[i] + dl; d[i] = v < 0 ? 0 : v > 255 ? 255 : v;
      v = d[i + 1] + dl; d[i + 1] = v < 0 ? 0 : v > 255 ? 255 : v;
      v = d[i + 2] + dl; d[i + 2] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }

  /* ═════════════ NOITE — PRÉVIA COM REDUÇÃO DE RUÍDO AO VIVO (WebGL) ═════════════
     Passo 1 (temporal): cada pixel guarda uma média acumulada dos quadros e
       quantos quadros ela representa (até 16). Onde a imagem muda mais do que
       o ruído esperado (algo se moveu), a média recomeça do quadro atual — sem
       rastro. Em áreas paradas o ruído cai ≈ √N.
     Passo 2 (espacial + tons): filtro bilateral 5×5 (suaviza o ruído que
       sobrou sem borrar bordas, mais forte onde há poucos quadros acumulados)
       e a mesma curva de ganho/altas luzes da foto noturna.
     Precisa de WebGL2 com textura de ponto flutuante (ou WebGL1 com half-float);
     sem isso o app volta ao clareamento simples por CSS. */
  const NL = { gl: null, ok: null, canvas: null, video: null, raf: 0, vfc: 0, on: false, w: 0, h: 0, ping: 0, frames: 0, gain: 1, sigma: 4, lastT: -1 };
  const VSF = 'attribute vec2 p;varying vec2 uv;void main(){uv=vec2(p.x*.5+.5,p.y*.5+.5);gl_Position=vec4(p,0.,1.);}';
  /* temporal: cur (vídeo), acc (rgb = média, a = nº de quadros/16) */
  const FS_T = [
    'precision highp float;varying vec2 uv;uniform sampler2D cur;uniform sampler2D acc;uniform vec2 px;uniform float sig;uniform float first;',
    'float L(vec3 c){return dot(c,vec3(.299,.587,.114));}',
    'void main(){',
    ' vec3 c=texture2D(cur,uv).rgb; vec4 a=texture2D(acc,uv);',
    ' if(first>.5){gl_FragColor=vec4(c,1./16.);return;}',
    ' float bc=0.,ba=0.;',
    ' for(int j=-1;j<=1;j++)for(int i=-1;i<=1;i++){vec2 o=vec2(float(i),float(j))*px; bc+=L(texture2D(cur,uv+o).rgb); ba+=L(texture2D(acc,uv+o).rgb);}',
    ' float d=abs(bc-ba)/9.*255.;',                                   /* diferença da média 3×3 (σ do ruído cai 3×) */
    ' float m=smoothstep(sig*1.2,sig*3.5,d);',                         /* 0 = parado, 1 = movimento */
    ' float n=a.a*16.; n=mix(min(n+1.,16.),1.,m);',
    ' gl_FragColor=vec4(mix(a.rgb,c,1./n),n/16.);}'
  ].join('\n');
  /* exibição: bilateral 5×5 + ganho com ombro nas altas luzes (igual à foto) */
  const FS_D = [
    'precision highp float;varying vec2 uv;uniform sampler2D acc;uniform vec2 px;uniform float gain;uniform float sig;',
    'float L(vec3 c){return dot(c,vec3(.299,.587,.114));}',
    'float sh(float v){return v<.78?v:.78+.22*(1.-exp(-(v-.78)/.22));}',
    'void main(){',
    ' vec4 c0=texture2D(acc,uv); float n=max(1.,c0.a*16.);',
    ' float rs=max(1.5,sig*2.2/sqrt(n))/255.;',                          /* faixa do bilateral = ruído restante */
    ' vec3 s=vec3(0.); float ws=0.;',
    ' for(int j=-2;j<=2;j++)for(int i=-2;i<=2;i++){',
    '  vec3 q=texture2D(acc,uv+vec2(float(i),float(j))*px).rgb; vec3 dq=q-c0.rgb;',
    '  float w=exp(-float(i*i+j*j)/4.5-dot(dq,dq)/(2.*rs*rs*3.));',
    '  s+=q*w; ws+=w;}',
    ' vec3 c=s/ws; float l=L(c);',
    ' float lo=pow(sh(l*gain),.92);',
    ' float k=l>.002?lo/l:gain; float sat=l<.12?.75+l*2.:1.;',
    ' vec3 o=lo+(c-l)*k*sat;',
    ' gl_FragColor=vec4(clamp(o,0.,1.),1.);}'
  ].join('\n');

  function nlInit(canvas) {
    let gl = canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: true });
    let fmt = null;
    if (gl && gl.getExtension('EXT_color_buffer_float')) fmt = { internal: gl.RGBA16F, type: gl.HALF_FLOAT };
    if (!fmt) {
      gl = canvas.getContext('webgl', { premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: true });
      const hf = gl && gl.getExtension('OES_texture_half_float');
      if (gl && hf && gl.getExtension('EXT_color_buffer_half_float')) fmt = { internal: gl.RGBA, type: hf.HALF_FLOAT_OES };
    }
    if (!gl || !fmt) return false;
    const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
    const prog = (vs, fs, names) => {
      const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      const loc = {}; for (const n of names) loc[n] = gl.getUniformLocation(p, n);
      return { p, loc, ap: gl.getAttribLocation(p, 'p') };
    };
    NL.pt = prog(VSF, FS_T, ['cur', 'acc', 'px', 'sig', 'first']);
    NL.pd = prog(VSF, FS_D, ['acc', 'px', 'gain', 'sig']);
    NL.buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, NL.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const tex = () => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t; };
    NL.cur = tex();
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);   /* reduz o vídeo ao enviar */
    NL.acc = [tex(), tex()]; NL.fb = [gl.createFramebuffer(), gl.createFramebuffer()];
    NL.fmt = fmt; NL.gl = gl; NL.tex = tex;
    return true;
  }

  function nlAlloc(w, h) {
    const gl = NL.gl;
    for (let k = 0; k < 2; k++) {
      gl.bindTexture(gl.TEXTURE_2D, NL.acc[k]);
      gl.texImage2D(gl.TEXTURE_2D, 0, NL.fmt.internal, w, h, 0, gl.RGBA, NL.fmt.type, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, NL.fb[k]);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, NL.acc[k], 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('framebuffer de ponto flutuante indisponível');
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    NL.w = w; NL.h = h; NL.frames = 0;
  }

  function nlDraw(prog) {
    const gl = NL.gl;
    gl.useProgram(prog.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, NL.buf);
    gl.enableVertexAttribArray(prog.ap); gl.vertexAttribPointer(prog.ap, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /* processa um quadro novo do vídeo */
  function nlStep() {
    const v = NL.video, gl = NL.gl;
    if (!NL.on || !v || !v.videoWidth || v.readyState < 2) return;
    /* resolução de trabalho: até 960 px no lado maior (prévia) */
    const sc = Math.min(1, 960 / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.round(v.videoWidth * sc), h = Math.round(v.videoHeight * sc);
    if (w !== NL.w || h !== NL.h) { nlAlloc(w, h); NL.canvas.width = w; NL.canvas.height = h; }
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, NL.cur);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);      /* textura na orientação do GL (como os framebuffers) */
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v); } catch (e) { stopLive(); return; }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    const src = NL.ping, dst = 1 - NL.ping;
    gl.bindFramebuffer(gl.FRAMEBUFFER, NL.fb[dst]); gl.viewport(0, 0, w, h);
    gl.useProgram(NL.pt.p);
    gl.uniform1i(NL.pt.loc.cur, 0); gl.uniform1i(NL.pt.loc.acc, 1);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, NL.acc[src]);
    gl.uniform2f(NL.pt.loc.px, 1 / w, 1 / h);
    gl.uniform1f(NL.pt.loc.sig, NL.sigma);
    gl.uniform1f(NL.pt.loc.first, NL.frames === 0 ? 1 : 0);
    nlDraw(NL.pt);
    NL.ping = dst; NL.frames++;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, w, h);
    gl.useProgram(NL.pd.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, NL.acc[dst]);
    gl.uniform1i(NL.pd.loc.acc, 0);
    gl.uniform2f(NL.pd.loc.px, 1 / w, 1 / h);
    gl.uniform1f(NL.pd.loc.gain, NL.gain);
    gl.uniform1f(NL.pd.loc.sig, NL.sigma);
    nlDraw(NL.pd);
  }

  function nlLoop() {
    NL.raf = 0;
    if (!NL.on) return;
    const v = NL.video;
    /* só processa quando chega um quadro novo (sem requestVideoFrameCallback: compara o tempo) */
    if (!v.requestVideoFrameCallback && v.currentTime !== NL.lastT) { NL.lastT = v.currentTime; nlStep(); }
    NL.raf = requestAnimationFrame(nlLoop);
  }
  function nlOnFrame() {
    if (!NL.on) return;
    nlStep();
    NL.vfc = NL.video.requestVideoFrameCallback(nlOnFrame);
  }

  /* mede ganho da cena e o ruído (diferença entre quadros) na CPU, 4× por segundo */
  let nlProbe = null;
  const prevSmall = new Uint8Array(48 * 27);
  function nlMeasure() {
    if (!NL.on) return;
    NL.gain = liveGain(NL.video, 5);
    try {
      px.drawImage(NL.video, 0, 0, 48, 27);
      const d = px.getImageData(0, 0, 48, 27).data, hd = new Uint32Array(64);
      for (let i = 0, j = 0; j < prevSmall.length; i += 4, j++) { const g = d[i + 1]; hd[Math.min(63, Math.abs(g - prevSmall[j]))]++; prevSmall[j] = g; }
      /* mediana da diferença entre quadros reduzidos (≈ ruído; o vídeo reduzido já é suavizado) */
      let acc = 0, med = 0; for (let v = 0; v < 64; v++) { acc += hd[v]; if (acc >= prevSmall.length / 2) { med = v; break; } }
      NL.sigma += (Math.min(10, Math.max(2, 2 + med * 1.5)) - NL.sigma) * 0.3;
    } catch (e) { /* vídeo ainda sem quadro */ }
  }

  function startLive(canvas, video) {
    if (NL.ok === null || NL.canvas !== canvas) {
      NL.canvas = canvas;
      try { NL.ok = nlInit(canvas); } catch (e) { console.warn('Noite ao vivo:', e); NL.ok = false; }
    }
    if (!NL.ok) return false;
    NL.video = video; NL.on = true; NL.frames = 0; NL.lastT = -1;
    smoothGain = 1; NL.gain = liveGain(video, 5);
    canvas.classList.remove('hidden');
    clearInterval(nlProbe); nlProbe = setInterval(nlMeasure, 250);
    if (video.requestVideoFrameCallback) NL.vfc = video.requestVideoFrameCallback(nlOnFrame);
    else if (!NL.raf) NL.raf = requestAnimationFrame(nlLoop);
    return true;
  }
  function suspendLive() {
    NL.on = false;
    if (NL.raf) cancelAnimationFrame(NL.raf); NL.raf = 0;
    if (NL.vfc && NL.video && NL.video.cancelVideoFrameCallback) NL.video.cancelVideoFrameCallback(NL.vfc); NL.vfc = 0;
  }
  function resumeLive() {
    if (!NL.video || !NL.canvas || NL.canvas.classList.contains('hidden')) return;
    NL.on = true; NL.frames = 0;      /* recomeça o acúmulo (a cena pode ter mudado) */
    if (NL.video.requestVideoFrameCallback) NL.vfc = NL.video.requestVideoFrameCallback(nlOnFrame);
    else if (!NL.raf) NL.raf = requestAnimationFrame(nlLoop);
  }
  function stopLive() {
    NL.on = false;
    clearInterval(nlProbe); nlProbe = null;
    if (NL.raf) cancelAnimationFrame(NL.raf); NL.raf = 0;
    if (NL.vfc && NL.video && NL.video.cancelVideoFrameCallback) NL.video.cancelVideoFrameCallback(NL.vfc); NL.vfc = 0;
    if (NL.canvas) NL.canvas.classList.add('hidden');
  }

  root.GSNight = { liveGain, capture, sceneStats, resetGain: () => { smoothGain = 1; },
    startLive, stopLive, liveActive: () => NL.on, _live: NL };

  /* ═════════════ SLOW-MO ═════════════ */
  async function prepare(track) {
    if (!track) return 30;
    try {
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.frameRate && caps.frameRate.max > 30) {
        await track.applyConstraints({ frameRate: { ideal: Math.min(240, caps.frameRate.max) } });
      }
    } catch (e) { /* mantém a taxa atual */ }
    const s = track.getSettings ? track.getSettings() : {};
    return s.frameRate || 30;
  }

  function supported() {
    return !!(window.MediaRecorder && HTMLCanvasElement.prototype.captureStream);
  }

  function pickMime() {
    if (!MediaRecorder.isTypeSupported) return '';
    return ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4;codecs=avc1', 'video/mp4'].find(m => MediaRecorder.isTypeSupported(m)) || '';
  }

  /* opts: { fps (taxa real da gravação), seconds (duração real), onProgress(0..1), signal:{cancel} } */
  function process(blob, opts) {
    opts = opts || {};
    const rate = (opts.fps || 30) >= 100 ? 0.25 : 0.5;
    const srcSec = Math.max(0.2, opts.seconds || 1);
    return new Promise((resolve, reject) => {
      if (!supported()) { reject(new Error('sem suporte')); return; }
      const url = URL.createObjectURL(blob);
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto';
      v.setAttribute('playsinline', '');
      /* precisa estar no documento para decodificar em todos os navegadores */
      v.style.cssText = 'position:fixed;left:-10px;top:-10px;width:2px;height:2px;opacity:0.01;pointer-events:none';
      document.body.appendChild(v);
      const cv = document.createElement('canvas'), prev = document.createElement('canvas'), cur = document.createElement('canvas');
      let rec = null, raf = 0, finished = false, lastT = -1, tCur = 0, frameDur = 1000 / 30 / rate;
      const chunks = [];
      const cleanup = () => {
        cancelAnimationFrame(raf);
        try { v.pause(); } catch (e) { }
        v.removeAttribute('src'); v.load(); v.remove();
        URL.revokeObjectURL(url);
      };
      const fail = err => { if (finished) return; finished = true; cleanup(); try { rec && rec.state !== 'inactive' && rec.stop(); } catch (e) { } reject(err); };
      v.onerror = () => fail(new Error('não foi possível ler a gravação'));
      v.onloadedmetadata = () => {
        const W = v.videoWidth, H = v.videoHeight;
        if (!W || !H) { fail(new Error('vídeo vazio')); return; }
        for (const c of [cv, prev, cur]) { c.width = W; c.height = H; }
        const ox = cv.getContext('2d'), pc = prev.getContext('2d'), cc = cur.getContext('2d');
        ox.fillStyle = '#000'; ox.fillRect(0, 0, W, H);
        const out = cv.captureStream(30);
        const mime = pickMime();
        try {
          rec = new MediaRecorder(out, Object.assign({ videoBitsPerSecond: Math.min(12e6, Math.max(3e6, W * H * 4)) }, mime ? { mimeType: mime } : {}));
        } catch (e) { fail(e); return; }
        rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onstop = () => {
          if (finished) return;
          finished = true; cleanup();
          const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
          resolve({ blob: new Blob(chunks, { type }), mime: type, rate, seconds: Math.round(srcSec / rate), w: W, h: H });
        };
        /* novo quadro decodificado: o atual vira o anterior */
        const onFrame = (now, meta) => {
          if (finished) return;
          pc.drawImage(cur, 0, 0); cc.drawImage(v, 0, 0, W, H);
          const t = meta && meta.mediaTime != null ? meta.mediaTime : v.currentTime;
          if (lastT >= 0 && t > lastT) frameDur = Math.min(400, Math.max(8, (t - lastT) * 1000 / rate));
          lastT = t; tCur = performance.now();
          if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(onFrame);
        };
        const draw = () => {
          if (finished) return;
          if (!v.requestVideoFrameCallback && v.currentTime !== lastT) onFrame(0, null);
          if (lastT >= 0) {
            /* interpolação por fusão entre o quadro anterior e o atual */
            const a = Math.min(1, (performance.now() - tCur) / frameDur);
            ox.globalAlpha = 1; ox.drawImage(prev, 0, 0);
            ox.globalAlpha = a; ox.drawImage(cur, 0, 0);
            ox.globalAlpha = 1;
          }
          if (opts.onProgress) opts.onProgress(Math.min(1, v.currentTime / srcSec));
          if (opts.signal && opts.signal.cancel) { fail(new Error('cancelado')); return; }
          raf = requestAnimationFrame(draw);
        };
        v.onended = () => {
          if (finished) return;
          ox.globalAlpha = 1; ox.drawImage(cur, 0, 0);
          setTimeout(() => { try { rec.stop(); } catch (e) { fail(e); } }, 120);
        };
        if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(onFrame);
        v.defaultPlaybackRate = rate; v.playbackRate = rate;
        rec.start(500);
        v.play().then(() => { v.playbackRate = rate; raf = requestAnimationFrame(draw); }).catch(fail);
      };
      v.src = url;
    });
  }

  root.GSSlowMo = { prepare, process, supported };
})(window);
