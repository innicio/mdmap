FROM node:18-alpine

WORKDIR /app

# 1. Instalamos las dependencias de producción
COPY package.json .
RUN npm install --production

# 2. Copiamos el servidor y el frontend estático
COPY server.js .
COPY public ./public

# 3. Descargamos todos los assets offline
RUN apk add --no-cache curl \
 && mkdir -p public/assets \
 \
 # D3 v7
 && curl -sL https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js \
      -o public/assets/d3.min.js \
 \
 # markmap-lib UMD IIFE v0.18.11
 && curl -sL https://cdn.jsdelivr.net/npm/markmap-lib@0.18.11/dist/browser/index.iife.js \
      -o public/assets/markmap-lib.iife.js \
 \
 # markmap-view UMD global v0.18.10
 && curl -sL https://cdn.jsdelivr.net/npm/markmap-view@0.18.10/dist/browser/index.js \
      -o public/assets/markmap-view.iife.js \
 \
 # markmap-toolbar v0.18.10 CSS + JS
 && curl -sL https://cdn.jsdelivr.net/npm/markmap-toolbar@0.18.10/dist/style.css \
      -o public/assets/markmap-toolbar.css \
 && curl -sL https://cdn.jsdelivr.net/npm/markmap-toolbar@0.18.10/dist/index.js \
      -o public/assets/markmap-toolbar.js \
 \
 # CodeMirror v5 + modo Markdown + addons
 && curl -sL https://cdn.jsdelivr.net/npm/codemirror@5.65.9/lib/codemirror.js \
      -o public/assets/codemirror.js \
 && curl -sL https://cdn.jsdelivr.net/npm/codemirror@5.65.9/lib/codemirror.css \
      -o public/assets/codemirror.css \
 && curl -sL https://cdn.jsdelivr.net/npm/codemirror@5.65.9/mode/markdown/markdown.js \
      -o public/assets/markdown.js \
 && curl -sL https://cdn.jsdelivr.net/npm/codemirror@5.65.9/addon/edit/continuelist.js \
      -o public/assets/continuelist.js \
 && curl -sL https://cdn.jsdelivr.net/npm/codemirror@5.65.9/addon/display/placeholder.js \
      -o public/assets/placeholder.js

# 4. Carpeta para el Markdown persistente
RUN mkdir -p content

# 5. Exponemos el puerto y arrancamos
EXPOSE 9000
CMD ["node", "server.js"]

