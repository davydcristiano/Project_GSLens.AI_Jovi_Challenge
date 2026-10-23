/* Abertura da câmera: erros de permissão/dispositivo, câmera traseira por padrão, troca de câmera */
'use strict';

module.exports = {
  title: 'Câmera: erros, traseira por padrão e troca',
  async run(t) {
    /* 1. mensagens de erro claras */
    const page = await t.launch();
    const expect = { NotAllowedError: /permiss/i, NotReadableError: /(uso|ocupad|outro app)/i, NotFoundError: /(nenhuma|não encontr)/i };
    for (const [name, re] of Object.entries(expect)) {
      await page.addInitScript(n => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('x', n)); }, name);
      await page.goto(t.app);
      await page.click('text=Abrir Câmera'); await page.waitForTimeout(400);
      const msg = (await page.textContent('#homeError')) || '';
      t.check(`erro ${name} → mensagem explicativa`, re.test(msg), msg.slice(0, 90));
    }
    t.noPageErrors(page);

    /* 2. celular simulado com duas câmeras: abre na traseira, botão troca para a frontal */
    const p2 = await t.launch();
    await p2.addInitScript(() => {
      window.__calls = [];
      navigator.mediaDevices.getUserMedia = async c => {
        window.__calls.push(JSON.stringify(c.video.facingMode));
        const fm = c.video.facingMode, want = fm.exact || fm.ideal;
        const cv = document.createElement('canvas'); cv.width = 640; cv.height = 480; const x = cv.getContext('2d');
        setInterval(() => { x.fillStyle = want === 'environment' ? '#2a6' : '#a26'; x.fillRect(0, 0, 640, 480); }, 50);
        const s = cv.captureStream(15), tr = s.getVideoTracks()[0];
        tr.getSettings = () => ({ facingMode: want, width: 640, height: 480 });
        return s;
      };
    });
    await p2.goto(t.app);
    await p2.click('text=Abrir Câmera'); await p2.waitForSelector('#cameraScreen:not(.screen-hidden)');
    const r1 = await p2.evaluate(() => ({ first: __calls[0], useFront, tf: document.getElementById('video').style.transform }));
    t.check('abre pedindo a câmera traseira', /environment/.test(r1.first), r1.first);
    t.check('traseira não é espelhada', r1.useFront === false && /scaleX\(1\)/.test(r1.tf), r1.tf);
    await p2.click('.flip-btn'); await p2.waitForTimeout(500);
    const r2 = await p2.evaluate(() => ({ last: __calls[__calls.length - 1], useFront }));
    t.check('botão troca para a frontal', /user/.test(r2.last) && r2.useFront === true, r2.last);
    t.noPageErrors(p2);
  }
};
