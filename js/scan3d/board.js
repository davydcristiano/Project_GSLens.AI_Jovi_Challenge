/* ═══════════════════════════════════════════════════
   GSLens.AI — Scanner 3D · board.js
   Prancha de escaneamento (folha A4) com 20 marcadores
   ArUco (dicionário ARUCO_MIP_36h12) ao redor de uma
   área livre central onde o objeto é colocado.

   Sistema de coordenadas da prancha (milímetros):
     origem = centro da folha, +X = direita, +Y = topo da
     página impressa, +Z = para cima (saindo do papel).
   Como a prancha tem tamanho físico conhecido, o modelo
   reconstruído sai em ESCALA REAL (se impressa a 100%).
═══════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const GS3D = root.GS3D = root.GS3D || {};

  const SHEET_W = 210, SHEET_H = 297;          /* A4 retrato */
  const MARKER = 30;                           /* lado do quadrado preto (mm) */
  const DICT = 'ARUCO_MIP_36h12';

  /* Volume de escaneamento (mm) — o objeto deve caber aqui */
  const VOLUME = { xmin: -55, xmax: 55, ymin: -55, ymax: 55, zmin: 0, zmax: 110 };

  /* Região da folha cuja aparência é conhecida (papel + impressão).
     Um pouco menor que a folha para tolerar bordas cortadas. */
  const KNOWN = { xmin: -101, xmax: 101, ymin: -144, ymax: 144 };

  /* Layout dos marcadores: id -> centro (mm) */
  const markers = [];
  (function buildLayout() {
    const xs = [-80, -40, 0, 40, 80];
    const ys = [80, 40, 0, -40, -80];
    let id = 0;
    for (const x of xs) markers.push({ id: id++, cx: x, cy: 123.5 });            /* topo      0..4  */
    for (const y of ys) markers.push({ id: id++, cx: 80, cy: y });               /* direita   5..9  */
    for (const x of xs.slice().reverse()) markers.push({ id: id++, cx: x, cy: -123.5 }); /* base 10..14 */
    for (const y of ys.slice().reverse()) markers.push({ id: id++, cx: -80, cy: y });    /* esquerda 15..19 */
    const h = MARKER / 2;
    for (const m of markers) {
      /* Cantos na ordem do ArUco: sup-esq, sup-dir, inf-dir, inf-esq
         (como o marcador aparece impresso de pé na página). */
      m.corners = [[m.cx - h, m.cy + h], [m.cx + h, m.cy + h], [m.cx + h, m.cy - h], [m.cx - h, m.cy - h]];
    }
  })();
  const markerById = new Map(markers.map(m => [m.id, m]));

  let _dict = null;
  function dictionary() {
    if (!_dict) {
      if (!root.AR || !root.AR.Dictionary) throw new Error('Biblioteca de marcadores (js-aruco2) não carregada.');
      _dict = new root.AR.Dictionary(DICT);
    }
    return _dict;
  }

  /* Bits do marcador: matriz (markSize-2)² com 1 = célula branca */
  function markerBits(id) {
    const d = dictionary();
    const code = d.codeList[id];
    const n = d.markSize - 2;
    const bits = [];
    for (let y = 0; y < n; y++) {
      const row = [];
      for (let x = 0; x < n; x++) row.push(code[y * n + x] === '1' ? 1 : 0);
      bits.push(row);
    }
    return { bits, cells: d.markSize };
  }

  /* Desenha a prancha num contexto 2D.
     pxPerMm: resolução; o canvas deve ter SHEET_W*pxPerMm × SHEET_H*pxPerMm. */
  function drawBoard(ctx, pxPerMm, opts) {
    opts = opts || {};
    const W = SHEET_W * pxPerMm, H = SHEET_H * pxPerMm;
    const X = mm => (mm + SHEET_W / 2) * pxPerMm;     /* mm -> px (x) */
    const Y = mm => (SHEET_H / 2 - mm) * pxPerMm;     /* mm -> px (y, invertido) */
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    for (const m of markers) {
      const { bits, cells } = markerBits(m.id);
      const cell = MARKER / cells;
      const x0 = m.cx - MARKER / 2, y0 = m.cy + MARKER / 2;   /* canto sup-esq em mm */
      ctx.fillStyle = '#000000';
      ctx.fillRect(X(x0), Y(y0), MARKER * pxPerMm, MARKER * pxPerMm);
      ctx.fillStyle = '#ffffff';
      for (let r = 0; r < cells - 2; r++)
        for (let c = 0; c < cells - 2; c++)
          if (bits[r][c]) ctx.fillRect(X(x0 + (c + 1) * cell), Y(y0 - (r + 1) * cell), cell * pxPerMm, cell * pxPerMm);
    }

    if (!opts.markersOnly) {
      /* Guias claras da área do objeto (impressas em cinza bem claro) */
      ctx.strokeStyle = '#d6d6d6';
      ctx.lineWidth = Math.max(1, 0.35 * pxPerMm);
      ctx.strokeRect(X(VOLUME.xmin), Y(VOLUME.ymax), (VOLUME.xmax - VOLUME.xmin) * pxPerMm, (VOLUME.ymax - VOLUME.ymin) * pxPerMm);
      ctx.beginPath();
      ctx.moveTo(X(-6), Y(0)); ctx.lineTo(X(6), Y(0));
      ctx.moveTo(X(0), Y(-6)); ctx.lineTo(X(0), Y(6));
      ctx.stroke();

      ctx.fillStyle = '#9a9a9a';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `${3.2 * pxPerMm}px sans-serif`;
      ctx.fillText('Posicione o objeto dentro do quadrado', X(0), Y(-66));
      ctx.font = `${2.6 * pxPerMm}px sans-serif`;
      ctx.fillText('GSLens.AI · Prancha do Scanner 3D · imprima em A4 a 100% (tamanho real)', X(0), Y(-73));
      /* Barra de escala de 50 mm para conferir a impressão */
      ctx.fillStyle = '#9a9a9a';
      ctx.fillRect(X(-25), Y(-82), 50 * pxPerMm, 1.2 * pxPerMm);
      ctx.fillRect(X(-25), Y(-80.5), 0.5 * pxPerMm, 3 * pxPerMm);
      ctx.fillRect(X(24.5), Y(-80.5), 0.5 * pxPerMm, 3 * pxPerMm);
      ctx.font = `${2.4 * pxPerMm}px sans-serif`;
      ctx.fillText('50 mm', X(0), Y(-86));
      ctx.fillText('↑ topo da prancha', X(0), Y(100));
    }
    ctx.restore();
  }

  /* Mapa de "densidade de tinta" esperada (0 = papel, 1 = preto),
     usado pela segmentação. Resolução: res px/mm. */
  let _expected = null;
  function expectedMap(res) {
    res = res || 2;
    if (_expected && _expected.res === res) return _expected;
    const w = SHEET_W * res, h = SHEET_H * res;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    drawBoard(ctx, res);
    const d = ctx.getImageData(0, 0, w, h).data;
    const ink = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) ink[i] = 1 - (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
    _expected = { res, w, h, ink };
    return _expected;
  }
  /* Amostra bilinear do mapa esperado em coordenadas da prancha (mm) */
  function sampleExpected(map, xmm, ymm) {
    const fx = (xmm + SHEET_W / 2) * map.res - 0.5, fy = (SHEET_H / 2 - ymm) * map.res - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    if (x0 < 0 || y0 < 0 || x0 >= map.w - 1 || y0 >= map.h - 1) return 0;
    const ax = fx - x0, ay = fy - y0, i = y0 * map.w + x0, k = map.ink;
    return (k[i] * (1 - ax) + k[i + 1] * ax) * (1 - ay) + (k[i + map.w] * (1 - ax) + k[i + map.w + 1] * ax) * ay;
  }

  /* ── Arquivos para impressão ── */
  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /* PDF vetorial em tamanho real (preferido) — usa jsPDF já presente no projeto */
  function printablePDF() {
    const jsPDF = root.jspdf && root.jspdf.jsPDF;
    if (!jsPDF) return null;
    const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
    const X = mm => mm + SHEET_W / 2, Y = mm => SHEET_H / 2 - mm;
    pdf.setFillColor(0, 0, 0);
    for (const m of markers) {
      const { bits, cells } = markerBits(m.id);
      const cell = MARKER / cells;
      const x0 = m.cx - MARKER / 2, y0 = m.cy + MARKER / 2;
      pdf.setFillColor(0, 0, 0);
      pdf.rect(X(x0), Y(y0), MARKER, MARKER, 'F');
      pdf.setFillColor(255, 255, 255);
      for (let r = 0; r < cells - 2; r++)
        for (let c = 0; c < cells - 2; c++)
          if (bits[r][c]) pdf.rect(X(x0 + (c + 1) * cell), Y(y0 - (r + 1) * cell), cell + 0.02, cell + 0.02, 'F');
    }
    pdf.setDrawColor(214, 214, 214);
    pdf.setLineWidth(0.35);
    pdf.rect(X(VOLUME.xmin), Y(VOLUME.ymax), VOLUME.xmax - VOLUME.xmin, VOLUME.ymax - VOLUME.ymin, 'S');
    pdf.line(X(-6), Y(0), X(6), Y(0));
    pdf.line(X(0), Y(-6), X(0), Y(6));
    pdf.setTextColor(154, 154, 154);
    pdf.setFontSize(9);
    pdf.text('Posicione o objeto dentro do quadrado', X(0), Y(-66), { align: 'center', baseline: 'middle' });
    pdf.setFontSize(7);
    pdf.text('GSLens.AI - Prancha do Scanner 3D - imprima em A4 a 100% (tamanho real)', X(0), Y(-73), { align: 'center', baseline: 'middle' });
    pdf.setFillColor(154, 154, 154);
    pdf.rect(X(-25), Y(-82), 50, 1.2, 'F');
    pdf.rect(X(-25), Y(-80.5), 0.5, 3, 'F');
    pdf.rect(X(24.5), Y(-80.5), 0.5, 3, 'F');
    pdf.setFontSize(7);
    pdf.text('50 mm', X(0), Y(-86), { align: 'center', baseline: 'middle' });
    pdf.text('topo da prancha', X(0), Y(100), { align: 'center', baseline: 'middle' });
    return pdf;
  }

  async function downloadPrintable() {
    try {
      const pdf = printablePDF();
      if (pdf) { pdf.save('GSLens_Prancha_Scanner3D_A4.pdf'); return 'pdf'; }
    } catch (e) { console.warn('PDF da prancha falhou, usando PNG:', e); }
    /* Alternativa: PNG a 300 dpi (11.811 px/mm) */
    const res = 300 / 25.4;
    const cv = document.createElement('canvas');
    cv.width = Math.round(SHEET_W * res); cv.height = Math.round(SHEET_H * res);
    drawBoard(cv.getContext('2d'), res);
    const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
    if (!blob) throw new Error('Não foi possível gerar a imagem da prancha.');
    downloadBlob(blob, 'GSLens_Prancha_Scanner3D_A4_300dpi.png');
    return 'png';
  }

  GS3D.board = {
    SHEET_W, SHEET_H, MARKER, DICT, VOLUME, KNOWN,
    markers, markerById, drawBoard, expectedMap, sampleExpected, markerBits,
    downloadPrintable, downloadBlob
  };
})(typeof window !== 'undefined' ? window : globalThis);
