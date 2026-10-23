# Testes automáticos — GSLens.AI

Testes reais da interface com uma **câmera simulada**: o Chromium recebe um vídeo
sintético no lugar da webcam (`--use-file-for-fake-video-capture`) e o teste usa o app
como uma pessoa usaria — abre a câmera, fotografa, edita, escaneia em 3D, exporta.

## Como rodar

```bash
cd tests
npm install                 # instala o Playwright
npx playwright install chromium
npm test                    # tudo (≈ 15 min na primeira vez, por causa dos vídeos)
npm run test:quick          # sem o escaneamento 3D completo
node run-all.js links noite # só os arquivos cujo nome contém "links" ou "noite"
```

O resumo aparece no terminal; o código de saída é 1 se alguma verificação falhar.
Capturas de tela e arquivos exportados ficam em `tests/.out/<teste>/`.
Para o validador independente dos formatos 3D é preciso `python3` + `numpy`
(sem eles a etapa é pulada com aviso).

## Organização

| Pasta | Conteúdo |
|---|---|
| `run-all.js` | executor: sobe um servidor local (porta 8790, ou `TEST_PORT`), gera os vídeos que faltam, roda os testes e resume |
| `lib/harness.js` | servidor estático, abertura do Chromium com câmera simulada, `check()` / `step()` |
| `lib/validate_exports.py` | validador independente de GLB, glTF, OBJ, FBX e STL |
| `fixtures/` | geradores dos vídeos de câmera (`videos.html`, `synth.js` — cena 3D com pose conhecida), página de teste aberta pelo QR |
| `unit/` | testes de módulos isolados (matemática e pipeline do scanner 3D) |
| `e2e/` | testes de ponta a ponta da interface |
| `vendor/three/` | three.js r160 (módulos ES) e carregadores GLTF/OBJ/STL/FBX — usados só nos testes, para reabrir os modelos exportados |

Os vídeos gerados ficam em `tests/.cache/` e são reaproveitados enquanto os geradores
não mudam.

## Escrevendo um teste

Crie `e2e/<nome>.test.js`:

```js
module.exports = {
  title: 'O que este arquivo testa',
  videos: ['links'],          // vídeos de câmera necessários (fixtures/videos.html)
  timeout: 120000,
  async run(t) {
    const page = await t.launch({ video: 'links' });
    await t.openCamera(page);
    await t.step('tirar foto', async () => {
      await page.click('#shutterBtn');
      await page.waitForFunction(() => photos.length === 1);
      t.check('foto salva', await page.evaluate(() => photos[0].type === 'photo'));
    }, page);
    t.noPageErrors(page);
  }
};
```

Observação: o teste de Noite/Slow-Mo roda sem a renderização WebGL por software
forçada — com ela o canvas 2D fica muito mais lento que num celular real.
