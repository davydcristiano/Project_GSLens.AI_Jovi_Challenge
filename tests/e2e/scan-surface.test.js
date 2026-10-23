/* Aba AR, modo SEM prancha: fotografar a mesa vazia, rastrear a mesa,
   captura automática, modelo 3D, correção de escala e exportação */
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = {
  title: 'Scanner 3D sem prancha (interface completa)',
  videos: ['scan-surface'],
  slow: true,
  timeout: 1200000,
  async run(t) {
    const page = await t.launch({ video: 'scan-surface' });
    await t.step('abrir câmera', () => t.openCamera(page), page);

    await t.step('modo sem prancha', async () => {
      await page.click('#modeAR');
      await page.waitForSelector('#scanPanel:not(.hidden)');
      await page.click('.scan-mode-opt[data-mode="surface"]');
      const st = await page.evaluate(() => ({ mode: Scan3D.mode, start: document.getElementById('scanStartBtn').disabled, ref: !document.getElementById('scanRefBtn').disabled, board: getComputedStyle(document.querySelector('.scan-link.board-only')).display }));
      t.check('"Iniciar" bloqueado até fotografar a mesa', st.mode === 'surface' && st.start && st.ref, st);
      t.check('link da prancha oculto no modo sem prancha', st.board === 'none');
    }, page);

    await t.step('fotografar mesa vazia', async () => {
      /* o vídeo mostra a mesa vazia nos primeiros 10 s */
      await page.click('#scanRefBtn');
      await page.waitForFunction(() => /Mesa registrada/.test(document.getElementById('scanStatus').textContent), null, { timeout: 15000 });
      t.check('mesa registrada e "Iniciar" liberado', await page.evaluate(() => !document.getElementById('scanStartBtn').disabled));
      await page.waitForTimeout(1500);
      t.check('mesa rastreada ao vivo (pose da câmera)', await page.evaluate(() => !!Scan3D._debug.lastPose));
      await t.shot(page, '01_mesa_registrada.png');
    }, page);

    await t.step('escanear', async () => {
      /* espera o objeto aparecer no vídeo antes de iniciar */
      await page.waitForTimeout(9000);
      await page.click('#scanStartBtn');
      await page.waitForFunction(() => document.getElementById('scanProgressBar').style.width === '100%' || Scan3D._debug.keyframes.length >= 30, null, { timeout: 600000, polling: 2000 });
      const n = await page.evaluate(() => Scan3D._debug.keyframes.length);
      t.check('vistas capturadas automaticamente', n >= 12, n);
      await t.shot(page, '02_escaneando.png');
    }, page);

    await t.step('gerar modelo', async () => {
      await page.waitForFunction(() => !document.getElementById('scanBuildBtn').disabled, null, { timeout: 120000 });
      await page.click('#scanBuildBtn');
      await page.waitForSelector('#scanScreen:not(.screen-hidden)', { timeout: 600000 });
      await page.waitForTimeout(1500);
      const st = await page.evaluate(() => Scan3D._debug.result.stats);
      t.check('modelo com malha fechada e textura', st.triangles > 1000 && st.openEdges === 0 && st.coverage > 0.5, { tri: st.triangles, cobertura: +st.coverage.toFixed(2), focal: +st.focalPx.toFixed(1) });
      const dims = st.sizeMm.slice().sort((a, b) => a - b);
      t.check('dimensões coerentes com a caneca (50×50×98 mm, escala aproximada)', dims[0] > 44 && dims[1] < 70 && dims[2] > 88 && dims[2] < 135, dims.map(v => v.toFixed(0)).join('×'));
      t.check('focal autocalibrada ≈ 760 px (erro < 3%)', Math.abs(st.focalPx / 760 - 1) < 0.03, st.focalPx.toFixed(1));
      t.check('aviso de escala aproximada e campo de correção', await page.evaluate(() => !document.getElementById('scaleFix').classList.contains('hidden') && /aproximada/.test(document.getElementById('scanStats').textContent)));
      await t.shot(page, '03_modelo3d.png');
    }, page);

    await t.step('corrigir escala com medida real', async () => {
      await page.selectOption('#scaleAxis', '2');
      await page.fill('#scaleValue', '98');
      await page.click('.scale-fix button');
      const z = await page.evaluate(() => Scan3D._debug.result.stats.sizeMm[2]);
      t.check('altura do modelo = 98 mm após a correção', Math.abs(z - 98) < 0.01, z.toFixed(2));
      await page.check('input[name="exportFmt"][value="stl"]');
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#exportBtn')]);
      const file = path.join(t.outDir, dl.suggestedFilename()); await dl.saveAs(file);
      /* STL binário em mm: confere a altura (Z) lida do arquivo */
      const b = fs.readFileSync(file), n = b.readUInt32LE(80);
      let zmin = Infinity, zmax = -Infinity;
      for (let i = 0; i < n; i++) for (let v = 0; v < 3; v++) { const zz = b.readFloatLE(84 + i * 50 + 12 + v * 12 + 8); if (zz < zmin) zmin = zz; if (zz > zmax) zmax = zz; }
      t.check('STL exportado com a escala corrigida', Math.abs((zmax - zmin) - 98) < 0.5, (zmax - zmin).toFixed(2) + ' mm');
    }, page);
    t.noPageErrors(page);
  }
};
