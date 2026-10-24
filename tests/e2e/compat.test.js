/* Compatibilidade: EV igual em todos os aparelhos e o app inteiro num
   "Android antigo" simulado (sem WebGL2, sem requestVideoFrameCallback,
   ResizeObserver, requestIdleCallback, BigInt, OffscreenCanvas, compensação
   de exposição da câmera) com o modo leve ligado */
'use strict';

const OLD = () => {
  const gc = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, opts) { return /webgl2/.test(type) ? null : gc.call(this, type, opts); };
  delete HTMLVideoElement.prototype.requestVideoFrameCallback;
  delete HTMLVideoElement.prototype.cancelVideoFrameCallback;
  for (const k of ['ResizeObserver', 'requestIdleCallback', 'cancelIdleCallback', 'OffscreenCanvas', 'BigInt', 'structuredClone']) { try { delete window[k]; } catch (e) {} window[k] = undefined; }
  if (window.MediaStreamTrack) MediaStreamTrack.prototype.getCapabilities = undefined;
};

const meanLum = `(src) => new Promise(res => { const im = new Image(); im.onload = () => { const c = document.createElement('canvas'); c.width = 64; c.height = 36; const x = c.getContext('2d'); x.drawImage(im, 0, 0, 64, 36); const d = x.getImageData(0, 0, 64, 36).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114; res(s / (d.length / 4)); }; im.src = src; })`;

module.exports = {
  title: 'Compatibilidade: EV e Android antigo simulado (modo leve)',
  videos: ['links', 'portrait'],
  timeout: 300000,
  async run(t) {
    /* ── EV ── */
    let page = await t.launch({ video: 'links' });
    await t.step('EV começa em 0.0 e funciona', async () => {
      await page.addInitScript(() => { try { localStorage.setItem('gs_linkscan', '0'); } catch (e) {} });
      await page.goto(t.app);
      /* simula o navegador restaurando o controle numa posição antiga */
      await page.$eval('#evSlider', el => { el.value = 1.3; });
      await page.click('text=Abrir Câmera');
      await page.waitForSelector('#cameraScreen:not(.screen-hidden)');
      await page.waitForFunction(() => document.getElementById('video').videoWidth > 0);
      const st = await page.evaluate(() => ({ ev: evLevel, slider: +document.getElementById('evSlider').value, txt: document.getElementById('evVal').textContent, strip: !document.getElementById('evStrip').classList.contains('hidden') }));
      t.check('ao abrir a câmera: EV 0.0 (controle, texto e valor)', st.ev === 0 && st.slider === 0 && st.txt === '0.0' && st.strip, st);
      /* mesmo quadro nas três fotos: pausa o vídeo de teste */
      await page.evaluate(() => document.getElementById('video').pause());
      await page.click('#shutterBtn'); await page.waitForFunction(() => photos.length >= 1);
      const l0 = await page.evaluate(`(${meanLum})(photos[0].dataUrl)`);
      await page.$eval('#evSlider', el => { el.value = 1.5; el.dispatchEvent(new Event('input')); });
      const css = await page.evaluate(() => document.getElementById('video').style.filter);
      t.check('EV +1.5 clareia a prévia em qualquer aparelho', /brightness\(1\.68/.test(css), css);
      await page.click('#shutterBtn'); await page.waitForFunction(() => photos.length >= 2);
      const lp = await page.evaluate(`(${meanLum})(photos[0].dataUrl)`);
      await page.$eval('#evSlider', el => { el.value = -1.5; el.dispatchEvent(new Event('input')); });
      await page.click('#shutterBtn'); await page.waitForFunction(() => photos.length >= 3);
      const lm = await page.evaluate(`(${meanLum})(photos[0].dataUrl)`);
      t.check('foto com EV +1.5 sai mais clara e com −1.5 mais escura', lp > l0 * 1.25 && lm < l0 * 0.8, { 'EV 0': l0.toFixed(0), 'EV +1.5': lp.toFixed(0), 'EV −1.5': lm.toFixed(0) });
      await page.evaluate(() => document.getElementById('video').play());
      const badge = await page.evaluate(() => ({ txt: document.getElementById('evBadge').textContent, on: !document.getElementById('evBadge').classList.contains('hidden') }));
      t.check('selo "EV −1.5" no visor', badge.on && badge.txt === 'EV -1.5', badge);
      /* sair e voltar à câmera: volta a 0.0 */
      await page.click('#cameraScreen .topbtn[aria-label="Voltar"]');
      await page.click('text=Abrir Câmera');
      await page.waitForFunction(() => document.getElementById('video').videoWidth > 0 && stream);
      t.check('reabrir a câmera volta o EV a 0.0', await page.evaluate(() => evLevel === 0 && +document.getElementById('evSlider').value === 0 && !/brightness/.test(document.getElementById('video').style.filter)));
    }, page);
    t.noPageErrors(page, 'EV: sem erros de JavaScript');
    await t.close();

    /* ── Android antigo simulado ── */
    page = await t.launch({ video: 'portrait' });
    await page.addInitScript(OLD);
    await page.addInitScript(() => { try { localStorage.setItem('gs_linkscan', '0'); } catch (e) {} });
    await t.step('abrir em modo leve', async () => {
      await page.goto(t.app + '?leve=1');
      const p = await page.evaluate(() => ({ low: GSPerf.low, gl2: GSPerf.gl2, camW: GSPerf.camW }));
      t.check('perfil leve detectado (sem WebGL2)', p.low && !p.gl2 && p.camW === 1280, p);
      await page.click('text=Abrir Câmera');
      await page.waitForSelector('#cameraScreen:not(.screen-hidden)');
      await page.waitForFunction(() => document.getElementById('video').videoWidth > 0);
      t.check('câmera abre em 720p no modo leve', await page.evaluate(() => Math.max(video.videoWidth, video.videoHeight) <= 1280));
    }, page);
    await t.step('filtro clássico (WebGL 1) e foto', async () => {
      await page.click('.fi[data-f="lomo"]'); await page.waitForTimeout(1500);
      t.check('prévia do filtro sem WebGL2', await page.evaluate(() => !document.getElementById('filterCanvas').classList.contains('hidden') || document.getElementById('video').style.filter !== 'none'));
      const n = await page.evaluate(() => photos.length);
      await page.click('#shutterBtn'); await page.waitForFunction(n => photos.length > n, n, { timeout: 15000 });
      t.check('foto com filtro', await page.evaluate(() => photos[0].filter === 'lomo'));
      await page.click('.fi[data-f="none"]');
    }, page);
    await t.step('Noite', async () => {
      await page.click('#modeNoite'); await page.waitForTimeout(2500);
      const n = await page.evaluate(() => photos.length);
      await page.click('#shutterBtn'); await page.waitForFunction(n => photos.length > n, n, { timeout: 30000 });
      t.check('foto noturna sem WebGL2 / sem requestVideoFrameCallback', await page.evaluate(() => photos[0].mode === 'noite'));
    }, page);
    await t.step('Retrato', async () => {
      await page.click('#modeRetrato');
      await page.waitForFunction(() => /Pessoa detectada|fundo desfocado/.test(document.getElementById('portraitBadge').textContent), null, { timeout: 60000 });
      t.check('IA do Retrato detecta a pessoa (WebGL 1, modo leve)', true);
      const n = await page.evaluate(() => photos.length);
      await page.click('#shutterBtn'); await page.waitForFunction(n => photos.length > n, n, { timeout: 30000 });
      t.check('foto de retrato com fundo desfocado', await page.evaluate(() => photos[0].mode === 'retrato' && photos[0].portrait && photos[0].portrait.applied), await page.evaluate(() => photos[0].portrait));
      await page.click('#modeFoto');
    }, page);
    await t.step('editor e exportação', async () => {
      await page.click('#thumbBtn'); await page.waitForSelector('#galleryScreen:not(.screen-hidden)');
      await (await page.$('.gal-cell img')).click(); await page.waitForSelector('#editModal:not(.hidden)');
      await page.click('.etab[data-tab="text"]'); await page.waitForSelector('#wtComposer:not(.hidden)');
      await page.keyboard.type('Teste'); await page.click('#wtDone');
      const b = await page.evaluate(() => photos[editingIdx].dataUrl.length);
      await page.click('#wtApply'); await page.waitForTimeout(400);
      t.check('texto livre aplicado', b !== await page.evaluate(() => photos[editingIdx].dataUrl.length));
      await page.click('#exportBtnEdit');
      t.check('menu Export abre', await page.evaluate(() => exportMenuOpen()));
      await page.keyboard.press('Escape');
      await page.click('#editBackBtn');
    }, page);
    await t.step('Montagem', async () => {
      await page.click('#reelOpenBtn'); await page.waitForSelector('#reelPicker:not(.hidden)');
      const cells = await page.$$('#reelPickGrid .reel-pick-cell'); await cells[0].click(); await cells[1].click();
      await page.click('#reelPickAdd');
      await page.waitForFunction(() => GSReel.state.clips.length === 2 && GSReel.state.clips.every(c => c.img));
      await page.evaluate(() => GSReel.state.clips.forEach(c => { c.dur = 1.5; }));
      await page.click('#reelExportBtn');
      await page.waitForSelector('#reelDone:not(.hidden)', { timeout: 60000 });
      t.check('vídeo da montagem gerado', await page.evaluate(() => photos[0].mode === 'montagem' && photos[0].blob.size > 5000));
      await page.click('#reelScreen .back-btn');
    }, page);
    t.noPageErrors(page, 'Android antigo: sem erros de JavaScript');
    const errs = page.__logs.filter(l => l.startsWith('console.error'));
    t.check('Android antigo: sem erros no console', errs.length === 0, errs.slice(0, 3));
  }
};
