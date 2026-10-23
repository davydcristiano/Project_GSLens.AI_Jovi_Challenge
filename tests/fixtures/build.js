/* Gera os vídeos de câmera falsa (tests/.cache/*.mjpeg) usados pelos testes.
   Um .mjpeg é só a concatenação de quadros JPEG — o formato que o Chromium
   aceita em --use-file-for-fake-video-capture.
   Os arquivos são reaproveitados enquanto o gerador e a URL do servidor não mudam.
   Uso direto: node fixtures/build.js [nomes...] */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CACHE, loadPlaywright, GL_ARGS, startServer } = require('../lib/harness');

/* Versão de cada gerador (aumente ao mudar o gerador em videos.html) e os
   arquivos de que ele depende — só os vídeos afetados são regerados. */
const GENERATORS = {
  'scan-board': { v: 1, deps: ['synth.js'] },
  'scan-surface': { v: 2, deps: ['synth.js', '../../js/scan3d/surface.js'] },
  'links': { v: 1, deps: ['qrcode.js'] },
  'night': { v: 1, deps: [] },
  'portrait': { v: 2, deps: ['media/selfie_mediapipe.webm', 'decode.js'] },
};

function fingerprint(name, base) {
  const g = GENERATORS[name];
  if (!g) throw new Error('gerador de vídeo desconhecido: ' + name);
  const h = crypto.createHash('sha1');
  h.update(name + ':' + g.v);
  for (const f of g.deps) h.update(fs.readFileSync(path.join(__dirname, f)));
  if (name === 'links') h.update(base);           /* o QR contém a URL do servidor */
  return h.digest('hex').slice(0, 12);
}

async function buildFixtures(base, names) {
  const todo = names.filter(n => {
    const meta = path.join(CACHE, n + '.json');
    try { return JSON.parse(fs.readFileSync(meta, 'utf8')).fp !== fingerprint(n, base) || !fs.existsSync(path.join(CACHE, n + '.mjpeg')); }
    catch (e) { return true; }
  });
  if (!todo.length) return;
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ args: GL_ARGS });
  try {
    for (const n of todo) {
      const t0 = Date.now();
      process.stdout.write(`   gerando vídeo de teste "${n}"… `);
      const page = await browser.newPage();
      page.setDefaultTimeout(600000);
      await page.goto(`${base}/tests/fixtures/videos.html?base=${encodeURIComponent(base)}`);
      await page.waitForFunction(() => window.__ready);
      const count = await page.evaluate(n => window.startGen(n), n);
      const file = path.join(CACHE, n + '.mjpeg');
      const fd = fs.openSync(file + '.tmp', 'w');
      for (let i = 0; i < count; i++) fs.writeSync(fd, Buffer.from(await page.evaluate(i => window.genFrame(i), i)));
      fs.closeSync(fd);
      fs.renameSync(file + '.tmp', file);
      if (n === 'night') {
        const png = await page.evaluate(() => window.cleanScene());
        fs.writeFileSync(path.join(CACHE, 'night-clean.png'), Buffer.from(png.split(',')[1], 'base64'));
      }
      fs.writeFileSync(path.join(CACHE, n + '.json'), JSON.stringify({ fp: fingerprint(n, base), frames: count }));
      await page.close();
      console.log(`${count} quadros, ${(fs.statSync(file).size / 1e6).toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    }
  } finally { await browser.close(); }
}

module.exports = { buildFixtures };

if (require.main === module) {
  (async () => {
    const srv = await startServer();
    const names = process.argv.slice(2);
    await buildFixtures(srv.base, names.length ? names : ['scan-board', 'links', 'night']);
    await srv.close();
  })();
}
