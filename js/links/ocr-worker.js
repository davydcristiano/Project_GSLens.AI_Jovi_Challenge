/* GSLens.AI — Worker de OCR (leitura de links impressos)
   Roda o Tesseract (WebAssembly, local) fora da thread da interface.
   Mensagens:  {id, png:Uint8Array}  →  {id, text, conf} | {id, error} */
'use strict';
let api = null, T = null, ready = null;

function init() {
  if (ready) return ready;
  ready = (async () => {
    importScripts('../vendor/tesseract/tesseract-core-lstm.wasm.js');
    T = await self.TesseractCore();
    const res = await fetch('../vendor/tesseract/eng.traineddata');
    if (!res.ok) throw new Error('Modelo de OCR não encontrado (' + res.status + ')');
    T.FS.writeFile('eng.traineddata', new Uint8Array(await res.arrayBuffer()));
    api = new T.TessBaseAPI();
    if (api.Init(null, 'eng') !== 0) throw new Error('Falha ao iniciar o OCR');
    api.SetPageSegMode(11);                      /* PSM_SPARSE_TEXT: texto solto em cenas */
    api.SetVariable('user_defined_dpi', '300');
  })();
  return ready;
}

self.onmessage = async (e) => {
  const { id, png } = e.data || {};
  try {
    await init();
    T.FS.writeFile('/input', png);
    api.SetImageFile();
    const text = api.GetUTF8Text() || '';
    const conf = api.MeanTextConf();
    api.Clear();
    self.postMessage({ id, text, conf });
  } catch (err) {
    ready = null;
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
