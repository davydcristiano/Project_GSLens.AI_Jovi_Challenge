/* Unitários (Node): pose a partir de homografia, focal, malha a partir de voxels */
'use strict';
const path = require('path');
const JS = path.resolve(__dirname, '..', '..', 'js', 'scan3d');

module.exports = {
  title: 'Matemática do scanner 3D (pose, focal, malha)',
  async run(t) {
    require(path.join(JS, 'math.js'));
    require(path.join(JS, 'reconstruct.js'));
    const M = globalThis.GS3D.math, R = globalThis.GS3D.recon;
    let seed = 7; const rnd = (a, b) => { seed = (seed * 1664525 + 1013904223) >>> 0; return a + (seed / 4294967296) * (b - a); };
    const makePose = (azDeg, elDeg, dist, target = [0, 0, 30], roll = 0) => {
      const az = azDeg * Math.PI / 180, el = elDeg * Math.PI / 180;
      const C = [target[0] + dist * Math.cos(el) * Math.cos(az), target[1] + dist * Math.cos(el) * Math.sin(az), target[2] + dist * Math.sin(el)];
      const zc = M.normalize3([target[0] - C[0], target[1] - C[1], target[2] - C[2]]);
      let xc = M.normalize3(M.cross3(zc, [0, 0, 1])); let yc = M.cross3(zc, xc);
      if (roll) { const c = Math.cos(roll), s = Math.sin(roll); const x2 = xc.map((v, i) => c * v + s * yc[i]); const y2 = yc.map((v, i) => -s * xc[i] + c * v); xc = x2; yc = y2; }
      const Rm = [...xc, ...yc, ...zc]; return { R: Rm, t: M.mul3v(Rm, C).map(v => -v), C };
    };

    /* 1. pose a partir de homografia + refino (pontos com ruído de 0,3 px) */
    const K = M.makeK(900, 640, 360);
    let maxT = 0, maxRot = 0;
    for (let k = 0; k < 20; k++) {
      const p = makePose(rnd(0, 360), rnd(25, 75), rnd(300, 500));
      const obj = [], img = [];
      for (let x = -90; x <= 90; x += 30) for (let y = -130; y <= 130; y += 40) { obj.push([x, y, 0]); const q = M.project(K, p.R, p.t, [x, y, 0]); img.push([q[0] + rnd(-.3, .3), q[1] + rnd(-.3, .3)]); }
      const H = M.homographyDLT(obj.map(o => [o[0], o[1]]), img);
      const pose = M.poseFromHomography(H, K), ref = M.refinePose(K, pose.R, pose.t, obj, img);
      const C2 = M.cameraCenter(ref.R, ref.t);
      maxT = Math.max(maxT, Math.hypot(C2[0] - p.C[0], C2[1] - p.C[1], C2[2] - p.C[2]));
      for (let i = 0; i < 9; i++) maxRot = Math.max(maxRot, Math.abs(ref.R[i] - p.R[i]));
    }
    t.check('pose: erro do centro da câmera < 2 mm', maxT < 2, maxT.toFixed(3) + ' mm');
    t.check('pose: erro de rotação < 0,005', maxRot < 0.005, maxRot.toExponential(2));

    /* 2. distância focal estimada só pelas vistas */
    const w = 960, h = 540, f = 760, Kf = M.kForImage(f, w, h), Hs = [];
    for (let i = 0; i < 24; i++) { const p = makePose(i * 15, i % 2 ? 40 : 62, 380 + (i % 3) * 25, [0, 0, 25], (i % 4 - 1.5) * 0.08); Hs.push(M.mul3(Kf, [p.R[0], p.R[1], p.t[0], p.R[3], p.R[4], p.t[1], p.R[6], p.R[7], p.t[2]])); }
    const fe = M.estimateFocal(Hs, (w - 1) / 2, (h - 1) / 2);
    t.check('focal estimada com erro < 1%', Math.abs(fe.f / f - 1) < 0.01, fe.f.toFixed(1) + ' px (real 760)');

    /* 3. malha fechada a partir de voxels (caixa 60×40×50 mm) */
    const vol = { xmin: -55, xmax: 55, ymin: -55, ymax: 55, zmin: 0, zmax: 110 }, res = 96, vs = 110 / res;
    const occ = new Uint8Array(res * res * res);
    for (let k = 0; k < res; k++) for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
      const x = vol.xmin + (i + .5) * vs, y = vol.ymin + (j + .5) * vs, z = (k + .5) * vs;
      if (Math.abs(x) < 30 && Math.abs(y) < 20 && z < 50) occ[(k * res + j) * res + i] = 1;
    }
    const mesh = R.meshFromOccupancy({ occ, nx: res, ny: res, nz: res, vs, vol });
    const val = R.validateMesh(mesh);
    t.check('malha válida e fechada', val.ok && val.openEdges === 0, val);
    let V = 0; const p = mesh.positions, I = mesh.indices;
    for (let k = 0; k < I.length; k += 3) { const a = I[k] * 3, b = I[k + 1] * 3, c = I[k + 2] * 3; V += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6; }
    t.check('volume da malha ≈ volume real (±12%)', Math.abs(V / 120000 - 1) < 0.12, V.toFixed(0) + ' mm³ (real 120000)');
  }
};
