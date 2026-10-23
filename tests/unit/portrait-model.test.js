/* Modelo de segmentação de pessoas (Retrato): executor TFLite próprio × MediaPipe oficial */
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = {
  title: 'Retrato: segmentação de pessoas comparada ao MediaPipe oficial',
  timeout: 240000,
  async run(t) {
    const page = await t.launch();
    await page.goto(t.url('tests/unit/portrait.html'));
    await page.waitForFunction(() => window.__result !== undefined, null, { timeout: 200000 });
    const r = await page.evaluate(() => window.__result);
    if (!t.check('execução sem erro', !r.error, r.error && r.error.split('\n')[0])) return;
    t.check('pixels de referência suficientes', r.pixelsFundo > 50000 && r.pixelsPessoa > 5000, { fundo: r.pixelsFundo, pessoa: r.pixelsPessoa });
    t.check('fundo do MediaPipe: < 3% marcado como pessoa', r.falsoPositivoFundo < 0.03, (r.falsoPositivoFundo * 100).toFixed(2) + '%');
    t.check('pessoa do MediaPipe (interior): > 97% marcada como pessoa', r.acertoPessoa > 0.97, (r.acertoPessoa * 100).toFixed(2) + '% (incluindo a faixa de borda: ' + (r.acertoComBordas * 100).toFixed(1) + '%)');
    t.check('inferência roda num Worker (fora da interface)', r.worker);
    console.log('   (tempo médio por inferência: ' + r.msMedio + ' ms)');
    const img = await page.evaluate(() => window.__debugImg);
    if (img) fs.writeFileSync(path.join(t.outDir, 'mascara.png'), Buffer.from(img.split(',')[1], 'base64'));
    const fp = await page.evaluate(() => window.__fpImg);
    if (fp) fs.writeFileSync(path.join(t.outDir, 'diagnostico.png'), Buffer.from(fp.split(',')[1], 'base64'));
    t.noPageErrors(page);
  }
};
