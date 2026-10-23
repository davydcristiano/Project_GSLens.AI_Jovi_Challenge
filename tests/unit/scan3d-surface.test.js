/* Scanner 3D SEM prancha, com cena sintética de pose conhecida:
   rastreamento da mesa, autocalibração (focal + inclinação desconhecidas) e modelo final */
'use strict';
const fs = require('fs');
const path = require('path');

const CASES = [
  /* caneca, referência a 30 cm inclinada (inclinação NÃO informada ao algoritmo) */
  { q: '?step=2&obj=mug', scale: 1, label: 'caneca' },
  /* caixa colorida, sombras projetadas, referência a 40 cm e mais inclinada → escala 0,75× */
  { q: '?step=2&obj=box&shadows=1&d=400&ax=0.2&ay=0.12', scale: 300 / 400, label: 'caixa+sombras, ref. a 40 cm' },
];

module.exports = {
  title: 'Scanner 3D sem prancha: rastreamento, autocalibração e reconstrução',
  slow: true,
  timeout: 1500000,
  async run(t) {
    for (const c of CASES) {
      const page = await t.launch();
      page.setDefaultTimeout(900000);
      await page.goto(t.url('tests/unit/surface.html' + c.q));
      await page.waitForFunction(() => window.__result !== undefined, null, { timeout: 900000 });
      const r = await page.evaluate(() => window.__result);
      const L = `[${c.label}]`;
      if (!t.check(`${L} execução sem erro`, !r.error, r.error && r.error.split('\n')[0])) continue;
      t.check(`${L} rastreamento sem perdas`, r.lost === 0, `${r.lost} de ${r.frames} quadros`);
      t.check(`${L} erro de rastreamento p95 < 1 px`, r.trackErrPx.p95 < 1, r.trackErrPx);
      t.check(`${L} focal autocalibrada com erro < 2%`, Math.abs(r.focalErrPct) < 2, r.focalErrPct + '%');
      const got = r.stats.sizeMm.slice().sort((a, b) => a - b), truth = r.truth.dims.map(v => v * c.scale).sort((a, b) => a - b);
      const errs = got.map((g, i) => g / truth[i] - 1);
      t.check(`${L} dimensões dentro de −8%/+35% do esperado`, errs.every(e => e > -0.08 && e < 0.35), got.map(v => v.toFixed(1)).join('×') + ' mm (esperado ' + truth.map(v => v.toFixed(1)).join('×') + ')');
      t.check(`${L} malha fechada com textura`, r.stats.openEdges === 0 && r.stats.coverage > 0.6, { tri: r.stats.triangles, cobertura: +r.stats.coverage.toFixed(2) });
      const img = await page.evaluate(() => window.__debugImg);
      if (img) fs.writeFileSync(path.join(t.outDir, 'textura_' + c.label.replace(/\W+/g, '_') + '.png'), Buffer.from(img.split(',')[1], 'base64'));
      t.noPageErrors(page, `${L} sem erros de JavaScript`);
      await page.close();
    }
  }
};
