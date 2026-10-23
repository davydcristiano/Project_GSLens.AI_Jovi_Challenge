// Renderizador sintético para testes: prancha impressa + objeto conhecido,
// câmera com intrínsecos e pose exatos (convenção de visão computacional).
import * as THREE from '../vendor/three/build/three.module.js';

const GS3D = window.GS3D;

export function makePose(azDeg, elDeg, dist, target = [0, 0, 30], roll = 0) {
  const M = GS3D.math;
  const az = azDeg * Math.PI / 180, el = elDeg * Math.PI / 180;
  const C = [target[0] + dist * Math.cos(el) * Math.cos(az), target[1] + dist * Math.cos(el) * Math.sin(az), target[2] + dist * Math.sin(el)];
  const zc = M.normalize3([target[0] - C[0], target[1] - C[1], target[2] - C[2]]);
  let xc = M.normalize3(M.cross3(zc, [0, 0, 1]));
  let yc = M.cross3(zc, xc);
  if (roll) { const c = Math.cos(roll), s = Math.sin(roll); const x2 = xc.map((v, i) => c * v + s * yc[i]); const y2 = yc.map((v, i) => -s * xc[i] + c * v); xc = x2; yc = y2; }
  const R = [...xc, ...yc, ...zc];
  const t = M.mul3v(R, C).map(v => -v);
  return { R, t, C };
}

export class Synth {
  constructor(w, h, f, opts = {}) {
    this.w = w; this.h = h; this.f = f;
    this.canvas = document.createElement('canvas');
    this.canvas.width = w; this.canvas.height = h;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setSize(w, h, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = !!opts.shadows;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(opts.bg || 0x6b5a4a);
    // mesa texturizada (fundo arbitrário)
    const table = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.MeshStandardMaterial({ color: opts.table || 0x8a6a4a, roughness: 0.9 }));
    table.position.z = -0.5; table.receiveShadow = true;
    this.scene.add(table);
    if (opts.surface === 'texture') {
      /* mesa com textura (sem prancha): toalha estampada / tampo com veios e impressos */
      const N = 2048, cv = document.createElement('canvas'); cv.width = cv.height = N;
      const g = cv.getContext('2d');
      let sd = opts.seed || 7; const r = () => { sd = (sd * 1664525 + 1013904223) >>> 0; return sd / 4294967296; };
      g.fillStyle = '#b08a60'; g.fillRect(0, 0, N, N);
      for (let k = 0; k < 260; k++) {             /* veios */
        g.strokeStyle = `rgba(${70 + r() * 60 | 0},${45 + r() * 40 | 0},${25 + r() * 25 | 0},${0.15 + r() * 0.3})`;
        g.lineWidth = 1 + r() * 5; g.beginPath(); const y0 = r() * N; g.moveTo(0, y0);
        for (let x = 0; x <= N; x += 64) g.lineTo(x, y0 + Math.sin(x / (90 + r() * 200) + k) * (8 + r() * 30));
        g.stroke();
      }
      const cols = ['#7a2e2e', '#2e4f7a', '#e8dcc0', '#3d6b3a', '#d9a441', '#222', '#f2f2f2', '#8c4f8c'];
      for (let k = 0; k < 900; k++) {             /* estampa: formas, letras e manchas em várias escalas */
        g.fillStyle = cols[(r() * cols.length) | 0]; g.globalAlpha = 0.55 + r() * 0.45;
        const x = r() * N, y = r() * N, sz = 6 + r() * r() * 70;
        const t = r();
        if (t < 0.35) g.fillRect(x, y, sz, sz * (0.3 + r()));
        else if (t < 0.65) { g.beginPath(); g.arc(x, y, sz / 2, 0, 7); g.fill(); }
        else { g.font = `bold ${sz | 0}px sans-serif`; g.fillText(String.fromCharCode(65 + (r() * 26 | 0)), x, y); }
      }
      g.globalAlpha = 1;
      const id = g.getImageData(0, 0, N, N);       /* granulado fino */
      for (let i = 0; i < id.data.length; i += 4) { const nz = (r() - 0.5) * 18; id.data[i] += nz; id.data[i + 1] += nz; id.data[i + 2] += nz; }
      g.putImageData(id, 0, 0);
      const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(800, 800), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
      plane.receiveShadow = true;
      this.scene.add(plane);
    } else {
    // prancha
    const res = 8, cv = document.createElement('canvas');
    cv.width = GS3D.board.SHEET_W * res; cv.height = GS3D.board.SHEET_H * res;
    GS3D.board.drawBoard(cv.getContext('2d'), res);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    const board = new THREE.Mesh(new THREE.PlaneGeometry(GS3D.board.SHEET_W, GS3D.board.SHEET_H), new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }));
    board.receiveShadow = true;
    this.scene.add(board);
    }
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.6));
    const dl = new THREE.DirectionalLight(0xffffff, 1.4);
    dl.position.set(200, -150, 500); dl.castShadow = !!opts.shadows;
    if (opts.shadows) { dl.shadow.mapSize.set(2048, 2048); Object.assign(dl.shadow.camera, { left: -200, right: 200, top: 200, bottom: -200, near: 10, far: 1500 }); }
    this.scene.add(dl);
    this.camera = new THREE.PerspectiveCamera(2 * Math.atan(h / 2 / f) * 180 / Math.PI, w / h, 5, 5000);
    this.camera.matrixAutoUpdate = false;
    this.objects = new THREE.Group();
    this.scene.add(this.objects);
  }
  addObject(kind) {
    const add = (geo, color, pos, rot) => {
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.6 }));
      m.position.set(...pos); if (rot) m.rotation.set(...rot); m.castShadow = true; this.objects.add(m); return m;
    };
    if (kind === 'box') {                 // caixa 60x40x50 mm, multicolorida
      const geo = new THREE.BoxGeometry(60, 40, 50);
      const mats = [0xd03030, 0x30a040, 0x3050d0, 0xe0b020, 0xa040c0, 0x20a0a0].map(c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.6 }));
      const m = new THREE.Mesh(geo, mats); m.position.set(0, 0, 25); m.castShadow = true; this.objects.add(m);
      this.truth = { kind, dims: [60, 40, 50], volume: 60 * 40 * 50 };
    } else if (kind === 'mug') {          // cilindro + esfera
      add(new THREE.CylinderGeometry(25, 25, 70, 48), 0x2060c0, [0, 0, 35], [Math.PI / 2, 0, 0]);
      add(new THREE.SphereGeometry(18, 32, 16), 0xe04020, [0, 0, 70 + 10]);
      this.truth = { kind, dims: [50, 50, 98] };
    }
  }
  render(pose) {
    const { R, t } = pose;
    const V = new THREE.Matrix4().set(
      R[0], R[1], R[2], t[0],
      -R[3], -R[4], -R[5], -t[1],
      -R[6], -R[7], -R[8], -t[2],
      0, 0, 0, 1);
    this.camera.matrix.copy(V).invert();
    this.camera.updateMatrixWorld(true);
    this.renderer.render(this.scene, this.camera);
    const c2 = document.createElement('canvas'); c2.width = this.w; c2.height = this.h;
    const ctx = c2.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(this.canvas, 0, 0);
    return ctx.getImageData(0, 0, this.w, this.h);
  }
}
