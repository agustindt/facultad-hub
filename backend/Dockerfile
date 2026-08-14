# Backend del hub — imagen multi-etapa.
#
# Etapa 1 (deps): instala las dependencias con el toolchain completo.
# Etapa 2 (runtime): copia SOLO node_modules y el código a una imagen chica.
#
# Por qué multi-stage: la imagen final no lleva npm, ni el cache de npm, ni
# nada de lo que hizo falta para instalar. Compará el tamaño de `node:22` con
# el de `node:22-alpine` y vas a ver la diferencia — es la evidencia que pide
# el TP2.

# ---------- etapa 1: dependencias ----------
FROM node:22-alpine AS deps
WORKDIR /app

# Sólo el manifiesto primero: si package.json no cambió, Docker reusa esta capa
# y no vuelve a instalar nada. Copiar todo el código acá tiraría ese cache.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ---------- etapa 2: runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Escucha en todas las interfaces: adentro del contenedor, 127.0.0.1 sólo sería
# visible para el propio contenedor y nginx nunca llegaría.
ENV HOST=0.0.0.0
ENV PORT=4177

COPY --from=deps /app/node_modules ./node_modules
COPY server.js ./
COPY db ./db

# Usuario sin privilegios: la imagen de node ya trae uno.
USER node

EXPOSE 4177

# Healthcheck: el mismo endpoint que usa compose para el depends_on.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4177/api/vivo').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# CMD y no ENTRYPOINT: así se puede sobreescribir el comando al arrancar
# (por ejemplo `docker compose run backend node --test test/`) sin pelear.
CMD ["node", "server.js"]
