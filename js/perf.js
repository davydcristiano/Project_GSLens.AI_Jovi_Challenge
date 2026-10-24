/* GSLens.AI — perfil do aparelho (carregado antes de tudo)
   GSPerf.low = aparelho modesto: pouca memória, poucos núcleos, Android antigo
   ou navegador sem WebGL2. Nesse caso o app usa uma configuração leve:
   câmera em 720p, prévias em resolução menor, IA do Retrato até ~8 vezes por
   segundo e leitor de links com intervalo maior. O resultado visual continua o
   mesmo; só o custo cai. Forçar: ?leve=1 (ligado) ou ?leve=0 (desligado). */
(function (root) {
  'use strict';
  var nav = root.navigator || {}, ua = nav.userAgent || '';
  var mem = nav.deviceMemory || 0, cores = nav.hardwareConcurrency || 0;
  var m = /Android\s+(\d+)/.exec(ua), android = m ? +m[1] : 0;
  var chrome = +((/Chrome\/(\d+)/.exec(ua) || [])[1] || 0);
  var gl2 = false;
  try {
    var c = document.createElement('canvas'), g = c.getContext && c.getContext('webgl2');
    gl2 = !!g;
    /* libera o contexto de teste (o navegador limita quantos podem existir) */
    var lose = g && g.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
  } catch (e) {}
  var reasons = [];
  if (mem && mem <= 2) reasons.push('memória ' + mem + ' GB');
  if (cores && cores <= 4) reasons.push(cores + ' núcleos');
  if (android && android <= 8) reasons.push('Android ' + android);
  if (chrome && chrome < 80) reasons.push('Chrome ' + chrome);
  if (!gl2) reasons.push('sem WebGL2');
  var low = reasons.length > 0;
  try { var q = /[?&]leve=([01])/.exec(root.location.search); if (q) low = q[1] === '1'; } catch (e) {}
  root.GSPerf = {
    low: low, reasons: reasons, gl2: gl2,
    camW: low ? 1280 : 1920, camH: low ? 720 : 1080,
    previewMax: low ? 720 : 1280,       /* filtros WebGL ao vivo */
    liveMax: low ? 640 : 960,           /* Noite e Retrato ao vivo */
    segMinMs: low ? 120 : 0,            /* intervalo mínimo da IA do Retrato */
    scanSlow: low ? 1.6 : 1             /* multiplicador dos intervalos do leitor de links */
  };
})(typeof window !== 'undefined' ? window : this);
