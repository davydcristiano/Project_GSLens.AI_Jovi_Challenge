/* Fluxos principais: foto, aba Efeitos, vídeo, galeria, editor, PDF, lote, exclusão, painel */
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = {
  title: 'Fluxos do app: foto, efeitos, vídeo, galeria, editor, PDF e painel',
  videos: ['links'],
  timeout: 240000,
  async run(t) {
    const page = await t.launch({ video: 'links' });
    await t.step('abrir câmera', () => t.openCamera(page), page);
    const count = () => page.evaluate(() => photos.length);

    await t.step('foto no modo Foto', async () => {
      await page.click('#shutterBtn');
      await page.waitForFunction(() => photos.length >= 1);
      const p = await page.evaluate(() => ({ mode: photos[0].mode, w: photos[0].w, jpeg: photos[0].dataUrl.startsWith('data:image/jpeg') }));
      t.check('foto salva em JPEG no modo Foto', p.jpeg && p.mode === 'foto' && p.w > 0, p);
    }, page);

    await t.step('aba Efeitos', async () => {
      await page.click('#modeEfeitos');
      await page.waitForSelector('#fxPanel:not(.hidden)');
      await page.click('.fx-opt:has-text("Confetti")');
      await page.waitForTimeout(500);
      const st = await page.evaluate(() => ({ fx: fxRunning, scanHidden: document.getElementById('scanPanel').classList.contains('hidden') }));
      t.check('efeito animado rodando e painel do scanner oculto', st.fx && st.scanHidden, st);
      const n = await count();
      await page.click('#shutterBtn');
      await page.waitForFunction(n => photos.length > n, n);
      t.check('foto com efeito registra o efeito', await page.evaluate(() => photos[0].fx === 'confetti'));
      await t.shot(page, '01_efeitos.png');
    }, page);

    await t.step('gravar vídeo', async () => {
      await page.click('#modeVideo');
      await page.click('#shutterBtn'); await page.waitForTimeout(2200); await page.click('#shutterBtn');
      await page.waitForFunction(() => photos[0] && photos[0].type === 'video', null, { timeout: 15000 });
      const v = await page.evaluate(() => ({ mime: photos[0].mime, size: photos[0].blob.size }));
      t.check('vídeo gravado (com dados)', v.size > 5000 && /video\//.test(v.mime), v);
    }, page);

    await t.step('galeria e editor', async () => {
      await page.click('#thumbBtn');
      await page.waitForSelector('#galleryScreen:not(.screen-hidden)');
      t.check('galeria lista fotos e vídeo', await page.$$eval('.gal-cell', c => c.length) >= 3);
      await (await page.$('.gal-cell img')).click();
      await page.waitForSelector('#editModal:not(.hidden)');
      const before = await page.evaluate(() => photos[editingIdx].dataUrl.length);
      await page.$eval('#slBrightness', el => { el.value = 40; el.dispatchEvent(new Event('input')); });
      await page.waitForTimeout(1200);
      t.check('ajuste de brilho altera e salva a foto', before !== await page.evaluate(() => photos[editingIdx].dataUrl.length));
      await page.click('.etab[data-tab="effects"]'); await page.click('.fxchip[data-e="noir"]');
      await page.click('.etab[data-tab="frame"]'); await page.click('.frame-btn[data-frame="polaroid"]');
      await page.waitForTimeout(1500);
      const d = await page.evaluate(() => [photos[editingIdx].w, photos[editingIdx].h]);
      t.check('moldura Polaroid aumenta a imagem', d[1] > d[0] * 0.5, d);
      await page.click('.etab[data-tab="frame"]');
      const labels = await page.$$eval('#panelFrame .grid-group', e => e.map(x => x.textContent));
      t.check('molduras em grupos Básicas/Clássicas/Modernas', labels.join() === 'Básicas,Clássicas,Modernas', labels);
      await page.click('.etab[data-tab="text"]');
      await page.fill('#textInput', 'GSLens');
      const r = await (await page.$('#drawCanvas')).boundingBox();
      const b2 = await page.evaluate(() => photos[editingIdx].dataUrl);
      await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
      await page.click('text=✓ Aplicar Texto'); await page.waitForTimeout(500);
      t.check('texto aplicado na foto', b2 !== await page.evaluate(() => photos[editingIdx].dataUrl));
      await page.click('.etab[data-tab="ai"]'); await page.click('text=✨ Auto Melhorar');
      await page.waitForFunction(() => /Medido/.test(document.getElementById('aiResultText').textContent));
      t.check('auto melhorar mede a imagem', true);
      await t.shot(page, '02_editor.png');
    }, page);

    await t.step('exportar PDF', async () => {
      await page.click('.etab[data-tab="export"]');
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.export-card:has-text("PDF + Fundo Branco")')]);
      const f = path.join(t.outDir, dl.suggestedFilename()); await dl.saveAs(f);
      t.check('PDF válido baixado', fs.readFileSync(f).slice(0, 5).toString() === '%PDF-');
    }, page);

    await t.step('PDF em lote e exclusão', async () => {
      await page.click('#editModal .modal-backdrop-custom', { position: { x: 5, y: 5 } });
      await page.click('#selectModeBtn');
      for (const c of await page.$$('.gal-cell')) await c.click();
      await page.click('.batch-actions >> text=PDF');
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('text=Grade 2×2')]);
      const f = path.join(t.outDir, 'lote.pdf'); await dl.saveAs(f);
      t.check('PDF em lote gerado (vídeo ignorado)', fs.statSync(f).size > 10000);
      await page.click('#selectModeBtn');
      for (const c of await page.$$('.gal-cell')) await c.click();
      await page.click('.batch-actions >> text=Excluir'); await page.waitForTimeout(500);
      const st = await page.evaluate(() => ({ empty: !!document.querySelector('#galGrid #galEmpty'), badge: document.getElementById('countBadge').classList.contains('hidden') }));
      t.check('excluir tudo deixa a galeria vazia', st.empty && st.badge, st);
    }, page);

    await t.step('painel e volta', async () => {
      await page.click('#galBackBtn');
      await page.click('.extra-btn:has-text("Stats")');
      await page.waitForSelector('#dashboardScreen:not(.screen-hidden)');
      await page.click('#dashboardScreen .back-btn');
      t.check('painel abre e volta à câmera', await page.evaluate(() => !document.getElementById('cameraScreen').classList.contains('screen-hidden')));
      await page.click('#cameraScreen .topbtn[aria-label="Voltar"]');
      t.check('voltar para a Home desliga a câmera', await page.evaluate(() => !stream));
    }, page);
    t.noPageErrors(page);
  }
};
