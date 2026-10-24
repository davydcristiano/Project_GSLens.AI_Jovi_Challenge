/* Desempenho: a interface não pode travar (tarefas longas na thread principal)
   ao abrir o app, nos modos ao vivo (Noite, Retrato, AR) e ao tirar fotos.
   Os limites são folgados: neste ambiente de teste a GPU é simulada por
   software, bem mais lenta que a de um celular. */
'use strict';

const INIT = () => {
  window.__lt = [];
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push(e.duration); }).observe({ type: 'longtask', buffered: true }); } catch (e) { }
};
const reset = p => p.evaluate(() => { window.__lt = []; });
const measure = async (p, ms) => { await p.waitForTimeout(ms); return p.evaluate(ms => { const lt = window.__lt; return { bloqueioPct: +(100 * lt.reduce((a, b) => a + b, 0) / ms).toFixed(1), maiorMs: Math.round(Math.max(0, ...lt)) }; }, ms); };

module.exports = {
  title: 'Desempenho: interface sem travadas',
  videos: ['links', 'night', 'portrait', 'scan-board'],
  timeout: 400000,
  async run(t) {
    const open = async video => { const p = await t.launch({ video }); await p.addInitScript(INIT); return p; };

    let p = await open('links');
    await t.step('abrir o app', async () => {
      await p.goto(t.app);
      const r = await measure(p, 5000);
      t.check('abertura sem bloco > 250 ms', r.maiorMs < 250, r);
    }, p);
    await t.step('tirar fotos', async () => {
      await t.openCamera(p); await p.waitForTimeout(800); await reset(p);
      for (let i = 0; i < 4; i++) { await p.evaluate(() => document.getElementById('shutterBtn').click()); await p.waitForTimeout(700); }
      const r = await measure(p, 200);
      t.check('foto sem bloco > 400 ms', r.maiorMs < 400, r);
      t.check('4 fotos salvas', await p.evaluate(() => photos.length) === 4);
    }, p);
    t.noPageErrors(p);

    p = await open('night');
    await t.step('Noite ao vivo', async () => {
      await t.openCamera(p); await p.click('#modeNoite'); await p.waitForTimeout(1500); await reset(p);
      const r = await measure(p, 5000);
      t.check('Noite: interface livre (bloqueio < 15%)', r.bloqueioPct < 15, r);
    }, p);

    p = await open('portrait');
    await t.step('Retrato ao vivo', async () => {
      await t.openCamera(p); await p.click('#modeRetrato');
      await p.waitForFunction(() => /Pessoa/.test(document.getElementById('portraitBadge').textContent), null, { timeout: 60000 });
      await reset(p);
      const r = await measure(p, 5000);
      t.check('Retrato: interface livre (bloqueio < 15%)', r.bloqueioPct < 15, r);
    }, p);

    p = await open('scan-board');
    await t.step('AR rastreando', async () => {
      await t.openCamera(p); await p.click('#modeAR'); await p.waitForTimeout(1500); await p.click('#scanStartBtn'); await reset(p);
      const r = await measure(p, 6000);
      t.check('AR: bloqueio < 25%', r.bloqueioPct < 25, r);
      t.check('AR: vistas sendo capturadas', await p.evaluate(() => Scan3D._debug.keyframes.length) >= 1);
    }, p);
  }
};
