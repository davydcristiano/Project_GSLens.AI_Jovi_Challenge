/* ═══════════════════════════════════════════════════
   GSLens.AI — Scanner 3D · features.js
   Visão computacional básica para o rastreamento sem prancha:
   • tons de cinza e pirâmide de imagens
   • cantos de Shi‑Tomasi (menor autovalor do tensor de estrutura),
     distribuídos numa grade
   • fluxo óptico de Lucas‑Kanade em pirâmide (com chute inicial)
   • homografia robusta (RANSAC + reajuste nos inliers)
   • retificação de uma imagem por homografia (amostragem bilinear)
═══════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const GS3D = root.GS3D = root.GS3D || {};
  const M = GS3D.math;

  /* imagem cinza: { w, h, d: Float32Array } (0–255) */
  function gray(img) {
    const { width: w, height: h, data } = img;
    const d = new Float32Array(w * h);
    for (let i = 0, j = 0; i < d.length; i++, j += 4) d[i] = data[j] * 0.299 + data[j + 1] * 0.587 + data[j + 2] * 0.114;
    return { w, h, d };
  }

  /* reduz pela metade com filtro [1 2 1]/4 separável */
  function down(g) {
    const W = g.w >> 1, H = g.h >> 1, s = g.d, w = g.w, h = g.h;
    const tmp = new Float32Array(W * h), o = new Float32Array(W * H);
    for (let y = 0; y < h; y++) for (let x = 0; x < W; x++) {
      const xx = 2 * x, i = y * w;
      tmp[y * W + x] = (s[i + Math.max(0, xx - 1)] + 2 * s[i + xx] + s[i + Math.min(w - 1, xx + 1)]) * 0.25;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const yy = 2 * y;
      o[y * W + x] = (tmp[Math.max(0, yy - 1) * W + x] + 2 * tmp[yy * W + x] + tmp[Math.min(h - 1, yy + 1) * W + x]) * 0.25;
    }
    return { w: W, h: H, d: o };
  }

  function pyramid(g, levels) {
    const p = [g];
    while (p.length < levels && p[p.length - 1].w > 40 && p[p.length - 1].h > 40) p.push(down(p[p.length - 1]));
    return p;
  }

  /* gradientes centrais */
  function grads(g) {
    const { w, h, d } = g, gx = new Float32Array(w * h), gy = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      gx[i] = (d[i + 1] - d[i - 1]) * 0.5; gy[i] = (d[i + w] - d[i - w]) * 0.5;
    }
    return { gx, gy };
  }

  /* Cantos de Shi‑Tomasi: até maxN pontos, no máximo `perCell` por célula de uma
     grade cols×rows (espalha os pontos pela imagem). valid(x,y) opcional. */
  function corners(g, opts) {
    opts = opts || {};
    const { w, h } = g, { gx, gy } = grads(g);
    const r = opts.win || 3, border = (opts.border || 8) + r;
    /* integrais de gx², gy², gxgy para somas em janela O(1) */
    const W1 = w + 1, Sxx = new Float64Array(W1 * (h + 1)), Syy = new Float64Array(W1 * (h + 1)), Sxy = new Float64Array(W1 * (h + 1));
    for (let y = 0; y < h; y++) {
      let a = 0, b = 0, c = 0;
      for (let x = 0; x < w; x++) {
        const i = y * w + x; a += gx[i] * gx[i]; b += gy[i] * gy[i]; c += gx[i] * gy[i];
        const k = (y + 1) * W1 + x + 1;
        Sxx[k] = Sxx[k - W1] + a; Syy[k] = Syy[k - W1] + b; Sxy[k] = Sxy[k - W1] + c;
      }
    }
    const box = (S, x0, y0, x1, y1) => S[y1 * W1 + x1] - S[y0 * W1 + x1] - S[y1 * W1 + x0] + S[y0 * W1 + x0];
    const score = new Float32Array(w * h);
    let mx = 0;
    for (let y = border; y < h - border; y++) for (let x = border; x < w - border; x++) {
      const a = box(Sxx, x - r, y - r, x + r + 1, y + r + 1), b = box(Syy, x - r, y - r, x + r + 1, y + r + 1), c = box(Sxy, x - r, y - r, x + r + 1, y + r + 1);
      const tr = (a + b) * 0.5, l = tr - Math.sqrt(Math.max(0, tr * tr - (a * b - c * c)));
      score[y * w + x] = l; if (l > mx) mx = l;
    }
    const thr = Math.max(opts.minScore || 0, mx * (opts.quality || 0.02));
    const cols = opts.cols || 16, rows = opts.rows || 12, per = opts.perCell || 3;
    const cells = Array.from({ length: cols * rows }, () => []);
    for (let y = border; y < h - border; y++) for (let x = border; x < w - border; x++) {
      const s = score[y * w + x];
      if (s < thr) continue;
      /* máximo local 3×3 */
      let isMax = true;
      for (let dy = -1; dy <= 1 && isMax; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && score[(y + dy) * w + x + dx] > s) { isMax = false; break; }
      if (!isMax || (opts.valid && !opts.valid(x, y))) continue;
      const ci = Math.min(rows - 1, (y * rows / h) | 0) * cols + Math.min(cols - 1, (x * cols / w) | 0);
      cells[ci].push([x, y, s]);
    }
    const minD2 = (opts.minDist || 6) ** 2, out = [];
    for (const c of cells) {
      c.sort((a, b) => b[2] - a[2]);
      const kept = [];
      for (const p of c) {
        if (kept.length >= per) break;
        if (kept.every(q => (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 >= minD2)) kept.push(p);
      }
      out.push(...kept);
    }
    out.sort((a, b) => b[2] - a[2]);
    return { pts: out.slice(0, opts.maxN || 400), maxScore: mx };
  }

  function sample(g, x, y) {
    const w = g.w, h = g.h;
    if (x < 0 || y < 0 || x > w - 1.001 || y > h - 1.001) return NaN;
    const x0 = x | 0, y0 = y | 0, ax = x - x0, ay = y - y0, d = g.d, i = y0 * w + x0;
    return (d[i] * (1 - ax) + d[i + 1] * ax) * (1 - ay) + (d[i + w] * (1 - ax) + d[i + w + 1] * ax) * ay;
  }

  /* Lucas‑Kanade em pirâmide. pyrA/pyrB: pirâmides; pts: posições em A;
     guess: posições iniciais em B (ou null = mesmas de A).
     Retorna { pts:[[x,y]], ok:Uint8Array, err:Float32Array } */
  function lk(pyrA, pyrB, pts, guess, opts) {
    opts = opts || {};
    const R = opts.win || 7, iters = opts.iters || 12, L = Math.min(pyrA.length, pyrB.length);
    const n = pts.length, outP = new Array(n), ok = new Uint8Array(n), err = new Float32Array(n);
    const N = (2 * R + 1) * (2 * R + 1);
    const Ix = new Float32Array(N), Iy = new Float32Array(N), I0 = new Float32Array(N);
    const gradsA = pyrA.map(grads);
    for (let k = 0; k < n; k++) {
      const p = pts[k], q0 = guess ? guess[k] : p;
      let gxv = (q0[0] - p[0]) / (1 << (L - 1)), gyv = (q0[1] - p[1]) / (1 << (L - 1));
      let good = true;
      for (let l = L - 1; l >= 0; l--) {
        const A = pyrA[l], B = pyrB[l], G = gradsA[l], sc = 1 / (1 << l);
        const px = p[0] * sc, py = p[1] * sc;
        if (px < R + 1 || py < R + 1 || px > A.w - R - 2 || py > A.h - R - 2) { good = false; break; }
        /* janela em A: intensidade e gradientes (bilinear) */
        let a = 0, b = 0, c = 0, m = 0;
        for (let j = -R, t = 0; j <= R; j++) for (let i = -R; i <= R; i++, t++) {
          const x = px + i, y = py + j, x0 = x | 0, y0 = y | 0, ax = x - x0, ay = y - y0, ii = y0 * A.w + x0;
          const wa = (1 - ax) * (1 - ay), wb = ax * (1 - ay), wc = (1 - ax) * ay, wd = ax * ay;
          I0[t] = A.d[ii] * wa + A.d[ii + 1] * wb + A.d[ii + A.w] * wc + A.d[ii + A.w + 1] * wd;
          Ix[t] = G.gx[ii] * wa + G.gx[ii + 1] * wb + G.gx[ii + A.w] * wc + G.gx[ii + A.w + 1] * wd;
          Iy[t] = G.gy[ii] * wa + G.gy[ii + 1] * wb + G.gy[ii + A.w] * wc + G.gy[ii + A.w + 1] * wd;
          a += Ix[t] * Ix[t]; b += Ix[t] * Iy[t]; c += Iy[t] * Iy[t]; m += I0[t];
        }
        const det = a * c - b * b;
        if (det < 1e-3 * N * N) { good = false; break; }
        const mA = m / N;
        let vx = gxv, vy = gyv;
        for (let it = 0; it < iters; it++) {
          /* compensa diferença de brilho médio (exposição automática) */
          let mB = 0, cnt = 0;
          for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) { const v = sample(B, px + vx + i, py + vy + j); if (v === v) { mB += v; cnt++; } }
          if (cnt < N * 0.8) { good = false; break; }
          mB /= cnt;
          let ex = 0, ey = 0;
          for (let j = -R, t = 0; j <= R; j++) for (let i = -R; i <= R; i++, t++) {
            const v = sample(B, px + vx + i, py + vy + j);
            if (v !== v) continue;
            const dI = (I0[t] - mA) - (v - mB);
            ex += dI * Ix[t]; ey += dI * Iy[t];
          }
          const dx = (c * ex - b * ey) / det, dy = (a * ey - b * ex) / det;
          vx += dx; vy += dy;
          if (dx * dx + dy * dy < 0.0009) break;
        }
        if (!good) break;
        if (l > 0) { gxv = vx * 2; gyv = vy * 2; } else { gxv = vx; gyv = vy; }
      }
      if (!good) { outP[k] = [NaN, NaN]; continue; }
      const qx = p[0] + gxv, qy = p[1] + gyv;
      /* erro residual (média do |dI|) — descarta correspondências ruins */
      const A = pyrA[0], B = pyrB[0];
      let e = 0, cnt = 0, mA = 0, mB = 0;
      for (let j = -R; j <= R; j += 2) for (let i = -R; i <= R; i += 2) { const va = sample(A, p[0] + i, p[1] + j), vb = sample(B, qx + i, qy + j); if (va === va && vb === vb) { mA += va; mB += vb; cnt++; } }
      if (cnt < 10) { outP[k] = [NaN, NaN]; continue; }
      mA /= cnt; mB /= cnt;
      for (let j = -R; j <= R; j += 2) for (let i = -R; i <= R; i += 2) { const va = sample(A, p[0] + i, p[1] + j), vb = sample(B, qx + i, qy + j); if (va === va && vb === vb) e += Math.abs((va - mA) - (vb - mB)); }
      err[k] = e / cnt;
      outP[k] = [qx, qy];
      ok[k] = err[k] < (opts.maxErr || 18) ? 1 : 0;
    }
    return { pts: outP, ok, err };
  }

  /* Homografia robusta: RANSAC (4 pontos) + reajuste DLT nos inliers */
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  function ransacH(src, dst, opts) {
    opts = opts || {};
    const n = src.length, thr2 = (opts.thresh || 3) ** 2, iters = opts.iters || 300;
    if (n < 8) return null;
    let best = null, bestN = 0;
    const errOf = (H, i) => {
      const s = src[i], d = dst[i], w = H[6] * s[0] + H[7] * s[1] + H[8];
      if (!(w > 1e-9)) return Infinity;
      const u = (H[0] * s[0] + H[1] * s[1] + H[2]) / w - d[0], v = (H[3] * s[0] + H[4] * s[1] + H[5]) / w - d[1];
      return u * u + v * v;
    };
    for (let it = 0; it < iters; it++) {
      const idx = new Set(); while (idx.size < 4) idx.add((rnd() * n) | 0);
      const id = [...idx];
      const H = M.homographyDLT(id.map(i => src[i]), id.map(i => dst[i]));
      if (!H) continue;
      let cnt = 0;
      for (let i = 0; i < n; i++) if (errOf(H, i) < thr2) cnt++;
      if (cnt > bestN) { bestN = cnt; best = H; if (cnt > 0.9 * n) break; }
    }
    if (!best || bestN < 6) return null;
    let H = best, inl = new Uint8Array(n);
    for (let pass = 0; pass < 3; pass++) {
      const s = [], d = [];
      inl = new Uint8Array(n);
      for (let i = 0; i < n; i++) if (errOf(H, i) < thr2) { inl[i] = 1; s.push(src[i]); d.push(dst[i]); }
      if (s.length < 6) break;
      const H2 = M.homographyDLT(s, d);
      if (!H2) break;
      H = H2;
    }
    let cnt = 0, e2 = 0;
    for (let i = 0; i < n; i++) if (inl[i]) { cnt++; e2 += errOf(H, i); }
    return { H, inliers: inl, count: cnt, rms: cnt ? Math.sqrt(e2 / cnt) : Infinity };
  }

  /* imagem de saída w×h onde out(x,y) = src(Hm·(x,y)) — NaN fora da origem */
  function warp(src, Hm, w, h) {
    const o = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const z = Hm[6] * x + Hm[7] * y + Hm[8];
      o[y * w + x] = z > 0 ? sample(src, (Hm[0] * x + Hm[1] * y + Hm[2]) / z, (Hm[3] * x + Hm[4] * y + Hm[5]) / z) : NaN;
    }
    return { w, h, d: o };
  }

  const applyH = (H, p) => { const z = H[6] * p[0] + H[7] * p[1] + H[8]; return [(H[0] * p[0] + H[1] * p[1] + H[2]) / z, (H[3] * p[0] + H[4] * p[1] + H[5]) / z]; };

  /* ═════════ Descritores binários orientados (estilo ORB) ═════════
     Para casar pontos entre vistas com rotação grande (contornar o objeto
     gira a imagem da mesa) e para relocalizar quando o rastreamento se perde.
     • orientação pelo centróide de intensidade (raio 15)
     • 256 testes de intensidade em pares de pontos dentro de um disco de
       raio 13, girados pela orientação, sobre a imagem suavizada
     • em 2 níveis da pirâmide (tolera mudança de escala ~2×) */
  const NB = 256, PAT = (() => {
    let sd = 0x2545F491; const r = () => { sd = (sd * 1664525 + 1013904223) >>> 0; return sd / 4294967296; };
    const g = () => { let x; do { const u = r() || 1e-9, v = r(); x = Math.sqrt(-2 * Math.log(u)) * Math.cos(6.2832 * v) * 5.2; } while (Math.abs(x) > 12.5); return x; };
    const p = new Float32Array(NB * 4);
    for (let i = 0; i < NB; i++) { p[4 * i] = g(); p[4 * i + 1] = g(); p[4 * i + 2] = g(); p[4 * i + 3] = g(); }
    return p;
  })();
  const NROT = 36, ROT = (() => {
    const out = [];
    for (let k = 0; k < NROT; k++) {
      const a = k * 2 * Math.PI / NROT, c = Math.cos(a), s = Math.sin(a), t = new Int8Array(NB * 4);
      for (let i = 0; i < NB; i++) for (let j = 0; j < 2; j++) {
        const x = PAT[4 * i + 2 * j], y = PAT[4 * i + 2 * j + 1];
        t[4 * i + 2 * j] = Math.round(c * x - s * y); t[4 * i + 2 * j + 1] = Math.round(s * x + c * y);
      }
      out.push(t);
    }
    return out;
  })();

  function boxBlur(g, r) {
    const { w, h, d } = g, tmp = new Float32Array(w * h), o = new Float32Array(w * h), k = 2 * r + 1;
    for (let y = 0; y < h; y++) { let s = 0; for (let x = -r; x <= r; x++) s += d[y * w + Math.min(w - 1, Math.max(0, x))]; for (let x = 0; x < w; x++) { tmp[y * w + x] = s / k; s += d[y * w + Math.min(w - 1, x + r + 1)] - d[y * w + Math.max(0, x - r)]; } }
    for (let x = 0; x < w; x++) { let s = 0; for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]; for (let y = 0; y < h; y++) { o[y * w + x] = s / k; s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; } }
    return { w, h, d: o };
  }

  /* pontos + descritores de uma pirâmide (níveis 0 e 1). Retorna
     { pts:[[x,y] no nível 0], desc:Uint32Array(n*8) } */
  function orbFeatures(pyr, opts) {
    opts = opts || {};
    const pts = [], descs = [];
    for (let l = 0; l < Math.min(2, pyr.length); l++) {
      const g = pyr[l], sc = 1 << l, sm = boxBlur(g, 2);
      const c = corners(g, { maxN: l ? 160 : 320, cols: l ? 10 : 16, rows: l ? 6 : 10, perCell: 3, quality: 0.01, minScore: 20, border: 17, minDist: 6 });
      const { w, d } = g;
      for (const [x, y] of c.pts) {
        /* orientação: centróide de intensidade */
        let m10 = 0, m01 = 0;
        for (let dy = -15; dy <= 15; dy++) { const lim = Math.floor(Math.sqrt(225 - dy * dy)); for (let dx = -lim; dx <= lim; dx++) { const v = d[(y + dy) * w + x + dx]; m10 += dx * v; m01 += dy * v; } }
        const ang = Math.atan2(m01, m10), k = ((Math.round(ang / (2 * Math.PI) * NROT) % NROT) + NROT) % NROT, P = ROT[k];
        const de = new Uint32Array(8), sd = sm.d;
        for (let i = 0; i < NB; i++) {
          const a = sd[(y + P[4 * i + 1]) * w + x + P[4 * i]], b = sd[(y + P[4 * i + 3]) * w + x + P[4 * i + 2]];
          if (a < b) de[i >> 5] |= 1 << (i & 31);
        }
        pts.push([x * sc + (sc - 1) * 0.5, y * sc + (sc - 1) * 0.5]); descs.push(de);
      }
    }
    const desc = new Uint32Array(descs.length * 8);
    descs.forEach((de, i) => desc.set(de, i * 8));
    return { pts, desc };
  }

  function popcnt(v) { v = v - ((v >>> 1) & 0x55555555); v = (v & 0x33333333) + ((v >>> 2) & 0x33333333); return (((v + (v >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; }

  /* casamento por vizinho mais próximo (distância de Hamming), com teste de
     razão e verificação mútua. Retorna [[iA, iB], ...] */
  function matchBinary(A, B, opts) {
    opts = opts || {};
    const nA = A.desc.length / 8, nB = B.desc.length / 8, maxD = opts.maxDist || 70, ratio = opts.ratio || 0.82;
    const bestBA = new Int32Array(nB).fill(-1), bestBAd = new Int32Array(nB).fill(999);
    const fwd = [];
    for (let i = 0; i < nA; i++) {
      let b1 = 999, b2 = 999, bi = -1;
      const ia = i * 8;
      for (let j = 0; j < nB; j++) {
        const jb = j * 8;
        let dd = 0;
        for (let k = 0; k < 8; k++) dd += popcnt(A.desc[ia + k] ^ B.desc[jb + k]);
        if (dd < b1) { b2 = b1; b1 = dd; bi = j; } else if (dd < b2) b2 = dd;
        if (dd < bestBAd[j]) { bestBAd[j] = dd; bestBA[j] = i; }
      }
      if (bi >= 0 && b1 <= maxD && b1 < ratio * b2) fwd.push([i, bi]);
    }
    return fwd.filter(([i, j]) => bestBA[j] === i);
  }

  GS3D.features = { gray, down, pyramid, grads, corners, lk, ransacH, warp, sample, applyH, orbFeatures, matchBinary, boxBlur };
})(typeof window !== 'undefined' ? window : globalThis);
