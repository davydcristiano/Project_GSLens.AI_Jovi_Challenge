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

  /* Extrai links de um texto livre (OCR). Corrige erros comuns de leitura. */
  function extractLinks(text) {
    if (!text) return [];
    const out = [], seen = new Set();
    const t = text
      .replace(/\b(https?)\s*[:;]\s*\/\s*\/\s*/gi, '$1://')   /* "https : //" */
      .replace(/\bw\s*w\s*w\s*[.,]\s*/gi, 'www.')               /* "w w w ," */
      .replace(/([a-z0-9])\s*\.\s*(com|br|org|net|gov|edu|io|app|dev)\b/gi, '$1.$2');
    const re = /\b((?:https?:\/\/|www\.)[^\s<>"'`]+|[a-z0-9][a-z0-9-]{0,62}(?:\.[a-z0-9-]{1,63})*\.[a-z]{2,24}(?:\/[^\s<>"'`]*)?)/gi;
    let m;
    while ((m = re.exec(t))) {
      const cand = m[1];
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
  async function readQR(canvas, ctx) {
    const bd = await getBarcodeDetector();
    if (bd) {
      try {
        const res = await bd.detect(canvas);
        if (res.length) return res.map(r => ({ raw: r.rawValue, corners: (r.cornerPoints || []).map(p => [p.x, p.y]) }));
        return [];
      } catch (e) { /* cai para o jsQR */ }
    }
    if (typeof root.jsQR !== 'function') return [];
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const r = root.jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
    if (!r || !r.data) return [];
    const L = r.location;
    return [{ raw: r.data, corners: [L.topLeftCorner, L.topRightCorner, L.bottomRightCorner, L.bottomLeftCorner].map(p => [p.x, p.y]) }];
  }

  /* OCR: Worker quando possível; na abertura via file:// (Workers bloqueados)
     usa a mesma biblioteca na thread principal, só sob demanda. */
  const OCR = {
    worker: null, failed: false, inline: null, seq: 0, pending: new Map(),
    canWorker() { return !this.failed && /^https?:$/.test(location.protocol) && 'Worker' in root; },
    ensureWorker() {
      if (this.worker || !this.canWorker()) return this.worker;
      try {
        this.worker = new Worker('js/links/ocr-worker.js');
        this.worker.onmessage = e => { const p = this.pending.get(e.data.id); if (!p) return; this.pending.delete(e.data.id); e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data); };
        this.worker.onerror = e => { console.warn('OCR worker:', e.message); this.failed = true; this.pending.forEach(p => p.reject(new Error('OCR indisponível'))); this.pending.clear(); this.worker = null; };
      } catch (e) { this.failed = true; this.worker = null; }
      return this.worker;
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
    async recognize(png) {
      if (this.ensureWorker()) {
        const id = ++this.seq;
        return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker.postMessage({ id, png }, [png.buffer]); });
      }
      const { T, api } = await this.inlineEngine();
      T.FS.writeFile('/input', png); api.SetImageFile();
      const text = api.GetUTF8Text() || '', conf = api.MeanTextConf(); api.Clear();
      return { text, conf };
    },
    busy() { return this.pending.size > 0; }
  };

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
    x.putImageData(id, 0, 0);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  }

  /* ───────── Leitura ao vivo na câmera ───────── */
  const L = {
    enabled: true, running: false, timer: null, frameCanvas: null, frameCtx: null,
    lastSeen: new Map(),        /* conteúdo -> último instante visto */
    blocked: new Map(),         /* conteúdo -> não reabrir enquanto continuar visível */
    ocrHits: new Map(), lastOcr: 0, ocrRunning: false,
    lastBox: null, lastBoxT: 0
  };

  function loadPref() { try { const v = localStorage.getItem('gs_linkscan'); if (v !== null) L.enabled = v === '1'; } catch (e) { } }
  function savePref() { try { localStorage.setItem('gs_linkscan', L.enabled ? '1' : '0'); } catch (e) { } }

  function updateToggle() {
    const b = $('linkBtn');
    if (b) { b.classList.toggle('active', L.enabled); b.setAttribute('aria-pressed', L.enabled ? 'true' : 'false'); }
    const badge = $('linkBadge');
    if (badge) badge.classList.toggle('hidden', !(L.enabled && shouldScan()));
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
    const sc = Math.min(1, 800 / Math.max(sw, sh));
    const w = Math.round(sw * sc), h = Math.round(sh * sc);
    if (L.frameCanvas.width !== w || L.frameCanvas.height !== h) { L.frameCanvas.width = w; L.frameCanvas.height = h; }
    L.frameCtx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
    const now = performance.now();
    let found = [];
    try { found = await readQR(L.frameCanvas, L.frameCtx); } catch (e) { console.warn('QR:', e); }
    if (!L.enabled || !shouldScan()) { clearOverlay(); schedule(300); return; }
    if (found.length) {
      const q = found[0];
      L.lastBox = q.corners.map(p => [sx + p[0] / sc, sy + p[1] / sc]); L.lastBoxT = now;
      drawBox(L.lastBox, q.raw);
      handleDetection(q.raw, 'qr', now);
    } else if (now - L.lastBoxT > 400) clearOverlay();
    releaseBlocks(now);

    /* OCR de links impressos, em paralelo e num ritmo menor */
    if (!L.ocrRunning && OCR.canWorker() && now - L.lastOcr > 800 && !found.length) {
      L.ocrRunning = true; L.lastOcr = now;
      /* quadro inteiro (o texto pode passar um pouco da borda visível) */
      ocrPng(video, 0, 0, vw, vh, 1280).then(png => OCR.recognize(png)).then(r => {
        if (!L.enabled) return;
        const links = extractLinks(r.text);
        const t = performance.now();
        const keys = new Set();
        for (const url of links) {
          /* agrupa leituras pelo domínio; guarda a versão mais completa do endereço */
          const key = new URL(url).hostname.replace(/^www\./, '');
          keys.add(key);
          const h = L.ocrHits.get(key) || { n: 0, url };
          h.n++; if (url.length > h.url.length) h.url = url;
          L.ocrHits.set(key, h);
          L.lastSeen.set(h.url, t); L.lastSeen.set(key, t);
          /* link impresso precisa aparecer em 2 leituras seguidas (evita falsos positivos) */
          if (h.n >= 2 && !L.blocked.has(key)) { L.blocked.set(key, t); handleDetection(h.url, 'ocr', t); }
        }
        for (const k of Array.from(L.ocrHits.keys())) if (!keys.has(k)) L.ocrHits.delete(k);
      }).catch(e => { if (!/indisponível/.test(e.message)) console.warn('OCR:', e.message); })
        .finally(() => { L.ocrRunning = false; });
    }
    schedule(found.length ? 350 : 260);
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
    open(parsed, source === 'ocr' ? 'Link impresso' : 'QR Code');
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
    ctx.lineWidth = 3 * dpr; ctx.strokeStyle = '#32d74b'; ctx.fillStyle = 'rgba(50,215,75,.16)';
    ctx.beginPath(); corners.forEach((p, i) => { const q = P(p); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  function clearOverlay() { const cv = $('linkCanvas'); if (cv && cv.width) cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); }

  /* ───────── Mini navegador ───────── */
  const W = { url: null, loadTimer: null, parsed: null, history: [] };

  function host(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return url; } }
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function showSheet() {
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
  function start() { loadPref(); updateToggle(); if (L.enabled) schedule(500); }
  function onVisibility() { if (!document.hidden && L.enabled && !L.timer) schedule(300); }

  /* ───────── Leitura de uma foto da galeria ───────── */
  async function scanImage(img, onStatus) {
    const sc = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const mk = (flip) => {
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * sc); c.height = Math.round(img.naturalHeight * sc);
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
      if (links.length) return { parsed: { kind: 'url', url: links[0], raw: links[0] }, source: 'Link impresso', all: links, text: r.text };
      if (!k) lastText = r.text;
    }
    return { parsed: null, text: lastText };
  }

  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('webSheet').classList.contains('hidden')) close(); });

  root.LinkScan = {
    start, toggle, close, reload, openExternal, copyUrl, share, open, openUrl, scanImage,
    parseContent, extractLinks, normalizeUrl, wake: () => { if (L.enabled && !L.timer) schedule(200); updateToggle(); },
    get enabled() { return L.enabled; }, _state: L, _ocr: OCR
  };
})(window);
