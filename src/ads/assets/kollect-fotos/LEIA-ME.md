# Fotos do anúncio da Kollect

As imagens desta pasta (`.webp`, `.jpg`, `.jpeg`, `.png` ou `.avif`) passam inteiras
dentro do quadro 4:5 do anúncio (o globo se transforma nele), em ordem de nome.
Cada visitante começa numa foto sorteada.

- `originais/`: as fotos como vieram (não vão para o anúncio nem para o Git).
- `01.webp`, `02.webp`…: as versões otimizadas que o anúncio usa
  (foto inteira em 4:5, 720 x 900 px, ~75 KB cada).

Para trocar ou adicionar fotos: coloque o original em `originais/` e gere a versão
otimizada aqui com o mesmo nome:

    ffmpeg -i originais/10.jpg -vf "scale=720:900:flags=lanczos" -c:v libwebp -q:v 62 10.webp

Depois rode o build (`npm run build`). Use fotos em 4:5 (como posts do Instagram,
1080 x 1350); em outro formato, as bordas são cortadas para caber no quadro.
