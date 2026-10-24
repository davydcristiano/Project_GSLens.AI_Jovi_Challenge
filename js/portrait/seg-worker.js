/* GSLens.AI — Worker de segmentação de pessoas (modo Retrato)
   Roda o modelo Selfie Segmentation do MediaPipe (js/portrait/models/) com o
   executor próprio (tflite.js), fora da thread da interface.
   Mensagens:
     → { type:'init' }                                   ← { type:'ready' } | { type:'error' }
     → { type:'run', id, model:'square'|'landscape', rgba:Uint8ClampedArray }
     ← { type:'mask', id, mask:Float32Array, w, h, ms } */
'use strict';
importScripts('tflite.js?v=20261024d');

const MODELS = { square: 'models/selfie_segmentation.tflite', landscape: 'models/selfie_segmentation_landscape.tflite' };
const nets = {};
let loading = null;

function load() {
  if (!loading) loading = Promise.all(Object.entries(MODELS).map(async ([k, url]) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error('modelo não encontrado: ' + url);
    nets[k] = new GSTFLite.Interpreter(GSTFLite.parse(await r.arrayBuffer()));
  }));
  return loading;
}

const inputs = {};
self.onmessage = async e => {
  const m = e.data || {};
  try {
    if (m.type === 'init') { await load(); self.postMessage({ type: 'ready' }); return; }
    if (m.type === 'run') {
      await load();
      const net = nets[m.model], [, H, W] = net.inputShape;
      const n = W * H, x = inputs[m.model] || (inputs[m.model] = new Float32Array(n * 3)), p = m.rgba;
      for (let i = 0, j = 0; i < n; i++, j += 4) { x[i * 3] = p[j] / 255; x[i * 3 + 1] = p[j + 1] / 255; x[i * 3 + 2] = p[j + 2] / 255; }
      const t0 = performance.now();
      const out = net.run(x);
      const mask = new Float32Array(out);           /* cópia: o buffer interno é reaproveitado */
      self.postMessage({ type: 'mask', id: m.id, mask, w: W, h: H, ms: performance.now() - t0 }, [mask.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, error: String(err && err.message || err) });
  }
};
