#!/usr/bin/env node
/* Executa todos os testes automáticos.
   Uso:  node run-all.js            → todos
         node run-all.js links noite → só os arquivos cujo nome contém "links" ou "noite"
         node run-all.js --quick     → pula os testes longos (scanner 3D completo)
   Saída: relatório no terminal; capturas e arquivos em tests/.out/; código 1 se algo falhar. */
'use strict';
const fs = require('fs');
const path = require('path');
const { startServer, Ctx } = require('./lib/harness');
const { buildFixtures } = require('./fixtures/build');

(async () => {
  const args = process.argv.slice(2);
  const quick = args.includes('--quick');
  const filters = args.filter(a => !a.startsWith('--'));
  const files = ['unit', 'e2e'].flatMap(d => fs.readdirSync(path.join(__dirname, d)).filter(f => f.endsWith('.test.js')).sort().map(f => path.join(d, f)));
  const chosen = files.map(f => ({ f, mod: require('./' + f) }))
    .filter(({ f }) => !filters.length || filters.some(x => f.includes(x)))
    .filter(({ mod }) => !(quick && mod.slow));

  const server = await startServer();
  const needed = [...new Set(chosen.flatMap(({ mod }) => mod.videos || []))];
  if (needed.length) await buildFixtures(server.base, needed);

  const summary = [];
  const t0 = Date.now();
  for (const { f, mod } of chosen) {
    console.log(`\n▶ ${f} — ${mod.title}`);
    const ctx = new Ctx(path.basename(f, '.test.js'), server.base);
    const ts = Date.now();
    let crashed = null;
    const timeout = mod.timeout || 180000;
    try {
      await Promise.race([
        mod.run(ctx),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`tempo esgotado (${timeout / 1000}s)`)), timeout))
      ]);
    } catch (e) { crashed = e; ctx.check('execução do arquivo', false, e.message.split('\n')[0]); }
    await ctx.close();
    const fails = ctx.results.filter(r => !r.ok).length;
    summary.push({ f, total: ctx.results.length, fails, s: ((Date.now() - ts) / 1000).toFixed(1) });
  }
  await server.close();

  console.log('\n══════ RESUMO ══════');
  for (const s of summary) console.log(`${s.fails ? '✘' : '✔'} ${s.f.padEnd(34)} ${String(s.total - s.fails).padStart(3)}/${s.total} verificações  ${s.s}s`);
  const totalFails = summary.reduce((a, s) => a + s.fails, 0);
  const total = summary.reduce((a, s) => a + s.total, 0);
  console.log(`\n${totalFails ? '✘' : '✔'} ${total - totalFails}/${total} verificações em ${((Date.now() - t0) / 1000).toFixed(0)}s — detalhes em tests/.out/`);
  process.exit(totalFails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
