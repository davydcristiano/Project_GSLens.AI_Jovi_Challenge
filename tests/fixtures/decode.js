/* Decodifica todos os quadros de um vídeo no navegador.
   (No Chromium sem janela, buscar com currentTime devolve sempre o mesmo
   quadro; reproduzir a ½ velocidade e capturar cada quadro apresentado
   com requestVideoFrameCallback funciona de forma confiável.) */
window.decodeFrames = function (src, onFrame) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.src = src;
    v.style.cssText = 'position:fixed;left:0;top:0;width:4px;height:4px;opacity:.01';
    document.body.appendChild(v);
    let n = 0, busy = Promise.resolve();
    v.onerror = () => reject(new Error('vídeo não decodificado: ' + src));
    v.onloadeddata = () => {
      const cb = (now, meta) => {
        busy = busy.then(() => onFrame(v, n++, meta.mediaTime));
        if (!v.ended) v.requestVideoFrameCallback(cb);
      };
      v.requestVideoFrameCallback(cb);
      v.onended = () => busy.then(() => { v.remove(); resolve(n); });
      v.playbackRate = 0.5;
      v.play().catch(reject);
    };
  });
};
