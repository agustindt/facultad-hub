# Frontend del hub — imagen multi-etapa.
#
# El hub no tiene build step: es un index.html con todo adentro y las librerías
# vendorizadas al lado. Aun así la etapa de build existe y hace algo real:
# verifica que los archivos estén y deja preparado sólo lo que se sirve.
#
# Etapa 2 es nginx alpine, que pesa un orden de magnitud menos que cualquier
# imagen con Node.

# ---------- etapa 1: preparar los assets ----------
FROM node:22-alpine AS build
WORKDIR /build
COPY public ./public

# Si falta el index, la imagen no se construye. Mejor romper acá que descubrirlo
# con un 404 en la defensa.
RUN test -f public/index.html && \
    test -d public/vendor && \
    echo "assets OK: $(find public -type f | wc -l) archivos"

# ---------- etapa 2: servidor estático ----------
FROM nginx:1.27-alpine AS runtime
LABEL org.opencontainers.image.source=https://github.com/agustindt/facultad-hub

COPY --from=build /build/public /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=5 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1
