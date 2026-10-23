/* Modo Noite (prévia clareada + empilhamento de quadros) e Slow-Mo (arquivo realmente lento) */
'use strict';
const fs = require('fs');
const path = require('path');
const { CACHE } = require('../lib/harness');

module.exports = {
  title: 'Modo Noite e Slow-Mo',
  videos: ['night'],
  timeout: 240000,
  async run(t) {
    const page = await t.launch({ video: 'night', gl: process.env.NIGHT_GL === '1' ? undefined : false, args: ['--autoplay-policy=no-user-gesture-required'] });
    await t.step('abrir câmera', () => t.openCamera(page), page);

    await t.step('Noite: prévia com redução de ruído ao vivo', async () => {
      await page.click('#modeNoite'); await page.waitForTimeout(1500);
      const st = await page.evaluate(() => ({ live: liveLayer, visivel: !document.getElementById('liveCanvas').classList.contains('hidden') }));
      t.check('prévia processada em WebGL ativa', st.live === 'noite' && st.visivel, st);
      /* ruído temporal (variação quadro a quadro) em áreas lisas: prévia nova × vídeo cru com o mesmo ganho */
      const r = await page.evaluate(async cleanUrl => {
        const lc = document.getElementById('liveCanvas'), v = document.getElementById('video'), N = GSNight._live;
        const W = lc.width, H = lc.height;
        const img = await new Promise(res => { const i = new Image(); i.onload = () => res(i); i.src = cleanUrl; });
        const cx = document.createElement('canvas'); cx.width = W; cx.height = H; const x = cx.getContext('2d', { willReadFrequently: true });
        x.drawImage(img, 0, 0, W, H); const clean = x.getImageData(0, 0, W, H).data;
        const pts = [];
        for (let y = 12; y < H - 12; y += 6) for (let xx = 12; xx < W - 12; xx += 6) {
          if (y > H * 0.68 && y < H * 0.88) continue;           /* faixa da bola */
          let flat = true; const j = (y * W + xx) * 4;
          for (let dy = -8; dy <= 8 && flat; dy += 4) for (let dx = -8; dx <= 8; dx += 4) { const i = ((y + dy) * W + xx + dx) * 4; if (Math.abs(clean[i] - clean[j]) + Math.abs(clean[i + 1] - clean[j + 1]) + Math.abs(clean[i + 2] - clean[j + 2]) > 3) { flat = false; break; } }
          if (flat) pts.push((y * W + xx) * 4);
        }
        const snaps = [], raws = []; let last = N.frames;
        const t0 = performance.now();
        while (snaps.length < 6 && performance.now() - t0 < 30000) {
          await new Promise(r => setTimeout(r, 30));
          if (N.frames === last) continue; last = N.frames;
          x.drawImage(lc, 0, 0); snaps.push(x.getImageData(0, 0, W, H).data);
          x.drawImage(v, 0, 0, W, H); raws.push(x.getImageData(0, 0, W, H).data);
        }
        const tstd = (arr, g) => { let s = 0; for (const p of pts) { let m = 0, q = 0; for (const d of arr) { const l = Math.min(255, g * (d[p] + d[p + 1] + d[p + 2]) / 3); m += l; q += l * l; } m /= arr.length; s += Math.sqrt(Math.max(0, q / arr.length - m * m)); } return s / pts.length; };
        return { pontos: pts.length, quadros: snaps.length, acumulados: N.frames, ganho: +N.gain.toFixed(2), ruidoPrevia: +tstd(snaps, 1).toFixed(2), ruidoCruComGanho: +tstd(raws, N.gain).toFixed(2) };
      }, t.url('tests/.cache/night-clean.png'));
      t.check('ruído da prévia < 50% do vídeo cru com o mesmo ganho', r.quadros >= 4 && r.ruidoPrevia < r.ruidoCruComGanho * 0.5, r);
      await t.shot(page, '01_previa_noite.png', { clip: await (await page.$('#viewfinder')).boundingBox() });
      /* filtro de cor por cima da prévia noturna */
      await page.click('.fi[data-f="lomo"]'); await page.waitForTimeout(800);
      t.check('filtro de cor aplicado sobre a prévia noturna', await page.evaluate(() => !document.getElementById('filterCanvas').classList.contains('hidden') && liveLayer === 'noite'));
      await page.click('.fi[data-f="none"]');
    }, page);

    await t.step('Noite: foto empilhada', async () => {
      /* tempo medido dentro da página (o WebGL por software do navegador de teste
         atrasa a entrega do clique, o que não acontece num celular) */
      const ms = await page.evaluate(() => new Promise(res => {
        const n = photos.length, t0 = performance.now();
        document.getElementById('shutterBtn').click();
        const iv = setInterval(() => { if (photos.length > n) { clearInterval(iv); res(Math.round(performance.now() - t0)); } }, 20);
      }));
      const info = await page.evaluate(() => photos[0].night);
      t.check('vários quadros mesclados', info && info.used >= 5, info);
      t.check('captura noturna em menos de 6 s', ms < 6000, ms + ' ms');
      /* compara com a cena limpa: a foto noturna deve ficar bem mais clara que o quadro cru
         e com menos ruído relativo ao ganho do que só clarear um quadro */
      const r = await page.evaluate(async cleanUrl => {
        const load = src => new Promise(res => { const i = new Image(); i.onload = () => res(i); i.src = src; });
        const grab = el => { const c = document.createElement('canvas'); c.width = 1280; c.height = 720; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(el, 0, 0, 1280, 720); return x.getImageData(0, 0, 1280, 720).data; };
        const a = grab(await load(photos[0].dataUrl)), raw = grab(document.getElementById('video')), clean = grab(await load(cleanUrl));
        const mean = d => { let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; return s / (d.length / 4 * 3); };
        const blockStd = (d, bx, by) => { let m = 0, q = 0; for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const i = ((by + y) * 1280 + bx + x) * 4, g = (d[i] + d[i + 1] + d[i + 2]) / 3; m += g; q += g * g; } m /= 256; return Math.sqrt(Math.max(0, q / 256 - m * m)); };
        /* blocos lisos na cena limpa (com margem para o tremor), fora da faixa da bola */
        const blocks = [];
        for (let by = 16; by < 700; by += 16) for (let bx = 16; bx < 1260; bx += 16) {
          if (by > 490 && by < 630) continue;
          let flat = true;
          for (let y = -6; y < 22 && flat; y += 2) for (let x = -6; x < 22; x += 2) { const i = ((by + y) * 1280 + bx + x) * 4, j = (by * 1280 + bx) * 4; if (Math.abs(clean[i] - clean[j]) + Math.abs(clean[i + 1] - clean[j + 1]) + Math.abs(clean[i + 2] - clean[j + 2]) > 3) { flat = false; break; } }
          if (flat) blocks.push([bx, by]);
        }
        const noise = d => blocks.reduce((s, [x, y]) => s + blockStd(d, x, y), 0) / blocks.length;
        return { blocos: blocks.length, ganho: mean(a) / Math.max(1, mean(raw)), ruidoFoto: noise(a), ruidoCru: noise(raw) };
      }, t.url('tests/.cache/night-clean.png'));
      t.check('foto noturna ≥ 2,5× mais clara que o quadro cru', r.ganho >= 2.5, r.ganho.toFixed(2) + '×');
      t.check('ruído por unidade de ganho menor que o de um único quadro', r.ruidoFoto / r.ganho < r.ruidoCru * 0.8, { blocos: r.blocos, ruidoFoto: r.ruidoFoto.toFixed(2), ganho: r.ganho.toFixed(2), ruidoCru: r.ruidoCru.toFixed(2) });
      const durl = await page.evaluate(() => photos[0].dataUrl);
      fs.writeFileSync(path.join(t.outDir, 'foto_noite.jpg'), Buffer.from(durl.split(',')[1], 'base64'));
      if (fs.existsSync(path.join(CACHE, 'night-clean.png'))) fs.copyFileSync(path.join(CACHE, 'night-clean.png'), path.join(t.outDir, 'cena_limpa.png'));
    }, page);

    await t.step('sair do Noite restaura a prévia', async () => {
      await page.click('#modeFoto'); await page.waitForTimeout(400);
      t.check('sem processamento fora do modo Noite', await page.evaluate(() => document.getElementById('video').style.filter === 'none' && document.getElementById('liveCanvas').classList.contains('hidden') && !liveLayer));
    }, page);

    await t.step('Slow-Mo', async () => {
      await page.click('#modeSlowMo'); await page.waitForTimeout(400);
      await page.click('#shutterBtn'); await page.waitForTimeout(3000); await page.click('#shutterBtn');
      await page.waitForFunction(() => photos[0] && photos[0].mode === 'slowmo', null, { timeout: 60000 });
      const info = await page.evaluate(async () => {
        const p = photos[0], v = document.createElement('video'); v.muted = true; v.src = p.dataUrl;
        await new Promise(r => v.onloadedmetadata = r);
        let dur = v.duration;
        if (!isFinite(dur)) { v.currentTime = 1e9; await new Promise(r => v.ontimeupdate = r); dur = v.duration; }
        return { slow: p.slow, dur, size: p.blob.size };
      });
      t.check('arquivo Slow-Mo gerado (½×)', info.slow && info.slow.baked && info.slow.rate === 0.5, info.slow);
      const ratio = info.dur / info.slow.srcSeconds;
      t.check('duração do arquivo ≈ 2× o tempo gravado', ratio > 1.75 && ratio < 2.3, `${info.slow.srcSeconds} s gravados → ${info.dur.toFixed(2)} s`);
    }, page);

    await t.step('Slow-Mo: cancelar guarda o original', async () => {
      await page.click('#shutterBtn'); await page.waitForTimeout(2000); await page.click('#shutterBtn');
      await page.waitForSelector('#camProcCancel:not(.hidden)'); await page.waitForTimeout(600);
      await page.click('#camProcCancel');
      await page.waitForFunction(() => photos[0] && photos[0].slow && !photos[0].slow.baked, null, { timeout: 20000 });
      await page.click('#thumbBtn'); await (await page.$('.gal-cell video')).click(); await page.waitForTimeout(600);
      t.check('original toca a ½× no app', await page.evaluate(() => document.getElementById('modalVideo').playbackRate === 0.5));
    }, page);
    t.noPageErrors(page);
  }
};
