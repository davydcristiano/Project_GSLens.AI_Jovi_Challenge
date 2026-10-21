/* ═══════════════════════════════════════════════════
   GSLens.AI — Scanner 3D · pipeline.js
   Quadros-chave → modelo 3D texturizado:
   1. calibração (distância focal) + poses refinadas
   2. silhuetas (segmentação contra a prancha conhecida)
   3. esculpimento volumétrico + limpeza
   4. superfície (Surface Nets) + suavização
   5. textura (atlas) a partir das fotos
═══════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const GS3D = root.GS3D = root.GS3D || {};
  const M = GS3D.math;

  function abortIf(isCancelled) { if (isCancelled && isCancelled()) throw new DOMException('cancelado', 'AbortError'); }

  /* Calibração: f a partir das homografias + refino por erro de reprojeção */
  function calibrate(kfs, fGuess) {
    const w = kfs[0].w, h = kfs[0].h, maxDim = Math.max(w, h);
    const est = M.estimateFocal(kfs.map(k => k.det.H), (w - 1) / 2, (h - 1) / 2);
    let f0 = est && est.f > 0.45 * maxDim && est.f < 3 * maxDim ? est.f : (fGuess || 0.82 * maxDim);
    const totalErr = (f) => {
      const K = M.kForImage(f, w, h);
      let s = 0, n = 0;
      for (const kf of kfs) {
        const p0 = M.poseFromHomography(kf.det.H, K);
        if (!p0) return Infinity;
        const r = M.refinePose(K, p0.R, p0.t, kf.det.obj, kf.det.img, 6);
        s += r.rms * r.rms * kf.det.obj.length; n += kf.det.obj.length;
      }
      return s / n;
    };
    const f = M.goldenMin(totalErr, 0.75 * f0, 1.3 * f0, 22);
    const K = M.kForImage(f, w, h);
    const poses = kfs.map(kf => {
      const p0 = M.poseFromHomography(kf.det.H, K);
      const r = M.refinePose(K, p0.R, p0.t, kf.det.obj, kf.det.img, 15);
      return { K, R: r.R, t: r.t, rms: r.rms, C: M.cameraCenter(r.R, r.t) };
    });
    return { f, K, poses, fLinear: est ? est.f : null };
  }

  /* opts: { resolution, maxTexture } ; stage(name, frac) */
  async function buildModel(keyframes, opts, stage, isCancelled) {
    opts = opts || {};
    const st = (s, f, extra) => { if (stage) stage(s, f, extra); };
    const warnings = [];
    if (!keyframes || keyframes.length < 6) throw new Error('São necessárias pelo menos 6 vistas da prancha para reconstruir o objeto.');

    /* 1) Calibração */
    st('calib', 0);
    await GS3D.recon.yieldUI();
    const cal = calibrate(keyframes, opts.fGuess);
    abortIf(isCancelled);
    const views = [];
    keyframes.forEach((kf, i) => {
      const p = cal.poses[i];
      if (p.rms > 2.5) return;                       /* vista com rastreamento ruim */
      views.push(Object.assign({ rgba: kf.rgba, w: kf.w, h: kf.h, H: kf.det.H }, p));
    });
    const dropped = keyframes.length - views.length;
    if (dropped) warnings.push(dropped + ' vista(s) descartada(s) por rastreamento impreciso.');
    if (views.length < 6) throw new Error('Rastreamento impreciso em muitas vistas. Ilumine melhor a prancha e evite movimentos rápidos.');
    const rms = Math.sqrt(views.reduce((s, v) => s + v.rms * v.rms, 0) / views.length);
    st('calib', 1, { f: cal.f, rms });

    /* 2) Silhuetas */
    const segViews = [];
    for (let i = 0; i < views.length; i++) {
      abortIf(isCancelled);
      const v = views[i];
      const seg = GS3D.segment(v);
      if (seg.mask) {
        v.mask = seg.mask; v.paperL0 = seg.paperL0; v.objFrac = seg.nObj / (v.w * v.h);
        segViews.push(v);
      }
      st('segment', (i + 1) / views.length);
      await GS3D.recon.yieldUI();
    }
    if (segViews.length < 6) throw new Error('A prancha ficou pouco visível nas fotos. Enquadre a folha inteira durante o escaneamento.');
    const noObj = segViews.filter(v => v.objFrac < 0.002).length;
    if (noObj > segViews.length / 2) throw new Error('Nenhum objeto foi detectado sobre a prancha. Coloque o objeto dentro do quadrado central (ele precisa contrastar com o papel branco).');
    /* compensação de exposição entre vistas (pela luminância do papel) */
    const refL = M.median(segViews.map(v => v.paperL0).filter(x => x > 0));
    for (const v of segViews) v.gain = v.paperL0 > 0 ? Math.max(0.6, Math.min(1.6, refL / v.paperL0)) : 1;

    /* 3) Esculpimento */
    const vol = GS3D.board.VOLUME;
    const res = opts.resolution || 96;
    const carveViews = segViews.map(v => ({ P: GS3D.recon.projMatrix(v.K, v.R, v.t), w: v.w, h: v.h, mask: v.mask }));
    const grid = await GS3D.recon.carve(carveViews, vol, res, f => st('carve', f * 0.85), isCancelled, opts.tolerance);
    abortIf(isCancelled);
    if (!grid.count) throw new Error('Nenhum volume consistente foi encontrado. Verifique se o objeto está dentro do quadrado e escaneie de vários ângulos.');
    let { occ } = grid;
    const { nx, ny, nz } = grid;
    occ = GS3D.recon.largestComponent(occ, nx, ny, nz).occ;
    occ = GS3D.recon.morph3(GS3D.recon.morph3(occ, nx, ny, nz, false), nx, ny, nz, true);   /* abertura: remove "saias" de sombra */
    const lcc = GS3D.recon.largestComponent(occ, nx, ny, nz);
    occ = GS3D.recon.fillCavities(lcc.occ, nx, ny, nz);
    if (lcc.size < 30) throw new Error('O volume reconstruído ficou pequeno demais. Aproxime a câmera e garanta contraste entre objeto e papel.');
    /* toque nas paredes/teto do volume: objeto maior que a área útil? */
    let wall = 0, tot = 0;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      if (!occ[(k * ny + j) * nx + i]) continue;
      tot++;
      if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) wall++;
    }
    if (wall > 0.01 * tot) warnings.push('O objeto parece ultrapassar a área útil (11 × 11 × 11 cm) — partes podem ter sido cortadas.');
    st('carve', 1);
    await GS3D.recon.yieldUI();

    /* 4) Superfície */
    abortIf(isCancelled);
    st('mesh', 0);
    await GS3D.recon.yieldUI();
    const mesh = GS3D.recon.meshFromOccupancy(Object.assign({}, grid, { occ }));
    const val = GS3D.recon.validateMesh(mesh);
    if (!val.ok) throw new Error('A malha gerada é inválida: ' + val.errors.join(', '));
    st('mesh', 1);

    /* 5) Textura */
    const tex = await GS3D.texture.bake(mesh, segViews, { maxSize: opts.maxTexture || 2048 }, f => st('texture', f), isCancelled);
    abortIf(isCancelled);
    if (tex.coverage < 0.6) warnings.push('Parte da superfície não foi vista por nenhuma foto (' + Math.round((1 - tex.coverage) * 100) + '%) e ficou com cor neutra.');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = tex.size;
    canvas.getContext('2d').putImageData(new ImageData(tex.atlas, tex.size, tex.size), 0, 0);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    if (!blob) throw new Error('Não foi possível codificar a textura (PNG).');
    const png = new Uint8Array(await blob.arrayBuffer());
    const bounds = GS3D.recon.bounds(mesh.positions);
    st('done', 1);
    return {
      positions: mesh.positions, indices: mesh.indices, normals: mesh.normals, uvs: tex.uvs,
      png, textureCanvas: canvas, textureSize: tex.size,
      stats: {
        views: segViews.length, captured: keyframes.length, focalPx: cal.f, reprojRms: rms,
        vertices: mesh.positions.length / 3, triangles: mesh.indices.length / 3,
        sizeMm: bounds.size, voxelMm: grid.vs, coverage: tex.coverage, openEdges: val.openEdges
      },
      warnings
    };
  }

  GS3D.pipeline = { buildModel, calibrate };
})(typeof window !== 'undefined' ? window : globalThis);
