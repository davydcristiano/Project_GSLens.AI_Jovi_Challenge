/* ═══════════════════════════════════════════════════
   GSLens.AI — Leitor de QR Code e Links
   - QR Code ao vivo: BarcodeDetector nativo (quando existe)
     ou jsQR (JavaScript puro, funciona em qualquer navegador)
   - Links impressos (ex.: "www.site.com.br") por OCR local
     (Tesseract/WebAssembly num Worker — nada sai do aparelho)
   - Mini navegador interno (iframe isolado) para abrir o link
     sem sair do app, com cartão de resultado para QR que não
     são links (Wi-Fi, contato, e-mail, telefone, texto...)
═══════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const $ = id => document.getElementById(id);
  /* diagnóstico: abra o app com ?debug=links para ver as leituras no console */
  const DEBUG = typeof location !== 'undefined' && /[?&]debug=links\b/.test(location.search);

  /* ───────── Interpretação de conteúdo ───────── */
  const TLDS = new Set(('com br org net gov edu io ai app dev co me info biz tv xyz site online store shop tech blog news ' +
    'us uk ca de fr es it pt nl be ch at se no dk fi pl ru jp cn kr in au nz mx ar cl co pe uy py bo ve ec za ' +
    'eu asia cloud digital link live page pro top club fun art design media agency studio games global world ly gg sh to so cc tk ws').split(' '));

  /* Normaliza um candidato a URL vindo de OCR ou QR. Retorna string ou null. */
  function normalizeUrl(raw, strict) {
    if (!raw) return null;
    let s = String(raw).trim().replace(/[​-‍﻿]/g, '');
    s = s.replace(/^[("'<\[]+/, '').replace(/[)"'>\],.;:!?]+$/, '');
    if (!s) return null;
    if (/^(javascript|data|file|blob|vbscript|about|chrome|intent):/i.test(s)) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      if (strict && !/^www\./i.test(s)) {
        /* domínio sem esquema: exige TLD conhecido */
        const host = s.split(/[/?#]/)[0];
        const tld = host.split('.').pop().toLowerCase();
        if (!host.includes('.') || !TLDS.has(tld)) return null;
      }
      s = 'https://' + s;
    }
    let u;
    try { u = new URL(s); } catch (e) { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    const host = u.hostname;
    if (!host || host.length > 253) return null;
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host === 'localhost';
    if (!isIp) {
      const parts = host.split('.');
      if (parts.length < 2 || parts.some(p => !p || p.length > 63)) return null;
      const tld = parts[parts.length - 1].toLowerCase();
      if (!/^(xn--[a-z0-9-]+|[a-z]{2,24})$/.test(tld)) return null;
      if (strict && !TLDS.has(tld)) return null;
    }
    return u.href;
  }

  /* Corrige confusões típicas do OCR no final do domínio:
     "youtube.con" / ".corn" / ".c0m" / ".coml" (cursor colado) → ".com" etc. */
  const TLD_FIX = [
    [/\.(?:con|corn|c0m|cOm|coin|cam|comn|conn|corm|eom|oom|c〇m)(?=$|[\/?#.])/i, '.com'],
    [/\.(com|net|org|br|gov|edu|io|app|dev)[il1|!I\]\)]+(?=$|[\/?#])/i, '.$1'],
    [/\.com\.(?:bt|hr|bn|b1|8r)(?=$|[\/?#])/i, '.com.br'],
    [/\.(?:0rg|orq|ong)(?=$|[\/?#])/i, '.org'],
    [/\.(?:nel|nct)(?=$|[\/?#])/i, '.net']
  ];
  function fixOcrTld(c) {
    let out = c;
    for (const [re, rp] of TLD_FIX) out = out.replace(re, rp);
    return out;
  }

  /* Extrai links de um texto livre (OCR). Corrige erros comuns de leitura. */
  function extractLinks(text) {
    if (!text) return [];
    const out = [], seen = new Set();
    const t = text
      .replace(/\b(https?)\s*[:;]\s*\/\s*\/\s*/gi, '$1://')   /* "https : //" */
      /* "www" lido errado ("were", "vww", "ww", "wvw") antes de "palavra com" */
      .replace(/(^|[^a-z0-9])(?:w[a-z]{0,3}|(?=[a-z]*w)(?=[a-z]*[wv][a-z]*[wv])[wve]{2,5})\s*[.,:;]?\s+(?=[a-z0-9-]{3,}\s*[.,]?\s*(?:com|con|c0m|corn|net|org)(?:\s*[.,]?\s*br)?[|\])!.]*\s*(?:$|\n))/gim, '$1www.')
      .replace(/\b(?:[wvm]\s*[wv]\s*[wv]|[wv]\s*[wvm]\s*[wv]|[wv]\s*[wv]\s*[wvm])\s*[.,:;]\s*(?=[a-z0-9])/gi, 'www.')
      /* ponto perdido depois de "www.": "www.youtube con" → "www.youtube.con" */
      .replace(/\b(www\.[a-z0-9-]{2,})\s*[,;:]?\s+(com|con|corn|c0m|cam|net|org|gov|edu|io|app|dev)\b/gi, '$1.$2')
      .replace(/([a-z0-9])\s*-\s+([a-z0-9])/gi, '$1-$2')              /* "gslens- demo" */               /* "w w w ," */
      .replace(/([a-z0-9])\s*\.\s*(com|br|org|net|gov|edu|io|app|dev)\b/gi, '$1.$2');
    const re = /\b((?:https?:\/\/|www\.)[^\s<>"'`]+|[a-z0-9][a-z0-9-]{0,62}(?:\.[a-z0-9-]{1,63})*\.[a-z]{2,24}(?:\/[^\s<>"'`]*)?)/gi;
    let m;
    while ((m = re.exec(t))) {
      /* corta caracteres que não existem em URL (ex.: cursor "|" colado no ".com") */
      let cand = m[1].replace(/[|¦\\{}^`\[\]].*$/, '');
      cand = fixOcrTld(cand).replace(/^[a-z0-9]{1,3}(?=www\.)/i, '');   /* ruído colado antes do "www." */
      if (/@/.test(t.slice(Math.max(0, m.index - 1), m.index))) continue;   /* parte de e-mail */
      const url = normalizeUrl(cand.replace(/^w{1,4}\.(?=[a-z0-9-]+\.)/i, m0 => (/^w{3}\./i.test(m0) ? m0 : 'www.')), true);
      if (!url) continue;
      const host = new URL(url).hostname;
      if (host.replace(/^www\./, '').length < 4) continue;
      if (!seen.has(url)) { seen.add(url); out.push(url); }
    }
    return out;
  }

  /* Classifica o conteúdo de um QR Code */
  function parseContent(raw) {
    const s = String(raw || '').trim();
    if (!s) return { kind: 'empty' };
    const direct = /^https?:\/\//i.test(s) ? normalizeUrl(s, false) : null;
    if (direct) return { kind: 'url', url: direct, raw: s };
    if (/^WIFI:/i.test(s)) {
      const f = k => { const r = new RegExp('[;:]' + k + ':((?:\\\\.|[^;])*)', 'i').exec(s); return r ? r[1].replace(/\\([\\;,:"])/g, '$1') : ''; };
      return { kind: 'wifi', ssid: f('S'), password: f('P'), security: f('T') || 'aberta', hidden: /[;:]H:true/i.test(s), raw: s };
    }
    if (/^mailto:/i.test(s) || /^MATMSG:/i.test(s)) {
      const to = /^mailto:/i.test(s) ? s.slice(7).split('?')[0] : ((/TO:([^;]*)/i.exec(s) || [])[1] || '');
      return { kind: 'email', to: decodeURIComponent(to), href: /^mailto:/i.test(s) ? s : 'mailto:' + to, raw: s };
    }
    if (/^tel:/i.test(s)) return { kind: 'tel', number: s.slice(4), href: s, raw: s };
    if (/^(smsto|sms):/i.test(s)) { const p = s.split(':'); return { kind: 'sms', number: p[1] || '', body: p.slice(2).join(':'), href: 'sms:' + (p[1] || ''), raw: s }; }
    if (/^geo:/i.test(s)) {
      const m = /^geo:\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i.exec(s);
      if (m) return { kind: 'geo', lat: +m[1], lon: +m[2], url: `https://www.openstreetmap.org/?mlat=${m[1]}&mlon=${m[2]}#map=17/${m[1]}/${m[2]}`, raw: s };
    }
    if (/^BEGIN:VCARD/i.test(s) || /^MECARD:/i.test(s)) {
      const get = k => { const r = new RegExp('(?:^|\\n|;)' + k + '[^:]*:([^\\r\\n;]*)', 'i').exec(s); return r ? r[1].trim() : ''; };
      return { kind: 'contact', name: get('FN') || get('N'), phone: get('TEL'), email: get('EMAIL'), org: get('ORG'), url: normalizeUrl(get('URL'), false), raw: s };
    }
    const links = extractLinks(s);
    if (links.length === 1 && s.replace(/\s+/g, '').length <= links[0].length + 2) return { kind: 'url', url: links[0], raw: s };
    return { kind: 'text', text: s, links, raw: s };
  }

  /* ───────── Motores de leitura ───────── */
  let barcodeDetector = null, bdChecked = false;
  async function getBarcodeDetector() {
    if (bdChecked) return barcodeDetector;
    bdChecked = true;
    try {
      if ('BarcodeDetector' in root) {
        const fmts = await root.BarcodeDetector.getSupportedFormats();
        if (fmts.includes('qr_code')) barcodeDetector = new root.BarcodeDetector({ formats: ['qr_code'].concat(fmts.filter(f => ['data_matrix', 'aztec'].includes(f))) });
      }
    } catch (e) { barcodeDetector = null; }
    return barcodeDetector;
  }

  /* Lê QR de um canvas. Retorna [{raw, corners:[[x,y]...] (pixels do canvas)}] */
  /* Lê QR de um canvas. Retorna [{raw, corners}] (pixels do canvas).
     CORREÇÃO: em alguns Androids o BarcodeDetector existe mas sempre
     devolve vazio (serviço de detecção ausente). Antes isso desligava a
     leitura em silêncio; agora o jsQR também é usado quando o nativo não
     acha nada (useJs=true) e o nativo é desativado se der erro. */
  let bdFails = 0;
  function jsqrRead(canvas, ctx) {
    if (typeof root.jsQR !== 'function') return [];
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const r = root.jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
    if (!r || !r.data) return [];
    const L0 = r.location;
    return [{ raw: r.data, corners: [L0.topLeftCorner, L0.topRightCorner, L0.bottomRightCorner, L0.bottomLeftCorner].map(p => [p.x, p.y]), engine: 'jsQR' }];
  }
  async function readQR(canvas, ctx, useJs) {
    const bd = await getBarcodeDetector();
    if (bd) {
      try {
        const res = await bd.detect(canvas);
        if (res.length) { bdFails = 0; return res.map(r => ({ raw: r.rawValue, corners: (r.cornerPoints || []).map(p => [p.x, p.y]), engine: 'nativo' })); }
      } catch (e) { if (++bdFails > 3) { barcodeDetector = null; console.warn('BarcodeDetector desativado:', e); } }
      if (useJs === false) return [];
    }
    return jsqrRead(canvas, ctx);
  }

  /* OCR: Worker quando possível; na abertura via file:// (Workers bloqueados)
     usa a mesma biblioteca na thread principal, só sob demanda. */
  /* Pool de leitores de OCR (Workers). Em aparelhos com 6+ núcleos usa 2
     leitores em paralelo — o dobro de leituras por segundo. */
  const OCR = {
    workers: [], failed: false, inline: null, seq: 0, pending: new Map(),
    size: Math.max(1, Math.min(2, ((root.navigator && navigator.hardwareConcurrency) || 2) >= 6 ? 2 : 1)),
    canWorker() { return !this.failed && /^https?:$/.test(location.protocol) && 'Worker' in root; },
    spawn() {
      const w = new Worker('js/links/ocr-worker.js?v=20261023a');
      w.busy = 0;
      w.onmessage = e => { w.busy = Math.max(0, w.busy - 1); const p = this.pending.get(e.data.id); if (!p) return; this.pending.delete(e.data.id); e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data); };
      w.onerror = e => { console.warn('OCR worker:', e.message); this.failed = true; this.pending.forEach(p => p.reject(new Error('OCR indisponível'))); this.pending.clear(); this.workers = []; };
      return w;
    },
    ensureWorker() {
      if (!this.canWorker()) return null;
      try { while (this.workers.length < this.size) this.workers.push(this.spawn()); }
      catch (e) { this.failed = true; this.workers = []; return null; }
      return this.workers.slice().sort((a, b) => a.busy - b.busy)[0];
    },
    free() { return this.workers.filter(w => !w.busy).length || (this.workers.length ? 0 : this.size); },
    /* pré-carrega o OCR (~0,6 s) enquanto o usuário ainda está na tela inicial */
    warm() {
      if (this.warmed || !this.canWorker()) return; this.warmed = true;
      /* aquece com um texto de verdade (a 1ª leitura real fica ~2x mais rápida) */
      const c = document.createElement('canvas'); c.width = 420; c.height = 64;
      const x = c.getContext('2d', { willReadFrequently: true }); x.fillStyle = '#fff'; x.fillRect(0, 0, 420, 64);   /* canvas de CPU: ler os pixels não espera a GPU */
      x.fillStyle = '#111'; x.font = '32px Arial, sans-serif'; x.fillText('www.exemplo.com.br', 12, 44);
      const d = x.getImageData(0, 0, 420, 64).data;
      const pgm = toPGM(grayFromRGBA(d, 420 * 64), 420, 64);
      for (let i = 0; i < this.size; i++) this.recognize(pgm.slice(), true).then(() => this.recognize(pgm.slice(), true)).catch(() => {});
    },
    async inlineEngine() {
      if (this.inline) return this.inline;
      this.inline = (async () => {
        if (!root.TesseractCore) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'js/vendor/tesseract/tesseract-core-lstm.wasm.js'; s.onload = res; s.onerror = () => rej(new Error('Falha ao carregar o OCR')); document.head.appendChild(s); });
        const T = await root.TesseractCore();
        const buf = await fetch('js/vendor/tesseract/eng.traineddata').then(r => { if (!r.ok) throw new Error('modelo'); return r.arrayBuffer(); })
          .catch(() => { throw new Error('O modelo de OCR não pode ser lido abrindo o arquivo direto do disco. Use um servidor (http://localhost) ou HTTPS.'); });
        T.FS.writeFile('eng.traineddata', new Uint8Array(buf));
        const api = new T.TessBaseAPI(); api.Init(null, 'eng'); api.SetPageSegMode(11); api.SetVariable('user_defined_dpi', '300');
        return { T, api };
      })();
      this.inline.catch(() => { this.inline = null; });
      return this.inline;
    },
    async recognize(png, tsv) {
      const w = this.ensureWorker();
      if (w) {
        const id = ++this.seq;
        w.busy++;
        return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); w.postMessage({ id, png, tsv: !!tsv }, [png.buffer]); });
      }
      const { T, api } = await this.inlineEngine();
      T.FS.writeFile('/input', png); api.SetImageFile();
      const out = tsv ? { tsv: api.GetTSVText(0) || '' } : { text: api.GetUTF8Text() || '' };
      out.conf = api.MeanTextConf(); api.Clear();
      return out;
    },
    busy() { return this.pending.size > 0; }
  };

  /* PGM (cinza, sem compressão): montado em ~1 ms — bem mais rápido que
     codificar PNG a cada leitura; o Tesseract lê direto. */
  function toPGM(gray, w, h) {
    const hdr = new TextEncoder().encode('P5\n' + w + ' ' + h + '\n255\n');
    const out = new Uint8Array(hdr.length + w * h);
    out.set(hdr); out.set(gray, hdr.length);
    return out;
  }
  function grayFromRGBA(d, n) { const g = new Uint8Array(n); for (let i = 0, j = 0; j < n; i += 4, j++) g[j] = d[i]; return g; }

  /* Prepara imagem para OCR: tons de cinza com contraste normalizado */
  async function ocrPng(srcCanvas, sx, sy, sw, sh, maxW) {
    const sc = Math.min(1, (maxW || 1280) / sw);
    const w = Math.max(1, Math.round(sw * sc)), h = Math.max(1, Math.round(sh * sc));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, w, h);
    const id = x.getImageData(0, 0, w, h), d = id.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) { const g = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8; d[i] = g; hist[g]++; }
    let lo = 0, hi = 255, acc = 0; const n = w * h;
    while (lo < 255 && (acc += hist[lo]) < n * 0.01) lo++;
    acc = 0; while (hi > 0 && (acc += hist[hi]) < n * 0.01) hi--;
    const k = 255 / Math.max(16, hi - lo);
    for (let i = 0; i < d.length; i += 4) { const g = Math.max(0, Math.min(255, (d[i] - lo) * k)); d[i] = d[i + 1] = d[i + 2] = g; d[i + 3] = 255; }
    return toPGM(grayFromRGBA(d, w * h), w, h);
  }

  /* ───────── Localizador de linhas de texto (estilo "Texto ao Vivo") ─────────
     Texto pequeno (ex.: link num monitor a 1 m) some quando o quadro inteiro
     é reduzido para o OCR. Aqui as linhas de texto são localizadas por
     bordas verticais densas e alinhadas; só esses trechos são recortados
     em resolução nativa, ampliados (~40 px de altura de letra) e lidos
     juntos numa única passada do OCR. */
  function findTextRegions(src, vw, vh, maxRegions) {
    const sc = Math.min(1, (findTextRegions.maxW || 1440) / vw);
    const w = Math.round(vw * sc), h = Math.round(vh * sc);
    const c = findTextRegions.c || (findTextRegions.c = document.createElement('canvas'));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(src, 0, 0, vw, vh, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data;
    const g = new Uint8Array(w * h);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    /* bordas verticais (traços de letras) */
    const e = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let xx = 1; xx < w - 1; xx++) {
      const i = y * w + xx;
      const gx = Math.abs(g[i + 1] - g[i - 1]);
      const gy = Math.abs(g[i + w] - g[i - w]);
      if (gx > 10 && gx >= gy * 0.6) e[i] = 1;
    }
    /* fecha os espaços entre letras na horizontal e entre partes na vertical */
    const gap = Math.max(4, Math.round(6 * w / 960)), row = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      let last = -1e9;
      for (let xx = 0; xx < w; xx++) {
        const i = y * w + xx;
        if (e[i]) { if (xx - last <= gap) for (let k = last + 1; k < xx; k++) row[y * w + k] = 1; row[i] = 1; last = xx; }
      }
    }
    for (let i = w; i < w * (h - 1); i++) if (!row[i] && row[i - w] && row[i + w]) row[i] = 1;
    /* componentes conexos */
    const lab = new Int32Array(w * h), stack = new Int32Array(w * h), boxes = [];
    let L2 = 0;
    for (let s0 = 0; s0 < w * h; s0++) {
      if (!row[s0] || lab[s0]) continue;
      L2++; let sp = 0; stack[sp++] = s0; lab[s0] = L2;
      let x0 = w, y0 = h, x1 = 0, y1 = 0, n = 0, en = 0;
      while (sp) {
        const p = stack[--sp], px = p % w, py = (p / w) | 0; n++; en += e[p];
        if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
        if (px > 0 && row[p - 1] && !lab[p - 1]) { lab[p - 1] = L2; stack[sp++] = p - 1; }
        if (px < w - 1 && row[p + 1] && !lab[p + 1]) { lab[p + 1] = L2; stack[sp++] = p + 1; }
        if (py > 0 && row[p - w] && !lab[p - w]) { lab[p - w] = L2; stack[sp++] = p - w; }
        if (py < h - 1 && row[p + w] && !lab[p + w]) { lab[p + w] = L2; stack[sp++] = p + w; }
      }
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      if (bh < 4 || bh > 100 * w / 960 || bw < 2.2 * bh || bw > 0.95 * w) continue;
      const fill = n / (bw * bh), dens = en / (bw * bh);
      if (fill < 0.35 || dens < 0.06 || dens > 0.75) continue;
      boxes.push({ x: x0 / sc, y: y0 / sc, w: bw / sc, h: bh / sc, score: bw * Math.min(1, dens * 4) });
    }
    boxes.sort((a, b) => b.score - a.score);
    return boxes.slice(0, maxRegions || 10);
  }

  /* Recorta, amplia e empilha as regiões; lê com OCR (TSV) e devolve
     links com a caixa na coordenada do quadro de vídeo. */
  async function ocrRegions(src, vw, vh, regions) {
    if (!regions.length) return { links: [], text: '' };
    const segs = [];
    const TARGET = 40, MAXW = 1400, GAP = 18;
    let y = GAP, maxW = 0;
    for (const r of regions) {
      const pad = r.h * 0.6;
      const fx = Math.max(0, r.x - pad), fy = Math.max(0, r.y - pad);
      const fw = Math.min(vw - fx, r.w + 2 * pad), fh = Math.min(vh - fy, r.h + 2 * pad);
      let scale = Math.max(1, Math.min(4, TARGET / Math.max(4, r.h)));
      if (fw * scale > MAXW - 2 * GAP) scale = (MAXW - 2 * GAP) / fw;
      const sw = Math.round(fw * scale), sh = Math.round(fh * scale);
      segs.push({ fx, fy, fw, fh, scale, dx: GAP, dy: y, sw, sh });
      y += sh + GAP; maxW = Math.max(maxW, sw + 2 * GAP);
      if (y > 2200) break;
    }
    const c = document.createElement('canvas'); c.width = maxW; c.height = y;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    x.imageSmoothingQuality = 'high';
    for (const s0 of segs) {
      x.drawImage(src, s0.fx, s0.fy, s0.fw, s0.fh, s0.dx, s0.dy, s0.sw, s0.sh);
      /* contraste por recorte; texto claro em fundo escuro é invertido */
      const id = x.getImageData(s0.dx, s0.dy, s0.sw, s0.sh), dd = id.data;
      let mn = 255, mx = 0, sum = 0;
      for (let i = 0; i < dd.length; i += 4) { const v = (dd[i] * 77 + dd[i + 1] * 150 + dd[i + 2] * 29) >> 8; dd[i] = v; sum += v; if (v < mn) mn = v; if (v > mx) mx = v; }
      const mean = sum / (dd.length / 4), inv = mean < (mn + mx) / 2 - 10, k = 255 / Math.max(24, mx - mn);
      for (let i = 0; i < dd.length; i += 4) { let v = (dd[i] - mn) * k; if (inv) v = 255 - v; v = Math.max(0, Math.min(255, v)); dd[i] = dd[i + 1] = dd[i + 2] = v; dd[i + 3] = 255; }
      /* nitidez (unsharp) — o recorte ampliado de texto pequeno fica borrado */
      if (s0.scale > 1.3) {
        const W0 = s0.sw, src0 = new Uint8ClampedArray(W0 * s0.sh);
        for (let i = 0, j = 0; j < src0.length; i += 4, j++) src0[j] = dd[i];
        const rr = Math.max(1, Math.round(s0.scale * 0.8));
        for (let yy = rr; yy < s0.sh - rr; yy++) for (let xx = rr; xx < W0 - rr; xx++) {
          const j = yy * W0 + xx;
          const blur = (src0[j - rr] + src0[j + rr] + src0[j - rr * W0] + src0[j + rr * W0]) / 4;
          const v = Math.max(0, Math.min(255, src0[j] + 1.6 * (src0[j] - blur)));
          const i = j * 4; dd[i] = dd[i + 1] = dd[i + 2] = v;
        }
      }
      x.putImageData(id, s0.dx, s0.dy);
    }
    const all = x.getImageData(0, 0, c.width, c.height).data;
    const r = await OCR.recognize(toPGM(grayFromRGBA(all, c.width * c.height), c.width, c.height), true);
    const out = parseTsvLinks(r.tsv || '', segs);
    out.n = segs.length;
    return out;
  }

  function parseTsvLinks(tsv, segs) {
    const lines = new Map();
    for (const ln of tsv.split('\n')) {
      const f = ln.split('\t');
      if (f.length < 12 || f[0] !== '5') continue;
      const txt = f.slice(11).join('\t').trim(); if (!txt) continue;
      const key = f[2] + '.' + f[3] + '.' + f[4];
      const word = { t: txt, x: +f[6], y: +f[7], w: +f[8], h: +f[9], conf: +f[10] };
      if (!lines.has(key)) lines.set(key, []);
      lines.get(key).push(word);
    }
    const out = [], all = [];
    for (const words of lines.values()) {
      const text = words.map(w => w.t).join(' ');
      all.push(text);
      for (const url of extractLinks(text)) {
        const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
        const part = words.filter(w => { const t = w.t.toLowerCase().replace(/[^a-z0-9.\-/:]/g, ''); return t.length > 2 && (host.includes(t.replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0]) || t.includes(host)); });
        let ws = part.length ? part : words;
        /* inclui a terminação lida separada ("youtube" + "con]") */
        const last = words.indexOf(ws[ws.length - 1]);
        if (last >= 0 && words[last + 1] && /^[.,]?(com|con|corn|c0m|br|net|org|gov|io)\W*$/i.test(words[last + 1].t)) ws = ws.concat(words[last + 1]);
        const x0 = Math.min(...ws.map(w => w.x)), y0 = Math.min(...ws.map(w => w.y)), x1 = Math.max(...ws.map(w => w.x + w.w)), y1 = Math.max(...ws.map(w => w.y + w.h));
        const seg = segs.find(s0 => (y0 + y1) / 2 >= s0.dy - 12 && (y0 + y1) / 2 <= s0.dy + s0.sh + 12) || segs[0];
        const box = [seg.fx + (x0 - seg.dx) / seg.scale, seg.fy + (y0 - seg.dy) / seg.scale, (x1 - x0) / seg.scale, (y1 - y0) / seg.scale];
        const label = ws.map(w => w.t).join(' ');
        out.push({ url, box, label, conf: Math.min(...ws.map(w => w.conf)), explicit: /^(https?:|www\.)/i.test(label.replace(/\s+/g, '')) });
      }
    }
    return { links: out, text: all.join('\n') };
  }

  /* ───────── Leitura ao vivo na câmera ───────── */
  const L = {
    clusters: [], enabled: true, running: false, timer: null, frameCanvas: null, frameCtx: null, pass: 0, ticks: 0, statusMsg: '',
    lastSeen: new Map(),        /* conteúdo -> último instante visto */
    blocked: new Map(),         /* conteúdo -> não reabrir enquanto continuar visível */
    ocrHits: new Map(), lastOcr: 0, ocrRunning: false,
    lastBox: null, lastBoxT: 0
  };

  function loadPref() { try { const v = localStorage.getItem('gs_linkscan'); if (v !== null) L.enabled = v === '1'; } catch (e) { } }
  function savePref() { try { localStorage.setItem('gs_linkscan', L.enabled ? '1' : '0'); } catch (e) { } }

  function setStatus(msg, kind) {
    L.statusMsg = msg;
    const b = $('linkBadge'); if (!b) return;
    b.textContent = msg; b.className = 'link-badge' + (kind ? ' ' + kind : '') + (b.classList.contains('hidden') ? ' hidden' : '');
  }

  function updateToggle() {
    const b = $('linkBtn');
    if (b) { b.classList.toggle('active', L.enabled); b.setAttribute('aria-pressed', L.enabled ? 'true' : 'false'); }
    const badge = $('linkBadge');
    if (badge) {
      const chipOn = $('linkChip') && !$('linkChip').classList.contains('hidden');
      badge.classList.toggle('hidden', !(L.enabled && shouldScan()) || chipOn);
      if (!L.statusMsg) badge.textContent = OCR.canWorker() ? '🔗 Procurando QR Code e links' : '🔗 Procurando QR Code';
    }
  }

  function shouldScan() {
    const app = root.GSApp;
    if (!app || !app.getStream()) return false;
    if ($('cameraScreen').classList.contains('screen-hidden')) return false;
    if (app.getMode() === 'ar') return false;              /* a aba AR usa a câmera para o scanner 3D */
    if (!$('webSheet').classList.contains('hidden')) return false;
    if (document.hidden) return false;
    return true;
  }

  function schedule(ms) { clearTimeout(L.timer); L.timer = setTimeout(loop, ms); }

  async function loop() {
    L.timer = null;
    if (!L.enabled) { clearOverlay(); return; }
    if (!shouldScan()) { clearOverlay(); updateToggle(); schedule(600); return; }
    updateToggle();
    const video = $('video');
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) { schedule(400); return; }
    if (!L.frameCanvas) { L.frameCanvas = document.createElement('canvas'); L.frameCtx = L.frameCanvas.getContext('2d', { willReadFrequently: true }); }
    /* região visível do vídeo (object-fit: cover + zoom digital) */
    const m = root.GSApp.getVideoMapping();
    let sx = 0, sy = 0, sw = vw, sh = vh;
    if (m) { sx = Math.max(0, -m.ox / m.s); sy = Math.max(0, -m.oy / m.s); sw = Math.min(vw - sx, m.W / m.s); sh = Math.min(vh - sy, m.H / m.s); }
    const vis = { x: sx, y: sy, w: sw, h: sh };   /* parte do vídeo que aparece na tela */
    /* DESEMPENHO: UM retrato do quadro por ciclo, lido da GPU sem bloquear a
       interface (antes o vídeo era copiado de forma síncrona várias vezes por
       ciclo: QR, regiões de texto e cada recorte do OCR) */
    let src = video;
    if (root.GSFrameReader && Math.max(vw, vh) <= 1920) {
      if (!L.reader) { L.reader = new GSFrameReader(); L.snap = document.createElement('canvas'); L.snapCtx = L.snap.getContext('2d', { willReadFrequently: true }); }
      const f = await L.reader.grab(video, 0, 0, vw, vh, vw, vh);
      if (!L.enabled || !shouldScan()) { clearOverlay(); schedule(300); return; }
      if (f && f.w === vw && f.h === vh) {
        if (L.snap.width !== vw || L.snap.height !== vh) { L.snap.width = vw; L.snap.height = vh; }
        L.snapCtx.putImageData(new ImageData(f.data, vw, vh), 0, 0);
        src = L.snap;
      }
    }
    /* alterna: imagem visível inteira (reduzida) e o centro em resolução
       nativa — QR pequeno/distante só é legível no recorte central */
    L.pass = (L.pass + 1) % 2;
    if (L.pass === 1) {
      const cw = Math.min(sw, Math.max(480, sw * 0.5)), ch = Math.min(sh, Math.max(480, sh * 0.5));
      sx = sx + (sw - cw) / 2; sy = sy + (sh - ch) / 2; sw = cw; sh = ch;
    }
    const sc = Math.min(1, (L.pass === 1 ? 900 : 800) / Math.max(sw, sh));
    const w = Math.round(sw * sc), h = Math.round(sh * sc);
    if (L.frameCanvas.width !== w || L.frameCanvas.height !== h) { L.frameCanvas.width = w; L.frameCanvas.height = h; }
    L.frameCtx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
    const now = performance.now();
    let found = [];
    try { found = await readQR(L.frameCanvas, L.frameCtx, L.pass === 0 ? true : (L.ticks++ % 2 === 0)); }
    catch (e) { console.warn('QR:', e); setStatus('⚠️ Erro no leitor de QR: ' + (e.message || e), 'err'); }
    if (!L.enabled || !shouldScan()) { clearOverlay(); schedule(300); return; }
    if (found.length) {
      const q = found[0];
      L.lastBox = q.corners.map(p => [sx + p[0] / sc, sy + p[1] / sc]); L.lastBoxT = now;
      drawBox(L.lastBox, q.raw);
      handleDetection(q.raw, 'qr', now);
    } else if (now - L.lastBoxT > 400 && !(L.textBox && now - L.textBox.t < 1500)) clearOverlay();
    releaseBlocks(now);

    /* Links escritos: linhas de texto localizadas + leitura ampliada (rápida
       para texto pequeno); a cada 3 leituras, também o quadro inteiro. */
    if ((L.ocrJobs || 0) < OCR.size && OCR.canWorker() && now - L.lastOcr > (L.ocrJobs ? 120 : 60) && !found.length) {
      L.ocrJobs = (L.ocrJobs || 0) + 1; L.ocrRunning = true; L.lastOcr = now;
      L.ocrTurn = (L.ocrTurn || 0) + 1;
      const tJob = performance.now();
      const job = (async () => {
        if (L.ocrTurn % 5 === 0) {
          const png = await ocrPng(src, vis.x, vis.y, vis.w, vis.h, 1280);
          const r = await OCR.recognize(png);
          return { text: r.text, links: extractLinks(r.text).map(url => ({ url, box: null, label: url, explicit: false, conf: null })) };
        }
        /* só o texto que aparece na tela (como a câmera do iPhone) */
        const mx = vis.w * 0.03, my = vis.h * 0.03;
        /* texto cortado pela borda da tela fica de fora (geraria domínio incompleto) */
        const regs = findTextRegions(src, vw, vh, 24).filter(r => {
          const cy = r.y + r.h / 2;
          return r.x >= vis.x + 2 && r.x + r.w <= vis.x + vis.w - 2 && cy > vis.y - my && cy < vis.y + vis.h + my;
        }).slice(0, 6);
        return ocrRegions(src, vw, vh, regs);
      })();
      job.then(res => {
        if (DEBUG) console.info('[links] OCR', Math.round(performance.now() - tJob) + 'ms', L.ocrTurn % 5 === 0 ? '(quadro)' : '(regiões ' + (res.n || 0) + ')', JSON.stringify(res.text || ''), res.links.map(l => l.url));
        if (!L.enabled || !shouldScan()) return;
        L.ocrOk = true;
        onTextLinks(res.links, performance.now());
      }).catch(e => {
        console.warn('OCR:', e.message);
        L.ocrErr = (L.ocrErr || 0) + 1;
        if (L.ocrErr >= 2 || OCR.failed) { OCR.failed = true; setStatus('🔗 QR ativo · links escritos: leitura de texto indisponível neste aparelho (use 📸 foto)', 'warn'); }
      }).finally(() => { L.ocrJobs = Math.max(0, L.ocrJobs - 1); L.ocrRunning = L.ocrJobs > 0; });
    }
    schedule(found.length ? 350 : 140);
  }

  /* Link de texto reconhecido: marca com cantoneiras amarelas, mostra o selo
     com o domínio e o texto ampliado, e abre a prévia (como a câmera do iPhone).
     Abre na 1ª leitura quando o texto começa com "www." ou "http"; nos demais
     casos, após 2 leituras iguais (evita abrir por engano). */
  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 3) return 9;
    const d = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let prev = d[0]; d[0] = i;
      for (let j = 1; j <= b.length; j++) { const tmp = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = tmp; }
    }
    return d[b.length];
  }
  /* Leituras do mesmo link com pequenos erros do OCR ("gslene-demo",
     "mww.gsiens-demo") são agrupadas; abre UMA vez, com a versão mais lida. */
  function clusterFor(hostName) {
    for (const c of L.clusters) for (const h0 of c.hosts) {
      if (h0 === hostName) return c;
      if (Math.min(h0.length, hostName.length) > 5 && (lev(h0, hostName) <= 2 || h0.startsWith(hostName + '.') || hostName.startsWith(h0 + '.'))) return c;
    }
    const c = { hosts: new Set(), variants: new Map(), n: 0, last: 0, opened: false };
    L.clusters.push(c);
    return c;
  }
  function bestUrl(c) {
    let best = null, bc = -1;
    for (const [u, k] of c.variants) if (k > bc || (k === bc && u.length > best.length)) { best = u; bc = k; }
    return best;
  }
  function onTextLinks(links, t) {
    L.clusters = (L.clusters || []).filter(c => t - c.last < 4500);   /* saiu de vista: pode abrir de novo */
    const seen = new Set();
    for (const lk of links) {
      const hostName = new URL(lk.url).hostname.replace(/^www\./, '');
      const c = clusterFor(hostName);
      c.hosts.add(hostName);
      c.variants.set(lk.url, (c.variants.get(lk.url) || 0) + 1);
      if (!seen.has(c)) { c.n++; seen.add(c); }
      c.last = t;
      const url = bestUrl(c);
      if (lk.box) { L.textBox = { box: lk.box, t }; drawBrackets(lk.box); }
      showChip(host(url), url, url.replace(/^https?:\/\//, '').replace(/\/$/, ''));
      /* parte de um domínio maior já visto ("demo.com.br" de "gslens-demo.com.br") */
      const partial = L.clusters.some(o => o !== c && Array.from(o.hosts).some(h0 => h0.endsWith('-' + hostName) || h0.endsWith('.' + hostName)));
      /* 1ª leitura só abre se começar com www./http E o OCR estiver confiante
         em todas as palavras; senão espera confirmação por uma 2ª leitura */
      const sure = lk.explicit && lk.conf != null && lk.conf >= 70;
      if (DEBUG) console.info('[links] candidato', lk.url, 'conf', lk.conf, 'leituras', c.n, sure ? '(confiante)' : '');
      if (!partial && !c.opened && (c.n >= 2 || sure)) {
        c.opened = true;
        setTimeout(() => {          /* deixa ver a marcação; usa a melhor leitura até aqui */
          if (!L.enabled || !shouldScan()) { c.opened = false; return; }
          if (navigator.vibrate) try { navigator.vibrate(30); } catch (e) { }
          open({ kind: 'url', url: bestUrl(c), raw: bestUrl(c) }, 'Link escrito');
        }, 150);
      }
    }
    if (!links.length && L.textBox && t - L.textBox.t > 1500) { L.textBox = null; clearOverlay(); hideChip(); }
  }

  function overlayCtx() {
    const cv = $('linkCanvas'); if (!cv) return null;
    const vf = $('viewfinder'), m = root.GSApp.getVideoMapping(); if (!m) return null;
    const dpr = Math.min(2, root.devicePixelRatio || 1);
    const W2 = vf.clientWidth, H2 = vf.clientHeight;
    if (cv.width !== Math.round(W2 * dpr) || cv.height !== Math.round(H2 * dpr)) { cv.width = Math.round(W2 * dpr); cv.height = Math.round(H2 * dpr); }
    const ctx = cv.getContext('2d');
    const P = p => { let X = m.ox + p[0] * m.s, Y = m.oy + p[1] * m.s; if (m.mirror) X = W2 - X; return [X * dpr, Y * dpr]; };
    return { ctx, P, dpr, cv };
  }
  /* cantoneiras amarelas em volta do texto (estilo Texto ao Vivo) */
  function drawBrackets(box) {
    const o = overlayCtx(); if (!o) return;
    const { ctx, P, dpr, cv } = o;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const pad = box[3] * 0.5;
    let a = P([box[0] - pad, box[1] - pad]), b = P([box[0] + box[2] + pad, box[1] + box[3] + pad]);
    const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
    const L3 = Math.max(8 * dpr, Math.min(22 * dpr, (y1 - y0) * 0.6, (x1 - x0) * 0.25));
    ctx.strokeStyle = '#ffd60a'; ctx.lineWidth = 2.5 * dpr; ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 4 * dpr;
    ctx.beginPath();
    ctx.moveTo(x0, y0 + L3); ctx.lineTo(x0, y0); ctx.lineTo(x0 + L3, y0);
    ctx.moveTo(x1 - L3, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + L3);
    ctx.moveTo(x1, y1 - L3); ctx.lineTo(x1, y1); ctx.lineTo(x1 - L3, y1);
    ctx.moveTo(x0 + L3, y1); ctx.lineTo(x0, y1); ctx.lineTo(x0, y1 - L3);
    ctx.stroke();
  }
  /* selo com o domínio (toque abre) + texto reconhecido ampliado */
  function showChip(hostName, url, label) {
    const chip = $('linkChip'); if (!chip) return;
    chip.dataset.url = url;
    $('linkChipText').textContent = hostName;
    chip.classList.remove('hidden');
    const bd = $('linkBadge'); if (bd) bd.classList.add('hidden');
    const z = $('linkZoom');
    if (z && label) { z.textContent = label; z.classList.remove('hidden'); clearTimeout(L.zoomT); L.zoomT = setTimeout(() => z.classList.add('hidden'), 1800); }
    clearTimeout(L.chipT); L.chipT = setTimeout(hideChip, 6000);
  }
  function hideChip() { const c = $('linkChip'); if (c) c.classList.add('hidden'); const z = $('linkZoom'); if (z) z.classList.add('hidden'); updateToggle(); }
  function chipTap() {
    const c = $('linkChip'); if (!c || !c.dataset.url) return;
    const now = performance.now(), key = host(c.dataset.url);
    L.blocked.set(key, now); L.blocked.set(c.dataset.url, now); L.lastSeen.set(key, now);
    const cl = clusterFor(key); cl.hosts.add(key); cl.opened = true; cl.last = now;
    open({ kind: 'url', url: c.dataset.url, raw: c.dataset.url }, 'Link escrito');
  }
  function togglePreview() {
    const card = $('webCard'), b = $('webHideBtn');
    const col = !card.classList.contains('collapsed');
    card.classList.toggle('collapsed', col);
    b.textContent = col ? 'Mostrar pré-visualização' : 'Ocultar pré-visualização';
  }

  function releaseBlocks(now) {
    for (const [k, t] of L.blocked) {
      const seen = L.lastSeen.get(k) || 0;
      if (now - seen > 2500 && now - t > 1500) L.blocked.delete(k);   /* saiu de vista: pode abrir de novo */
    }
  }

  function handleDetection(raw, source, now) {
    L.lastSeen.set(raw, now);
    if (L.blocked.has(raw)) return;
    L.blocked.set(raw, now);
    const parsed = source === 'ocr' ? { kind: 'url', url: raw, raw } : parseContent(raw);
    if (parsed.kind === 'empty') return;
    if (navigator.vibrate) try { navigator.vibrate(30); } catch (e) { }
    open(parsed, source === 'ocr' ? 'Link escrito' : 'QR Code');
  }

  /* contorno do QR detectado sobre o visor */
  function drawBox(corners, raw) {
    const cv = $('linkCanvas'); if (!cv) return;
    const vf = $('viewfinder'), m = root.GSApp.getVideoMapping(); if (!m) return;
    const dpr = Math.min(2, root.devicePixelRatio || 1);
    const W = vf.clientWidth, H = vf.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    const P = p => { let X = m.ox + p[0] * m.s, Y = m.oy + p[1] * m.s; if (m.mirror) X = W - X; return [X * dpr, Y * dpr]; };
    ctx.lineWidth = 3 * dpr; ctx.strokeStyle = '#ffd60a'; ctx.fillStyle = 'rgba(255,214,10,.14)';
    ctx.beginPath(); corners.forEach((p, i) => { const q = P(p); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  function clearOverlay() { const cv = $('linkCanvas'); if (cv && cv.width) cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); }

  /* ───────── Mini navegador ───────── */
  const W = { url: null, loadTimer: null, parsed: null, history: [] };

  function host(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return url; } }
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function showSheet() {
    hideChip(); clearOverlay();
    $('webCard').classList.remove('collapsed'); $('webHideBtn').textContent = 'Ocultar pré-visualização';
    $('webHideBtn').classList.toggle('hidden', !W.url);
    $('webSheet').classList.remove('hidden');
    document.body.classList.add('sheet-open');
  }

  function open(parsed, sourceLabel) {
    W.parsed = parsed;
    $('webSource').textContent = sourceLabel || 'Link';
    if (parsed.kind === 'url' || parsed.kind === 'geo') return openUrl(parsed.url, sourceLabel);
    showInfo(parsed);
  }

  function openUrl(url, sourceLabel) {
    const safe = normalizeUrl(url, false);
    if (!safe) { root.GSApp.toast('⚠️ Link inválido ou não suportado'); return; }
    let target = safe, note = '';
    /* página segura não pode embutir http:// (bloqueio de conteúdo misto) */
    if (location.protocol === 'https:' && /^http:/i.test(safe)) { target = safe.replace(/^http:/i, 'https:'); note = 'Exibindo a versão segura (https) do endereço.'; }
    W.url = target;
    W.history = W.history.filter(u => u !== target); W.history.unshift(target); W.history = W.history.slice(0, 8);
    $('webSource').textContent = sourceLabel || $('webSource').textContent || 'Link';
    $('webHost').textContent = host(target);
    $('webUrl').textContent = target;
    $('webUrl').title = target;
    $('webLock').textContent = /^https:/i.test(target) ? '🔒' : '⚠️';
    $('webLock').title = /^https:/i.test(target) ? 'Conexão segura (HTTPS)' : 'Conexão sem criptografia (HTTP)';
    $('webInfo').classList.add('hidden');
    $('webFrameWrap').classList.remove('hidden');
    $('webNote').textContent = note || 'Alguns sites não permitem ser exibidos dentro de outros apps. Se a página ficar em branco, toque em ↗ para abrir no navegador.';
    $('webActions').classList.remove('hidden');
    loadFrame(target);
    showSheet();
  }

  function loadFrame(url) {
    const old = $('webFrame');
    const f = document.createElement('iframe');
    f.id = 'webFrame'; f.className = 'web-frame';
    f.title = 'Página: ' + host(url);
    /* página da mesma origem do app não recebe allow-same-origin (não pode acessar o app) */
    let sameOrigin = false; try { sameOrigin = new URL(url).origin === location.origin; } catch (e) { }
    f.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals' + (sameOrigin ? '' : ' allow-same-origin'));
    f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    f.setAttribute('allow', 'fullscreen; clipboard-write');
    f.setAttribute('loading', 'eager');
    $('webLoading').classList.remove('hidden');
    $('webTimeout').classList.add('hidden');
    clearTimeout(W.loadTimer);
    W.loadTimer = setTimeout(() => { $('webLoading').classList.add('hidden'); $('webTimeout').classList.remove('hidden'); }, 15000);
    f.addEventListener('load', () => { clearTimeout(W.loadTimer); $('webLoading').classList.add('hidden'); });
    f.src = url;
    old.replaceWith(f);
  }

  function showInfo(p) {
    W.url = null;
    $('webFrameWrap').classList.add('hidden');
    const box = $('webInfo'); box.classList.remove('hidden');
    const rows = [], btns = [];
    const row = (k, v) => v && rows.push(`<div class="qr-row"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`);
    let title = 'Conteúdo do QR Code';
    if (p.kind === 'wifi') {
      title = '📶 Rede Wi-Fi'; row('Rede (SSID)', p.ssid); row('Senha', p.password || '(sem senha)'); row('Segurança', p.security);
      if (p.password) btns.push(['📋 Copiar senha', () => copy(p.password, 'Senha copiada')]);
    } else if (p.kind === 'email') {
      title = '✉️ E-mail'; row('Para', p.to); btns.push(['✉️ Escrever e-mail', () => { location.href = p.href; }]);
    } else if (p.kind === 'tel') {
      title = '📞 Telefone'; row('Número', p.number); btns.push(['📞 Ligar', () => { location.href = p.href; }]);
    } else if (p.kind === 'sms') {
      title = '💬 SMS'; row('Número', p.number); row('Mensagem', p.body); btns.push(['💬 Enviar SMS', () => { location.href = p.href; }]);
    } else if (p.kind === 'contact') {
      title = '👤 Contato'; row('Nome', p.name); row('Telefone', p.phone); row('E-mail', p.email); row('Empresa', p.org); row('Site', p.url);
      if (p.url) btns.push(['🌐 Abrir site', () => openUrl(p.url, 'QR Code')]);
      btns.push(['💾 Salvar contato (.vcf)', () => downloadText(p.raw.startsWith('BEGIN') ? p.raw : mecardToVcard(p), 'contato.vcf', 'text/vcard')]);
    } else {
      title = '📝 Texto'; rows.push(`<pre class="qr-text">${esc(p.text)}</pre>`);
      (p.links || []).forEach(u => btns.push(['🌐 ' + host(u), () => openUrl(u, 'QR Code')]));
    }
    btns.push(['📋 Copiar conteúdo', () => copy(p.raw, 'Conteúdo copiado')]);
    $('webHost').textContent = title.replace(/^\S+\s/, '');
    $('webUrl').textContent = p.kind === 'text' ? 'Texto lido do QR Code' : 'Lido do QR Code';
    $('webLock').textContent = title.split(' ')[0];
    box.innerHTML = `<h3 class="qr-title">${esc(title)}</h3>${rows.join('')}<div class="qr-actions"></div>`;
    const act = box.querySelector('.qr-actions');
    btns.forEach(([label, fn]) => { const b = document.createElement('button'); b.className = 'btn qr-btn'; b.textContent = label; b.onclick = fn; act.appendChild(b); });
    $('webActions').classList.add('hidden');
    $('webNote').textContent = '';
    showSheet();
  }

  function mecardToVcard(p) {
    return ['BEGIN:VCARD', 'VERSION:3.0', 'FN:' + (p.name || ''), p.phone ? 'TEL:' + p.phone : '', p.email ? 'EMAIL:' + p.email : '', p.org ? 'ORG:' + p.org : '', p.url ? 'URL:' + p.url : '', 'END:VCARD'].filter(Boolean).join('\r\n');
  }
  function downloadText(text, name, type) {
    const a = document.createElement('a'); const u = URL.createObjectURL(new Blob([text], { type }));
    a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 3000);
  }
  async function copy(text, msg) {
    try { await navigator.clipboard.writeText(text); root.GSApp.toast('📋 ' + msg); }
    catch (e) {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); root.GSApp.toast('📋 ' + msg); } catch (e2) { root.GSApp.toast('Não foi possível copiar'); }
      ta.remove();
    }
  }

  function close() {
    clearTimeout(W.loadTimer);
    $('webSheet').classList.add('hidden');
    document.body.classList.remove('sheet-open');
    const f = $('webFrame'); if (f) { const b = document.createElement('iframe'); b.id = 'webFrame'; b.className = 'web-frame'; b.title = 'Página'; f.replaceWith(b); }   /* descarrega a página (para áudio/vídeo dela) */
    const now = performance.now();
    for (const k of L.blocked.keys()) { L.blocked.set(k, now); L.lastSeen.set(k, now); }
    for (const c of (L.clusters || [])) { c.last = now + 1500; c.opened = true; }
    if (L.enabled && !L.timer) schedule(500);
  }
  function reload() { if (W.url) loadFrame(W.url); }
  function openExternal() { if (W.url) { const w = root.open(W.url, '_blank', 'noopener,noreferrer'); if (!w) location.href = W.url; } }
  function copyUrl() { if (W.url) copy(W.url, 'Link copiado'); }
  async function share() {
    if (!W.url) return;
    if (navigator.share) { try { await navigator.share({ title: host(W.url), url: W.url }); } catch (e) { if (e.name !== 'AbortError') copyUrl(); } }
    else copyUrl();
  }

  function toggle() {
    L.enabled = !L.enabled; savePref(); updateToggle();
    root.GSApp.toast(L.enabled ? '🔗 Leitor de QR Code e links ATIVADO' : 'Leitor de QR Code e links desativado');
    if (L.enabled) schedule(100); else { clearTimeout(L.timer); L.timer = null; clearOverlay(); }
  }
  function start() {
    loadPref(); updateToggle();
    if (L.enabled) {
      schedule(300);
      /* aquece o OCR quando o aparelho estiver ocioso (não disputa a abertura do app) */
      const warm = () => OCR.warm();
      if (root.requestIdleCallback) requestIdleCallback(warm, { timeout: 2500 }); else setTimeout(warm, 1200);
    }
  }
  function onVisibility() { if (!document.hidden && L.enabled && !L.timer) schedule(300); }

  /* ───────── Leitura de uma foto da galeria ───────── */
  async function scanImage(img, onStatus) {
    const iw = img.naturalWidth || img.videoWidth || img.width, ih = img.naturalHeight || img.videoHeight || img.height;
    const sc = Math.min(1, 1600 / Math.max(iw, ih));
    const mk = (flip) => {
      const c = document.createElement('canvas');
      c.width = Math.round(iw * sc); c.height = Math.round(ih * sc);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (flip) { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
      ctx.drawImage(img, 0, 0, c.width, c.height);
      return { c, ctx };
    };
    /* fotos da câmera frontal saem espelhadas: tenta também desespelhar */
    const variants = [mk(false), mk(true)];
    if (onStatus) onStatus('Procurando QR Code…');
    for (const v of variants) {
      const q = await readQR(v.c, v.ctx);
      if (q.length) return { parsed: parseContent(q[0].raw), source: 'QR Code' };
    }
    let lastText = '';
    for (let k = 0; k < variants.length; k++) {
      if (onStatus) onStatus(k ? 'Tentando ler o texto espelhado…' : 'Lendo o texto da foto (OCR local)… a primeira leitura pode levar alguns segundos.');
      const v = variants[k];
      const png = await ocrPng(v.c, 0, 0, v.c.width, v.c.height, 1600);
      const r = await OCR.recognize(png);
      const links = extractLinks(r.text);
      if (links.length) return { parsed: { kind: 'url', url: links[0], raw: links[0] }, source: 'Link escrito', all: links, text: r.text };
      if (!k) lastText = r.text;
    }
    return { parsed: null, text: lastText };
  }

  /* Modo Foto: ao tirar a foto, procura QR Code e link HTTPS nela e abre
     o mini navegador (complementa a leitura ao vivo). */
  let captureBusy = false;
  async function scanCapture(canvas) {
    if (!L.enabled || captureBusy) return;
    captureBusy = true;
    try {
      const r = await scanImage(canvas, null);
      if (r && r.parsed && $('webSheet').classList.contains('hidden')) {
        const key = r.parsed.url || r.parsed.raw;
        L.blocked.set(key, performance.now()); L.lastSeen.set(key, performance.now());
        open(r.parsed, r.source === 'QR Code' ? 'QR Code (foto)' : 'Link na foto');
      }
    } catch (e) { console.warn('Leitura da foto:', e.message || e); }
    finally { captureBusy = false; }
  }

  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('webSheet').classList.contains('hidden')) close(); });

  root.LinkScan = {
    start, toggle, close, scanCapture, chipTap, togglePreview, _findTextRegions: findTextRegions, _ocrRegions: ocrRegions, reload, openExternal, copyUrl, share, open, openUrl, scanImage,
    parseContent, extractLinks, normalizeUrl, wake: () => { if (L.enabled) schedule(0); updateToggle(); },
    get enabled() { return L.enabled; }, _state: L, _ocr: OCR
  };
})(window);
