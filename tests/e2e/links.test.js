/* Leitor de QR Code e links: QR com URL → mini navegador, link impresso (OCR), QR de Wi‑Fi,
   filtros novos (prévia WebGL = foto) e leitura de QR numa foto da galeria */
'use strict';

module.exports = {
  title: 'Leitor de QR/links, filtros e leitura na galeria',
  videos: ['links'],
  timeout: 300000,
  async run(t) {
    const page = await t.launch({ video: 'links' });
    await t.step('abrir câmera com leitor', async () => {
      await t.openCamera(page, { linkScan: true });
      t.check('leitor ligado ao abrir', await page.evaluate(() => LinkScan.enabled));
    }, page);

    await t.step('QR com link', async () => {
      await page.waitForSelector('#webSheet:not(.hidden)', { timeout: 60000 });
      await page.waitForTimeout(1500);
      const fr = page.frames().find(f => f.url().includes('minipage.html'));
      const txt = fr ? await fr.textContent('#h') : '';
      t.check('QR abre a página no mini navegador interno', /Página aberta pelo QR/.test(txt), await page.textContent('#webSource'));
      await t.shot(page, '01_qr.png');
      await page.click('#webSheet .web-mi.danger');
      await page.waitForTimeout(2500);
      t.check('fechar não reabre o mesmo QR', !(await page.isVisible('#webSheet')));
    }, page);

    await t.step('link impresso (OCR)', async () => {
      await page.waitForFunction(() => { if (document.getElementById('webSheet').classList.contains('hidden')) return false; if (/gslens-teste/.test(document.getElementById('webHost').textContent)) return true; LinkScan.close(); return false; }, null, { timeout: 90000, polling: 500 });
      const u = await page.textContent('#webUrl');
      t.check('link escrito lido e aberto', u === 'https://www.gslens-teste.com.br/promo', u);
      await t.shot(page, '02_ocr.png');
      await page.click('#webSheet .web-mi.danger');
    }, page);

    await t.step('QR de Wi‑Fi', async () => {
      await page.waitForFunction(() => { if (document.getElementById('webSheet').classList.contains('hidden')) return false; if (!document.getElementById('webInfo').classList.contains('hidden')) return true; LinkScan.close(); return false; }, null, { timeout: 90000, polling: 500 });
      const txt = (await page.textContent('#webInfo')).replace(/\s+/g, ' ');
      t.check('cartão de Wi‑Fi com rede e senha', /GSLens Lab/.test(txt) && /senha-forte-123/.test(txt));
      await page.keyboard.press('Escape');
    }, page);

    await t.step('desligar leitor', async () => {
      await page.click('#linkBtn');
      await page.waitForTimeout(12000);
      t.check('leitor desligado não abre nada', !(await page.isVisible('#webSheet')) && !(await page.evaluate(() => LinkScan.enabled)));
    }, page);

    await t.step('filtros', async () => {
      const groups = await page.$$eval('.fi-group', e => e.map(x => x.textContent));
      t.check('faixa com filtros clássicos e modernos', groups.join() === 'Clássicos,Modernos' && await page.$$eval('.fi', e => e.length) >= 30, groups);
      await page.click('.fi[data-f="lomo"]'); await page.waitForTimeout(700);
      /* compara no MESMO quadro da câmera: a prévia desenha a cada quadro novo
         (requestVideoFrameCallback) e pode pular um quando a GPU está ocupada */
      const diff = await page.evaluate(async () => {
        const v = document.getElementById('video'), fc = document.getElementById('filterCanvas');
        let best = Infinity;
        for (let k = 0; k < 12 && best >= 2; k++) {
          const d = await new Promise(done => v.requestVideoFrameCallback(() => {
            const c = document.createElement('canvas'); c.width = fc.width; c.height = fc.height; c.getContext('2d').drawImage(fc, 0, 0);
            const c2 = document.createElement('canvas'); c2.width = fc.width; c2.height = fc.height;
            const x2 = c2.getContext('2d', { willReadFrequently: true }); x2.drawImage(v, 0, 0, c2.width, c2.height); GSFilters.apply(x2, c2.width, c2.height, 'lomo', 1);
            const a = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, b = x2.getImageData(0, 0, c2.width, c2.height).data;
            let s = 0; for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
            done(s / (a.length / 4 * 3));
          }));
          best = Math.min(best, d);
        }
        return best;
      });
      t.check('prévia WebGL idêntica à foto (diferença média < 2/255)', diff < 2, diff.toFixed(2));
      await page.click('.fi[data-f="none"]');
    }, page);

    await t.step('ler QR numa foto da galeria', async () => {
      for (let k = 0; k < 60; k++) {
        const has = await page.evaluate(() => { const v = document.getElementById('video'); const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; const x = c.getContext('2d'); x.drawImage(v, 0, 0); const d = x.getImageData(0, 0, c.width, c.height); return !!jsQR(d.data, d.width, d.height); });
        if (has) { await page.click('#shutterBtn'); break; }
        await page.waitForTimeout(400);
      }
      await page.waitForTimeout(500);
      await page.click('#thumbBtn'); await (await page.$('.gal-cell img')).click();
      await page.click('.etab[data-tab="ai"]'); await page.click('text=🔗 Ler QR / Link');
      await page.waitForSelector('#webSheet:not(.hidden)', { timeout: 30000 });
      t.check('QR encontrado na foto', /QR Code encontrado/.test(await page.textContent('#aiResultText')));
    }, page);
    t.noPageErrors(page);
  }
};
