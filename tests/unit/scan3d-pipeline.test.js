/* Pipeline do scanner 3D com imagens sintéticas de pose conhecida:
   calibração, reconstrução, textura e exportação (relidas por carregadores
   independentes do three.js + validador Python dos formatos). */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

module.exports = {
  title: 'Scanner 3D: pipeline completo e exportações (GLB, glTF, OBJ, FBX, STL)',
  timeout: 300000,
  async run(t) {
    const page = await t.launch();
    for (const obj of ['box', 'mug']) {
      await page.goto(t.url(`tests/unit/pipeline.html?obj=${obj}`));
      await page.waitForFunction(() => window.__result !== undefined, null, { timeout: 240000 });
      const r = await page.evaluate(() => window.__result);
      if (!t.check(`[${obj}] pipeline sem erro`, !r.error, r.error && r.error.split('\n')[0])) continue;
      t.check(`[${obj}] vistas com prancha detectada ≥ 20/24`, r.keyframes >= 20, r.keyframes);
      t.check(`[${obj}] focal estimada com erro < 3%`, Math.abs(r.focalErrPct) < 3, r.focalErrPct + '%');
      const dims = r.stats && r.stats.sizeMm;
      if (dims) {
        const truth = r.truth.dims.slice().sort((a, b) => a - b), got = dims.slice().sort((a, b) => a - b);
        const errs = got.map((g, i) => g / truth[i] - 1);
        /* reconstrução por silhuetas: medidas nunca menores que o real; topo/cantos crescem um pouco */
        t.check(`[${obj}] dimensões do modelo dentro de −8%/+35% do real`, errs.every(e => e > -0.08 && e < 0.35), got.map(v => v.toFixed(0)).join('×') + ' mm (real ' + truth.join('×') + ')');
      }
      const ex = r.exports || {};
      t.check(`[${obj}] GLB relido com textura`, ex.glb && ex.glb.tris > 100 && ex.glb.hasMap, ex.glb);
      t.check(`[${obj}] OBJ relido com UV`, ex.obj && ex.obj.tris > 100 && ex.obj.hasUV);
      t.check(`[${obj}] STL relido`, ex.stl && ex.stl.tris > 100);
      t.check(`[${obj}] FBX relido com textura`, ex.fbx && ex.fbx.tris > 100 && ex.fbx.hasMap);
      t.check(`[${obj}] glTF em ZIP com .gltf/.bin/.png`, ex.gltfZip && ['.gltf:', '.bin:', '.png:'].every(e => ex.gltfZip.files.some(f => f.includes(e))), ex.gltfZip && ex.gltfZip.files);
      if (obj === 'box') {
        /* grava os arquivos e valida bit a bit com o validador independente */
        const dir = path.join(t.outDir, 'exportados'); fs.mkdirSync(dir, { recursive: true });
        const files = await page.evaluate(() => Object.fromEntries(Object.entries(window.__exports).map(([k, v]) => {
          let s = ''; for (let i = 0; i < v.length; i += 32768) s += String.fromCharCode.apply(null, v.subarray(i, i + 32768));
          return [k, btoa(s)];
        })));
        const ext = { glb: 'glb', stl: 'stl', fbx: 'fbx', objzip: 'obj.zip', gltfzip: 'gltf.zip' };
        for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'modelo.' + ext[k]), Buffer.from(v, 'base64'));
        let out = null;
        try { out = execFileSync('python3', ['-I', path.join(__dirname, '..', 'lib', 'validate_exports.py'), dir], { encoding: 'utf8' }); }
        catch (e) { out = e.stdout || null; if (!out) console.log('   (validador Python indisponível — precisa de python3 + numpy; etapa pulada)'); }
        if (out) {
          const lines = out.split('\n').filter(l => /^(PASS|FAIL) /.test(l));
          const fails = lines.filter(l => l.startsWith('FAIL'));
          t.check('validador independente dos formatos', lines.length > 20 && !fails.length, fails.length ? fails.join(' | ') : lines.length + ' verificações');
        }
      }
    }
    t.noPageErrors(page);
  }
};
