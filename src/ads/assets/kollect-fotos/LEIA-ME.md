# Fotos do anúncio da Kollect

As imagens desta pasta (`.webp`, `.jpg`, `.jpeg`, `.png` ou `.avif`) passam dentro
do globo, em ordem de nome. Cada visitante começa numa foto sorteada.

- `originais/`: as fotos como vieram (não vão para o anúncio nem para o Git).
- `01.webp`, `02.webp`…: as versões otimizadas que o anúncio usa
  (recorte quadrado um pouco acima do centro, 720 px, ~60 KB cada).

Para trocar ou adicionar fotos: coloque o original em `originais/` e gere a versão
otimizada aqui com o mesmo nome:

    ffmpeg -i originais/10.jpg -vf "crop=iw:iw:0:ih*0.08,scale=720:720:flags=lanczos" -c:v libwebp -q:v 62 10.webp

Depois rode o build (`npm run build`). Produto no centro da foto funciona melhor:
o globo recorta em círculo.
