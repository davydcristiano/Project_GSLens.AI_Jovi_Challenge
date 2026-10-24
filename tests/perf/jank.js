/* Mede travadas por funcionalidade: tarefas longas (> 50 ms na thread da
   interface) e quadros lentos (intervalo de requestAnimationFrame > 50 ms).
   Uso: node tests/perf/jank.js [saida.json]
   Os números absolutos dependem da máquina (aqui o WebGL é por software);
   servem para comparar antes × depois. */
'use strict';
const fs = require('fs');
const { Ctx, startServer } = require('../lib/harness');
const { buildFixtures } = require('../fixtures/build');

const INIT = () => {
  if (window.__noBackdrop !== undefined || /nobackdrop/.test(location.search)) { }
  window.__lt = [];
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push(e.duration); }).observe({ type: 'longtask', buffered: true }); } catch (e) { }
  window.__frames = [];
  let last = 0;
  const loop = t => { if (last) window.__frames.push(t - last); last = t; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
};
const reset = page => page.evaluate(() => { window.__lt = []; window.__frames = []; });
const collect = async (page, ms) => {
  await page.waitForTimeout(ms);
  return page.evaluate(ms => {
    const lt = window.__lt, fr = window.__frames;
    const sum = lt.reduce((a, b) => a + b, 0);
    return {
      bloqueioPct: +(100 * sum / ms).toFixed(1),            /* % do tempo com a interface travada */
      tarefasLongas: lt.length, maiorMs: Math.round(Math.max(0, ...lt)),
      quadrosLentosPct: +(100 * fr.filter(d => d > 50).length / Math.max(1, fr.length)).toFixed(1)
    };
  }, ms);
};

(async () => {
  const srv = await startServer();
  await buildFixtures(srv.base, ['links', 'night', 'portrait', 'scan-board']);
  const t = new Ctx('perf', srv.base);
  const out = {};
  let run = async (name, video, fn) => {
    const page = await t.launch({ video, args: ['--autoplay-policy=no-user-gesture-required'] });
    await page.addInitScript(INIT);
    if (process.env.NOBACKDROP) await page.addInitScript(() => { document.addEventListener('DOMContentLoaded', () => { const st = document.createElement('style'); st.textContent = '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}'; document.head.appendChild(st); }); });
    try { out[name] = await fn(page); } catch (e) { out[name] = { erro: e.message.split('\n')[0] }; }
    console.log(name.padEnd(34), JSON.stringify(out[name]));
    await page.context().browser().close();
  };

  const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
  const run0 = run;
  run = async (n, v, f) => (!only || only.some(o => n.includes(o))) ? run0(n, v, f) : null;
  await run('inicio (carregar app)', 'links', async p => { await p.goto(t.app); return collect(p, 6000); });
  await run('camera foto + leitor QR/links', 'links', async p => { await t.openCamera(p, { linkScan: true }); await p.waitForTimeout(1500); await reset(p); return collect(p, 8000); });
  await run('camera foto sem leitor', 'links', async p => { await t.openCamera(p); await reset(p); return collect(p, 5000); });
  await run('efeitos (confete)', 'links', async p => { await t.openCamera(p); await p.click('#modeEfeitos'); await p.click('.fx-opt:has-text("Confetti")'); await reset(p); return collect(p, 5000); });
  await run('filtro WebGL (lomo)', 'links', async p => { await t.openCamera(p); await p.click('.fi[data-f="lomo"]'); await reset(p); return collect(p, 5000); });
  await run('noite (previa)', 'night', async p => { await t.openCamera(p); await p.click('#modeNoite'); await p.waitForTimeout(1500); await reset(p); return collect(p, 6000); });
  await run('retrato (previa)', 'portrait', async p => { await t.openCamera(p); await p.click('#modeRetrato'); await p.waitForFunction(() => /Pessoa/.test(document.getElementById('portraitBadge').textContent), null, { timeout: 60000 }); await reset(p); return collect(p, 8000); });
  await run('AR prancha (rastreando)', 'scan-board', async p => { await t.openCamera(p); await p.click('#modeAR'); await p.waitForTimeout(2000); await p.click('#scanStartBtn'); await reset(p); return collect(p, 8000); });
  await run('tirar foto (5x)', 'links', async p => {
    await t.openCamera(p); await reset(p);
    for (let i = 0; i < 5; i++) { await p.evaluate(() => document.getElementById('shutterBtn').click()); await p.waitForTimeout(700); }
    return collect(p, 300);
  });
  await run('galeria (24 fotos) abrir + rolar', 'links', async p => {
    await t.openCamera(p);
    for (let i = 0; i < 24; i++) { await p.evaluate(() => document.getElementById('shutterBtn').click()); await p.waitForTimeout(250); }
    await p.waitForTimeout(1500); await reset(p);
    await p.evaluate(() => document.getElementById('thumbBtn').click());
    await p.waitForTimeout(800);
    for (let i = 0; i < 10; i++) { await p.mouse.wheel(0, 300); await p.waitForTimeout(150); }
    return collect(p, 500);
  });
  await run('editor: arrastar brilho', 'links', async p => {
    await t.openCamera(p);
    await p.evaluate(() => document.getElementById('shutterBtn').click()); await p.waitForTimeout(800);
    await p.evaluate(() => document.getElementById('thumbBtn').click()); await p.waitForTimeout(500);
    await (await p.$('.gal-cell img')).click(); await p.waitForSelector('#editModal:not(.hidden)'); await p.waitForTimeout(500);
    await reset(p);
    for (let v = 0; v <= 60; v += 3) { await p.$eval('#slBrightness', (el, v) => { el.value = v; el.dispatchEvent(new Event('input')); }, v); await p.waitForTimeout(40); }
    return collect(p, 1500);
  });
  fs.writeFileSync(process.argv[2] || (t.outDir + '/jank.json'), JSON.stringify(out, null, 1));
  await srv.close();
})();
