/* ═══════════════════════════════════════════════════
   GSLens.AI — Scanner 3D · tracker.js
   Rastreamento óptico da prancha:
   1) detecção dos marcadores ArUco (js-aruco2)
   2) refinamento subpixel dos cantos (ajuste de retas às bordas)
   3) homografia prancha→imagem com rejeição de marcadores ruins
   4) pose 6DoF da câmera (R,t) dado K
═══════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const GS3D = root.GS3D = root.GS3D || {};
  const M = GS3D.math, B = GS3D.board;

  function Tracker() {
    if (!root.AR || !root.AR.Detector) throw new Error('Biblioteca de marcadores (js-aruco2) não carregada.');
    /* Hamming máx. 5: o dicionário 36h12 tem distância mínima 12, então
       5 erros ainda identificam o código sem ambiguidade. */
    this.detector = new root.AR.Detector({ dictionaryName: B.DICT, maxHammingDistance: 5 });
  }

  /* Amostra bilinear de imagem em tons de cinza (CV.Image) */
  function grayAt(g, x, y) {
    const w = g.width, h = g.height;
    if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return -1;
    const x0 = x | 0, y0 = y | 0, ax = x - x0, ay = y - y0, d = g.data, i = y0 * w + x0;
    return (d[i] * (1 - ax) + d[i + 1] * ax) * (1 - ay) + (d[i + w] * (1 - ax) + d[i + w + 1] * ax) * ay;
  }

  /* Ajuste de reta por mínimos quadrados totais: retorna {p (ponto), d (direção)} */
  function fitLine(pts) {
    let mx = 0, my = 0;
    for (const p of pts) { mx += p[0]; my += p[1]; }
    mx /= pts.length; my /= pts.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of pts) { const dx = p[0] - mx, dy = p[1] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { p: [mx, my], d: [Math.cos(ang), Math.sin(ang)] };
  }
  function intersect(l1, l2) {
    const det = l1.d[0] * l2.d[1] - l1.d[1] * l2.d[0];
    if (Math.abs(det) < 1e-9) return null;
    const dx = l2.p[0] - l1.p[0], dy = l2.p[1] - l1.p[1];
    const s = (dx * l2.d[1] - dy * l2.d[0]) / det;
    return [l1.p[0] + s * l1.d[0], l1.p[1] + s * l1.d[1]];
  }

  /* Refina os 4 cantos de um marcador localizando a borda externa
     (preto→branco, de dentro para fora) com precisão subpixel. */
  function refineCorners(gray, corners, cells) {
    const c = corners.map(p => [p.x, p.y]);
    const cxm = (c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4, cym = (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4;
    const lines = [];
    for (let s = 0; s < 4; s++) {
      const a = c[s], b = c[(s + 1) % 4];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 8) return c;
      const dir = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
      let nrm = [-dir[1], dir[0]];
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if ((mid[0] - cxm) * nrm[0] + (mid[1] - cym) * nrm[1] < 0) nrm = [-nrm[0], -nrm[1]];   /* aponta para fora */
      const cellPx = L / cells;
      const range = Math.max(1.5, Math.min(3.5, 0.45 * cellPx));
      const nS = Math.max(6, Math.min(40, Math.round(L / 2)));
      const pts = [];
      for (let k = 0; k < nS; k++) {
        const tt = 0.12 + 0.76 * (k / (nS - 1));
        const px = a[0] + (b[0] - a[0]) * tt, py = a[1] + (b[1] - a[1]) * tt;
        let best = 0, bestD = 0, prof = [];
        const step = 0.5;
        for (let d = -range - step; d <= range + step + 1e-9; d += step) prof.push(grayAt(gray, px + nrm[0] * d, py + nrm[1] * d));
        if (prof.some(v => v < 0)) continue;
        let bi = -1;
        for (let i = 1; i < prof.length - 1; i++) {
          const gr = prof[i + 1] - prof[i - 1];            /* derivada para fora */
          if (gr > best) { best = gr; bi = i; }
        }
        if (bi < 2 || bi >= prof.length - 2 || best < 12) continue;
        const g0 = prof[bi] - prof[bi - 2], g1 = best, g2 = prof[bi + 2] - prof[bi];
        const den = g0 - 2 * g1 + g2;
        const off = Math.abs(den) > 1e-9 ? 0.5 * (g0 - g2) / den : 0;
        bestD = (-range - step) + (bi + Math.max(-0.5, Math.min(0.5, off))) * step;
        pts.push([px + nrm[0] * bestD, py + nrm[1] * bestD]);
      }
      if (pts.length < 4) return c;
      let line = fitLine(pts);
      /* uma passada de rejeição de pontos distantes */
      const dist = p => Math.abs((p[0] - line.p[0]) * line.d[1] - (p[1] - line.p[1]) * line.d[0]);
      const inl = pts.filter(p => dist(p) < 0.8);
      if (inl.length >= 4) line = fitLine(inl);
      lines.push(line);
    }
    const out = [];
    for (let s = 0; s < 4; s++) {
      const p = intersect(lines[(s + 3) % 4], lines[s]);
      if (!p || Math.hypot(p[0] - c[s][0], p[1] - c[s][1]) > 4) return c;
      out.push(p);
    }
    return out;
  }

  /* Detecta a prancha numa ImageData. Retorna null se não houver marcadores suficientes. */
  Tracker.prototype.detect = function (imageData, opts) {
    opts = opts || {};
    const raw = this.detector.detect(imageData);
    const cells = this.detector.dictionary.markSize;
    const found = [];
    const seen = new Set();
    for (const mk of raw) {
      const def = B.markerById.get(mk.id);
      if (!def || seen.has(mk.id)) continue;   /* ignora ids fora da prancha / duplicados */
      seen.add(mk.id);
      const img = opts.refine === false ? mk.corners.map(p => [p.x, p.y]) : refineCorners(this.detector.grey, mk.corners, cells);
      found.push({ id: mk.id, img, obj: def.corners });
    }
    if (found.length < (opts.minMarkers || 3)) return { ok: false, markers: found };

    /* Homografia robusta: remove iterativamente o marcador com maior erro */
    let use = found.slice(), H = null, perMarker = [];
    for (let round = 0; round < 4; round++) {
      const src = [], dst = [];
      for (const m of use) for (let k = 0; k < 4; k++) { src.push(m.obj[k]); dst.push(m.img[k]); }
      H = M.homographyDLT(src, dst);
      if (!H) return { ok: false, markers: found };
      perMarker = use.map(m => {
        let e = 0;
        for (let k = 0; k < 4; k++) { const q = M.applyH(H, m.obj[k][0], m.obj[k][1]); e += Math.hypot(q[0] - m.img[k][0], q[1] - m.img[k][1]); }
        return e / 4;
      });
      let wi = 0;
      for (let i = 1; i < perMarker.length; i++) if (perMarker[i] > perMarker[wi]) wi = i;
      const thr = Math.max(2.5, 3 * M.median(perMarker));
      if (perMarker[wi] > thr && use.length > 3) use.splice(wi, 1); else break;
    }
    const obj = [], img = [];
    for (const m of use) for (let k = 0; k < 4; k++) { obj.push([m.obj[k][0], m.obj[k][1], 0]); img.push(m.img[k]); }
    return { ok: true, markers: found, used: use, H, obj, img, width: imageData.width, height: imageData.height, meanErr: perMarker.reduce((a, b) => a + b, 0) / perMarker.length };
  };

  /* Pose a partir de uma detecção e K */
  function solvePose(det, K) {
    const p0 = M.poseFromHomography(det.H, K);
    if (!p0) return null;
    const r = M.refinePose(K, p0.R, p0.t, det.obj, det.img, 10);
    const C = M.cameraCenter(r.R, r.t);
    return { R: r.R, t: r.t, rms: r.rms, C };
  }

  /* Variância do Laplaciano (nitidez) numa região central reduzida */
  function sharpness(gray) {
    const w = gray.width, h = gray.height, d = gray.data;
    const step = Math.max(1, Math.round(Math.min(w, h) / 240));
    let s = 0, s2 = 0, n = 0;
    for (let y = step; y < h - step; y += step) {
      for (let x = step; x < w - step; x += step) {
        const i = y * w + x;
        const v = 4 * d[i] - d[i - step] - d[i + step] - d[i - step * w] - d[i + step * w];
        s += v; s2 += v * v; n++;
      }
    }
    if (!n) return 0;
    const m = s / n;
    return s2 / n - m * m;
  }

  GS3D.Tracker = Tracker;
  GS3D.tracking = { solvePose, sharpness, refineCorners };
})(typeof window !== 'undefined' ? window : globalThis);
