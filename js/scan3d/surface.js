/* ═══════════════════════════════════════════════════
   GSLens.AI — Scanner 3D · surface.js
   Escaneamento SEM a prancha impressa: a referência é a própria
   superfície onde o objeto está (mesa de madeira, toalha estampada,
   revista…), fotografada vazia antes de colocar o objeto.

   1. SurfaceTracker — rastreia o plano da mesa:
      • cantos de textura na foto de referência;
      • a cada quadro: fluxo óptico do quadro anterior (previsão) e,
        em seguida, o quadro é RETIFICADO para o ponto de vista da
        referência e realinhado contra ela (Lucas‑Kanade) — sem deriva;
      • homografia referência→quadro por RANSAC.
   2. selfCalibrate — sem marcadores não há medidas conhecidas: a distância
      focal e a inclinação da foto de referência são estimadas pelas próprias
      vistas (autocalibração por plano: as colunas de K⁻¹·H precisam ser
      ortogonais e de mesmo comprimento — restrições de Zhang/Triggs),
      e depois refinadas pelo erro de reprojeção.
   3. segmentSurface — silhueta do objeto: cada vista é comparada com a
      foto da mesa vazia projetada naquele ponto de vista (com correção de
      iluminação; sombras — mais escuras mas com a mesma textura — contam
      como mesa).

   Unidades: "mm aproximados" — a escala supõe a foto de referência tirada a
   ~30 cm da mesa; a tela de resultado permite corrigir com uma medida real.
═══════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const GS3D = root.GS3D = root.GS3D || {};
  const M = GS3D.math, F = GS3D.features;

  const REF_DIST = 300;              /* distância suposta da foto de referência (mm) */

  /* ═════════════ RASTREADOR ═════════════ */
  class SurfaceTracker {
    constructor() { this.ref = null; }

    /* imagem da superfície vazia (ImageData) → pontos de textura */
    setReference(img) {
      const g = F.gray(img);
      const c = F.corners(g, { maxN: 360, cols: 18, rows: 12, perCell: 3, quality: 0.015, minScore: 40, border: 10, minDist: 8 });
      const n = c.pts.length;
      if (n < 90) return { ok: false, n, reason: 'Superfície lisa demais: use uma mesa com textura (madeira, toalha estampada, revista aberta…).' };
      /* espalhamento: precisa haver pontos em boa parte da imagem */
      const cells = new Set(c.pts.map(p => ((p[1] * 4 / g.h) | 0) * 4 + ((p[0] * 4 / g.w) | 0)));
      if (cells.size < 11) return { ok: false, n, reason: 'Pouca textura espalhada pela superfície — afaste a câmera ou use uma superfície mais estampada.' };
      this.ref = { w: g.w, h: g.h, gray: g, pyr: F.pyramid(g, 4), pts: c.pts.map(p => [p[0], p[1]]) };
      this.H = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      this.prevPyr = this.ref.pyr;
      this.prevPos = this.ref.pts.map(p => p.slice());
      this.lostFrames = 0;
      const f0 = F.orbFeatures(this.ref.pyr);
      this.anchors = [{ pts: f0.pts, desc: f0.desc, H: [1, 0, 0, 0, 1, 0, 0, 0, 1] }];
      this.prev = this.anchors[0]; this.scan = 0;
      this.grid = [];
      for (let y = 0.2; y < 0.9; y += 0.3) for (let x = 0.2; x < 0.9; x += 0.3) this.grid.push([x * g.w, y * g.h]);
      return { ok: true, n };
    }

    /* um quadro (ImageData, mesma resolução da referência) → { ok, H, inliers, ... }
       Previsão da homografia, em ordem:
       1) casamento de descritores com o último quadro rastreado (tolera
          movimentos grandes entre quadros e giro da imagem);
       2) fluxo óptico do quadro anterior;
       3) relocalização: casamento com as vistas‑âncora guardadas pelo caminho.
       Depois, realinhamento fino contra a foto de referência. */
    track(img) {
      const R = this.ref;
      if (!R) return { ok: false };
      const g = F.gray(img), pyr = F.pyramid(g, 4);
      const feats = F.orbFeatures(pyr);
      let Hp = null;
      if (this.prev && !this.lostFrames) Hp = this.matchTo(this.prev, feats, 15);
      if (!Hp && !this.lostFrames) Hp = this.flowPredict(pyr, g);
      if (!Hp) {
        /* relocalização: âncoras mais recentes primeiro (até 10 por quadro, em rodízio) */
        const A = this.anchors, n = A.length, tries = Math.min(n, 10);
        for (let k = 0; k < tries && !Hp; k++) {
          const idx = this.lostFrames ? (n - 1 - ((this.scan + k) % n)) : (n - 1 - k);
          Hp = this.matchTo(A[idx], feats, 20);
        }
        this.scan = (this.scan + tries) % Math.max(1, n);
      }
      let res = Hp ? this.refine(pyr, g, Hp) : null;
      if (!res && !Hp && this.lostFrames < 2) res = this.refine(pyr, g, this.H);
      this.prevPyr = pyr;
      if (!res || !sane(res.H, R.w, R.h, g.w, g.h)) {
        this.lostFrames++;
        return { ok: false, lost: this.lostFrames > 3 };
      }
      this.H = res.H; this.lostFrames = 0;
      this.prevPos = R.pts.map(p => F.applyH(res.H, p));
      this.prev = { pts: feats.pts, desc: feats.desc, H: res.H };
      this.maybeAnchor(this.prev);
      return res;
    }

    /* homografia referência→atual a partir do casamento com um quadro de H conhecida */
    matchTo(fr, feats, minInl) {
      const m = F.matchBinary(fr, feats);
      if (m.length < minInl) return null;
      const r = F.ransacH(m.map(([i]) => fr.pts[i]), m.map(([, j]) => feats.pts[j]), { thresh: 4, iters: 250 });
      if (!r || r.count < minInl) return null;
      return M.mul3(r.H, fr.H);
    }

    flowPredict(pyr, g) {
      const R = this.ref, idx = [], from = [];
      for (let i = 0; i < R.pts.length; i++) { const p = this.prevPos[i]; if (p && p[0] > 10 && p[1] > 10 && p[0] < g.w - 10 && p[1] < g.h - 10) { idx.push(i); from.push(p); } }
      if (idx.length < 12) return null;
      const f = F.lk(this.prevPyr, pyr, from, null, { win: 6, iters: 10, maxErr: 22 });
      const s = [], d = [];
      idx.forEach((i, k) => { if (f.ok[k]) { s.push(R.pts[i]); d.push(f.pts[k]); } });
      const r = s.length >= 12 ? F.ransacH(s, d, { thresh: 3, iters: 150 }) : null;
      return r && r.count >= 12 ? r.H : null;
    }

    /* guarda uma vista‑âncora quando o ponto de vista mudou bastante desde a última */
    maybeAnchor(fr) {
      const R = this.ref, last = this.anchors[this.anchors.length - 1];
      let move = 0;
      for (const p of this.grid) { const a = F.applyH(fr.H, p), b = F.applyH(last.H, p); move += Math.hypot(a[0] - b[0], a[1] - b[1]); }
      move /= this.grid.length;
      if (move < 0.12 * Math.max(R.w, R.h)) return;
      this.anchors.push(fr);
      if (this.anchors.length > 48) this.anchors.splice(1, 1);       /* mantém sempre a referência (índice 0) */
    }

    /* realinhamento de um quadro avulso (ex.: quadro-chave em resolução maior) */
    refineImage(img, Hp) { const g = F.gray(img); return this.refine(F.pyramid(g, 4), g, Hp); }

    refine(pyr, g, Hp) {
      const R = this.ref;
      const Hi = M.inv3(Hp);
      if (!Hi) return null;
      /* rect(x) = quadro(Hp·x): o quadro visto do ponto de vista da referência */
      const rect = F.warp(g, Hp, R.w, R.h);
      /* normaliza exposição (média/desvio) só na área válida */
      let s = 0, s2 = 0, n = 0, r1 = 0, r2 = 0;
      for (let i = 0; i < rect.d.length; i += 3) { const v = rect.d[i]; if (v === v) { s += v; s2 += v * v; r1 += R.gray.d[i]; r2 += R.gray.d[i] * R.gray.d[i]; n++; } }
      if (n < rect.d.length / 3 * 0.25) return null;                 /* superfície quase fora da tela */
      const mr = s / n, sr = Math.sqrt(Math.max(1, s2 / n - mr * mr)), mf = r1 / n, sf = Math.sqrt(Math.max(1, r2 / n - mf * mf));
      const a = sf / sr, b = mf - a * mr;
      for (let i = 0; i < rect.d.length; i++) { const v = rect.d[i]; if (v === v) rect.d[i] = a * v + b; }
      const rp = F.pyramid(rect, 3);
      const f = F.lk(R.pyr, rp, R.pts, null, { win: 7, iters: 12, maxErr: 20 });
      const src = [], dst = [], ids = [];
      for (let i = 0; i < R.pts.length; i++) {
        if (!f.ok[i]) continue;
        const q = f.pts[i];
        if (Math.hypot(q[0] - R.pts[i][0], q[1] - R.pts[i][1]) > 25) continue;
        src.push(R.pts[i]); dst.push(F.applyH(Hp, q)); ids.push(i);
      }
      if (src.length < 14) return null;
      const r = F.ransacH(src, dst, { thresh: 2.5, iters: 200 });
      if (!r || r.count < 14 || r.count < 0.25 * src.length) return null;
      const inl = [];
      ids.forEach((id, k) => { if (r.inliers[k]) inl.push([id, dst[k][0], dst[k][1]]); });
      return { ok: true, H: r.H, inliers: r.count, tracked: src.length, rms: r.rms, matches: inl };
    }
  }

  /* homografia plausível (não espelhada, sem escala absurda) */
  function sane(H, rw, rh, w, h) {
    if (!H || !H.every(isFinite)) return false;
    const c = [[0, 0], [rw, 0], [rw, rh], [0, rh]].map(p => { const z = H[6] * p[0] + H[7] * p[1] + H[8]; return z > 0 ? F.applyH(H, p) : null; });
    if (c.some(p => !p)) return false;
    let area = 0;
    for (let i = 0; i < 4; i++) { const p = c[i], q = c[(i + 1) % 4]; area += p[0] * q[1] - q[0] * p[1]; }
    area /= 2;
    return area > 0.01 * rw * rh && area < 40 * w * h;
  }

  /* ═════════════ GEOMETRIA DA REFERÊNCIA ═════════════
     Mundo: plano da mesa z = 0, z para cima. Câmera de referência olhando para
     baixo, inclinada por (ax, ay) rad em torno dos seus eixos x e y; a origem
     do mundo é o ponto da mesa no centro da foto de referência. */
  function refPose(ax, ay, d) {
    const R0 = [1, 0, 0, 0, -1, 0, 0, 0, -1];
    const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay);
    const Rx = [1, 0, 0, 0, cx, -sx, 0, sx, cx], Ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
    return { R: M.mul3(Rx, M.mul3(Ry, R0)), t: [0, 0, d || REF_DIST] };
  }
  /* A: plano (mm) → pixel da referência */
  function planeToRef(K, ax, ay, d) {
    const p = refPose(ax, ay, d), R = p.R, t = p.t;
    return M.mul3(K, [R[0], R[1], t[0], R[3], R[4], t[1], R[6], R[7], t[2]]);
  }

  /* inclinação inicial a partir da gravidade medida no momento da referência
     (vetor no sistema do aparelho em retrato: x direita, y para cima, z para fora da tela) */
  function tiltFromGravity(gv) {
    if (!gv) return [0, 0];
    const n = Math.hypot(gv[0], gv[1], gv[2]);
    if (!(n > 5)) return [0, 0];
    /* câmera traseira olhando para baixo: gravidade ≈ (0,0,-g) no aparelho */
    const gx = gv[0] / n, gy = gv[1] / n;
    return [Math.asin(Math.max(-1, Math.min(1, -gy))), Math.asin(Math.max(-1, Math.min(1, gx)))];
  }

  /* Nelder–Mead (minimização sem derivadas) */
  function nelderMead(fn, x0, step, iters) {
    const n = x0.length;
    let S = [x0.slice()];
    for (let i = 0; i < n; i++) { const x = x0.slice(); x[i] += step[i]; S.push(x); }
    let V = S.map(fn);
    for (let it = 0; it < (iters || 200); it++) {
      const o = V.map((v, i) => i).sort((a, b) => V[a] - V[b]); S = o.map(i => S[i]); V = o.map(i => V[i]);
      const c = new Array(n).fill(0); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += S[i][j] / n;
      const xr = c.map((v, j) => v + (v - S[n][j])), fr = fn(xr);
      if (fr < V[0]) { const xe = c.map((v, j) => v + 2 * (v - S[n][j])), fe = fn(xe); if (fe < fr) { S[n] = xe; V[n] = fe; } else { S[n] = xr; V[n] = fr; } }
      else if (fr < V[n - 1]) { S[n] = xr; V[n] = fr; }
      else {
        const xc = c.map((v, j) => v + 0.5 * (S[n][j] - v)), fc = fn(xc);
        if (fc < V[n]) { S[n] = xc; V[n] = fc; }
        else { for (let i = 1; i <= n; i++) { S[i] = S[i].map((v, j) => S[0][j] + 0.5 * (v - S[0][j])); V[i] = fn(S[i]); } }
      }
      if (Math.abs(V[n] - V[0]) < 1e-12) break;
    }
    const b = V.indexOf(Math.min(...V));
    return { x: S[b], f: V[b] };
  }

  /* custo de Zhang: colunas de K⁻¹·H·A ortogonais e de mesmo comprimento */
  function zhangCost(Hs, w, h, f, ax, ay) {
    const K = M.kForImage(f, w, h), Ki = M.inv3(K), A = planeToRef(K, ax, ay);
    let c = 0;
    for (const H of Hs) {
      const G = M.mul3(Ki, M.mul3(H, A));
      const h1 = [G[0], G[3], G[6]], h2 = [G[1], G[4], G[7]];
      const n1 = h1[0] * h1[0] + h1[1] * h1[1] + h1[2] * h1[2], n2 = h2[0] * h2[0] + h2[1] * h2[1] + h2[2] * h2[2];
      const e1 = (h1[0] * h2[0] + h1[1] * h2[1] + h1[2] * h2[2]) / Math.sqrt(n1 * n2), e2 = (n1 - n2) / (n1 + n2);
      c += e1 * e1 + e2 * e2;
    }
    return c / Hs.length;
  }

  /* 1ª etapa da autocalibração (rápida — também usada ao vivo para a sobreposição AR):
     restrições de Zhang com várias partidas de focal e inclinação */
  function calibrateZhang(Hs, w, h, init) {
    init = init || {};
    const md = Math.max(w, h);
    const fs = [init.f, 0.65 * md, 0.85 * md, 1.1 * md, 1.5 * md].filter(Boolean);
    const tilts = (init.tilt ? [init.tilt] : []).concat([[0, 0], [0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]]);
    let best = null;
    for (const f0 of fs) for (const t0 of tilts) {
      const r = nelderMead(x => {
        if (x[0] < 0.35 * md || x[0] > 4 * md || Math.abs(x[1]) > 0.9 || Math.abs(x[2]) > 0.9) return 1e3;
        return zhangCost(Hs, w, h, x[0], x[1], x[2]);
      }, [f0, t0[0], t0[1]], [0.15 * md, 0.08, 0.08], 160);
      if (!best || r.f < best.f) best = r;
    }
    return { f: best.x[0], ax: best.x[1], ay: best.x[2], cost: best.f };
  }

  /* Autocalibração. kfs: [{ H (ref→kf, px), matches:[[refIdx,u,v]] }], refPts: pontos da referência.
     Retorna { f, ax, ay, K, A, poses } */
  function selfCalibrate(kfs, refPts, w, h, init) {
    const md = Math.max(w, h);
    const z = calibrateZhang(kfs.map(k => k.H), w, h, init);
    const best = { x: [z.f, z.ax, z.ay], f: z.cost };
    /* 2) refino pelo erro de reprojeção dos pontos da mesa */
    const viewsFor = (f, ax, ay, iters) => {
      const K = M.kForImage(f, w, h), A = planeToRef(K, ax, ay), Ai = M.inv3(A);
      const plane = refPts.map(p => { const q = F.applyH(Ai, p); return [q[0], q[1], 0]; });
      let s = 0, n = 0;
      const poses = kfs.map(kf => {
        const G = M.mul3(kf.H, A);
        const p0 = M.poseFromHomography(G, K);
        if (!p0) return null;
        const obj = [], img = [];
        for (const [id, u, v] of kf.matches) { obj.push(plane[id]); img.push([u, v]); }
        if (obj.length < 8) return { K, R: p0.R, t: p0.t, rms: 99, C: M.cameraCenter(p0.R, p0.t) };
        const r = M.refinePose(K, p0.R, p0.t, obj, img, iters);
        s += r.rms * r.rms * obj.length; n += obj.length;
        return { K, R: r.R, t: r.t, rms: r.rms, C: M.cameraCenter(r.R, r.t), n: obj.length };
      });
      return { K, A, poses, cost: n ? s / n : Infinity };
    };
    const r2 = nelderMead(x => {
      if (x[0] < 0.35 * md || x[0] > 4 * md || Math.abs(x[1]) > 0.8 || Math.abs(x[2]) > 0.8) return 1e9;
      return viewsFor(x[0], x[1], x[2], 5).cost;
    }, best.x, [0.04 * best.x[0], 0.02, 0.02], 45);
    const [f, ax, ay] = r2.x;
    const out = viewsFor(f, ax, ay, 15);
    return { f, ax, ay, K: out.K, A: out.A, poses: out.poses, zhang: best.f, reprojRms: Math.sqrt(out.cost) };
  }

  /* ═════════════ SILHUETAS CONTRA A SUPERFÍCIE VAZIA ═════════════
     view: { rgba, w, h, Hk (ref→vista) }, ref: { rgba, w, h }
     máscara: 0 = mesa, 1 = objeto, 2 = desconhecido (fora da referência) */
  function segmentSurface(view, ref) {
    const { rgba, w, h } = view, n = w * h;
    const Hi = M.inv3(view.Hk);
    if (!Hi) return { mask: null };
    /* 1) referência projetada no ponto de vista desta foto (RGB + luminância) */
    const RL = new Float32Array(n).fill(NaN), RR = new Float32Array(n), RG = new Float32Array(n), RB = new Float32Array(n);
    const rw = ref.w, rh = ref.h, rd = ref.rgba, M2 = 6;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const z = Hi[6] * x + Hi[7] * y + Hi[8];
      if (!(z > 0)) continue;
      const u = (Hi[0] * x + Hi[1] * y + Hi[2]) / z, v = (Hi[3] * x + Hi[4] * y + Hi[5]) / z;
      if (u < M2 || v < M2 || u > rw - 1 - M2 || v > rh - 1 - M2) continue;
      const x0 = u | 0, y0 = v | 0, ax = u - x0, ay = v - y0, i = (y0 * rw + x0) * 4;
      const wa = (1 - ax) * (1 - ay), wb = ax * (1 - ay), wc = (1 - ax) * ay, wd = ax * ay, s = rw * 4, j = y * w + x;
      RR[j] = rd[i] * wa + rd[i + 4] * wb + rd[i + s] * wc + rd[i + s + 4] * wd;
      RG[j] = rd[i + 1] * wa + rd[i + 5] * wb + rd[i + s + 1] * wc + rd[i + s + 5] * wd;
      RB[j] = rd[i + 2] * wa + rd[i + 6] * wb + rd[i + s + 2] * wc + rd[i + s + 6] * wd;
      RL[j] = RR[j] * 0.299 + RG[j] * 0.587 + RB[j] * 0.114;
    }
    const L = new Float32Array(n);
    for (let i = 0; i < n; i++) L[i] = rgba[4 * i] * 0.299 + rgba[4 * i + 1] * 0.587 + rgba[4 * i + 2] * 0.114;

    /* 2) iluminação: razão de luminância vista/referência como função suave
       (quadrática) da posição, ajustada de forma robusta */
    const samp = [], step = Math.max(1, Math.round(Math.sqrt(n / 30000)));
    for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
      const i = y * w + x; if (!(RL[i] > 12)) continue;
      samp.push(x / w, y / h, L[i] / RL[i]);
    }
    if (samp.length < 900) return { mask: null, reason: 'superfície de referência pouco visível' };
    const coef = fitRatio(samp);
    if (!coef) return { mask: null };
    const ratioAt = (x, y) => { const u = x / w, v = y / h; return coef[0] + coef[1] * u + coef[2] * v + coef[3] * u * u + coef[4] * v * v + coef[5] * u * v; };

    /* 3) semelhança local de textura (correlação 7×7 entre vista e referência) —
       sombra: mais escura mas com o mesmo desenho da mesa */
    const ncc = localNCC(L, RL, w, h, 3);

    /* 4) classificação: diferença de cor tolerante a pequenos desalinhamentos
       (compara com o mínimo/máximo da referência numa vizinhança 5×5) */
    const mask = new Uint8Array(n).fill(2), obj = new Uint8Array(n);
    const rad = 2;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!(RL[i] === RL[i])) continue;
      const k = Math.max(0.2, ratioAt(x, y));
      const r = rgba[4 * i] / k, g = rgba[4 * i + 1] / k, b = rgba[4 * i + 2] / k;
      let dmin = Infinity, partial = false;
      for (let dy = -rad; dy <= rad; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) { partial = true; continue; }
        for (let dx = -rad; dx <= rad; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w) { partial = true; continue; }
          const j = yy * w + xx; if (!(RL[j] === RL[j])) { partial = true; continue; }
          const d = Math.abs(r - RR[j]) + Math.abs(g - RG[j]) + Math.abs(b - RB[j]);
          if (d < dmin) dmin = d;
        }
      }
      if (partial && dmin === Infinity) continue;
      const lv = L[i] / k, lr = RL[i];
      const tol = 36 + 0.12 * lr;
      if (dmin <= tol) { mask[i] = 0; continue; }
      /* sombra: luminância caiu (até ~35%), crominância parecida e textura correlacionada */
      const q = L[i] / Math.max(1, lr * k);
      const s1 = r + g + b + 1, s2 = RR[i] + RG[i] + RB[i] + 1;
      const cd = Math.abs(r / s1 - RR[i] / s2) + Math.abs(g / s1 - RG[i] / s2);
      if (q > 0.3 && q < 1.02 && cd < 0.07 && ncc[i] > 0.55) { mask[i] = 0; continue; }
      obj[i] = 1; mask[i] = 1;
    }
    /* 5) limpeza (abertura + fechamento) e componentes muito pequenos */
    let clean = morph(morph(obj, w, h, 1, false), w, h, 1, true);
    clean = morph(morph(clean, w, h, 3, true), w, h, 3, false);
    let nObj = 0;
    for (let i = 0; i < n; i++) {
      if (clean[i]) { if (mask[i] !== 2 || obj[i]) { mask[i] = 1; nObj++; } }
      else if (mask[i] === 1) mask[i] = 0;
    }
    return { mask, nObj, gain: coef[0], paperL0: 100 * coef[0] };
  }

  function fitRatio(samp) {
    const n = samp.length / 3, w = new Float64Array(n).fill(1);
    let coef = null;
    for (let it = 0; it < 6; it++) {
      const A = new Float64Array(36), bb = new Float64Array(6);
      for (let i = 0; i < n; i++) {
        if (!w[i]) continue;
        const u = samp[3 * i], v = samp[3 * i + 1], y = samp[3 * i + 2], phi = [1, u, v, u * u, v * v, u * v];
        for (let a = 0; a < 6; a++) { bb[a] += w[i] * phi[a] * y; for (let b = 0; b < 6; b++) A[a * 6 + b] += w[i] * phi[a] * phi[b]; }
      }
      const sol = M.solveLinear(A, bb, 6);
      if (!sol) break;
      coef = sol;
      const res = new Float64Array(n);
      for (let i = 0; i < n; i++) { const u = samp[3 * i], v = samp[3 * i + 1]; res[i] = samp[3 * i + 2] - (coef[0] + coef[1] * u + coef[2] * v + coef[3] * u * u + coef[4] * v * v + coef[5] * u * v); }
      const mad = M.median(Array.from(res, Math.abs)) * 1.4826 + 0.01, c = 4.685 * mad;
      for (let i = 0; i < n; i++) { const r = res[i] / c; w[i] = Math.abs(r) < 1 ? (1 - r * r) ** 2 : 0; }
    }
    return coef;
  }

  /* correlação normalizada local (janela (2r+1)²) via imagens integrais */
  function localNCC(A, B, w, h, r) {
    const W1 = w + 1, sz = W1 * (h + 1);
    const SA = new Float64Array(sz), SB = new Float64Array(sz), SAA = new Float64Array(sz), SBB = new Float64Array(sz), SAB = new Float64Array(sz), SN = new Float64Array(sz);
    for (let y = 0; y < h; y++) {
      let a = 0, b = 0, aa = 0, bb = 0, ab = 0, nn = 0;
      for (let x = 0; x < w; x++) {
        const i = y * w + x, bv = B[i];
        if (bv === bv) { const av = A[i]; a += av; b += bv; aa += av * av; bb += bv * bv; ab += av * bv; nn++; }
        const k = (y + 1) * W1 + x + 1;
        SA[k] = SA[k - W1] + a; SB[k] = SB[k - W1] + b; SAA[k] = SAA[k - W1] + aa; SBB[k] = SBB[k - W1] + bb; SAB[k] = SAB[k - W1] + ab; SN[k] = SN[k - W1] + nn;
      }
    }
    const out = new Float32Array(w * h);
    const box = (S, x0, y0, x1, y1) => S[y1 * W1 + x1] - S[y0 * W1 + x1] - S[y1 * W1 + x0] + S[y0 * W1 + x0];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r), x1 = Math.min(w, x + r + 1), y1 = Math.min(h, y + r + 1);
      const nn = box(SN, x0, y0, x1, y1); if (nn < 12) continue;
      const ma = box(SA, x0, y0, x1, y1) / nn, mb = box(SB, x0, y0, x1, y1) / nn;
      const va = box(SAA, x0, y0, x1, y1) / nn - ma * ma, vb = box(SBB, x0, y0, x1, y1) / nn - mb * mb;
      if (va < 4 || vb < 4) { out[y * w + x] = va < 4 && vb < 4 ? 1 : 0; continue; }   /* liso nos dois: compatível */
      out[y * w + x] = (box(SAB, x0, y0, x1, y1) / nn - ma * mb) / Math.sqrt(va * vb);
    }
    return out;
  }

  function morph(src, w, h, r, dilate) {
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      let run = 0;
      for (let x = 0; x < w; x++) {
        let v = dilate ? 0 : 1;
        for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) { const s = src[y * w + k]; if (dilate ? s : !s) { v = dilate ? 1 : 0; break; } }
        tmp[y * w + x] = v; run++;
      }
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = dilate ? 0 : 1;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) { const s = tmp[k * w + x]; if (dilate ? s : !s) { v = dilate ? 1 : 0; break; } }
      out[y * w + x] = v;
    }
    return out;
  }

  /* volume de escaneamento (mm aproximados) centrado onde estava o centro da foto de referência */
  const VOLUME = { xmin: -55, xmax: 55, ymin: -55, ymax: 55, zmin: 0, zmax: 110 };

  GS3D.surface = { SurfaceTracker, selfCalibrate, calibrateZhang, segmentSurface, planeToRef, refPose, tiltFromGravity, zhangCost, nelderMead, REF_DIST, VOLUME };
})(typeof window !== 'undefined' ? window : globalThis);
