/* Montagem (estilo Reels): fotos na timeline, duração, transições, ordem,
   música com trecho e volume, prévia, formato e exportação para vídeo com áudio */
'use strict';
const fs = require('fs');
const path = require('path');

/* WAV mono 16 bits: tom de 440 Hz com volume pulsando (para a onda sonora) */
function makeWav(file, seconds = 20, rate = 22050) {
  const n = seconds * rate, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate, env = 0.35 + 0.3 * Math.abs(Math.sin(t * Math.PI * 2));
    b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * t) * env * 32000), 44 + i * 2);
  }
  fs.writeFileSync(file, b);
}

module.exports = {
  title: 'Montagem: timeline de fotos com música e exportação em vídeo',
  videos: ['portrait'],
  timeout: 300000,
  async run(t) {
    const page = await t.launch({ video: 'portrait' });
    const R = () => page.evaluate(() => { const s = GSReel.state; return { n: s.clips.length, total: GSReel.total(), durs: s.clips.map(c => c.dur), trans: s.clips.map(c => c.trans), ids: s.clips.map(c => c.id), t: s.t, music: !!s.music, aspect: s.aspect }; });
    await t.step('abrir câmera e tirar 3 fotos', async () => {
      await t.openCamera(page);
      for (let k = 1; k <= 3; k++) {
        await page.click('#shutterBtn');
        await page.waitForFunction(k => photos.length >= k, k);
        await page.waitForTimeout(700);
      }
      t.check('3 fotos na galeria', await page.evaluate(() => photos.length) === 3);
    }, page);

    await t.step('escolher fotos na ordem', async () => {
      await page.click('#thumbBtn');
      await page.waitForSelector('#galleryScreen:not(.screen-hidden)');
      await page.click('#reelOpenBtn');
      await page.waitForSelector('#reelScreen:not(.screen-hidden)');
      await page.waitForSelector('#reelPicker:not(.hidden)');
      const cells = await page.$$('#reelPickGrid .reel-pick-cell');
      t.check('seletor mostra as fotos da galeria', cells.length === 3, cells.length);
      await cells[2].click(); await cells[0].click(); await cells[1].click();
      const nums = await page.$$eval('#reelPickGrid .reel-pick-n', e => e.map(x => x.textContent).join(','));
      t.check('números mostram a ordem escolhida', nums === '2,3,1', nums);
      await page.click('#reelPickAdd');
      await page.waitForFunction(() => GSReel.state.clips.length === 3 && GSReel.state.clips.every(c => c.img));
      const r = await R();
      t.check('3 fotos na timeline, 3 s cada (9 s)', r.n === 3 && Math.abs(r.total - 9) < 1e-6, r);
      t.check('fotos na ordem escolhida', await page.evaluate(() => GSReel.state.clips[0].src === photos[2].dataUrl && GSReel.state.clips[1].src === photos[0].dataUrl && GSReel.state.clips[2].src === photos[1].dataUrl));
      const lum = await page.evaluate(() => { const c = document.getElementById('reelCanvas'), d = c.getContext('2d').getImageData(c.width / 2 - 50, c.height / 2 - 50, 100, 100).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; return s / (d.length / 4) / 3; });
      t.check('prévia desenha a foto', lum > 20, lum.toFixed(0));
    }, page);

    await t.step('editar fotos na timeline', async () => {
      await page.click('#reelTrack .reel-clip >> nth=1');
      await page.waitForSelector('#reelPanel:not(.hidden) #reelDur');
      await page.$eval('#reelDur', el => { el.value = 2; el.dispatchEvent(new Event('input')); });
      let r = await R();
      t.check('duração da foto 2 vira 2 s (total 8 s)', r.durs[1] === 2 && Math.abs(r.total - 8) < 1e-6, r.durs);
      await page.click('#reelPanel [data-tr="slide"]');
      r = await R();
      t.check('transição de entrada "Deslizar"', r.trans[1] === 'slide', r.trans);
      t.check('primeira foto não tem transição de entrada', r.trans[0] === 'none' && await page.$eval('#reelPanel', () => true));
      /* alça da direita da foto 1: arrastar +1 s */
      await page.click('#reelTrack .reel-clip >> nth=0');
      const h = await (await page.$('#reelTrack .reel-clip >> nth=0')).$('.reel-handle');
      const bb = await h.boundingBox();
      await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.mouse.down();
      await page.mouse.move(bb.x + bb.width / 2 + 56, bb.y + bb.height / 2, { steps: 6 }); await page.mouse.up();
      r = await R();
      t.check('arrastar a alça estica a foto (3 s → 4 s)', Math.abs(r.durs[0] - 4) < 0.15, r.durs);
      const before = r.ids;
      await page.click('#reelRight');
      r = await R();
      t.check('"Mover ▶" troca a ordem', r.ids[0] === before[1] && r.ids[1] === before[0] && r.trans[0] === 'none', r.ids);
      await page.click('#reelDup');
      r = await R();
      t.check('duplicar e excluir', r.n === 4);
      await page.click('#reelDel');
      r = await R();
      t.check('excluir volta a 3 fotos', r.n === 3, r.n);
    }, page);

    await t.step('música', async () => {
      const wav = path.join(t.outDir, 'musica-teste.wav'); makeWav(wav);
      await page.setInputFiles('#reelMusicInput', wav);
      await page.waitForFunction(() => !!GSReel.state.music, null, { timeout: 15000 });
      t.check('música carregada com onda sonora', await page.evaluate(() => !document.getElementById('reelAudio').classList.contains('hidden') && GSReel.state.music.peaks.length > 100 && /musica-teste/.test(document.getElementById('reelAudioName').textContent)));
      await page.$eval('#reelMStart', el => { el.value = 4; el.dispatchEvent(new Event('input')); });
      await page.$eval('#reelMVol', el => { el.value = 0.6; el.dispatchEvent(new Event('input')); });
      const m = await page.evaluate(() => ({ s: GSReel.state.music.start, v: GSReel.state.music.vol }));
      t.check('trecho e volume da música', m.s === 4 && m.v === 0.6, m);
      await t.shot(page, '01_montagem.png');
    }, page);

    await t.step('prévia e timeline', async () => {
      await page.evaluate(() => GSReel.seek(0));
      await page.click('#reelPlay');
      await page.waitForTimeout(1500);
      let r = await R();
      t.check('reproduz a montagem', r.t > 1 && r.t < 3, r.t.toFixed(2));
      await page.click('#reelPlay');
      await page.evaluate(() => { const tl = document.getElementById('reelTimeline'); tl.scrollLeft = 5 * 56; tl.dispatchEvent(new Event('scroll')); });
      await page.waitForTimeout(200);
      r = await R();
      t.check('arrastar a timeline muda o tempo (agulha no centro)', Math.abs(r.t - 5) < 0.1, r.t.toFixed(2));
      await page.click('.reel-aspect[data-a="1:1"]');
      t.check('formato 1:1', await page.evaluate(() => { const c = document.getElementById('reelCanvas'); return c.width === c.height; }));
      await page.click('.reel-aspect[data-a="9:16"]');
    }, page);

    await t.step('exportar vídeo', async () => {
      const total = (await R()).total;
      const n0 = await page.evaluate(() => photos.length);
      await page.click('#reelExportBtn');
      await page.waitForSelector('#reelProc:not(.hidden)');
      await t.shot(page, '02_exportando.png');
      await page.waitForSelector('#reelDone:not(.hidden)', { timeout: 90000 });
      const v = await page.evaluate(() => ({ mode: photos[0].mode, type: photos[0].type, size: photos[0].blob.size, mime: photos[0].mime, w: photos[0].w, h: photos[0].h }));
      t.check('vídeo da montagem salvo na galeria', v.mode === 'montagem' && v.type === 'video' && v.size > 20000 && await page.evaluate(() => photos.length) === n0 + 1, v);
      t.check('vídeo vertical 9:16', v.w === 720 && v.h === 1280, v);
      const a = await page.evaluate(async () => {
        const ac = new AudioContext();
        const buf = await ac.decodeAudioData(await photos[0].blob.arrayBuffer());
        const d = buf.getChannelData(0); let s = 0; for (let i = 0; i < d.length; i += 7) s += d[i] * d[i];
        return { dur: buf.duration, rms: Math.sqrt(s / (d.length / 7)) };
      });
      t.check('vídeo tem a música (áudio audível)', a.rms > 0.02, a);
      t.check('duração do vídeo ≈ duração da montagem', Math.abs(a.dur - total) < 1.5, { audio: a.dur.toFixed(2), montagem: total });
      const lum = await page.evaluate(() => new Promise(res => {
        const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.src = photos[0].dataUrl;
        v.onplaying = () => setTimeout(() => { const c = document.createElement('canvas'); c.width = 72; c.height = 128; const x = c.getContext('2d'); x.drawImage(v, 0, 0, 72, 128); const d = x.getImageData(0, 0, 72, 128).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; v.pause(); res(s / (d.length / 4) / 3); }, 700);
        v.onerror = () => res(-1); v.play().catch(() => res(-2));
      }));
      t.check('vídeo mostra as fotos (não é tela preta)', lum > 20, lum.toFixed(0));
      await page.click('#reelDone .btn-accent');
      await page.waitForSelector('#editModal:not(.hidden)');
      t.check('"Ver vídeo" abre o vídeo no editor', await page.evaluate(() => photos[editingIdx].mode === 'montagem'));
      await page.click('#editBackBtn');
    }, page);

    await t.step('voltar mantém a montagem', async () => {
      await page.click('#reelOpenBtn');
      await page.waitForSelector('#reelScreen:not(.screen-hidden)');
      const r = await R();
      t.check('montagem continua ao reabrir', r.n === 3 && r.music, r);
      await page.click('#reelScreen .back-btn');
      t.check('voltar leva à galeria', await page.evaluate(() => !document.getElementById('galleryScreen').classList.contains('screen-hidden')));
    }, page);
    t.noPageErrors(page);
  }
};
