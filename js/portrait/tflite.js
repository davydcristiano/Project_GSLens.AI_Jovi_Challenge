/* GSLens.AI — leitor e executor mínimo de modelos TensorFlow Lite
   ─────────────────────────────────────────────────────────────
   Lê o arquivo .tflite (formato FlatBuffers, esquema oficial do TFLite) e
   executa em JavaScript puro as operações usadas pelo modelo de segmentação
   de pessoas do MediaPipe (Selfie Segmentation): convolução, convolução em
   profundidade, convolução transposta, soma, multiplicação, pooling médio,
   redimensionamento bilinear, hard-swish, sigmoide, ReLU, concatenação etc.
   Tudo roda no próprio aparelho — nenhuma imagem sai do dispositivo.
   Layout dos tensores: NHWC (lote 1), float32. Pesos float16 são convertidos. */
(function (root) {
  'use strict';

  /* ── FlatBuffers: leitura de tabelas ── */
  class FB {
    constructor(buf) { this.u8 = new Uint8Array(buf); this.dv = new DataView(this.u8.buffer, this.u8.byteOffset, this.u8.byteLength); }
    u32(o) { return this.dv.getUint32(o, true); }
    i32(o) { return this.dv.getInt32(o, true); }
    root() { return this.u32(0); }
    /* deslocamento do campo i da tabela t (0 = ausente) */
    field(t, i) {
      const vt = t - this.i32(t), vlen = this.dv.getUint16(vt, true);
      const off = 4 + 2 * i;
      return off < vlen ? this.dv.getUint16(vt + off, true) : 0;
    }
    has(t, i) { return this.field(t, i) !== 0; }
    int(t, i, d = 0) { const f = this.field(t, i); return f ? this.i32(t + f) : d; }
    uint(t, i, d = 0) { const f = this.field(t, i); return f ? this.u32(t + f) : d; }
    byte(t, i, d = 0) { const f = this.field(t, i); return f ? this.u8[t + f] : d; }
    bool(t, i, d = false) { const f = this.field(t, i); return f ? !!this.u8[t + f] : d; }
    float(t, i, d = 0) { const f = this.field(t, i); return f ? this.dv.getFloat32(t + f, true) : d; }
    table(t, i) { const f = this.field(t, i); return f ? t + f + this.u32(t + f) : 0; }
    vec(t, i) { const f = this.field(t, i); if (!f) return null; const p = t + f + this.u32(t + f); return { len: this.u32(p), start: p + 4 }; }
    vecTables(t, i) { const v = this.vec(t, i); if (!v) return []; const r = []; for (let k = 0; k < v.len; k++) { const p = v.start + 4 * k; r.push(p + this.u32(p)); } return r; }
    vecInts(t, i) { const v = this.vec(t, i); if (!v) return []; const r = []; for (let k = 0; k < v.len; k++) r.push(this.i32(v.start + 4 * k)); return r; }
    vecFloats(t, i) { const v = this.vec(t, i); if (!v) return []; const r = []; for (let k = 0; k < v.len; k++) r.push(this.dv.getFloat32(v.start + 4 * k, true)); return r; }
    vecBytes(t, i) { const v = this.vec(t, i); return v ? this.u8.subarray(v.start, v.start + v.len) : null; }
    str(t, i) { const v = this.vec(t, i); return v ? new TextDecoder().decode(this.u8.subarray(v.start, v.start + v.len)) : ''; }
  }

  const BUILTIN = {
    0: 'ADD', 1: 'AVERAGE_POOL_2D', 2: 'CONCATENATION', 3: 'CONV_2D', 4: 'DEPTHWISE_CONV_2D', 6: 'DEQUANTIZE',
    14: 'LOGISTIC', 17: 'MAX_POOL_2D', 18: 'MUL', 19: 'RELU', 21: 'RELU6', 22: 'RESHAPE', 23: 'RESIZE_BILINEAR',
    32: 'CUSTOM', 34: 'PAD', 40: 'MEAN', 41: 'SUB', 49: 'SPLIT', 67: 'TRANSPOSE_CONV', 75: 'SHAPE', 97: 'RESIZE_NEAREST_NEIGHBOR',
    98: 'LEAKY_RELU', 117: 'HARD_SWISH', 39: 'TRANSPOSE', 54: 'PRELU', 80: 'FAKE_QUANT', 42: 'DIV'
  };

  function half2float(h) {
    const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
    if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
    if (e === 31) return f ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + f / 1024);
  }

  /* ── leitura do modelo ── */
  function parse(buffer) {
    const fb = new FB(buffer);
    const m = fb.root();
    const opcodes = fb.vecTables(m, 1).map(oc => {
      const dep = fb.byte(oc, 0), bc = fb.int(oc, 3, 0);
      const code = Math.max(dep, bc);
      return { code, name: BUILTIN[code] || ('OP_' + code), custom: fb.str(oc, 1) };
    });
    const buffers = fb.vecTables(m, 4).map(b => fb.vecBytes(b, 0));
    const sg = fb.vecTables(m, 2)[0];
    const tensors = fb.vecTables(sg, 0).map((t, idx) => ({
      idx, shape: fb.vecInts(t, 0), type: fb.byte(t, 1), buffer: fb.uint(t, 2), name: fb.str(t, 3)
    }));
    const inputs = fb.vecInts(sg, 1), outputs = fb.vecInts(sg, 2);
    const ops = fb.vecTables(sg, 3).map(o => {
      const oc = opcodes[fb.uint(o, 0)];
      const op = { type: oc.name, custom: oc.custom, inputs: fb.vecInts(o, 1), outputs: fb.vecInts(o, 2), opt: {} };
      const t = fb.table(o, 4);
      const act = v => ['NONE', 'RELU', 'RELU_N1_TO_1', 'RELU6', 'TANH'][v] || 'NONE';
      if (t) switch (op.type) {
        case 'CONV_2D': op.opt = { padding: fb.byte(t, 0), sw: fb.int(t, 1, 1), sh: fb.int(t, 2, 1), act: act(fb.byte(t, 3)), dw: fb.int(t, 4, 1), dh: fb.int(t, 5, 1) }; break;
        case 'DEPTHWISE_CONV_2D': op.opt = { padding: fb.byte(t, 0), sw: fb.int(t, 1, 1), sh: fb.int(t, 2, 1), mult: fb.int(t, 3, 1), act: act(fb.byte(t, 4)), dw: fb.int(t, 5, 1), dh: fb.int(t, 6, 1) }; break;
        case 'AVERAGE_POOL_2D': case 'MAX_POOL_2D': op.opt = { padding: fb.byte(t, 0), sw: fb.int(t, 1, 1), sh: fb.int(t, 2, 1), fw: fb.int(t, 3, 1), fh: fb.int(t, 4, 1), act: act(fb.byte(t, 5)) }; break;
        case 'ADD': case 'MUL': case 'SUB': case 'DIV': op.opt = { act: act(fb.byte(t, 0)) }; break;
        case 'CONCATENATION': op.opt = { axis: fb.int(t, 0), act: act(fb.byte(t, 1)) }; break;
        case 'RESIZE_BILINEAR': op.opt = { alignCorners: fb.bool(t, 2), halfPixel: fb.bool(t, 3) }; break;
        case 'RESIZE_NEAREST_NEIGHBOR': op.opt = { alignCorners: fb.bool(t, 0), halfPixel: fb.bool(t, 1) }; break;
        case 'RESHAPE': op.opt = { shape: fb.vecInts(t, 0) }; break;
        case 'TRANSPOSE_CONV': op.opt = { padding: fb.byte(t, 0), sw: fb.int(t, 1, 1), sh: fb.int(t, 2, 1), act: act(fb.byte(t, 3)) }; break;
        case 'MEAN': op.opt = { keepDims: fb.bool(t, 0) }; break;
        case 'LEAKY_RELU': op.opt = { alpha: fb.float(t, 0, 0.2) }; break;
      }
      if (op.type === 'CUSTOM') op.customOptions = fb.vecBytes(o, 5);
      return op;
    });
    /* dados constantes (pesos) como Float32Array */
    for (const t of tensors) {
      const raw = buffers[t.buffer];
      if (!raw || !raw.length) continue;
      if (t.type === 0) t.data = new Float32Array(raw.slice().buffer);
      else if (t.type === 1) { const u16 = new Uint16Array(raw.slice().buffer); t.data = Float32Array.from(u16, half2float); }
      else if (t.type === 2) t.data = new Int32Array(raw.slice().buffer);
    }
    const desc = fb.str(m, 3);
    return { tensors, inputs, outputs, ops, description: desc };
  }

  /* ═════════════ EXECUÇÃO ═════════════
     O plano é compilado uma vez: cada operação ganha um buffer de saída
     próprio (reaproveitado a cada quadro, sem coletor de lixo) e as ativações
     que vêm logo depois de uma convolução (ReLU, hard-swish) são fundidas nela. */
  const A_NONE = 0, A_RELU = 1, A_RELU6 = 2, A_HSWISH = 3, A_N1 = 4, A_TANH = 5;
  const ACT_CODE = { NONE: A_NONE, RELU: A_RELU, RELU6: A_RELU6, RELU_N1_TO_1: A_N1, TANH: A_TANH };
  function act(v, a) {
    switch (a) {
      case A_RELU: return v > 0 ? v : 0;
      case A_RELU6: return v < 0 ? 0 : v > 6 ? 6 : v;
      case A_HSWISH: { const r = v + 3; return v * (r < 0 ? 0 : r > 6 ? 6 : r) / 6; }
      case A_N1: return v < -1 ? -1 : v > 1 ? 1 : v;
      case A_TANH: return Math.tanh(v);
      default: return v;
    }
  }
  function actArray(y, a) { if (a) for (let i = 0; i < y.length; i++) y[i] = act(y[i], a); }

  /* preenchimento "SAME" do TensorFlow: o excedente vai para baixo/direita */
  function samePad(inSize, k, s, outSize) { return Math.max(0, Math.floor(((outSize - 1) * s + k - inSize) / 2)); }

  /* convolução 1×1: produto de matrizes, 4 canais de saída por vez */
  function conv1x1(x, P, C, w, b, OC, y, a) {
    const oc4 = OC & ~3;
    for (let p = 0; p < P; p++) {
      const xi = p * C, yi = p * OC;
      let oc = 0;
      for (; oc < oc4; oc += 4) {
        const w0 = oc * C, w1 = w0 + C, w2 = w1 + C, w3 = w2 + C;
        let s0 = b[oc], s1 = b[oc + 1], s2 = b[oc + 2], s3 = b[oc + 3];
        for (let c = 0; c < C; c++) { const v = x[xi + c]; s0 += v * w[w0 + c]; s1 += v * w[w1 + c]; s2 += v * w[w2 + c]; s3 += v * w[w3 + c]; }
        if (a) { s0 = act(s0, a); s1 = act(s1, a); s2 = act(s2, a); s3 = act(s3, a); }
        y[yi + oc] = s0; y[yi + oc + 1] = s1; y[yi + oc + 2] = s2; y[yi + oc + 3] = s3;
      }
      for (; oc < OC; oc++) { let s = b[oc]; const wi = oc * C; for (let c = 0; c < C; c++) s += x[xi + c] * w[wi + c]; y[yi + oc] = a ? act(s, a) : s; }
    }
  }

  function convK(x, H, W, C, w, b, OC, KH, KW, y, OH, OW, sh, sw, dh, dw, padY, padX, a) {
    for (let oy = 0; oy < OH; oy++) for (let ox = 0; ox < OW; ox++) {
      const yi = (oy * OW + ox) * OC;
      for (let oc = 0; oc < OC; oc++) {
        let s = b[oc];
        for (let ky = 0; ky < KH; ky++) {
          const iy = oy * sh + ky * dh - padY; if (iy < 0 || iy >= H) continue;
          for (let kx = 0; kx < KW; kx++) {
            const ix = ox * sw + kx * dw - padX; if (ix < 0 || ix >= W) continue;
            const xi = (iy * W + ix) * C, wi = ((oc * KH + ky) * KW + kx) * C;
            for (let c = 0; c < C; c++) s += x[xi + c] * w[wi + c];
          }
        }
        y[yi + oc] = a ? act(s, a) : s;
      }
    }
  }

  function depthwise(x, H, W, C, w, b, KH, KW, y, OH, OW, sh, sw, padY, padX, a) {
    for (let oy = 0; oy < OH; oy++) {
      const ky0 = Math.max(0, padY - oy * sh), ky1 = Math.min(KH, H + padY - oy * sh);
      for (let ox = 0; ox < OW; ox++) {
        const yi = (oy * OW + ox) * C;
        for (let c = 0; c < C; c++) y[yi + c] = b[c];
        const kx0 = Math.max(0, padX - ox * sw), kx1 = Math.min(KW, W + padX - ox * sw);
        for (let ky = ky0; ky < ky1; ky++) {
          const iy = oy * sh + ky - padY;
          for (let kx = kx0; kx < kx1; kx++) {
            const xi = (iy * W + ox * sw + kx - padX) * C, wi = (ky * KW + kx) * C;
            for (let c = 0; c < C; c++) y[yi + c] += x[xi + c] * w[wi + c];
          }
        }
        if (a) for (let c = 0; c < C; c++) y[yi + c] = act(y[yi + c], a);
      }
    }
  }

  function poolOp(x, H, W, C, y, OH, OW, o, isMax) {
    const padY = o.padding === 0 ? samePad(H, o.fh, o.sh, OH) : 0, padX = o.padding === 0 ? samePad(W, o.fw, o.sw, OW) : 0;
    if (OH === 1 && OW === 1 && o.fh >= H && o.fw >= W && !isMax) {           /* média global */
      y.fill(0);
      for (let p = 0; p < H * W; p++) { const xi = p * C; for (let c = 0; c < C; c++) y[c] += x[xi + c]; }
      for (let c = 0; c < C; c++) y[c] /= H * W;
      return;
    }
    for (let oy = 0; oy < OH; oy++) for (let ox = 0; ox < OW; ox++) for (let c = 0; c < C; c++) {
      let s = isMax ? -Infinity : 0, n = 0;
      for (let ky = 0; ky < o.fh; ky++) { const iy = oy * o.sh + ky - padY; if (iy < 0 || iy >= H) continue;
        for (let kx = 0; kx < o.fw; kx++) { const ix = ox * o.sw + kx - padX; if (ix < 0 || ix >= W) continue;
          const v = x[(iy * W + ix) * C + c]; if (isMax) { if (v > s) s = v; } else s += v; n++; } }
      y[(oy * OW + ox) * C + c] = isMax ? s : s / Math.max(1, n);
    }
  }

  /* elemento a elemento com difusão do último eixo (ou escalar) */
  function binaryOp(av, bv, y, kind, a) {
    const na = av.length, nb = bv.length, n = y.length;
    const f = kind === 0 ? (p, q) => p + q : kind === 1 ? (p, q) => p * q : (p, q) => p - q;
    if (na === n && nb === n) { if (kind === 0) for (let i = 0; i < n; i++) y[i] = av[i] + bv[i]; else for (let i = 0; i < n; i++) y[i] = f(av[i], bv[i]); }
    else if (na === n) { if (kind === 1) for (let i = 0; i < n; i++) y[i] = av[i] * bv[i % nb]; else for (let i = 0; i < n; i++) y[i] = f(av[i], bv[i % nb]); }
    else for (let i = 0; i < n; i++) y[i] = f(av[i % na], bv[i]);
    actArray(y, a);
  }

  /* bilinear com half_pixel_centers / align_corners (semântica do TFLite) */
  function resizeBilinear(x, H, W, C, y, OH, OW, o) {
    const sy = o.alignCorners && OH > 1 ? (H - 1) / (OH - 1) : H / OH, sx = o.alignCorners && OW > 1 ? (W - 1) / (OW - 1) : W / OW;
    for (let oy = 0; oy < OH; oy++) {
      const fy = o.halfPixel ? (oy + 0.5) * sy - 0.5 : oy * sy;
      const y0f = Math.floor(fy), y0 = Math.max(0, y0f), y1 = Math.min(H - 1, Math.ceil(fy)), dy = fy - y0f;
      for (let ox = 0; ox < OW; ox++) {
        const fx = o.halfPixel ? (ox + 0.5) * sx - 0.5 : ox * sx;
        const x0f = Math.floor(fx), x0 = Math.max(0, x0f), x1 = Math.min(W - 1, Math.ceil(fx)), dx = fx - x0f;
        const a = (y0 * W + x0) * C, bb = (y0 * W + x1) * C, c = (y1 * W + x0) * C, d = (y1 * W + x1) * C, yi = (oy * OW + ox) * C;
        for (let k = 0; k < C; k++) {
          const top = x[a + k] + (x[bb + k] - x[a + k]) * dx, bot = x[c + k] + (x[d + k] - x[c + k]) * dx;
          y[yi + k] = top + (bot - top) * dy;
        }
      }
    }
  }

  /* operação própria do MediaPipe "Convolution2DTransposeBias":
     opções (3 × int32): padding (1 = SAME, 2 = VALID), stride_w, stride_h */
  function convTransposeBias(x, H, W, C, w, b, OC, KH, KW, y, OH, OW, opt) {
    const dv = new DataView(opt.buffer, opt.byteOffset, opt.byteLength);
    const padding = dv.getInt32(0, true), sw = dv.getInt32(4, true), sh = dv.getInt32(8, true);
    const padY = padding === 1 ? Math.max(0, Math.floor(((H - 1) * sh + KH - OH) / 2)) : 0;
    const padX = padding === 1 ? Math.max(0, Math.floor(((W - 1) * sw + KW - OW) / 2)) : 0;
    for (let p = 0; p < OH * OW; p++) for (let oc = 0; oc < OC; oc++) y[p * OC + oc] = b ? b[oc] : 0;
    for (let iy = 0; iy < H; iy++) for (let ix = 0; ix < W; ix++) {
      const xi = (iy * W + ix) * C;
      for (let ky = 0; ky < KH; ky++) { const oy = iy * sh + ky - padY; if (oy < 0 || oy >= OH) continue;
        for (let kx = 0; kx < KW; kx++) { const ox = ix * sw + kx - padX; if (ox < 0 || ox >= OW) continue;
          for (let oc = 0; oc < OC; oc++) {
            const wi = ((oc * KH + ky) * KW + kx) * C; let s = 0;
            for (let c = 0; c < C; c++) s += x[xi + c] * w[wi + c];
            y[(oy * OW + ox) * OC + oc] += s;
          } } }
    }
  }

  const SUPPORTED = ['CONV_2D', 'DEPTHWISE_CONV_2D', 'AVERAGE_POOL_2D', 'MAX_POOL_2D', 'ADD', 'MUL', 'SUB', 'RELU', 'RELU6', 'HARD_SWISH', 'LOGISTIC', 'RESIZE_BILINEAR', 'CONCATENATION', 'RESHAPE', 'DEQUANTIZE', 'MEAN', 'CUSTOM'];

  class Interpreter {
    constructor(model) {
      this.m = model;
      const T = model.tensors;
      /* pesos float16 → DEQUANTIZE resolvido na carga */
      for (const op of model.ops) if (op.type === 'DEQUANTIZE' && T[op.inputs[0]].data) { T[op.outputs[0]].data = T[op.inputs[0]].data; op.static = true; }
      const ops = model.ops.filter(op => !op.static);
      for (const op of ops) if (!SUPPORTED.includes(op.type) || (op.type === 'CUSTOM' && op.custom !== 'Convolution2DTransposeBias')) throw new Error('operação não suportada: ' + op.type + ' ' + (op.custom || ''));
      /* quantas operações consomem cada tensor (para fundir ativações) */
      const uses = new Map();
      for (const op of ops) for (const i of op.inputs) if (i >= 0) uses.set(i, (uses.get(i) || 0) + 1);
      for (const o of model.outputs) uses.set(o, (uses.get(o) || 0) + 1);
      const plan = [];
      for (let k = 0; k < ops.length; k++) {
        const op = ops[k], next = ops[k + 1];
        const step = { op, out: op.outputs[0], act: ACT_CODE[(op.opt && op.opt.act) || 'NONE'] || 0 };
        if (['CONV_2D', 'DEPTHWISE_CONV_2D'].includes(op.type) && !step.act && next && ['RELU', 'RELU6', 'HARD_SWISH'].includes(next.type) && next.inputs[0] === op.outputs[0] && uses.get(op.outputs[0]) === 1) {
          step.act = next.type === 'RELU' ? A_RELU : next.type === 'RELU6' ? A_RELU6 : A_HSWISH;
          step.out = next.outputs[0]; k++;
        }
        const shp = T[step.out].shape, n = shp.reduce((a, b) => a * b, 1);
        step.buf = op.type === 'RESHAPE' ? null : new Float32Array(n);
        plan.push(step);
      }
      this.plan = plan;
      this.inputShape = T[model.inputs[0]].shape;
      this.outputShape = T[model.outputs[0]].shape;
      const zeros = new Map();
      this._zero = n => { if (!zeros.has(n)) zeros.set(n, new Float32Array(n)); return zeros.get(n); };
    }
    run(input) {
      const T = this.m.tensors, vals = this._vals || (this._vals = new Map());
      vals.clear(); vals.set(this.m.inputs[0], input);
      const get = i => vals.has(i) ? vals.get(i) : T[i].data;
      for (const st of this.plan) {
        const op = st.op, ins = op.inputs, o = op.opt, y = st.buf, sh = i => T[i].shape;
        const xs = sh(ins[0]), ys = T[st.out].shape;
        switch (op.type) {
          case 'CONV_2D': {
            const ws = sh(ins[1]), b = ins[2] >= 0 ? get(ins[2]) : this._zero(ws[0]);
            if (ws[1] === 1 && ws[2] === 1 && o.sh === 1 && o.sw === 1) conv1x1(get(ins[0]), xs[1] * xs[2], xs[3], get(ins[1]), b, ws[0], y, st.act);
            else convK(get(ins[0]), xs[1], xs[2], xs[3], get(ins[1]), b, ws[0], ws[1], ws[2], y, ys[1], ys[2], o.sh, o.sw, o.dh || 1, o.dw || 1,
              o.padding === 0 ? samePad(xs[1], ws[1], o.sh, ys[1]) : 0, o.padding === 0 ? samePad(xs[2], ws[2], o.sw, ys[2]) : 0, st.act);
            break;
          }
          case 'DEPTHWISE_CONV_2D': {
            const ws = sh(ins[1]);
            if ((o.mult || 1) !== 1 || (o.dh || 1) !== 1 || (o.dw || 1) !== 1) throw new Error('depthwise com multiplicador/dilatação não suportado');
            depthwise(get(ins[0]), xs[1], xs[2], xs[3], get(ins[1]), ins[2] >= 0 ? get(ins[2]) : this._zero(ws[3]), ws[1], ws[2], y, ys[1], ys[2], o.sh, o.sw,
              o.padding === 0 ? samePad(xs[1], ws[1], o.sh, ys[1]) : 0, o.padding === 0 ? samePad(xs[2], ws[2], o.sw, ys[2]) : 0, st.act);
            break;
          }
          case 'AVERAGE_POOL_2D': case 'MAX_POOL_2D': poolOp(get(ins[0]), xs[1], xs[2], xs[3], y, ys[1], ys[2], o, op.type === 'MAX_POOL_2D'); actArray(y, st.act); break;
          case 'ADD': binaryOp(get(ins[0]), get(ins[1]), y, 0, st.act); break;
          case 'MUL': binaryOp(get(ins[0]), get(ins[1]), y, 1, st.act); break;
          case 'SUB': binaryOp(get(ins[0]), get(ins[1]), y, 2, st.act); break;
          case 'RELU': { const x = get(ins[0]); for (let i = 0; i < y.length; i++) y[i] = x[i] > 0 ? x[i] : 0; break; }
          case 'RELU6': { const x = get(ins[0]); for (let i = 0; i < y.length; i++) y[i] = x[i] < 0 ? 0 : x[i] > 6 ? 6 : x[i]; break; }
          case 'HARD_SWISH': { const x = get(ins[0]); for (let i = 0; i < y.length; i++) { const v = x[i], r = v + 3; y[i] = v * (r < 0 ? 0 : r > 6 ? 6 : r) / 6; } break; }
          case 'LOGISTIC': { const x = get(ins[0]); for (let i = 0; i < y.length; i++) y[i] = 1 / (1 + Math.exp(-x[i])); break; }
          case 'RESIZE_BILINEAR': resizeBilinear(get(ins[0]), xs[1], xs[2], xs[3], y, ys[1], ys[2], o); break;
          case 'RESHAPE': vals.set(st.out, get(ins[0])); continue;
          case 'DEQUANTIZE': y.set(get(ins[0])); break;
          case 'MEAN': {
            /* média espacial (eixos 1 e 2) — único caso usado pelos modelos de segmentação */
            const axes = Array.from(get(ins[1])).map(a => a < 0 ? a + xs.length : a).sort();
            if (xs.length !== 4 || axes.join() !== '1,2') throw new Error('MEAN só nos eixos 1,2');
            poolOp(get(ins[0]), xs[1], xs[2], xs[3], y, 1, 1, { padding: 1, fh: xs[1], fw: xs[2], sh: 1, sw: 1 }, false);
            break;
          }
          case 'CONCATENATION': {
            const parts = ins.map(i => ({ d: get(i), c: sh(i)[sh(i).length - 1] })), C = parts.reduce((s, p) => s + p.c, 0), P = parts[0].d.length / parts[0].c;
            for (let p = 0; p < P; p++) { let off = 0; for (const q of parts) { y.set(q.d.subarray(p * q.c, p * q.c + q.c), p * C + off); off += q.c; } }
            actArray(y, st.act); break;
          }
          case 'CUSTOM': {
            const ws = sh(ins[1]);
            convTransposeBias(get(ins[0]), xs[1], xs[2], xs[3], get(ins[1]), ins[2] >= 0 ? get(ins[2]) : null, ws[0], ws[1], ws[2], y, ys[1], ys[2], op.customOptions);
            break;
          }
        }
        vals.set(st.out, y);
      }
      return get(this.m.outputs[0]);
    }
  }

  root.GSTFLite = { parse, Interpreter, _FB: FB, half2float };
})(typeof window !== 'undefined' ? window : globalThis);
