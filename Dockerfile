FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Instalar solo dependencias de producción
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copiar código inmutable con propiedad del usuario sin privilegios 'node' (UID 1000)
COPY --chown=node:node server.js ./
COPY --chown=node:node public ./public

RUN mkdir -p /app/content /app/images && chown -R node:node /app/content /app/images

USER node
EXPOSE 9000

CMD ["node", "server.js"]