/* GSLens.AI — leitura ASSÍNCRONA de quadros da câmera
   ─────────────────────────────────────────────────────────────
   Por que existe: copiar um quadro do vídeo para a CPU (drawImage + getImageData
   ou gl.readPixels) obriga a página a ESPERAR a GPU terminar todo o trabalho
   pendente — a interface congela por um ou mais quadros. Fazendo isso várias
   vezes por segundo (leitor de QR, Retrato, Noite, AR) o app "engasga".

   Como funciona (WebGL2): o quadro é enviado à GPU, reduzido/recortado lá, e
   os pixels são pedidos para um buffer (PIXEL_PACK_BUFFER) com uma "cerca"
   (fenceSync). A página segue livre; um ou dois quadros depois, quando a GPU
   sinaliza a cerca, os pixels são copiados sem espera alguma.
   Sem WebGL2 (navegadores antigos) usa o caminho síncrono de antes.

   Uso:
     const r = new GSFrameReader();
     r.request(video, sx, sy, sw, sh, w, h)  // pede (false se ainda ocupado)
     const f = r.poll()                       // { data: Uint8ClampedArray RGBA (de cima p/ baixo), w, h } ou null
     const f = await r.grab(video, ...)       // pede e espera (sem bloquear a interface) */
(function (root) {
  'use strict';

  const VS = '#version 300 es\nin vec2 p;out vec2 uv;uniform vec4 rc;void main(){vec2 q=p*.5+.5;uv=rc.xy+q*rc.zw;gl_Position=vec4(p,0.,1.);}';
  const FS = '#version 300 es\nprecision mediump float;in vec2 uv;uniform sampler2D t;out vec4 o;void main(){o=texture(t,uv);}';

  class FrameReader {
    constructor() { this.busy = false; this.mode = null; }

    _init() {
      if (this.mode) return;
      try {
        const c = document.createElement('canvas'); c.width = c.height = 1;
        const gl = c.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'low-power' });
        if (!gl) throw new Error('sem WebGL2');
        const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
        const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS)); gl.bindAttribLocation(p, 0, 'p'); gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
        gl.useProgram(p);
        this.uRc = gl.getUniformLocation(p, 'rc');
        const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        const tex = () => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t; };
        this.src = tex(); this.dst = tex(); this.fb = gl.createFramebuffer(); this.pbo = gl.createBuffer();
        this.gl = gl; this.w = this.h = 0; this.mode = 'gl';
      } catch (e) {
        this.mode = 'sync';
        this.c2 = document.createElement('canvas');
        this.x2 = this.c2.getContext('2d', { willReadFrequently: true });
      }
    }

    /* pede o recorte (sx,sy,sw,sh) do vídeo reduzido para w×h */
    request(video, sx, sy, sw, sh, w, h) {
      if (this.busy) return false;
      this._init();
      w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
      const vw = video.videoWidth || video.width, vh = video.videoHeight || video.height;
      if (!vw || !vh) return false;
      if (this.mode === 'sync') {
        if (this.c2.width !== w || this.c2.height !== h) { this.c2.width = w; this.c2.height = h; }
        this.x2.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
        this.ready = { data: this.x2.getImageData(0, 0, w, h).data, w, h, t: performance.now() };
        this.busy = true;
        return true;
      }
      const gl = this.gl;
      if (gl.isContextLost()) { this.mode = null; return false; }
      if (w !== this.w || h !== this.h) {
        gl.bindTexture(gl.TEXTURE_2D, this.dst);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.dst, 0);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, w * h * 4, gl.STREAM_READ);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        this.w = w; this.h = h;
      }
      gl.bindTexture(gl.TEXTURE_2D, this.src);
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video); } catch (e) { return false; }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
      gl.viewport(0, 0, w, h);
      /* o quadro desenhado no framebuffer fica "de cabeça para baixo" em relação
         ao GL — e o readPixels lê de baixo para cima: o resultado sai na ordem certa */
      gl.uniform4f(this.uRc, sx / vw, sy / vh, sw / vw, sh / vh);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      this.busy = true; this.t0 = performance.now();
      return true;
    }

    /* pixels prontos? (nunca espera) */
    poll() {
      if (!this.busy) return null;
      if (this.mode === 'sync') { const r = this.ready; this.ready = null; this.busy = false; return r; }
      const gl = this.gl;
      const st = gl.getSyncParameter(this.fence, gl.SYNC_STATUS);
      if (st !== gl.SIGNALED) {
        /* proteção: contexto perdido ou GPU sem resposta por muito tempo — libera
           (um aparelho lento só demora mais; a interface continua livre) */
        if (gl.isContextLost() || performance.now() - this.t0 > 8000) { if (!gl.isContextLost()) gl.deleteSync(this.fence); this.fence = null; this.busy = false; if (gl.isContextLost()) this.mode = null; }
        return null;
      }
      gl.deleteSync(this.fence); this.fence = null;
      this.lastLatency = performance.now() - this.t0;
      const out = new Uint8Array(this.w * this.h * 4);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.busy = false;
      return { data: new Uint8ClampedArray(out.buffer), w: this.w, h: this.h, t: this.t0 };   /* t: quando o quadro foi pedido */
    }

    /* pede e aguarda (verificando a cada quadro da tela, sem bloquear) */
    grab(video, sx, sy, sw, sh, w, h) {
      return new Promise(resolve => {
        if (!this.request(video, sx, sy, sw, sh, w, h)) {
          if (this.busy) { const wait = () => { const r = this.poll(); if (r || !this.busy) resolve(r); else setTimeout(wait, 8); }; wait(); }
          else resolve(null);
          return;
        }
        const tick = () => { const r = this.poll(); if (r) resolve(r); else if (!this.busy) resolve(null); else setTimeout(tick, 4); };
        tick();
      });
    }
  }

  /* Controle de fluxo da GPU: só deixa enviar um novo quadro de efeito quando o
     anterior já terminou. Sem isso, um aparelho com GPU mais lenta acumula uma
     fila crescente de quadros (atraso cada vez maior e engasgos). WebGL1: sem
     cercas — sempre libera (comportamento anterior). */
  class GpuPacer {
    constructor(gl) { this.gl = gl; this.gl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext; this.fence = null; this.skipped = 0; }
    ready() {
      if (!this.gl2 || !this.fence) return true;
      const gl = this.gl;
      if (gl.isContextLost()) { this.fence = null; return true; }
      if (gl.getSyncParameter(this.fence, gl.SYNC_STATUS) !== gl.SIGNALED) { this.skipped++; return false; }
      gl.deleteSync(this.fence); this.fence = null;
      return true;
    }
    submitted() { if (this.gl2 && !this.gl.isContextLost()) { this.fence = this.gl.fenceSync(this.gl.SYNC_GPU_COMMANDS_COMPLETE, 0); this.gl.flush(); } }
  }

  root.GSFrameReader = FrameReader;
  root.GSGpuPacer = GpuPacer;
})(window);
