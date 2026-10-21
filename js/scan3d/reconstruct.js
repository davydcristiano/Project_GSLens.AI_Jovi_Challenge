/* ═══════════════════════════════════════════════════
   GSLens.AI — Scanner 3D · reconstruct.js
   Reconstrução volumétrica por interseção de silhuetas
   (visual hull / space carving) a partir das vistas
   calibradas, seguida de extração de superfície
   (Surface Nets) e suavização.
═══════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const GS3D = root.GS3D = root.GS3D || {};
  const M = GS3D.math;

  const yieldUI = () => new Promise(r => setTimeout(r, 0));

  /* Matriz de projeção 3×4 (plana, 12) = K [R | t] */
  function projMatrix(K, R, t) {
    const P = new Float64Array(12);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) P[r * 4 + c] = K[r * 3] * R[c] + K[r * 3 + 1] * R[3 + c] + K[r * 3 + 2] * R[6 + c];
      P[r * 4 + 3] = K[r * 3] * t[0] + K[r * 3 + 1] * t[1] + K[r * 3 + 2] * t[2];
    }
    return P;
  }

  /* ── Esculpimento ──
     views: [{ P, w, h, mask }]; vol: {xmin..zmax}; res: voxels no eixo X */
  async function carve(views, vol, res, onProgress, isCancelled, tol) {
    tol = tol == null ? 0.08 : tol;
    const vs = (vol.xmax - vol.xmin) / res;
    const nx = res, ny = Math.round((vol.ymax - vol.ymin) / vs), nz = Math.round((vol.zmax - vol.zmin) / vs);
    const N = nx * ny * nz;
    const objV = new Uint8Array(N), bgV = new Uint8Array(N);
    for (let vi = 0; vi < views.length; vi++) {
      if (isCancelled && isCancelled()) throw new DOMException('cancelado', 'AbortError');
      const { P, w, h, mask } = views[vi];
      const dx0 = P[0] * vs, dx1 = P[4] * vs, dx2 = P[8] * vs;
      for (let k = 0; k < nz; k++) {
        const z = vol.zmin + (k + 0.5) * vs;
        for (let j = 0; j < ny; j++) {
          const y = vol.ymin + (j + 0.5) * vs, x = vol.xmin + 0.5 * vs;
          let p0 = P[0] * x + P[1] * y + P[2] * z + P[3];
          let p1 = P[4] * x + P[5] * y + P[6] * z + P[7];
          let p2 = P[8] * x + P[9] * y + P[10] * z + P[11];
          let idx = (k * ny + j) * nx;
          for (let i = 0; i < nx; i++, idx++, p0 += dx0, p1 += dx1, p2 += dx2) {
            if (p2 <= 0) continue;
            const u = (p0 / p2 + 0.5) | 0, v = (p1 / p2 + 0.5) | 0;
            if (u < 0 || v < 0 || u >= w || v >= h) continue;
            const m = mask[v * w + u];
            if (m === 1) objV[idx]++;
            else if (m === 0) bgV[idx]++;
          }
        }
      }
      if (onProgress) onProgress((vi + 1) / views.length);
      await yieldUI();
    }
    const occ = new Uint8Array(N);
    let count = 0;
    for (let i = 0; i < N; i++) {
      const known = objV[i] + bgV[i];
      if (known >= 3 && bgV[i] <= Math.floor(tol * known)) { occ[i] = 1; count++; }
    }
    return { occ, nx, ny, nz, vs, vol, count };
  }

  /* Maior componente 6-conexa */
  function largestComponent(occ, nx, ny, nz) {
    const N = nx * ny * nz, label = new Int32Array(N), queue = new Int32Array(N);
    let best = 0, bestLabel = 0, cur = 0;
    for (let s = 0; s < N; s++) {
      if (!occ[s] || label[s]) continue;
      cur++;
      let qh = 0, qt = 0, size = 0;
      queue[qt++] = s; label[s] = cur;
      while (qh < qt) {
        const p = queue[qh++]; size++;
        const i = p % nx, j = ((p / nx) | 0) % ny, k = (p / (nx * ny)) | 0;
        const nb = [i > 0 ? p - 1 : -1, i < nx - 1 ? p + 1 : -1, j > 0 ? p - nx : -1, j < ny - 1 ? p + nx : -1, k > 0 ? p - nx * ny : -1, k < nz - 1 ? p + nx * ny : -1];
        for (const q of nb) if (q >= 0 && occ[q] && !label[q]) { label[q] = cur; queue[qt++] = q; }
      }
      if (size > best) { best = size; bestLabel = cur; }
    }
    const out = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (label[i] === bestLabel && bestLabel) out[i] = 1;
    return { occ: out, size: best };
  }

  /* Preenche cavidades internas (vazios não alcançáveis a partir da borda) */
  function fillCavities(occ, nx, ny, nz) {
    const N = nx * ny * nz, seen = new Uint8Array(N), queue = new Int32Array(N);
    let qt = 0, qh = 0;
    const push = p => { if (!occ[p] && !seen[p]) { seen[p] = 1; queue[qt++] = p; } };
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) push((k * ny + j) * nx + i);
    }
    while (qh < qt) {
      const p = queue[qh++];
      const i = p % nx, j = ((p / nx) | 0) % ny, k = (p / (nx * ny)) | 0;
      if (i > 0) push(p - 1); if (i < nx - 1) push(p + 1);
      if (j > 0) push(p - nx); if (j < ny - 1) push(p + nx);
      if (k > 0) push(p - nx * ny); if (k < nz - 1) push(p + nx * ny);
    }
    const out = new Uint8Array(N);
    for (let i = 0; i < N; i++) out[i] = occ[i] || !seen[i] ? 1 : 0;
    return out;
  }

  /* Erosão/dilatação com vizinhança 6 */
  function morph3(occ, nx, ny, nz, dilate) {
    const N = nx * ny * nz, out = new Uint8Array(N);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const p = (k * ny + j) * nx + i;
      const nb = [p, i > 0 ? p - 1 : -1, i < nx - 1 ? p + 1 : -1, j > 0 ? p - nx : -1, j < ny - 1 ? p + nx : -1, k > 0 ? p - nx * ny : -2, k < nz - 1 ? p + nx * ny : -1];
      if (dilate) { let v = 0; for (const q of nb) if (q >= 0 && occ[q]) { v = 1; break; } out[p] = v; }
      else {
        /* erosão: fora do volume conta como vazio, exceto o chão (k=0 apoia na prancha) */
        let v = 1; for (const q of nb) { if (q === -2) continue; if (q < 0 || !occ[q]) { v = 0; break; } } out[p] = v;
      }
    }
    return out;
  }

  /* ── Surface Nets ──
     Campo escalar F (nx×ny×nz, já com borda zero), iso. Retorna malha
     com vértices nas coordenadas de amostra (índices). */
  function surfaceNets(F, nx, ny, nz, iso) {
    const cx = nx - 1, cy = ny - 1, cz = nz - 1;
    const cellVert = new Int32Array(cx * cy * cz).fill(-1);
    const pos = [];
    const at = (i, j, k) => F[(k * ny + j) * nx + i];
    const corner = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
    const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    const val = new Float64Array(8);
    for (let k = 0; k < cz; k++) for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
      let mask = 0;
      for (let c = 0; c < 8; c++) { const v = at(i + corner[c][0], j + corner[c][1], k + corner[c][2]); val[c] = v; if (v > iso) mask |= 1 << c; }
      if (mask === 0 || mask === 255) continue;
      let sx = 0, sy = 0, sz = 0, n = 0;
      for (const [a, b] of edges) {
        const ia = (mask >> a) & 1, ib = (mask >> b) & 1;
        if (ia === ib) continue;
        const t = (iso - val[a]) / (val[b] - val[a]);
        sx += corner[a][0] + t * (corner[b][0] - corner[a][0]);
        sy += corner[a][1] + t * (corner[b][1] - corner[a][1]);
        sz += corner[a][2] + t * (corner[b][2] - corner[a][2]);
        n++;
      }
      cellVert[(k * cy + j) * cx + i] = pos.length / 3;
      pos.push(i + sx / n, j + sy / n, k + sz / n);
    }
    const tris = [];
    const cv = (i, j, k) => cellVert[(k * cy + j) * cx + i];
    const P = (v) => [pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]];
    const d2 = (a, b) => { const A = P(a), Bp = P(b); return (A[0] - Bp[0]) ** 2 + (A[1] - Bp[1]) ** 2 + (A[2] - Bp[2]) ** 2; };
    const quad = (a, b, c, d, flip) => {
      if (a < 0 || b < 0 || c < 0 || d < 0) return;
      if (flip) { const t = b; b = d; d = t; }
      if (d2(a, c) <= d2(b, d)) tris.push(a, b, c, a, c, d);
      else tris.push(a, b, d, b, c, d);
    };
    /* Cada aresta da grade com troca de sinal gera um quad ligando as 4
       células que a compartilham (inclusive arestas que partem da borda). */
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const inside = at(i, j, k) > iso;
      const midY = j >= 1 && j <= ny - 2, midZ = k >= 1 && k <= nz - 2, midX = i >= 1 && i <= nx - 2;
      if (i <= nx - 2 && midY && midZ && inside !== (at(i + 1, j, k) > iso))   /* aresta em X: normal ±X */
        quad(cv(i, j - 1, k - 1), cv(i, j, k - 1), cv(i, j, k), cv(i, j - 1, k), !inside);
      if (j <= ny - 2 && midX && midZ && inside !== (at(i, j + 1, k) > iso))   /* aresta em Y: normal ±Y */
        quad(cv(i - 1, j, k - 1), cv(i - 1, j, k), cv(i, j, k), cv(i, j, k - 1), !inside);
      if (k <= nz - 2 && midX && midY && inside !== (at(i, j, k + 1) > iso))   /* aresta em Z: normal ±Z */
        quad(cv(i - 1, j - 1, k), cv(i, j - 1, k), cv(i, j, k), cv(i - 1, j, k), !inside);
    }
    return { positions: Float32Array.from(pos), indices: Uint32Array.from(tris) };
  }

  /* Suavização de Taubin (preserva volume) */
  function taubin(positions, indices, iters, lambda, mu) {
    const nv = positions.length / 3;
    const nbrs = Array.from({ length: nv }, () => new Set());
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t], b = indices[t + 1], c = indices[t + 2];
      nbrs[a].add(b); nbrs[a].add(c); nbrs[b].add(a); nbrs[b].add(c); nbrs[c].add(a); nbrs[c].add(b);
    }
    const adj = nbrs.map(s => Int32Array.from(s));
    const tmp = new Float32Array(positions.length);
    const step = (f) => {
      for (let v = 0; v < nv; v++) {
        const a = adj[v];
        if (!a.length) { tmp[3 * v] = positions[3 * v]; tmp[3 * v + 1] = positions[3 * v + 1]; tmp[3 * v + 2] = positions[3 * v + 2]; continue; }
        let sx = 0, sy = 0, sz = 0;
        for (const u of a) { sx += positions[3 * u]; sy += positions[3 * u + 1]; sz += positions[3 * u + 2]; }
        const n = a.length;
        tmp[3 * v] = positions[3 * v] + f * (sx / n - positions[3 * v]);
        tmp[3 * v + 1] = positions[3 * v + 1] + f * (sy / n - positions[3 * v + 1]);
        tmp[3 * v + 2] = positions[3 * v + 2] + f * (sz / n - positions[3 * v + 2]);
      }
      positions.set(tmp);
    };
    for (let i = 0; i < iters; i++) { step(lambda); step(mu); }
  }

  function computeNormals(positions, indices) {
    const nrm = new Float32Array(positions.length);
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
      const e1 = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
      const e2 = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
      const n = M.cross3(e1, e2);   /* peso = área */
      for (const v of [a, b, c]) { nrm[v] += n[0]; nrm[v + 1] += n[1]; nrm[v + 2] += n[2]; }
    }
    for (let v = 0; v < nrm.length; v += 3) {
      const l = Math.hypot(nrm[v], nrm[v + 1], nrm[v + 2]);
      if (l > 1e-12) { nrm[v] /= l; nrm[v + 1] /= l; nrm[v + 2] /= l; }
      else { nrm[v] = 0; nrm[v + 1] = 0; nrm[v + 2] = 1; }   /* vértice degenerado: normal unitária padrão */
    }
    return nrm;
  }

  /* Volume ocupado → malha em mm (coordenadas da prancha) */
  function meshFromOccupancy(grid) {
    const { occ, nx, ny, nz, vs, vol } = grid;
    const PX = nx + 2, PY = ny + 2, PZ = nz + 2;
    let F = new Float32Array(PX * PY * PZ);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++)
      if (occ[(k * ny + j) * nx + i]) F[((k + 1) * PY + (j + 1)) * PX + (i + 1)] = 1;
    /* desfoque gaussiano separável [1 2 1]/4 (duas passadas) → superfície suave */
    const blur = (src, axis) => {
      const dst = new Float32Array(src.length);
      const st = axis === 0 ? 1 : axis === 1 ? PX : PX * PY;
      const n = axis === 0 ? PX : axis === 1 ? PY : PZ;
      for (let k = 0; k < PZ; k++) for (let j = 0; j < PY; j++) for (let i = 0; i < PX; i++) {
        const p = (k * PY + j) * PX + i, c = axis === 0 ? i : axis === 1 ? j : k;
        const a = c > 0 ? src[p - st] : 0, b = c < n - 1 ? src[p + st] : 0;
        dst[p] = 0.25 * a + 0.5 * src[p] + 0.25 * b;
      }
      return dst;
    };
    for (let pass = 0; pass < 2; pass++) { F = blur(F, 0); F = blur(F, 1); F = blur(F, 2); }
    /* bordas do campo = zero (garante superfície fechada) */
    for (let k = 0; k < PZ; k++) for (let j = 0; j < PY; j++) for (let i = 0; i < PX; i++)
      if (i === 0 || j === 0 || k === 0 || i === PX - 1 || j === PY - 1 || k === PZ - 1) F[(k * PY + j) * PX + i] = 0;
    const mesh = surfaceNets(F, PX, PY, PZ, 0.5);
    const p = mesh.positions;
    for (let v = 0; v < p.length; v += 3) {
      p[v] = vol.xmin + (p[v] - 1 + 0.5) * vs;
      p[v + 1] = vol.ymin + (p[v + 1] - 1 + 0.5) * vs;
      p[v + 2] = Math.max(vol.zmin, vol.zmin + (p[v + 2] - 1 + 0.5) * vs);
    }
    taubin(p, mesh.indices, 3, 0.45, -0.47);
    for (let v = 2; v < p.length; v += 3) if (p[v] < vol.zmin) p[v] = vol.zmin;
    mesh.normals = computeNormals(p, mesh.indices);
    return mesh;
  }

  /* Validação estrutural da malha (antes de visualizar/exportar) */
  function validateMesh(mesh) {
    const errs = [];
    const { positions, indices } = mesh;
    if (!positions || positions.length < 9) errs.push('malha sem vértices');
    if (!indices || indices.length < 3 || indices.length % 3) errs.push('malha sem triângulos válidos');
    const nv = positions ? positions.length / 3 : 0;
    if (positions) for (let i = 0; i < positions.length; i++) if (!isFinite(positions[i])) { errs.push('coordenada inválida (NaN/Infinito)'); break; }
    if (indices) for (let i = 0; i < indices.length; i++) if (indices[i] >= nv) { errs.push('índice de vértice fora do intervalo'); break; }
    /* arestas não-manifold/abertas (informativo) */
    let open = 0;
    if (indices && !errs.length) {
      const edges = new Map();
      for (let t = 0; t < indices.length; t += 3) for (let e = 0; e < 3; e++) {
        const a = indices[t + e], b = indices[t + (e + 1) % 3];
        const key = a < b ? a * nv + b : b * nv + a;
        edges.set(key, (edges.get(key) || 0) + 1);
      }
      for (const c of edges.values()) if (c !== 2) open++;
    }
    return { ok: !errs.length, errors: errs, openEdges: open };
  }

  function bounds(positions) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) for (let a = 0; a < 3; a++) {
      const v = positions[i + a]; if (v < mn[a]) mn[a] = v; if (v > mx[a]) mx[a] = v;
    }
    return { min: mn, max: mx, size: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]] };
  }

  GS3D.recon = { projMatrix, carve, largestComponent, fillCavities, morph3, meshFromOccupancy, surfaceNets, computeNormals, validateMesh, bounds, yieldUI };
})(typeof window !== 'undefined' ? window : globalThis);
