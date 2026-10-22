/* ═══════════════════════════════════════════════════
   GSLens.AI — Molduras Clássicas e Modernas
   Todas desenhadas por código (canvas), em qualquer
   resolução, sem imagens externas.
   GSFrames.render(srcCanvas, id, info) -> canvas | null
═══════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  const LIST = [
    { id: 'wood', name: '🪵 Madeira', group: 'classic' },
    { id: 'museum', name: '🖼️ Passe-partout', group: 'classic' },
    { id: 'ornate', name: '👑 Ornamentada', group: 'classic' },
    { id: 'deckled', name: '📜 Serrilhada', group: 'classic' },
    { id: 'slide', name: '🎞️ Slide 35mm', group: 'classic' },
    { id: 'antique', name: '🕰️ Antiga', group: 'classic' },
    { id: 'neon', name: '💡 Neon', group: 'modern' },
    { id: 'gradient', name: '🌈 Gradiente', group: 'modern' },
    { id: 'glass', name: '🫧 Vidro', group: 'modern' },
    { id: 'story', name: '📱 Story 9:16', group: 'modern' },
    { id: 'tape', name: '🩹 Fita adesiva', group: 'modern' },
    { id: 'cinema', name: '🎬 Cinema', group: 'modern' },
    { id: 'gallery', name: '🏛️ Galeria', group: 'modern' }
  ];
  const IDS = new Set(LIST.map(f => f.id));

  /* pseudo-aleatório determinístico (mesma moldura sempre igual) */
  function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
  function rr(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function make(w, h) { const c = document.createElement('canvas'); c.width = Math.round(w); c.height = Math.round(h); return c; }
  function blurredCover(src, w, h, blurPx, darken) {
    const c = make(w, h), x = c.getContext('2d');
    const s = Math.max(w / src.width, h / src.height) * 1.1;
    x.filter = `blur(${Math.round(blurPx)}px)`;
    x.drawImage(src, (w - src.width * s) / 2, (h - src.height * s) / 2, src.width * s, src.height * s);
    x.filter = 'none';
    if (darken) { x.fillStyle = `rgba(0,0,0,${darken})`; x.fillRect(0, 0, w, h); }
    return c;
  }

  const R = {
    /* ── Clássicas ── */
    wood(src) {
      const iw = src.width, ih = src.height, b = Math.round(Math.max(iw, ih) * 0.07);
      const c = make(iw + 2 * b, ih + 2 * b), x = c.getContext('2d'), W = c.width, H = c.height, rnd = rng(7);
      const grain = (horizontal) => {
        const g = make(horizontal ? W : b, horizontal ? b : H), gx = g.getContext('2d');
        gx.fillStyle = '#7a4a24'; gx.fillRect(0, 0, g.width, g.height);
        const L = horizontal ? g.height : g.width, len = horizontal ? g.width : g.height;
        for (let i = 0; i < L * 1.2; i++) {
          const p = rnd() * L, tone = 40 + rnd() * 50;
          gx.strokeStyle = `rgba(${tone + 50},${tone + 10},${tone - 20},${0.15 + rnd() * 0.25})`;
          gx.lineWidth = 0.5 + rnd() * Math.max(1, L / 60);
          gx.beginPath();
          const amp = rnd() * L * 0.05, fr = 2 + rnd() * 6;
          for (let t = 0; t <= len; t += Math.max(4, len / 120)) {
            const q = p + Math.sin(t / len * fr * Math.PI) * amp;
            horizontal ? (t ? gx.lineTo(t, q) : gx.moveTo(t, q)) : (t ? gx.lineTo(q, t) : gx.moveTo(q, t));
          }
          gx.stroke();
        }
        return g;
      };
      const gh = grain(true), gv = grain(false);
      /* 4 réguas com cantos em 45° (como moldura de verdade) */
      const piece = (img, pts) => { x.save(); x.beginPath(); pts.forEach((p, i) => i ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1])); x.closePath(); x.clip(); x.drawImage(img, pts.ox || 0, pts.oy || 0); x.restore(); };
      const top = [[0, 0], [W, 0], [W - b, b], [b, b]]; top.ox = 0; top.oy = 0;
      const bot = [[0, H], [W, H], [W - b, H - b], [b, H - b]]; bot.ox = 0; bot.oy = H - b;
      const lef = [[0, 0], [b, b], [b, H - b], [0, H]]; lef.ox = 0; lef.oy = 0;
      const rig = [[W, 0], [W - b, b], [W - b, H - b], [W, H]]; rig.ox = W - b; rig.oy = 0;
      piece(gh, top); piece(gh, bot); piece(gv, lef); piece(gv, rig);
      /* relevo: luz em cima/esquerda, sombra embaixo/direita */
      const shade = (pts, col) => { x.beginPath(); pts.forEach((p, i) => i ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1])); x.closePath(); x.fillStyle = col; x.fill(); };
      shade(top, 'rgba(255,230,190,.12)'); shade(lef, 'rgba(255,230,190,.08)'); shade(bot, 'rgba(0,0,0,.25)'); shade(rig, 'rgba(0,0,0,.18)');
      x.strokeStyle = 'rgba(0,0,0,.35)'; x.lineWidth = Math.max(1, b * 0.03);
      [[0, 0, b, b], [W, 0, W - b, b], [0, H, b, H - b], [W, H, W - b, H - b]].forEach(([a, bb, c2, d]) => { x.beginPath(); x.moveTo(a, bb); x.lineTo(c2, d); x.stroke(); });
      x.drawImage(src, b, b);
      /* filete dourado interno */
      x.strokeStyle = '#c9a24a'; x.lineWidth = Math.max(2, b * 0.08); x.strokeRect(b - x.lineWidth / 2, b - x.lineWidth / 2, iw + x.lineWidth, ih + x.lineWidth);
      x.strokeStyle = 'rgba(0,0,0,.45)'; x.lineWidth = Math.max(1, b * 0.03); x.strokeRect(b, b, iw, ih);
      return c;
    },
    museum(src) {
      const iw = src.width, ih = src.height, m = Math.round(Math.max(iw, ih) * 0.11), f = Math.round(Math.max(iw, ih) * 0.025);
      const c = make(iw + 2 * (m + f), ih + 2 * (m + f)), x = c.getContext('2d'), W = c.width, H = c.height;
      x.fillStyle = '#1b1b1d'; x.fillRect(0, 0, W, H);                              /* moldura fina escura */
      x.fillStyle = 'rgba(255,255,255,.12)'; x.fillRect(0, 0, W, Math.max(1, f * 0.25));
      x.fillStyle = '#f3efe6'; x.fillRect(f, f, W - 2 * f, H - 2 * f);              /* passe-partout */
      const bev = Math.max(2, m * 0.06);                                            /* chanfro do recorte */
      x.fillStyle = '#d9d2c3'; x.fillRect(f + m - bev, f + m - bev, iw + 2 * bev, ih + 2 * bev);
      x.fillStyle = '#fffdf8'; x.beginPath(); x.moveTo(f + m - bev, f + m - bev); x.lineTo(f + m + iw + bev, f + m - bev); x.lineTo(f + m + iw, f + m); x.lineTo(f + m, f + m); x.lineTo(f + m, f + m + ih); x.lineTo(f + m - bev, f + m + ih + bev); x.closePath(); x.fill();
      x.drawImage(src, f + m, f + m);
      return c;
    },
    ornate(src) {
      const iw = src.width, ih = src.height, b = Math.round(Math.max(iw, ih) * 0.09);
      const c = make(iw + 2 * b, ih + 2 * b), x = c.getContext('2d'), W = c.width, H = c.height;
      const g = x.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, '#7a5414'); g.addColorStop(0.25, '#f2d27a'); g.addColorStop(0.5, '#a8771f'); g.addColorStop(0.75, '#f7df92'); g.addColorStop(1, '#6b4810');
      x.fillStyle = g; x.fillRect(0, 0, W, H);
      /* perfis concêntricos */
      const lines = [[0.12, 'rgba(60,35,5,.7)'], [0.2, 'rgba(255,240,190,.7)'], [0.55, 'rgba(60,35,5,.55)'], [0.62, 'rgba(255,240,190,.6)'], [0.86, 'rgba(60,35,5,.7)']];
      for (const [t, col] of lines) { x.strokeStyle = col; x.lineWidth = Math.max(1, b * 0.035); const o = b * t; x.strokeRect(o, o, W - 2 * o, H - 2 * o); }
      /* contas decorativas entre os perfis */
      const o = b * 0.375, step = b * 0.32, rad = b * 0.075;
      const bead = (cx, cy) => { const rg = x.createRadialGradient(cx - rad * 0.3, cy - rad * 0.3, rad * 0.1, cx, cy, rad); rg.addColorStop(0, '#fff3c4'); rg.addColorStop(1, '#8a5f17'); x.fillStyle = rg; x.beginPath(); x.arc(cx, cy, rad, 0, Math.PI * 2); x.fill(); };
      for (let t = o + step; t < W - o - step / 2; t += step) { bead(t, o); bead(t, H - o); }
      for (let t = o + step; t < H - o - step / 2; t += step) { bead(o, t); bead(W - o, t); }
      /* ornamentos nos cantos */
      const orn = (cx, cy, sx, sy) => {
        x.save(); x.translate(cx, cy); x.scale(sx, sy);
        x.fillStyle = '#fbe7a4'; x.strokeStyle = 'rgba(60,35,5,.8)'; x.lineWidth = Math.max(1, b * 0.03);
        x.beginPath(); x.arc(0, 0, b * 0.42, 0, Math.PI * 2); x.fill(); x.stroke();
        for (let k = 0; k < 8; k++) { x.save(); x.rotate(k * Math.PI / 4); x.beginPath(); x.ellipse(b * 0.28, 0, b * 0.12, b * 0.05, 0, 0, Math.PI * 2); x.fillStyle = '#b8862b'; x.fill(); x.restore(); }
        x.beginPath(); x.arc(0, 0, b * 0.12, 0, Math.PI * 2); x.fillStyle = '#7a5414'; x.fill();
        x.restore();
      };
      orn(o, o, 1, 1); orn(W - o, o, -1, 1); orn(o, H - o, 1, -1); orn(W - o, H - o, -1, -1);
      x.fillStyle = 'rgba(0,0,0,.5)'; x.fillRect(b - 3, b - 3, iw + 6, ih + 6);
      x.drawImage(src, b, b);
      return c;
    },
    deckled(src) {
      const iw = src.width, ih = src.height, b = Math.round(Math.max(iw, ih) * 0.06), out = Math.round(b * 0.6);
      const c = make(iw + 2 * (b + out), ih + 2 * (b + out)), x = c.getContext('2d'), W = c.width, H = c.height;
      x.fillStyle = '#d8d0c0'; x.fillRect(0, 0, W, H);                               /* fundo de linho */
      const rnd = rng(3);
      for (let i = 0; i < W * H / 900; i++) { x.fillStyle = `rgba(120,105,80,${rnd() * 0.08})`; x.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 3, 1); }
      /* papel com borda recortada em ondinhas (tesoura de picotar) */
      const L = out, R = W - out, T = out, B = H - out, step = Math.max(6, b * 0.28), amp = step * 0.32;
      x.beginPath();
      for (let t = L; t <= R; t += step) x.arc(t + step / 2, T, step / 2, Math.PI, 0);
      for (let t = T; t <= B; t += step) x.arc(R, t + step / 2, step / 2, -Math.PI / 2, Math.PI / 2);
      for (let t = R; t >= L; t -= step) x.arc(t - step / 2, B, step / 2, 0, Math.PI);
      for (let t = B; t >= T; t -= step) x.arc(L, t - step / 2, step / 2, Math.PI / 2, Math.PI * 1.5);
      x.closePath();
      x.save(); x.shadowColor = 'rgba(0,0,0,.35)'; x.shadowBlur = amp * 3; x.shadowOffsetY = amp; x.fillStyle = '#f6efdf'; x.fill(); x.restore();
      x.drawImage(src, out + b, out + b);
      x.fillStyle = 'rgba(160,120,60,.12)'; x.fillRect(out + b, out + b, iw, ih);   /* leve envelhecimento */
      return c;
    },
    slide(src) {
      const iw = src.width, ih = src.height, s = Math.max(iw, ih), b = Math.round(s * 0.1);
      const c = make(s + 2 * b, s + 2 * b), x = c.getContext('2d'), W = c.width, H = c.height;
      const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#f2f2ee'); g.addColorStop(1, '#d9d9d2');
      x.fillStyle = '#2a2a2a'; x.fillRect(0, 0, W, H);
      rr(x, 0, 0, W, H, b * 0.5); x.fillStyle = g; x.fill();
      /* janela com cantos arredondados no formato da foto (moldura de slide quadrada) */
      const ix = (W - iw) / 2, iy = (H - ih) / 2;
      x.save(); rr(x, ix, iy, iw, ih, b * 0.18); x.clip(); x.drawImage(src, ix, iy); x.restore();
      x.strokeStyle = 'rgba(0,0,0,.3)'; x.lineWidth = Math.max(1, b * 0.04); rr(x, ix, iy, iw, ih, b * 0.18); x.stroke();
      const ty = Math.max(b * 0.5, iy / 2);
      x.fillStyle = '#6c6c66'; x.font = `600 ${Math.round(b * 0.32)}px sans-serif`; x.textBaseline = 'middle';
      x.fillText('GSLENS 35mm', b * 0.6, ty);
      x.textAlign = 'right'; x.fillText(new Date().toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' }).toUpperCase(), W - b * 0.6, H - ty);
      return c;
    },
    antique(src) {
      const iw = src.width, ih = src.height, b = Math.round(Math.max(iw, ih) * 0.08);
      const c = make(iw + 2 * b, ih + 2.6 * b), x = c.getContext('2d'), W = c.width, H = c.height;
      x.fillStyle = '#efe2c4'; x.fillRect(0, 0, W, H);
      const rg = x.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75);
      rg.addColorStop(0, 'rgba(0,0,0,0)'); rg.addColorStop(1, 'rgba(110,70,20,.35)'); x.fillStyle = rg; x.fillRect(0, 0, W, H);
      const rnd = rng(11);
      for (let i = 0; i < 18; i++) { const r = (0.02 + rnd() * 0.06) * W; const g2 = x.createRadialGradient(0, 0, 0, 0, 0, r); x.save(); x.translate(rnd() * W, rnd() * H); g2.addColorStop(0, 'rgba(140,95,40,.12)'); g2.addColorStop(1, 'rgba(140,95,40,0)'); x.fillStyle = g2; x.fillRect(-r, -r, 2 * r, 2 * r); x.restore(); }
      x.strokeStyle = '#7a5a2e'; x.lineWidth = Math.max(1, b * 0.04);
      x.strokeRect(b * 0.45, b * 0.45, W - b * 0.9, H - b * 0.9);
      x.lineWidth = Math.max(1, b * 0.015); x.strokeRect(b * 0.6, b * 0.6, W - b * 1.2, H - b * 1.2);
      x.drawImage(src, b, b);
      x.fillStyle = 'rgba(120,80,20,.18)'; x.fillRect(b, b, iw, ih);
      x.fillStyle = '#6b4d24'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.font = `italic ${Math.round(b * 0.42)}px Georgia, serif`;
      x.fillText(new Date().toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' }), W / 2, ih + b + (H - ih - b) / 2 - b * 0.1);
      return c;
    },

    /* ── Modernas ── */
    neon(src) {
      const iw = src.width, ih = src.height, b = Math.round(Math.max(iw, ih) * 0.08);
      const c = make(iw + 2 * b, ih + 2 * b), x = c.getContext('2d'), W = c.width, H = c.height;
      x.fillStyle = '#06060c'; x.fillRect(0, 0, W, H);
      const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#00e5ff'); g.addColorStop(0.5, '#a855f7'); g.addColorStop(1, '#ff2bd6');
      const r = b * 0.35, o = b * 0.45;
      for (const [blur, lw, a] of [[b * 0.9, b * 0.16, 0.6], [b * 0.4, b * 0.1, 0.9], [0, b * 0.05, 1]]) {
        x.save(); x.shadowColor = '#c084fc'; x.shadowBlur = blur; x.globalAlpha = a; x.strokeStyle = g; x.lineWidth = lw;
        rr(x, o, o, W - 2 * o, H - 2 * o, r); x.stroke(); x.restore();
      }
      x.save(); rr(x, b, b, iw, ih, r * 0.6); x.clip(); x.drawImage(src, b, b); x.restore();
      x.strokeStyle = 'rgba(255,255,255,.85)'; x.lineWidth = Math.max(1, b * 0.02); rr(x, o, o, W - 2 * o, H - 2 * o, r); x.stroke();
      return c;
    },
    gradient(src) {
      const iw = src.width, ih = src.height, b = Math.round(Math.max(iw, ih) * 0.05);
      const c = make(iw + 2 * b, ih + 2 * b), x = c.getContext('2d'), W = c.width, H = c.height;
      const g = x.createLinearGradient(0, H, W, 0);
      g.addColorStop(0, '#feda75'); g.addColorStop(0.3, '#fa7e1e'); g.addColorStop(0.55, '#d62976'); g.addColorStop(0.8, '#962fbf'); g.addColorStop(1, '#4f5bd5');
      x.fillStyle = g; x.fillRect(0, 0, W, H);
      x.save(); rr(x, b, b, iw, ih, b * 0.9); x.clip(); x.drawImage(src, b, b); x.restore();
      return c;
    },
    glass(src) {
      const iw = src.width, ih = src.height, b = Math.round(Math.max(iw, ih) * 0.1);
      const W = iw + 2 * b, H = ih + 2 * b;
      const c = blurredCover(src, W, H, Math.max(iw, ih) * 0.04, 0.12), x = c.getContext('2d');
      x.fillStyle = 'rgba(255,255,255,.08)'; x.fillRect(0, 0, W, H);
      x.save(); x.shadowColor = 'rgba(0,0,0,.45)'; x.shadowBlur = b * 0.6; x.shadowOffsetY = b * 0.15; rr(x, b, b, iw, ih, b * 0.35); x.fillStyle = '#000'; x.fill(); x.restore();
      x.save(); rr(x, b, b, iw, ih, b * 0.35); x.clip(); x.drawImage(src, b, b); x.restore();
      x.strokeStyle = 'rgba(255,255,255,.55)'; x.lineWidth = Math.max(1, b * 0.03); rr(x, b, b, iw, ih, b * 0.35); x.stroke();
      return c;
    },
    story(src) {
      const iw = src.width, ih = src.height;
      const W = Math.round(Math.max(iw, ih * 9 / 16) * 1.0), H = Math.round(W * 16 / 9);
      const c = blurredCover(src, W, H, W * 0.05, 0.25), x = c.getContext('2d');
      const m = W * 0.07, s = Math.min((W - 2 * m) / iw, (H * 0.72) / ih), dw = iw * s, dh = ih * s;
      const dx = (W - dw) / 2, dy = (H - dh) / 2;
      x.save(); x.shadowColor = 'rgba(0,0,0,.5)'; x.shadowBlur = W * 0.04; x.shadowOffsetY = W * 0.012; rr(x, dx, dy, dw, dh, W * 0.04); x.fillStyle = '#000'; x.fill(); x.restore();
      x.save(); rr(x, dx, dy, dw, dh, W * 0.04); x.clip(); x.drawImage(src, dx, dy, dw, dh); x.restore();
      x.fillStyle = 'rgba(255,255,255,.9)'; x.font = `700 ${Math.round(W * 0.045)}px system-ui, sans-serif`; x.textAlign = 'center';
      x.fillText('GSLens.AI', W / 2, dy + dh + W * 0.11);
      return c;
    },
    tape(src) {
      const iw = src.width, ih = src.height, p = Math.round(Math.max(iw, ih) * 0.035), m = Math.round(Math.max(iw, ih) * 0.1);
      const pw = iw + 2 * p, ph = ih + 2 * p + p * 2.5;
      const c = make(pw + 2 * m, ph + 2 * m), x = c.getContext('2d'), W = c.width, H = c.height, rnd = rng(5);
      x.fillStyle = '#f4efe6'; x.fillRect(0, 0, W, H);                               /* papel de caderno */
      x.strokeStyle = 'rgba(80,140,200,.18)'; x.lineWidth = Math.max(1, W / 600);
      for (let y = m * 0.5; y < H; y += Math.max(12, W / 28)) { x.beginPath(); x.moveTo(0, y); x.lineTo(W, y); x.stroke(); }
      x.save(); x.translate(W / 2, H / 2); x.rotate(-0.025);
      x.shadowColor = 'rgba(0,0,0,.28)'; x.shadowBlur = m * 0.25; x.shadowOffsetY = m * 0.06;
      x.fillStyle = '#fff'; x.fillRect(-pw / 2, -ph / 2, pw, ph); x.shadowColor = 'transparent';
      x.drawImage(src, -pw / 2 + p, -ph / 2 + p);
      const tape = (cx, cy, ang) => {
        x.save(); x.translate(cx, cy); x.rotate(ang);
        const tw = m * 1.4, th = m * 0.42;
        x.fillStyle = 'rgba(250,235,160,.62)'; x.beginPath();
        x.moveTo(-tw / 2, -th / 2);
        for (let k = 0; k <= 6; k++) x.lineTo(-tw / 2 + tw * k / 6, -th / 2 + (rnd() - 0.5) * th * 0.12);
        for (let k = 6; k >= 0; k--) x.lineTo(-tw / 2 + tw * k / 6, th / 2 + (rnd() - 0.5) * th * 0.12);
        x.closePath(); x.fill(); x.restore();
      };
      tape(-pw / 2 + m * 0.2, -ph / 2 + m * 0.1, -0.7); tape(pw / 2 - m * 0.2, -ph / 2 + m * 0.1, 0.7);
      x.restore();
      return c;
    },
    cinema(src) {
      const iw = src.width, ih = src.height, ar = 2.39;
      let cw = iw, ch = Math.round(iw / ar);
      if (ch > ih) { ch = ih; cw = Math.round(ih * ar); }
      const bar = Math.round(ch * 0.16);
      const c = make(cw, ch + 2 * bar), x = c.getContext('2d'), W = c.width, H = c.height;
      x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
      x.drawImage(src, (iw - cw) / 2, (ih - ch) / 2, cw, ch, 0, bar, cw, ch);
      x.fillStyle = 'rgba(255,255,255,.75)'; x.font = `500 ${Math.round(bar * 0.32)}px ui-monospace, monospace`; x.textBaseline = 'middle';
      x.fillText('● REC', bar * 0.4, bar / 2);
      x.textAlign = 'right'; x.fillText('2.39 : 1', W - bar * 0.4, bar / 2);
      x.textAlign = 'center'; x.font = `italic ${Math.round(bar * 0.34)}px Georgia, serif`; x.fillText('GSLens.AI', W / 2, H - bar / 2);
      return c;
    },
    gallery(src, info) {
      const iw = src.width, ih = src.height, m = Math.round(Math.max(iw, ih) * 0.12), cap = Math.round(m * 1.1);
      const c = make(iw + 2 * m, ih + 2 * m + cap), x = c.getContext('2d'), W = c.width, H = c.height;
      x.fillStyle = '#ffffff'; x.fillRect(0, 0, W, H);
      x.strokeStyle = '#111'; x.lineWidth = Math.max(1, m * 0.02); x.strokeRect(m * 0.35, m * 0.35, W - m * 0.7, H - m * 0.7);
      x.drawImage(src, m, m);
      const d = new Date(info && info.date || Date.now());
      x.fillStyle = '#111'; x.textAlign = 'left'; x.textBaseline = 'alphabetic';
      x.font = `600 ${Math.round(m * 0.24)}px system-ui, sans-serif`; x.fillText('Sem título', m, m + ih + m * 0.6);
      x.fillStyle = '#777'; x.font = `${Math.round(m * 0.18)}px system-ui, sans-serif`;
      x.fillText('Fotografia digital · ' + d.toLocaleDateString('pt-BR'), m, m + ih + m * 0.95);
      x.textAlign = 'right'; x.fillText('GSLens.AI', W - m, m + ih + m * 0.95);
      return c;
    }
  };

  function render(src, id, info) {
    const fn = R[id];
    return fn ? fn(src, info) : null;
  }

  root.GSFrames = { LIST, has: id => IDS.has(id), render };
})(window);
