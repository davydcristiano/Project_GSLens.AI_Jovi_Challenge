# Bibliotecas de terceiros (locais, sem CDN)

| Pasta | Biblioteca | Versão | Licença | Uso |
|---|---|---|---|---|
| `jspdf/` | [jsPDF](https://github.com/parallax/jsPDF) `dist/jspdf.umd.min.js` | 2.5.1 | MIT | Gerar PDF, PDF em lote, prancha imprimível do Scanner 3D |
| `aruco/` | [js-aruco2](https://github.com/damianofalcioni/js-aruco2) `src/cv.js`, `src/aruco.js` | master (2020+) | MIT / BSD (ver LICENSE.txt) | Detecção dos marcadores ArUco da prancha (rastreamento da câmera na aba AR) |
| `jsqr/` | [jsQR](https://github.com/cozmo/jsQR) `dist/jsQR.js` | 1.4.0 | Apache-2.0 | Leitura de QR Code ao vivo (quando o navegador não tem `BarcodeDetector`) |
| `tesseract/` | [tesseract.js-core](https://github.com/naptha/tesseract.js-core) `tesseract-core-lstm.wasm.js` + [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast) `eng.traineddata` | 7.0.0 | Apache-2.0 | OCR local para detectar links impressos (carregado só quando o leitor está ativo) |
| `three/` | [three.js](https://github.com/mrdoob/three.js) `build/three.min.js` + `examples/jsm/controls/OrbitControls.js` | r160 | MIT | Visualizador do modelo 3D (carregado sob demanda) |

Modificações mínimas feitas nos arquivos de terceiros:

- `three/three.min.js` e `tesseract/tesseract-core-lstm.wasm.js`: convertidos (esbuild 0.28, `--target=chrome58`) para JavaScript de 2017, para rodar em Android antigos; o comportamento é o mesmo.
- `three/three.min.js`: removido apenas o `console.warn` inicial que avisa que o build UMD é
  "deprecated" (o arquivo é o oficial do r160; o aviso poluía o console a cada carregamento).
- `three/OrbitControls.js`: convertido de ES module para script clássico (as importações de
  `'three'` passam a vir do objeto global `THREE`) — necessário para o projeto continuar
  funcionando também ao abrir o `index.html` direto do disco (`file://`), onde ES modules
  são bloqueados pelo navegador.
- `jspdf/jspdf.umd.min.js`: removida a linha `sourceMappingURL` (o `.map` não é distribuído).

Chart.js (tela de Estatísticas) continua via CDN; sem conexão a tela mostra os dados em lista.
