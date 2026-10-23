/* Modo Retrato: segmentação ao vivo, fundo desfocado na prévia e na foto,
   intensidade ajustável, e nenhum desfoque quando não há pessoa */
'use strict';
const fs = require('fs');
const path = require('path');

/* nitidez de uma região: média do |laplaciano| da luminância (regiões em fração da imagem) */
const SHARP = `(src, regions) => {
  const W = 640, H = 360, c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(src, 0, 0, W, H);
  const d = x.getImageData(0, 0, W, H).data, L = i => d[i * 4] * .299 + d[i * 4 + 1] * .587 + d[i * 4 + 2] * .114;
  return regions.map(([x0, y0, x1, y1]) => { let s = 0, n = 0;
    for (let y = Math.round(y0 * H) + 1; y < Math.round(y1 * H) - 1; y++) for (let xx = Math.round(x0 * W) + 1; xx < Math.round(x1 * W) - 1; xx++) {
      const i = y * W + xx; s += Math.abs(4 * L(i) - L(i - 1) - L(i + 1) - L(i - W) - L(i + W)); n++; }
    return s / n; });
}`;
const BG = [0.03, 0.12, 0.24, 0.55];     /* fundo: casa à esquerda (a pessoa nunca passa ali) */
const FACE = [0.43, 0.12, 0.58, 0.42];   /* rosto */

module.exports = {
  title: 'Modo Retrato (IA local): prévia, foto, intensidade e cena sem pessoa',
  videos: ['portrait', 'links'],
  timeout: 300000,
  async run(t) {
    const page = await t.launch({ video: 'portrait' });
    await t.step('abrir câmera', () => t.openCamera(page), page);
    const sharp = (sel) => page.evaluate(([fn, sel, rg]) => (eval(fn))(document.querySelector(sel), rg), [SHARP, sel, [BG, FACE]]);

    await t.step('prévia ao vivo', async () => {
      await page.click('#modeRetrato');
      await page.waitForFunction(() => /Pessoa detectada/.test(document.getElementById('portraitBadge').textContent), null, { timeout: 60000 });
      await page.waitForTimeout(1200);
      t.check('pessoa detectada e camada processada visível', await page.evaluate(() => liveLayer === 'retrato' && !document.getElementById('liveCanvas').classList.contains('hidden')));
      const [vb, vf] = await sharp('#video'), [lb, lf] = await sharp('#liveCanvas');
      t.check('fundo desfocado na prévia (detalhe < 45% do original)', lb < vb * 0.45, { fundo: (lb / vb).toFixed(2), rosto: (lf / vf).toFixed(2) });
      t.check('rosto preservado na prévia (detalhe > 55% do original)', lf > vf * 0.55, (lf / vf).toFixed(2));
      await t.shot(page, '01_previa_retrato.png', { clip: await (await page.$('#viewfinder')).boundingBox() });
    }, page);

    await t.step('intensidade do desfoque', async () => {
      const at = async v => { await page.$eval('#portraitSlider', (el, v) => { el.value = v; el.dispatchEvent(new Event('input')); }, v); await page.waitForTimeout(700); const [vb] = await sharp('#video'), [lb] = await sharp('#liveCanvas'); return { r: lb / vb, label: await page.textContent('#portraitVal') }; };
      const lo = await at(0.1), hi = await at(1);
      t.check('mais intensidade → fundo mais desfocado', hi.r < lo.r * 0.8, { 'f/' : [lo.label, hi.label], detalhe: [lo.r.toFixed(2), hi.r.toFixed(2)] });
      await at(0.6);
    }, page);

    await t.step('foto', async () => {
      const raw = await page.evaluate(() => { const v = document.getElementById('video'), c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0); return c.toDataURL('image/jpeg', 0.95); });
      await page.click('#shutterBtn');
      await page.waitForFunction(() => photos[0] && photos[0].mode === 'retrato', null, { timeout: 30000 });
      const info = await page.evaluate(() => photos[0].portrait);
      t.check('foto com fundo desfocado', info && info.applied && info.person > 0.1, info);
      const r = await page.evaluate(async ([fn, raw, rg]) => {
        const load = s => new Promise(res => { const i = new Image(); i.onload = () => res(i); i.src = s; });
        const f = eval(fn); return { foto: f(await load(photos[0].dataUrl), rg), cru: f(await load(raw), rg) };
      }, [SHARP, raw, [BG, FACE]]);
      t.check('foto: fundo com < 45% do detalhe original', r.foto[0] < r.cru[0] * 0.45, (r.foto[0] / r.cru[0]).toFixed(2));
      t.check('foto: rosto com > 55% do detalhe original', r.foto[1] > r.cru[1] * 0.55, (r.foto[1] / r.cru[1]).toFixed(2));
      const url = await page.evaluate(() => photos[0].dataUrl);
      fs.writeFileSync(path.join(t.outDir, '02_foto_retrato.jpg'), Buffer.from(url.split(',')[1], 'base64'));
    }, page);

    await t.step('sair do Retrato', async () => {
      await page.click('#modeFoto'); await page.waitForTimeout(300);
      t.check('camada e controles do Retrato desligados', await page.evaluate(() => !liveLayer && document.getElementById('liveCanvas').classList.contains('hidden') && document.getElementById('portraitStrip').classList.contains('hidden') && !GSPortrait.liveActive()));
    }, page);
    t.noPageErrors(page);

    /* cena sem pessoa: não desfoca nada */
    const p2 = await t.launch({ video: 'links' });
    await t.step('cena sem pessoa', async () => {
      await t.openCamera(p2);
      await p2.click('#modeRetrato');
      await p2.waitForFunction(() => /Aponte para uma pessoa/.test(document.getElementById('portraitBadge').textContent), null, { timeout: 60000 });
      t.check('aviso "Aponte para uma pessoa"', true);
      await p2.click('#shutterBtn');
      await p2.waitForFunction(() => photos[0] && photos[0].mode === 'retrato', null, { timeout: 30000 });
      const info = await p2.evaluate(() => photos[0].portrait);
      t.check('foto sem pessoa não é desfocada', info && !info.applied, info);
    }, p2);
    t.noPageErrors(p2);
  }
};
