/* ═══════════════════════════════════════════════════
   GSLens.AI — Scanner 3D · viewer.js
   Visualizador do modelo gerado (three.js + OrbitControls):
   girar (arrastar), aproximar/afastar (roda/pinça),
   mover (botão direito/2 dedos), malha, textura, auto-giro.
   three.js é carregado sob demanda (só quando há modelo).
═══════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const GS3D = root.GS3D = root.GS3D || {};

  let _threeLoading = null;
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = res; s.onerror = () => rej(new Error('Falha ao carregar ' + src));
      document.head.appendChild(s);
    });
  }
  function ensureThree() {
    if (root.THREE && root.THREE.OrbitControls) return Promise.resolve(root.THREE);
    if (!_threeLoading) {
      _threeLoading = loadScript('js/vendor/three/three.min.js')
        .then(() => loadScript('js/vendor/three/OrbitControls.js'))
        .then(() => root.THREE)
        .catch(e => { _threeLoading = null; throw e; });
    }
    return _threeLoading;
  }
  function webglAvailable() {
    try {
      const c = document.createElement('canvas');
      return !!(root.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
    } catch (e) { return false; }
  }

  class Viewer {
    constructor(container) {
      this.container = container;
      this.disposed = false;
    }
    async init() {
      if (!webglAvailable()) throw new Error('Este navegador/dispositivo não oferece WebGL — não é possível exibir o modelo 3D (a exportação continua disponível).');
      const THREE = await ensureThree();
      if (this.disposed) return;
      this.THREE = THREE;
      const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      this.renderer.setPixelRatio(Math.min(2, root.devicePixelRatio || 1));
      this.renderer.setSize(w, h);
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.container.appendChild(this.renderer.domElement);
      this.renderer.domElement.setAttribute('aria-label', 'Visualização 3D do objeto escaneado');
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(40, w / h, 0.001, 50);
      this.scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3f4a, 2.2));
      const dl = new THREE.DirectionalLight(0xffffff, 1.2);
      dl.position.set(1, 2, 1.5);
      this.scene.add(dl);
      this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.08;
      this.controls.autoRotateSpeed = 2.4;
      this._loop = () => {
        if (this.disposed) return;
        this._raf = requestAnimationFrame(this._loop);
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
      };
      this._raf = requestAnimationFrame(this._loop);
      if (typeof ResizeObserver !== 'undefined') { this._ro = new ResizeObserver(() => this.resize()); this._ro.observe(this.container); }
      else { this._onWin = () => this.resize(); window.addEventListener('resize', this._onWin); }   /* Chrome < 64 */
    }
    resize() {
      if (!this.renderer) return;
      const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    setModel(scan) {
      const THREE = this.THREE;
      if (!THREE) return;
      this.clearModel();
      const { positions: p, indices: I, normals: nr, uvs } = scan;
      const b = GS3D.recon.bounds(p);
      const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2, z0 = b.min[2];
      const n = I.length;
      const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
      for (let k = 0; k < n; k++) {
        const v = I[k];
        pos[3 * k] = (p[3 * v] - cx) / 1000; pos[3 * k + 1] = (p[3 * v + 2] - z0) / 1000; pos[3 * k + 2] = -(p[3 * v + 1] - cy) / 1000;
        nor[3 * k] = nr[3 * v]; nor[3 * k + 1] = nr[3 * v + 2]; nor[3 * k + 2] = -nr[3 * v + 1];
        uv[2 * k] = uvs[2 * k]; uv[2 * k + 1] = 1 - uvs[2 * k + 1];   /* three: flipY no CanvasTexture */
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.computeBoundingSphere();
      this.texture = new THREE.CanvasTexture(scan.textureCanvas);
      this.texture.colorSpace = THREE.SRGBColorSpace;
      this.texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      this.matTex = new THREE.MeshStandardMaterial({ map: this.texture, roughness: 0.85, metalness: 0 });
      this.matPlain = new THREE.MeshStandardMaterial({ color: 0xb8c0cc, roughness: 0.7, metalness: 0 });
      this.mesh = new THREE.Mesh(geo, this.matTex);
      this.scene.add(this.mesh);
      const size = Math.max(b.size[0], b.size[1], b.size[2]) / 1000;
      this.grid = new THREE.GridHelper(Math.max(0.1, size * 2.2), 10, 0x00e5ff, 0x3a4152);
      this.grid.material.transparent = true; this.grid.material.opacity = 0.45;
      this.scene.add(this.grid);
      this.size = size;
      this.center = new THREE.Vector3(0, b.size[2] / 2000, 0);
      this.resetView();
    }
    resetView() {
      if (!this.mesh) return;
      const d = Math.max(0.05, this.size * 2.4);
      this.camera.position.set(this.center.x + d * 0.7, this.center.y + d * 0.55, this.center.z + d * 0.75);
      this.controls.target.copy(this.center);
      this.controls.minDistance = this.size * 0.3;
      this.controls.maxDistance = this.size * 12;
      this.camera.near = this.size / 200; this.camera.far = this.size * 100;
      this.camera.updateProjectionMatrix();
      this.controls.update();
    }
    zoom(factor) {
      if (!this.mesh) return;
      const off = this.camera.position.clone().sub(this.controls.target).multiplyScalar(factor);
      const len = Math.min(this.controls.maxDistance, Math.max(this.controls.minDistance, off.length()));
      off.setLength(len);
      this.camera.position.copy(this.controls.target).add(off);
    }
    setAutoRotate(on) { if (this.controls) this.controls.autoRotate = !!on; }
    setWireframe(on) { if (this.matTex) { this.matTex.wireframe = !!on; this.matPlain.wireframe = !!on; } }
    setTextured(on) { if (this.mesh) this.mesh.material = on ? this.matTex : this.matPlain; }
    snapshot() { return this.renderer ? this.renderer.domElement.toDataURL('image/png') : null; }
    clearModel() {
      if (this.mesh) { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh = null; }
      if (this.grid) { this.scene.remove(this.grid); this.grid.geometry.dispose(); this.grid.material.dispose(); this.grid = null; }
      if (this.texture) { this.texture.dispose(); this.texture = null; }
      if (this.matTex) { this.matTex.dispose(); this.matTex = null; }
      if (this.matPlain) { this.matPlain.dispose(); this.matPlain = null; }
    }
    dispose() {
      this.disposed = true;
      cancelAnimationFrame(this._raf);
      if (this._ro) this._ro.disconnect();
      if (this._onWin) window.removeEventListener('resize', this._onWin);
      this.clearModel();
      if (this.controls) this.controls.dispose();
      if (this.renderer) {
        this.renderer.dispose();
        if (this.renderer.forceContextLoss) this.renderer.forceContextLoss();
        this.renderer.domElement.remove();
      }
      this.renderer = null;
    }
  }

  GS3D.Viewer = Viewer;
  GS3D.ensureThree = ensureThree;
  GS3D.webglAvailable = webglAvailable;
})(typeof window !== 'undefined' ? window : globalThis);
