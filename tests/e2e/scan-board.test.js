/* Aba AR com a prancha impressa: detecção, controles, captura automática, modelo 3D,
   visualizador, exportação dos 5 formatos, cancelar processamento e reiniciar */
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = {
  title: 'Scanner 3D com prancha (interface completa)',
  videos: ['scan-board'],
  slow: true,
  timeout: 900000,
  async run(t) {
    const page = await t.launch({ video: 'scan-board' });
    await t.step('abrir câmera', () => t.openCamera(page), page);

    await t.step('detectar prancha', async () => {
      await page.click('#modeAR');
      await page.waitForSelector('#scanPanel:not(.hidden)');
      await page.waitForFunction(() => /Prancha detectada|Afaste|Câmera muito baixa|Mova mais/.test(document.getElementById('scanStatus').textContent), null, { timeout: 30000 });
      t.check('prancha detectada; painel de efeitos oculto', await page.evaluate(() => document.getElementById('fxPanel').classList.contains('hidden')));
    }, page);

    await t.step('controles', async () => {
      await page.click('#scanStartBtn'); await page.waitForTimeout(1500);
      await page.click('#scanPauseBtn'); const paused = await page.evaluate(() => Scan3D.state);
      await page.click('#scanStartBtn'); const resumed = await page.evaluate(() => Scan3D.state);
      await page.click('#scanCancelBtn'); const cancelled = await page.evaluate(() => [Scan3D.state, Scan3D._debug.keyframes.length]);
      t.check('pausar → retomar → cancelar', paused === 'paused' && resumed === 'scanning' && cancelled[1] === 0, { paused, resumed, cancelled });
      await page.click('#scanStartBtn');
    }, page);

    await t.step('captura automática', async () => {
      await page.waitForFunction(() => document.getElementById('scanProgressBar').style.width === '100%' || Scan3D._debug.keyframes.length >= 30, null, { timeout: 600000, polling: 2000 });
      const n = await page.evaluate(() => Scan3D._debug.keyframes.length);
      t.check('vistas capturadas automaticamente', n >= 12, n);
    }, page);

    await t.step('gerar modelo', async () => {
      await page.click('#scanBuildBtn');
      await page.waitForSelector('#scanScreen:not(.screen-hidden)', { timeout: 600000 });
      await page.waitForTimeout(1500);
      const st = await page.evaluate(() => Scan3D._debug.result.stats);
      t.check('modelo com malha fechada e textura', st.triangles > 1000 && st.openEdges === 0 && st.coverage > 0.5, st);
      const dims = st.sizeMm.slice().sort((a, b) => a - b);
      t.check('dimensões coerentes com a caneca (50×50×98 mm)', dims[0] > 44 && dims[1] < 70 && dims[2] > 90 && dims[2] < 135, dims.map(v => v.toFixed(0)).join('×'));
      await t.shot(page, '01_modelo3d.png');
    }, page);

    for (const fmt of ['glb', 'gltf', 'obj', 'fbx', 'stl']) {
      await t.step('exportar ' + fmt, async () => {
        await page.check(`input[name="exportFmt"][value="${fmt}"]`);
        const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#exportBtn')]);
        const file = path.join(t.outDir, dl.suggestedFilename()); await dl.saveAs(file);
        t.check(`arquivo ${fmt.toUpperCase()} baixado`, fs.statSync(file).size > 10000, dl.suggestedFilename() + ' ' + fs.statSync(file).size + ' bytes');
      }, page);
    }

    await t.step('escanear de novo e cancelar processamento', async () => {
      await page.click('text=Escanear novamente');
      await page.waitForSelector('#cameraScreen:not(.screen-hidden)');
      /* continua escaneando até haver cobertura suficiente para gerar */
      await page.waitForFunction(() => !document.getElementById('scanBuildBtn').disabled, null, { timeout: 400000, polling: 1000 });
      await page.click('#scanPauseBtn');
      const n = await page.evaluate(() => Scan3D._debug.keyframes.length);
      await page.click('#scanBuildBtn'); await page.click('#scanProcCancel');
      await page.waitForFunction(() => Scan3D.state !== 'processing', null, { timeout: 120000 });
      const after = await page.evaluate(() => ({ n: Scan3D._debug.keyframes.length, state: Scan3D.state, overlay: document.getElementById('scanProc').classList.contains('hidden') }));
      t.check('cancelar o processamento mantém as vistas', after.n === n && after.overlay, { antes: n, depois: after });
    }, page);
    t.noPageErrors(page);
  }
};
