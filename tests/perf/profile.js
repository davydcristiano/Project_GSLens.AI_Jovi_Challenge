/* Perfil de CPU da thread da interface por cenário (funções com mais tempo próprio).
   Uso: node tests/perf/profile.js [cenário...] */
'use strict';
const { Ctx, startServer } = require('../lib/harness');

async function profile(page, ms) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await cdp.send('Profiler.start');
  await page.waitForTimeout(ms);
  const { profile } = await cdp.send('Profiler.stop');
  const self = new Map(), byId = new Map(profile.nodes.map(n => [n.id, n]));
  const dt = (profile.endTime - profile.startTime) / profile.samples.length / 1000;
  for (const id of profile.samples) {
    const n = byId.get(id), f = n.callFrame;
    const key = (f.functionName || '(anônima)') + ' ' + (f.url.split('/').slice(-2).join('/').split('?')[0]) + ':' + (f.lineNumber + 1);
    self.set(key, (self.get(key) || 0) + dt);
  }
  const total = [...self.entries()].filter(([k]) => !/^\(idle\)|^\(program\)|^\(garbage/.test(k)).reduce((a, [, v]) => a + v, 0);
  return { ocupadoPct: +(100 * total / ms).toFixed(1), top: [...self.entries()].filter(([k]) => !/^\(idle\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${v.toFixed(0).padStart(5)} ms  ${k}`) };
}

const SC = {
  inicio: ['links', async (t, p) => { await p.goto(t.app); return profile(p, 5000); }],
  leitor: ['links', async (t, p) => { await t.openCamera(p, { linkScan: true }); await p.waitForTimeout(1000); return profile(p, 6000); }],
  noite: ['night', async (t, p) => { await t.openCamera(p); await p.click('#modeNoite'); await p.waitForTimeout(1500); return profile(p, 5000); }],
  retrato: ['portrait', async (t, p) => { await t.openCamera(p); await p.click('#modeRetrato'); await p.waitForFunction(() => /Pessoa/.test(document.getElementById('portraitBadge').textContent), null, { timeout: 60000 }); return profile(p, 6000); }],
  ar: ['scan-board', async (t, p) => { await t.openCamera(p); await p.click('#modeAR'); await p.waitForTimeout(1500); await p.click('#scanStartBtn'); return profile(p, 6000); }],
  foto: ['links', async (t, p) => { await t.openCamera(p); const pr = profile(p, 4000); for (let i = 0; i < 4; i++) { await p.evaluate(() => document.getElementById('shutterBtn').click()); await p.waitForTimeout(900); } return pr; }],
  filtro: ['links', async (t, p) => { await t.openCamera(p); await p.click('.fi[data-f="lomo"]'); await p.waitForTimeout(800); return profile(p, 4000); }],
};

(async () => {
  const srv = await startServer();
  const t = new Ctx('perf', srv.base);
  for (const name of (process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SC))) {
    const [video, fn] = SC[name];
    const page = await t.launch({ video, args: ['--autoplay-policy=no-user-gesture-required'] });
    const r = await fn(t, page);
    console.log(`\n=== ${name}: thread da interface ocupada ${r.ocupadoPct}%`);
    r.top.forEach(l => console.log('  ' + l));
    await page.context().browser().close();
  }
  await srv.close();
})();
