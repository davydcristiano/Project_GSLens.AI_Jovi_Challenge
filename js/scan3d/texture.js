/* ═══════════════════════════════════════════════════
   GSLens.AI — Scanner 3D · texture.js
   Textura real do objeto a partir das fotos dos quadros-
   chave: visibilidade por z-buffer em software, escolha
   das melhores vistas por triângulo, compensação de
   exposição entre vistas e "bake" num atlas de textura.
═══════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const GS3D = root.GS3D = root.GS3D || {};
  const M = GS3D.math;

  /* z-buffer (armazena 1/z — maior = mais próximo) numa escala reduzida */
  function depthBuffer(mesh, view, scale) {
    const W = Math.max(8, Math.round(view.w * scale)), H = Math.max(8, Math.round(view.h * scale));
    const buf = new Float32Array(W * H);
    const { positions: p, indices: I } = mesh;
    const nv = p.length / 3;
    const sx = new Float32Array(nv), sy = new Float32Array(nv), iz = new Float32Array(nv);
    const { K, R, t } = view;
    for (let v = 0; v < nv; v++) {
      const q = M.project(K, R, t, [p[3 * v], p[3 * v + 1], p[3 * v + 2]]);
      sx[v] = q[0] * scale; sy[v] = q[1] * scale; iz[v] = q[2] > 0 ? 1 / q[2] : -1;
    }
    for (let tr = 0; tr < I.length; tr += 3) {
      const a = I[tr], b = I[tr + 1], c = I[tr + 2];
      if (iz[a] <= 0 || iz[b] <= 0 || iz[c] <= 0) continue;
      const x0 = sx[a], y0 = sy[a], x1 = sx[b], y1 = sy[b], x2 = sx[c], y2 = sy[c];
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      if (Math.abs(area) < 1e-9) continue;
      const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
      const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const w0 = ((x1 - x) * (y2 - y) - (x2 - x) * (y1 - y)) / area;
        const w1 = ((x2 - x) * (y0 - y) - (x0 - x) * (y2 - y)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
        const z = w0 * iz[a] + w1 * iz[b] + w2 * iz[c];
        const k = y * W + x;
        if (z > buf[k]) buf[k] = z;
      }
    }
    return { buf, W, H, scale };
  }

  function sampleRGB(view, x, y, out) {
    const w = view.w, h = view.h;
    if (x < 0) x = 0; if (y < 0) y = 0;
    if (x > w - 1.001) x = w - 1.001; if (y > h - 1.001) y = h - 1.001;
    const x0 = x | 0, y0 = y | 0, ax = x - x0, ay = y - y0, d = view.rgba;
    const i00 = (y0 * w + x0) * 4, i10 = i00 + 4, i01 = i00 + w * 4, i11 = i01 + 4;
    for (let c = 0; c < 3; c++)
      out[c] = (d[i00 + c] * (1 - ax) + d[i10 + c] * ax) * (1 - ay) + (d[i01 + c] * (1 - ax) + d[i11 + c] * ax) * ay;
    return out;
  }

  /* Gera atlas + UVs. views: [{K,R,t,C,w,h,rgba,gain}] */
  async function bake(mesh, views, opts, onProgress, isCancelled) {
    opts = opts || {};
    const { positions: p, indices: I, normals } = mesh;
    const T = I.length / 3;
    const yieldUI = GS3D.recon.yieldUI;

    /* 1) Visibilidade */
    const dbs = [];
    for (let v = 0; v < views.length; v++) {
      if (isCancelled && isCancelled()) throw new DOMException('cancelado', 'AbortError');
      dbs.push(depthBuffer(mesh, views[v], 0.5));
      if (onProgress) onProgress(0.4 * (v + 1) / views.length);
      if (v % 3 === 2) await yieldUI();
    }

    /* 2) Melhores vistas por triângulo (até 3) */
    const NB = 3;
    const best = new Int16Array(T * NB).fill(-1), bestW = new Float32Array(T * NB);
    const cand = [];
    for (let tr = 0; tr < T; tr++) {
      const a = I[3 * tr] * 3, b = I[3 * tr + 1] * 3, c = I[3 * tr + 2] * 3;
      const cen = [(p[a] + p[b] + p[c]) / 3, (p[a + 1] + p[b + 1] + p[c + 1]) / 3, (p[a + 2] + p[b + 2] + p[c + 2]) / 3];
      const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]], e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
      let n = M.cross3(e1, e2);
      const nl = M.norm3(n);
      if (nl < 1e-12) { n = [normals[a], normals[a + 1], normals[a + 2]]; } else n = [n[0] / nl, n[1] / nl, n[2] / nl];
      cand.length = 0;
      for (let v = 0; v < views.length; v++) {
        const view = views[v];
        const dir = [view.C[0] - cen[0], view.C[1] - cen[1], view.C[2] - cen[2]];
        const dl = M.norm3(dir);
        const cos = (n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2]) / dl;
        if (cos < 0.12) continue;
        const q = M.project(view.K, view.R, view.t, cen);
        if (!(q[2] > 0) || q[0] < 1 || q[1] < 1 || q[0] > view.w - 2 || q[1] > view.h - 2) continue;
        const db = dbs[v];
        const bx = Math.round(q[0] * db.scale), by = Math.round(q[1] * db.scale);
        if (bx < 0 || by < 0 || bx >= db.W || by >= db.H) continue;
        /* visível se não houver superfície mais próxima nos arredores imediatos */
        const zHit = db.buf[by * db.W + bx];
        if (zHit > 0) {
          const zFront = 1 / zHit;
          if (q[2] > zFront + Math.max(1.5, 0.006 * q[2])) continue;
        }
        cand.push([v, cos * cos * cos]);
      }
      cand.sort((x, y) => y[1] - x[1]);
      for (let k = 0; k < Math.min(NB, cand.length); k++) { best[tr * NB + k] = cand[k][0]; bestW[tr * NB + k] = cand[k][1]; }
      if (tr % 4000 === 3999) { if (onProgress) onProgress(0.4 + 0.2 * tr / T); await yieldUI(); }
    }

    /* 3) Empacotamento: 2 triângulos por célula quadrada */
    const cells = Math.ceil(T / 2);
    const G = Math.ceil(Math.sqrt(cells));
    const maxSize = opts.maxSize || 2048;
    let c = Math.max(6, Math.min(12, Math.floor(maxSize / G)));
    let S = 1;
    while (S < G * c) S <<= 1;
    if (S > maxSize) { S = maxSize; c = Math.floor(S / G); }
    if (c < 6) throw new Error('Malha densa demais para o atlas de textura (' + T + ' triângulos).');
    const atlas = new Uint8ClampedArray(S * S * 4);
    const uvs = new Float32Array(T * 6);
    const rgb = [0, 0, 0], acc = [0, 0, 0];
    const fallback = opts.fallbackColor || [150, 150, 150];

    for (let tr = 0; tr < T; tr++) {
      const cell = tr >> 1, slot = tr & 1;
      const x0 = (cell % G) * c, y0 = ((cell / G) | 0) * c;
      /* vértices do triângulo no atlas (px, convenção de centro de pixel +0.5) */
      let A, Bv, Cv;
      /* Hipotenusas separadas por uma faixa de texels de margem para que a
         filtragem bilinear de um triângulo não leia texels do vizinho. */
      if (slot === 0) { A = [x0 + 1, y0 + 1]; Bv = [x0 + c - 2, y0 + 1]; Cv = [x0 + 1, y0 + c - 2]; }
      else { A = [x0 + c - 1, y0 + c - 1]; Bv = [x0 + 3, y0 + c - 1]; Cv = [x0 + c - 1, y0 + 3]; }
      uvs.set([A[0] / S, A[1] / S, Bv[0] / S, Bv[1] / S, Cv[0] / S, Cv[1] / S], tr * 6);
      const ia = I[3 * tr] * 3, ib = I[3 * tr + 1] * 3, ic = I[3 * tr + 2] * 3;
      const den = (Bv[1] - Cv[1]) * (A[0] - Cv[0]) + (Cv[0] - Bv[0]) * (A[1] - Cv[1]);
      for (let ty = y0; ty < y0 + c && ty < S; ty++) for (let tx = x0; tx < x0 + c && tx < S; tx++) {
        const lx = tx - x0, ly = ty - y0;
        const inSlot0 = lx + ly <= c - 1;
        if ((slot === 0) !== inSlot0) continue;
        const px = tx + 0.5, py = ty + 0.5;
        let l0 = ((Bv[1] - Cv[1]) * (px - Cv[0]) + (Cv[0] - Bv[0]) * (py - Cv[1])) / den;
        let l1 = ((Cv[1] - A[1]) * (px - Cv[0]) + (A[0] - Cv[0]) * (py - Cv[1])) / den;
        let l2 = 1 - l0 - l1;
        /* texels de margem: projeta no triângulo (borda estendida) */
        l0 = Math.max(0, l0); l1 = Math.max(0, l1); l2 = Math.max(0, l2);
        const ls = l0 + l1 + l2; l0 /= ls; l1 /= ls; l2 /= ls;
        const X = [p[ia] * l0 + p[ib] * l1 + p[ic] * l2, p[ia + 1] * l0 + p[ib + 1] * l1 + p[ic + 1] * l2, p[ia + 2] * l0 + p[ib + 2] * l1 + p[ic + 2] * l2];
        acc[0] = acc[1] = acc[2] = 0;
        let ws = 0;
        for (let k = 0; k < NB; k++) {
          const v = best[tr * NB + k];
          if (v < 0) break;
          const view = views[v];
          const q = M.project(view.K, view.R, view.t, X);
          sampleRGB(view, q[0], q[1], rgb);
          const wgt = bestW[tr * NB + k], g = view.gain || 1;
          acc[0] += rgb[0] * g * wgt; acc[1] += rgb[1] * g * wgt; acc[2] += rgb[2] * g * wgt; ws += wgt;
        }
        const o = (ty * S + tx) * 4;
        if (ws > 0) { atlas[o] = acc[0] / ws; atlas[o + 1] = acc[1] / ws; atlas[o + 2] = acc[2] / ws; }
        else { atlas[o] = fallback[0]; atlas[o + 1] = fallback[1]; atlas[o + 2] = fallback[2]; }
        atlas[o + 3] = 255;
      }
      if (tr % 3000 === 2999) {
        if (isCancelled && isCancelled()) throw new DOMException('cancelado', 'AbortError');
        if (onProgress) onProgress(0.6 + 0.4 * tr / T);
        await yieldUI();
      }
    }
    /* células não usadas: cinza neutro (não aparece no modelo) */
    for (let i = 3; i < atlas.length; i += 4) if (!atlas[i]) { atlas[i - 3] = atlas[i - 2] = atlas[i - 1] = 128; atlas[i] = 255; }
    if (onProgress) onProgress(1);
    return { uvs, atlas, size: S, coverage: (() => { let n = 0; for (let tr = 0; tr < T; tr++) if (best[tr * NB] >= 0) n++; return n / T; })() };
  }

  GS3D.texture = { bake, depthBuffer };
})(typeof window !== 'undefined' ? window : globalThis);
