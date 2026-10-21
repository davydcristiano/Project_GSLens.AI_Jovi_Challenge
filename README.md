Projeto GSLeans.AI - CHALLENGE JOVI
===

Projeto do Challenge realizado em parceria com a JOVI durante a graduação na FIAP. Atuação em equipe no desenvolvimento de uma aplicação web multiplataforma com integração à câmera de dispositivos móveis.

## Informação
<br>

- Title:  `GSLeans.AI`
- Authors:  `Davyd Cristiano`, `Davi Sena`, `Christian Urbano`, `Thaylla Ohani`, `André Bettencourt`
- Full-preprint:
- <img src="assets/image-project.png" width="100%">

## Linguagens
<br>

- HTML5
- CSS3
- JavaScript (sem build, scripts clássicos)
- Bootstrap 4.0 - Framework Front-End
- three.js r160 (visualizador 3D), js-aruco2 (marcadores), jsPDF 2.5.1 — todos locais em `js/vendor/`

<br>

## Como executar

A câmera só funciona em **contexto seguro**: `https://` ou `http://localhost`.

```bash
# na pasta do projeto
python3 -m http.server 8080
# abra http://localhost:8080 no navegador
```

Para testar no celular, publique em HTTPS (ex.: GitHub Pages) — em `http://IP-da-máquina` o navegador bloqueia a câmera.

## Abas da câmera

- **Noite, Retrato, Foto, Vídeo, Slow-Mo** — como antes.
- **Efeitos** — efeitos visuais ao vivo (Grade, Partículas, Neon, Bokeh, Matrix, Corações, Estrelas, Chuva, Confetti). Antes ficavam dentro da aba AR.
- **AR · Scanner 3D** — escaneamento real de objetos físicos e geração de modelo 3D.

## Scanner 3D (aba AR)

1. Toque em **🖨️ Prancha A4** e imprima em tamanho real (100%, sem "ajustar à página"). Confira a barra de 50 mm.
2. Coloque o objeto (até ~11 × 11 × 11 cm) no quadrado central da folha.
3. Na aba **AR**, aponte para a folha: um cubo 3D aparece ancorado nela. Toque em **Iniciar** e contorne o objeto devagar em três alturas (baixa, média, de cima). As vistas são capturadas automaticamente; o anel verde mostra a cobertura.
4. **Gerar 3D** → visualize (girar, aproximar, malha, textura) e **exporte** em GLB, glTF, OBJ, FBX ou STL.

Como funciona (tudo no próprio dispositivo, nada é enviado para servidores):

| Etapa | Técnica | Arquivo |
|---|---|---|
| Rastreamento | 20 marcadores ArUco + homografia + pose 6DoF (Levenberg–Marquardt), cantos com precisão subpixel | `js/scan3d/tracker.js`, `math.js` |
| Calibração | distância focal estimada pelas próprias vistas (restrições de Zhang) + refino por erro de reprojeção | `pipeline.js`, `math.js` |
| Silhuetas | comparação com a aparência conhecida da prancha impressa, com modelo de iluminação | `segment.js` |
| Reconstrução | interseção volumétrica de silhuetas (visual hull) + Surface Nets + suavização Taubin | `reconstruct.js` |
| Textura | visibilidade por z-buffer, 3 melhores vistas por triângulo, compensação de exposição, atlas | `texture.js` |
| Exportação | escritores próprios conforme as especificações | `exporters.js` |

Escala real (com a prancha impressa a 100%): GLB/glTF/OBJ em metros (Y para cima), FBX em centímetros (Y para cima), STL em milímetros (Z para cima). glTF e OBJ são entregues em ZIP com todos os arquivos auxiliares (.bin/.mtl/.png); GLB e FBX trazem a textura embutida; STL contém só geometria.

Limitações do método: concavidades profundas e topos planos tendem a ficar arredondados/mais altos (característica da reconstrução por silhuetas); objetos brancos, transparentes ou espelhados não se destacam do papel.

<br>

## Direitos Reservados
```
Title: GSLeans.AI
Authors: Davyd Cristiano, Davi Sena, Christian Urbano, Thaylla Ohani, André Bettencourt.
```
