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
      /* texto livre (estilo status do WhatsApp) */
      const b2 = await page.evaluate(() => photos[editingIdx].dataUrl);
      await page.click('.etab[data-tab="text"]');
      await page.waitForSelector('#wtComposer:not(.hidden)');
      t.check('aba Texto abre direto o compositor', true);
      await page.keyboard.type('GSLens');
      const bar = await (await page.$('#wtColors')).boundingBox();
      await page.mouse.click(bar.x + bar.width / 2, bar.y + bar.height * 0.15);
      await page.click('#wtBgBtn'); await page.click('#wtFontBtn');
      const st = await page.evaluate(() => ({ color: getComputedStyle(document.getElementById('wtInput')).backgroundColor, font: document.getElementById('wtFontName').textContent }));
      await t.shot(page, '02_compositor_texto.png');
      t.check('cor, fundo e fonte mudam no compositor', st.color !== 'rgba(0, 0, 0, 0)' && st.font === 'Título', st);
      await page.click('#wtDone');
      let it = await page.$('.wt-item');
      t.check('texto vira adesivo sobre a foto', it && await page.evaluate(() => WText.count) === 1);
      const bb = await it.boundingBox(), x0 = await page.evaluate(() => WText._debug.items[0].x);
      await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.mouse.down();
      await page.mouse.move(bb.x + bb.width / 2 + 40, bb.y + bb.height / 2 + 10, { steps: 6 }); await page.mouse.up();
      t.check('arrastar move o texto', await page.evaluate(() => WText._debug.items[0].x) > x0 + 0.05);
      const bb2 = await it.boundingBox();
      await page.mouse.move(bb2.x + bb2.width / 2, bb2.y + bb2.height / 2);
      await page.mouse.wheel(0, -200); await page.mouse.wheel(0, -200);
      t.check('roda do mouse aumenta o texto', await page.evaluate(() => WText._debug.items[0].scale) > 1.1);
      await page.waitForTimeout(250);
      /* pinça com dois dedos (toque real via CDP): gira e aumenta */
      {
        const cdp = await page.context().newCDPSession(page);
        const b = await it.boundingBox(), cx = b.x + b.width / 2, cy = b.y + b.height / 2;
        const s0 = await page.evaluate(() => WText._debug.items[0].scale);
        const pts = (d, a) => [{ x: cx - d * Math.cos(a), y: cy - d * Math.sin(a), id: 1 }, { x: cx + d * Math.cos(a), y: cy + d * Math.sin(a), id: 2 }];
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(20, 0) });
        for (let k = 1; k <= 8; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(20 + k * 5, k * 0.06) });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        const r = await page.evaluate(() => ({ s: WText._debug.items[0].scale, rot: WText._debug.items[0].rot }));
        t.check('pinça com dois dedos aumenta e gira o texto', r.s > s0 * 1.6 && r.rot > 0.35, r);
        await page.waitForTimeout(200);
      }
      const bb3 = await it.boundingBox();
      await page.mouse.click(bb3.x + bb3.width / 2, bb3.y + bb3.height / 2);
      await page.waitForSelector('#wtComposer:not(.hidden)');
      t.check('tocar no texto abre a edição com o texto', await page.$eval('#wtInput', e => e.value) === 'GSLens');
      await page.keyboard.type('!'); await page.click('#wtDone');
      t.check('edição atualiza o texto', await page.evaluate(() => WText._debug.items[0].text) === 'GSLens!');
      /* segundo texto, arrastado até a lixeira */
      await page.click('#wtAdd'); await page.keyboard.type('apagar'); await page.click('#wtDone');
      it = (await page.$$('.wt-item'))[1];
      const b4 = await it.boundingBox();
      await page.mouse.move(b4.x + b4.width / 2, b4.y + b4.height / 2); await page.mouse.down();
      await page.mouse.move(b4.x + b4.width / 2, b4.y + b4.height / 2 + 15, { steps: 3 });
      const tr = await (await page.$('#wtTrash')).boundingBox();
      await page.mouse.move(tr.x + tr.width / 2, tr.y + tr.height / 2, { steps: 8 });
      t.check('lixeira aparece ao arrastar', await page.evaluate(() => document.getElementById('wtTrash').classList.contains('over')));
      await page.mouse.up();
      t.check('soltar na lixeira apaga o texto', await page.evaluate(() => WText.count) === 1);
      await t.shot(page, '02a_texto_livre.png');
      await page.click('#wtApply'); await page.waitForTimeout(500);
      t.check('texto incorporado na foto', b2 !== await page.evaluate(() => photos[editingIdx].dataUrl) && await page.evaluate(() => WText.count) === 0);
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
      await page.click('#editBackBtn');
      t.check('botão voltar do editor fecha e mostra a galeria', await page.evaluate(() => document.getElementById('editModal').classList.contains('hidden') && !document.getElementById('galleryScreen').classList.contains('screen-hidden')));
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
      const cam = await page.evaluate(() => ({ ev: !document.getElementById('evStrip').classList.contains('hidden'), extras: [...document.querySelectorAll('.extra-btn')].filter(b => b.offsetParent).map(b => b.textContent) }));
      t.check('câmera com EV visível e sem os botões EV/Compartilhar/Stats', cam.ev && !cam.extras.length, cam);
      await t.shot(page, '04_camera.png');
      await page.click('#cameraScreen .topbtn[aria-label="Voltar"]');
      t.check('voltar para a Home desliga a câmera', await page.evaluate(() => !stream));
      await page.click('.quicklink:has-text("Estatísticas")');
      await page.waitForSelector('#dashboardScreen:not(.screen-hidden)');
      await page.click('#dashboardScreen .back-btn');
      t.check('painel abre pela Home e volta', await page.evaluate(() => document.getElementById('homeScreen').style.display !== 'none'));
    }, page);
    t.noPageErrors(page);
  }
};
