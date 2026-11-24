# --- Etapa 1: Compilación de assets frontend ---
FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY src ./src
COPY scripts ./scripts
RUN npm run build

# --- Etapa 2: Imagen final de producción ---
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node server.js auth.js ./
COPY --chown=node:node public ./public
COPY --from=builder --chown=node:node /app/public/assets/mdmap-vendor.js ./public/assets/mdmap-vendor.js
COPY --from=builder --chown=node:node /app/public/assets/katex ./public/assets/katex

RUN mkdir -p /app/content /app/images /app/data && chown -R node:node /app/content /app/images /app/data

USER node
EXPOSE 9000

CMD ["node", "server.js"]