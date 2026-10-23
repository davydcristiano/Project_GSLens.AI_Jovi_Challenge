/* Infraestrutura dos testes automáticos do GSLens.AI.
   - servidor HTTP estático (raiz = pasta do projeto) em porta livre
   - Chromium (Playwright) com câmera falsa alimentada por vídeo .mjpeg
   - verificações (check) e etapas (step) com relatório e código de saída */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');          /* pasta do projeto */
const TESTS = path.resolve(__dirname, '..');
const CACHE = path.join(TESTS, '.cache');                 /* vídeos gerados */
const OUT = path.join(TESTS, '.out');                     /* capturas de tela, arquivos exportados */
fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

function loadPlaywright() {
  const tries = ['playwright', process.env.PLAYWRIGHT_MODULE, '/home/claude/.npm-global/lib/node_modules/playwright'].filter(Boolean);
  for (const t of tries) { try { return require(t); } catch (e) { /* próxima */ } }
  throw new Error('Playwright não encontrado. Rode "npm install" dentro de tests/ (ou defina PLAYWRIGHT_MODULE).');
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
  '.traineddata': 'application/octet-stream', '.tflite': 'application/octet-stream', '.bin': 'application/octet-stream', '.onnx': 'application/octet-stream'
};

function startServer() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(data);
      });
    });
    /* porta fixa (o vídeo de QR contém a URL; muda de porta → vídeo regerado) */
    const want = +(process.env.TEST_PORT || 8790);
    const ready = () => {
      const base = 'http://127.0.0.1:' + srv.address().port;
      resolve({ base, close: () => new Promise(r => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(r); }) });
    };
    srv.once('error', e => { if (e.code === 'EADDRINUSE') srv.listen(0, '127.0.0.1', ready); else throw e; });
    srv.listen(want, '127.0.0.1', ready);
  });
}

const GL_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

class Ctx {
  constructor(name, base) {
    this.name = name; this.base = base;
    this.results = []; this.browsers = [];
    this.outDir = path.join(OUT, name); fs.mkdirSync(this.outDir, { recursive: true });
    this.pw = loadPlaywright();
  }
  url(p) { return this.base + '/' + p.replace(/^\//, ''); }
  get app() { return this.url('index.html'); }
  video(name) {
    const f = path.join(CACHE, name + '.mjpeg');
    if (!fs.existsSync(f)) throw new Error('vídeo de teste ausente: ' + f + ' (rode node fixtures/build.js)');
    return f;
  }
  async launch(opts = {}) {
    const args = opts.gl === false ? [] : [...GL_ARGS];
    if (opts.video) args.push('--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=' + this.video(opts.video));
    if (opts.args) args.push(...opts.args);
    const browser = await this.pw.chromium.launch({ args });
    this.browsers.push(browser);
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 1, acceptDownloads: true }, opts.context || {}));
    const page = await ctx.newPage();
    page.__logs = [];
    page.on('pageerror', e => page.__logs.push('PAGEERROR: ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL|ERR_NAME|Failed to load resource/.test(m.text())) page.__logs.push('console.error: ' + m.text()); });
    page.on('dialog', d => d.accept());
    return page;
  }
  /* abre o app e a câmera */
  async openCamera(page, { linkScan = false } = {}) {
    /* preferência do leitor de QR/links gravada ANTES de a página carregar
       (desligar depois de abrir a câmera deixava uma janela em que um QR do
       vídeo podia ser lido sob carga) */
    if (!page.__lsInit) { page.__lsInit = true; await page.addInitScript(v => { try { localStorage.setItem('gs_linkscan', v); } catch (e) { } }, linkScan ? '1' : '0'); }
    await page.goto(this.app);
    await page.click('text=Abrir Câmera');
    await page.waitForSelector('#cameraScreen:not(.screen-hidden)', { timeout: 20000 });
    await page.waitForFunction(() => document.getElementById('video').videoWidth > 0, null, { timeout: 15000 });
    if (!linkScan) await page.evaluate(() => { if (window.LinkScan && LinkScan.enabled) LinkScan.toggle(); });
  }
  check(name, cond, info) {
    const ok = !!cond;
    this.results.push({ name, ok, info });
    console.log(`   ${ok ? '✔' : '✘'} ${name}${info !== undefined ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''}`);
    return ok;
  }
  /* etapa: exceções viram falha (com captura de tela) sem interromper o arquivo */
  async step(name, fn, page) {
    const t0 = Date.now();
    try {
      const r = await fn();
      console.log(`   · ${name} (${Date.now() - t0} ms)`);
      return r;
    } catch (e) {
      this.results.push({ name, ok: false, info: e.message.split('\n')[0] });
      console.log(`   ✘ ${name}: ${e.message.split('\n')[0]}`);
      if (page) { try { await page.screenshot({ path: path.join(this.outDir, 'falha_' + name.replace(/\W+/g, '_') + '.png') }); } catch (e2) { } }
      return undefined;
    }
  }
  noPageErrors(page, label = 'sem erros de JavaScript na página') {
    const errs = page.__logs.filter(l => l.startsWith('PAGEERROR'));
    this.check(label, errs.length === 0, errs.length ? errs.slice(0, 3).join(' | ') : undefined);
  }
  shot(page, file, opts) { return page.screenshot(Object.assign({ path: path.join(this.outDir, file) }, opts || {})); }
  async close() { for (const b of this.browsers) { try { await b.close(); } catch (e) { } } this.browsers = []; }
}

module.exports = { ROOT, TESTS, CACHE, OUT, startServer, Ctx, loadPlaywright, GL_ARGS };
