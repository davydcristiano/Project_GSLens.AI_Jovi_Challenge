/* ═══════════════════════════════════════════════════
   GSLens.AI — Scanner 3D · math.js
   Álgebra linear e geometria projetiva usadas pelo
   rastreamento da prancha e pela reconstrução 3D:
   - homografia (DLT normalizado)
   - estimativa de distância focal a partir de homografias
   - pose da câmera (R,t) a partir da homografia
   - refinamento de pose por Levenberg–Marquardt
   Unidades da prancha: milímetros. Imagem: pixels.
═══════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const GS3D = root.GS3D = root.GS3D || {};

  /* ── 3×3 (arrays planos de 9, linha a linha) ── */
  function mul3(A, B) {
    const C = new Array(9);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        C[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
    return C;
  }
  function mul3v(A, v) {
    return [A[0] * v[0] + A[1] * v[1] + A[2] * v[2],
            A[3] * v[0] + A[4] * v[1] + A[5] * v[2],
            A[6] * v[0] + A[7] * v[1] + A[8] * v[2]];
  }
  function transpose3(A) { return [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]]; }
  function det3(A) {
    return A[0] * (A[4] * A[8] - A[5] * A[7]) - A[1] * (A[3] * A[8] - A[5] * A[6]) + A[2] * (A[3] * A[7] - A[4] * A[6]);
  }
  function inv3(A) {
    const d = det3(A);
    if (!isFinite(d) || Math.abs(d) < 1e-300) return null;
    const id = 1 / d;
    return [
      (A[4] * A[8] - A[5] * A[7]) * id, (A[2] * A[7] - A[1] * A[8]) * id, (A[1] * A[5] - A[2] * A[4]) * id,
      (A[5] * A[6] - A[3] * A[8]) * id, (A[0] * A[8] - A[2] * A[6]) * id, (A[2] * A[3] - A[0] * A[5]) * id,
      (A[3] * A[7] - A[4] * A[6]) * id, (A[1] * A[6] - A[0] * A[7]) * id, (A[0] * A[4] - A[1] * A[3]) * id
    ];
  }
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm3 = a => Math.hypot(a[0], a[1], a[2]);
  function normalize3(a) { const n = norm3(a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; }

  /* Aplica homografia a um ponto 2D */
  function applyH(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  }

  /* ── Autovalores/autovetores de matriz simétrica (Jacobi) ──
     A: n×n plano (será copiada). Retorna { values, vectors } com
     vetores nas COLUNAS de 'vectors' (n×n plano). */
  function eigSym(Ain, n) {
    const A = Float64Array.from(Ain);
    const V = new Float64Array(n * n);
    for (let i = 0; i < n; i++) V[i * n + i] = 1;
    for (let sweep = 0; sweep < 60; sweep++) {
      let off = 0;
      for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p * n + q] * A[p * n + q];
      if (off < 1e-22) break;
      for (let p = 0; p < n; p++) {
        for (let q = p + 1; q < n; q++) {
          const apq = A[p * n + q];
          if (Math.abs(apq) < 1e-300) continue;
          const app = A[p * n + p], aqq = A[q * n + q];
          const theta = (aqq - app) / (2 * apq);
          const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
          const c = 1 / Math.sqrt(t * t + 1), s = t * c;
          for (let k = 0; k < n; k++) {
            const akp = A[k * n + p], akq = A[k * n + q];
            A[k * n + p] = c * akp - s * akq;
            A[k * n + q] = s * akp + c * akq;
          }
          for (let k = 0; k < n; k++) {
            const apk = A[p * n + k], aqk = A[q * n + k];
            A[p * n + k] = c * apk - s * aqk;
            A[q * n + k] = s * apk + c * aqk;
          }
          for (let k = 0; k < n; k++) {
            const vkp = V[k * n + p], vkq = V[k * n + q];
            V[k * n + p] = c * vkp - s * vkq;
            V[k * n + q] = s * vkp + c * vkq;
          }
        }
      }
    }
    const values = new Float64Array(n);
    for (let i = 0; i < n; i++) values[i] = A[i * n + i];
    return { values, vectors: V };
  }

  /* Resolve A x = b (n×n) por eliminação de Gauss com pivoteamento parcial */
  function solveLinear(Ain, bin, n) {
    const A = Float64Array.from(Ain), b = Float64Array.from(bin);
    for (let c = 0; c < n; c++) {
      let piv = c, best = Math.abs(A[c * n + c]);
      for (let r = c + 1; r < n; r++) { const v = Math.abs(A[r * n + c]); if (v > best) { best = v; piv = r; } }
      if (best < 1e-300) return null;
      if (piv !== c) {
        for (let k = 0; k < n; k++) { const tmp = A[c * n + k]; A[c * n + k] = A[piv * n + k]; A[piv * n + k] = tmp; }
        const tb = b[c]; b[c] = b[piv]; b[piv] = tb;
      }
      const d = A[c * n + c];
      for (let r = c + 1; r < n; r++) {
        const f = A[r * n + c] / d;
        if (f === 0) continue;
        for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k];
        b[r] -= f * b[c];
      }
    }
    const x = new Float64Array(n);
    for (let r = n - 1; r >= 0; r--) {
      let s = b[r];
      for (let k = r + 1; k < n; k++) s -= A[r * n + k] * x[k];
      x[r] = s / A[r * n + r];
    }
    return x;
  }

  /* ── Homografia por DLT normalizado (Hartley) ──
     src: [[x,y],...] (prancha, mm)  dst: [[u,v],...] (imagem, px) */
  function normalizePts(pts) {
    let mx = 0, my = 0;
    for (const p of pts) { mx += p[0]; my += p[1]; }
    mx /= pts.length; my /= pts.length;
    let md = 0;
    for (const p of pts) md += Math.hypot(p[0] - mx, p[1] - my);
    md /= pts.length;
    const s = md > 0 ? Math.SQRT2 / md : 1;
    return { T: [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1], pts: pts.map(p => [(p[0] - mx) * s, (p[1] - my) * s]) };
  }
  function homographyDLT(src, dst, weights) {
    const n = src.length;
    if (n < 4) return null;
    const ns = normalizePts(src), nd = normalizePts(dst);
    const AtA = new Float64Array(81);
    const row = new Float64Array(9);
    const addRow = (w) => {
      for (let i = 0; i < 9; i++) {
        const ri = row[i] * w;
        if (ri === 0) continue;
        for (let j = 0; j < 9; j++) AtA[i * 9 + j] += ri * row[j];
      }
    };
    for (let k = 0; k < n; k++) {
      const [x, y] = ns.pts[k], [u, v] = nd.pts[k];
      const w = weights ? weights[k] : 1;
      row.set([-x, -y, -1, 0, 0, 0, u * x, u * y, u]); addRow(w);
      row.set([0, 0, 0, -x, -y, -1, v * x, v * y, v]); addRow(w);
    }
    const { values, vectors } = eigSym(AtA, 9);
    let mi = 0;
    for (let i = 1; i < 9; i++) if (values[i] < values[mi]) mi = i;
    const h = [];
    for (let i = 0; i < 9; i++) h.push(vectors[i * 9 + mi]);
    const Tdi = inv3(nd.T);
    if (!Tdi) return null;
    let H = mul3(Tdi, mul3(h, ns.T));
    const s = H[8];
    if (Math.abs(s) < 1e-15) return null;
    H = H.map(x => x / s);
    return H.every(isFinite) ? H : null;
  }

  /* ── Rodrigues ── */
  function rodriguesToMat(r) {
    const th = Math.hypot(r[0], r[1], r[2]);
    if (th < 1e-12) return [1, -r[2], r[1], r[2], 1, -r[0], -r[1], r[0], 1];
    const kx = r[0] / th, ky = r[1] / th, kz = r[2] / th;
    const c = Math.cos(th), s = Math.sin(th), v = 1 - c;
    return [
      kx * kx * v + c, kx * ky * v - kz * s, kx * kz * v + ky * s,
      ky * kx * v + kz * s, ky * ky * v + c, ky * kz * v - kx * s,
      kz * kx * v - ky * s, kz * ky * v + kx * s, kz * kz * v + c
    ];
  }
  function matToRodrigues(R) {
    const tr = R[0] + R[4] + R[8];
    const cosT = Math.max(-1, Math.min(1, (tr - 1) / 2));
    const th = Math.acos(cosT);
    if (th < 1e-9) return [0, 0, 0];
    if (Math.PI - th < 1e-6) {
      /* ângulo ~180°: eixo a partir da diagonal */
      const xx = (R[0] + 1) / 2, yy = (R[4] + 1) / 2, zz = (R[8] + 1) / 2;
      let ax;
      if (xx >= yy && xx >= zz) { const x = Math.sqrt(xx); ax = [x, R[1] / (2 * x), R[2] / (2 * x)]; }
      else if (yy >= zz) { const y = Math.sqrt(yy); ax = [R[1] / (2 * y), y, R[5] / (2 * y)]; }
      else { const z = Math.sqrt(zz); ax = [R[2] / (2 * z), R[5] / (2 * z), z]; }
      ax = normalize3(ax);
      return [ax[0] * th, ax[1] * th, ax[2] * th];
    }
    const k = th / (2 * Math.sin(th));
    return [(R[7] - R[5]) * k, (R[2] - R[6]) * k, (R[3] - R[1]) * k];
  }

  /* Ortonormaliza (rotação mais próxima) via decomposição polar iterativa */
  function orthonormalize(M) {
    let R = M.slice();
    for (let it = 0; it < 30; it++) {
      const Ri = inv3(R);
      if (!Ri) break;
      const RiT = transpose3(Ri);
      const N = R.map((v, i) => 0.5 * (v + RiT[i]));
      let diff = 0;
      for (let i = 0; i < 9; i++) diff += Math.abs(N[i] - R[i]);
      R = N;
      if (diff < 1e-12) break;
    }
    if (det3(R) < 0) R = R.map(v => -v);
    return R;
  }

  function makeK(f, cx, cy) { return [f, 0, cx, 0, f, cy, 0, 0, 1]; }
  /* K com ponto principal no centro da imagem, na convenção de índice de
     pixel usada em todo o pipeline (centro do pixel i = coordenada i). */
  function kForImage(f, w, h) { return makeK(f, (w - 1) / 2, (h - 1) / 2); }

  /* Pose a partir da homografia prancha(z=0)->imagem e intrínsecos K */
  function poseFromHomography(H, K) {
    const Ki = inv3(K);
    if (!Ki) return null;
    const M = mul3(Ki, H);
    let h1 = [M[0], M[3], M[6]], h2 = [M[1], M[4], M[7]], h3 = [M[2], M[5], M[8]];
    const lam = 2 / (norm3(h1) + norm3(h2));
    let r1 = h1.map(v => v * lam), r2 = h2.map(v => v * lam), t = h3.map(v => v * lam);
    if (t[2] < 0) { r1 = r1.map(v => -v); r2 = r2.map(v => -v); t = t.map(v => -v); }
    const r3 = cross3(r1, r2);
    const R = orthonormalize([r1[0], r2[0], r3[0], r1[1], r2[1], r3[1], r1[2], r2[2], r3[2]]);
    return { R, t };
  }

  /* Projeção de ponto 3D (mm, coordenadas da prancha) para pixel */
  function project(K, R, t, X) {
    const xc = R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + t[0];
    const yc = R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + t[1];
    const zc = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + t[2];
    return [K[0] * xc / zc + K[2], K[4] * yc / zc + K[5], zc];
  }

  /* Levenberg–Marquardt da pose (6 parâmetros) minimizando o erro de
     reprojeção de pontos 3D conhecidos. Retorna { R, t, rms } */
  function refinePose(K, R0, t0, obj, img, iters) {
    let p = matToRodrigues(R0).concat(t0);
    const n = obj.length;
    const resid = (pp) => {
      const R = rodriguesToMat(pp), t = [pp[3], pp[4], pp[5]];
      const r = new Float64Array(2 * n);
      for (let i = 0; i < n; i++) {
        const q = project(K, R, t, obj[i]);
        if (!(q[2] > 0)) { r[2 * i] = 1e4; r[2 * i + 1] = 1e4; continue; }
        r[2 * i] = q[0] - img[i][0]; r[2 * i + 1] = q[1] - img[i][1];
      }
      return r;
    };
    const cost = r => { let s = 0; for (let i = 0; i < r.length; i++) s += r[i] * r[i]; return s; };
    let r = resid(p), c = cost(r), lambda = 1e-3;
    const J = new Float64Array(2 * n * 6);
    for (let it = 0; it < (iters || 12); it++) {
      for (let j = 0; j < 6; j++) {
        const h = j < 3 ? 1e-6 : Math.max(1e-4, Math.abs(p[j]) * 1e-6);
        const pp = p.slice(); pp[j] += h;
        const r2 = resid(pp);
        for (let i = 0; i < 2 * n; i++) J[i * 6 + j] = (r2[i] - r[i]) / h;
      }
      const JtJ = new Float64Array(36), Jtr = new Float64Array(6);
      for (let i = 0; i < 2 * n; i++) {
        for (let a = 0; a < 6; a++) {
          const ja = J[i * 6 + a];
          Jtr[a] += ja * r[i];
          for (let b = a; b < 6; b++) JtJ[a * 6 + b] += ja * J[i * 6 + b];
        }
      }
      for (let a = 0; a < 6; a++) for (let b = 0; b < a; b++) JtJ[a * 6 + b] = JtJ[b * 6 + a];
      let improved = false;
      for (let tries = 0; tries < 8; tries++) {
        const A = Float64Array.from(JtJ);
        for (let a = 0; a < 6; a++) A[a * 6 + a] *= (1 + lambda);
        const dx = solveLinear(A, Jtr.map(v => -v), 6);
        if (!dx) { lambda *= 10; continue; }
        const pn = p.map((v, i) => v + dx[i]);
        const rn = resid(pn), cn = cost(rn);
        if (cn < c) {
          p = pn; r = rn;
          const rel = (c - cn) / (c || 1);
          c = cn; lambda = Math.max(lambda / 10, 1e-9); improved = true;
          if (rel < 1e-10) it = 1e9;
          break;
        }
        lambda *= 10;
      }
      if (!improved) break;
    }
    return { R: rodriguesToMat(p), t: [p[3], p[4], p[5]], rms: Math.sqrt(c / Math.max(1, n)) };
  }

  /* Estimativa linear da distância focal a partir de várias homografias
     (ponto principal no centro, pixels quadrados — modelo de Zhang com um
     único parâmetro). As coordenadas são reescaladas por 'scale' (≈ maior
     dimensão da imagem) para que as equações fiquem bem condicionadas.
     Retorna { f, perView } ou null se as vistas forem degeneradas. */
  function estimateFocal(Hs, cx, cy, scale) {
    const s = scale || 2 * Math.max(cx, cy);
    const T = [1 / s, 0, -cx / s, 0, 1 / s, -cy / s, 0, 0, 1];
    const eqs = Hs.map(H => {
      let Mx = mul3(T, H);
      /* normaliza só pelas colunas 1 e 2 (as únicas usadas); a escala da
         translação (coluna 3) não interfere nas restrições. */
      const sc = Math.hypot(Mx[0], Mx[1], Mx[3], Mx[4], Mx[6], Mx[7]);
      Mx = Mx.map(v => v / sc);
      const [h11, h12, , h21, h22, , h31, h32] = Mx;
      /* (h11 h12 + h21 h22) w + h31 h32 = 0 ;  (h11²+h21²−h12²−h22²) w + (h31²−h32²) = 0 ; w = 1/f'² */
      return [[h11 * h12 + h21 * h22, h31 * h32], [h11 * h11 + h21 * h21 - h12 * h12 - h22 * h22, h31 * h31 - h32 * h32]];
    });
    const perView = [];
    for (const e of eqs) {
      let aa = 0, ab = 0;
      for (const [a, b] of e) { aa += a * a; ab += a * b; }
      const w = -ab / aa;
      /* só confia em vistas com perspectiva suficiente (termo b não desprezível) */
      const strength = Math.sqrt(e[0][1] * e[0][1] + e[1][1] * e[1][1]);
      if (aa > 0 && w > 0 && strength > 1e-4) perView.push({ f: s / Math.sqrt(w), strength });
    }
    if (!perView.length) return null;
    const med = median(perView.map(p => p.f));
    let aa = 0, ab = 0, used = 0;
    eqs.forEach((e, i) => {
      for (const [a, b] of e) {
        /* descarta equações de vistas cujo f isolado destoa muito da mediana */
        const wv = -(a * b) / (a * a || 1);
        const fv = wv > 0 ? s / Math.sqrt(wv) : Infinity;
        if (!isFinite(fv) || Math.abs(fv / med - 1) > 0.35) continue;
        aa += a * a; ab += a * b; used++;
      }
    });
    if (!used || aa <= 0) return { f: med, perView: perView.map(p => p.f) };
    const w = -ab / aa;
    return { f: w > 0 ? s / Math.sqrt(w) : med, perView: perView.map(p => p.f) };
  }

  function median(arr) {
    if (!arr.length) return NaN;
    const a = Float64Array.from(arr).sort();
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
  }

  /* Busca da seção áurea (minimização 1D) */
  function goldenMin(fn, a, b, iters) {
    const g = (Math.sqrt(5) - 1) / 2;
    let c = b - g * (b - a), d = a + g * (b - a);
    let fc = fn(c), fd = fn(d);
    for (let i = 0; i < (iters || 30); i++) {
      if (fc < fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = fn(c); }
      else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = fn(d); }
    }
    return fc < fd ? c : d;
  }

  /* Centro da câmera em coordenadas da prancha: C = -Rᵀ t */
  function cameraCenter(R, t) {
    const Rt = transpose3(R);
    const c = mul3v(Rt, t);
    return [-c[0], -c[1], -c[2]];
  }

  GS3D.math = {
    mul3, mul3v, transpose3, det3, inv3, dot3, cross3, norm3, normalize3, applyH,
    eigSym, solveLinear, homographyDLT, rodriguesToMat, matToRodrigues, orthonormalize,
    makeK, kForImage, poseFromHomography, project, refinePose, estimateFocal, median, goldenMin, cameraCenter
  };
})(typeof window !== 'undefined' ? window : globalThis);
