/* ═══════════════════════════════════════════════════
   GSLens.AI — Scanner 3D · segment.js
   Silhueta do objeto em cada quadro-chave.
   Como a aparência da prancha é conhecida (geramos a
   impressão), cada pixel que cai sobre a folha é comparado
   com o que DEVERIA estar ali (papel ou tinta), corrigido
   pela iluminação estimada. O que não bate é objeto.

   Máscara de saída (Uint8Array, 1 byte por pixel):
     0 = fundo confirmado (papel/tinta visível)
     1 = objeto
     2 = desconhecido (fora da folha, bordas de impressão,
         ou região ambígua) — não vota na reconstrução
═══════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const GS3D = root.GS3D = root.GS3D || {};
  const M = GS3D.math, B = GS3D.board;

  /* Mapas min/max da densidade de tinta esperada num raio r (px do mapa) */
  const _minmax = new Map();
  function expectedMinMax(r) {
    const map = B.expectedMap(2);
    if (_minmax.has(r)) return _minmax.get(r);
    const { w, h, ink } = map;
    const tmpMin = new Float32Array(w * h), tmpMax = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let mn = 1, mx = 0;
        for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) { const v = ink[y * w + k]; if (v < mn) mn = v; if (v > mx) mx = v; }
        tmpMin[y * w + x] = mn; tmpMax[y * w + x] = mx;
      }
    }
    const eMin = new Float32Array(w * h), eMax = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let mn = 1, mx = 0;
        for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) { const i = k * w + x; if (tmpMin[i] < mn) mn = tmpMin[i]; if (tmpMax[i] > mx) mx = tmpMax[i]; }
        eMin[y * w + x] = mn; eMax[y * w + x] = mx;
      }
    }
    const out = { map, eMin, eMax };
    _minmax.set(r, out);
    return out;
  }

  /* Mapa esperado borrado (simula o desfoque/amostragem da câmera) */
  const _blur = new Map();
  function expectedBlur(r) {
    if (_blur.has(r)) return _blur.get(r);
    const { w, h, ink } = B.expectedMap(2);
    let a = Float32Array.from(ink), b = new Float32Array(w * h);
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let s = 0, c = 0;
        for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) { s += a[y * w + k]; c++; }
        b[y * w + x] = s / c;
      }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let s = 0, c = 0;
        for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) { s += b[k * w + x]; c++; }
        a[y * w + x] = s / c;
      }
    }
    _blur.set(r, a);
    return a;
  }

  /* Ajuste robusto (IRLS, Tukey) de L(u,v) = a + b u + c v + d u² + e v² + f uv */
  function fitIllumination(samples) {
    const n = samples.length / 3;
    const w = new Float64Array(n).fill(1);
    let coef = null;
    for (let it = 0; it < 5; it++) {
      const A = new Float64Array(36), bb = new Float64Array(6);
      for (let i = 0; i < n; i++) {
        const u = samples[3 * i] / 100, v = samples[3 * i + 1] / 100, L = samples[3 * i + 2];
        const phi = [1, u, v, u * u, v * v, u * v];
        const wi = w[i];
        if (!wi) continue;
        for (let a = 0; a < 6; a++) { bb[a] += wi * phi[a] * L; for (let b = 0; b < 6; b++) A[a * 6 + b] += wi * phi[a] * phi[b]; }
      }
      const sol = M.solveLinear(A, bb, 6);
      if (!sol) break;
      coef = sol;
      const res = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const u = samples[3 * i] / 100, v = samples[3 * i + 1] / 100;
        res[i] = samples[3 * i + 2] - (coef[0] + coef[1] * u + coef[2] * v + coef[3] * u * u + coef[4] * v * v + coef[5] * u * v);
      }
      const mad = M.median(Array.from(res, Math.abs)) * 1.4826 + 1;
      const c = 4.685 * mad;
      for (let i = 0; i < n; i++) { const r = res[i] / c; w[i] = Math.abs(r) < 1 ? (1 - r * r) * (1 - r * r) : 0; }
    }
    return coef;
  }

  /* Morfologia binária (quadrado 2r+1) */
  function morph(src, w, h, r, dilate) {
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = dilate ? 0 : 1;
        for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
          const s = src[y * w + k];
          if (dilate ? s : !s) { v = dilate ? 1 : 0; break; }
        }
        tmp[y * w + x] = v;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = dilate ? 0 : 1;
        for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
          const s = tmp[k * w + x];
          if (dilate ? s : !s) { v = dilate ? 1 : 0; break; }
        }
        out[y * w + x] = v;
      }
    }
    return out;
  }

  /* kf: { rgba, w, h, H } (H: prancha mm -> pixel) */
  function segment(kf) {
    const { rgba, w, h } = kf;
    const Hi = M.inv3(kf.H);
    if (!Hi) throw new Error('Homografia inválida no quadro-chave.');
    const K = B.KNOWN;

    /* Escala local (mm por pixel) no centro da prancha → raio de tolerância de bordas */
    const c0 = M.applyH(Hi, w / 2, h / 2), c1 = M.applyH(Hi, w / 2 + 1, h / 2), c2 = M.applyH(Hi, w / 2, h / 2 + 1);
    const mmPerPx = Math.max(Math.hypot(c1[0] - c0[0], c1[1] - c0[1]), Math.hypot(c2[0] - c0[0], c2[1] - c0[1]));
    const rMap = Math.max(2, Math.min(8, Math.round(1.6 * mmPerPx * 2)));   /* mapa tem 2 px/mm */
    const { map, eMin, eMax } = expectedMinMax(rMap);
    const eBlur = expectedBlur(Math.max(1, Math.min(6, Math.round(0.6 * mmPerPx * 2))));

    /* 1) Coordenadas na prancha e classe esperada por pixel */
    const n = w * h;
    const cls = new Uint8Array(n);      /* 0 fora, 1 papel puro, 2 tinta pura, 3 transição */
    const U = new Float32Array(n), V = new Float32Array(n), EB = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const ww = Hi[6] * x + Hi[7] * y + Hi[8];
        const u = (Hi[0] * x + Hi[1] * y + Hi[2]) / ww, v = (Hi[3] * x + Hi[4] * y + Hi[5]) / ww;
        U[i] = u; V[i] = v;
        if (!(ww > 0) || u < K.xmin || u > K.xmax || v < K.ymin || v > K.ymax) continue;
        const mx = Math.round((u + B.SHEET_W / 2) * map.res - 0.5), my = Math.round((B.SHEET_H / 2 - v) * map.res - 0.5);
        if (mx < 0 || my < 0 || mx >= map.w || my >= map.h) continue;
        const j = my * map.w + mx;
        EB[i] = eBlur[j];
        if (eMax[j] < 0.15) cls[i] = 1;
        else if (eMin[j] > 0.85) cls[i] = 2;
        else cls[i] = 3;
      }
    }

    /* 2) Modelo de iluminação do papel + cromaticidade + razão da tinta */
    const step = Math.max(1, Math.round(Math.sqrt(n / 40000)));
    const samp = [], chR = [], chG = [];
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = y * w + x;
        if (cls[i] !== 1) continue;
        const r = rgba[4 * i], g = rgba[4 * i + 1], b = rgba[4 * i + 2];
        const L = 0.299 * r + 0.587 * g + 0.114 * b;
        samp.push(U[i], V[i], L);
        const s = r + g + b + 1;
        chR.push(r / s); chG.push(g / s);
      }
    }
    if (samp.length < 300) return { mask: null, reason: 'Papel da prancha pouco visível neste quadro.' };
    const coef = fitIllumination(Float64Array.from(samp));
    if (!coef) return { mask: null, reason: 'Falha ao estimar a iluminação.' };
    const Lp = (u, v) => { u /= 100; v /= 100; return coef[0] + coef[1] * u + coef[2] * v + coef[3] * u * u + coef[4] * v * v + coef[5] * u * v; };
    const pr = M.median(chR), pg = M.median(chG);
    const chDist = [];
    for (let k = 0; k < chR.length; k += 3) chDist.push(Math.hypot(chR[k] - pr, chG[k] - pg));
    const tauC = Math.max(0.028, 5 * 1.4826 * M.median(chDist));
    const inkR = [];
    for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
      const i = y * w + x;
      if (cls[i] !== 2) continue;
      const L = 0.299 * rgba[4 * i] + 0.587 * rgba[4 * i + 1] + 0.114 * rgba[4 * i + 2];
      inkR.push(L / Math.max(1, Lp(U[i], V[i])));
    }
    const kInk = inkR.length ? M.median(inkR) : 0.15;

    /* 3) Classificação */
    const obj = new Uint8Array(n);
    const mask = new Uint8Array(n).fill(2);
    for (let i = 0; i < n; i++) {
      const c = cls[i];
      if (!c) continue;
      const r = rgba[4 * i], g = rgba[4 * i + 1], b = rgba[4 * i + 2];
      const L = 0.299 * r + 0.587 * g + 0.114 * b;
      const ratio = L / Math.max(1, Lp(U[i], V[i]));
      const s = r + g + b + 1;
      const cd = L > 28 ? Math.hypot(r / s - pr, g / s - pg) : 0;
      /* razão esperada: papel = 1, tinta = kInk, misturas pelo mapa borrado */
      const pred = 1 - EB[i] * (1 - kInk);
      const darkExp = pred < 0.55;
      if (ratio > pred + 0.3 || ratio < pred - 0.4 || (cd > tauC * (darkExp ? 1.5 : 1) && ratio > kInk + 0.12)) { obj[i] = 1; mask[i] = 1; }
      else if (c === 1 || (c === 3 && !darkExp)) mask[i] = 0;
      else mask[i] = 3;   /* escuro como a tinta: decidido abaixo pela vizinhança */
    }

    /* 3b) Tinta "escura como esperado" só conta como fundo se o padrão do
       marcador ao redor estiver intacto (células brancas vizinhas vistas como
       papel). Se um objeto escuro cobrir o marcador, os brancos vizinhos somem
       e o pixel fica desconhecido — assim objetos pretos não são esculpidos. */
    {
      const rad = Math.max(3, Math.round(9 / Math.max(0.05, mmPerPx)));
      const W1 = w + 1;
      const iP = new Int32Array(W1 * (h + 1)), iB = new Int32Array(W1 * (h + 1));
      for (let y = 0; y < h; y++) {
        let rp = 0, rb = 0;
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (cls[i] === 1) { rp++; if (mask[i] === 0) rb++; }
          iP[(y + 1) * W1 + x + 1] = iP[y * W1 + x + 1] + rp;
          iB[(y + 1) * W1 + x + 1] = iB[y * W1 + x + 1] + rb;
        }
      }
      for (let y = 0; y < h; y++) {
        const y0 = Math.max(0, y - rad), y1 = Math.min(h, y + rad + 1);
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (mask[i] !== 3) continue;
          const x0 = Math.max(0, x - rad), x1 = Math.min(w, x + rad + 1);
          const np = iP[y1 * W1 + x1] - iP[y0 * W1 + x1] - iP[y1 * W1 + x0] + iP[y0 * W1 + x0];
          const nb = iB[y1 * W1 + x1] - iB[y0 * W1 + x1] - iB[y1 * W1 + x0] + iB[y0 * W1 + x0];
          mask[i] = np >= 6 && nb >= 0.85 * np ? 0 : 2;
        }
      }
    }

    /* 4) Limpeza: abertura (remove ruído) e fechamento (fecha furos) */
    let clean = morph(morph(obj, w, h, 1, false), w, h, 1, true);
    clean = morph(morph(clean, w, h, 2, true), w, h, 2, false);
    let nObj = 0;
    for (let i = 0; i < n; i++) {
      if (clean[i]) { mask[i] = 1; nObj++; }
      else if (mask[i] === 1) mask[i] = 0;
    }
    return { mask, nObj, kInk, tauC, mmPerPx, paperL0: coef[0] };
  }

  GS3D.segment = segment;
})(typeof window !== 'undefined' ? window : globalThis);
