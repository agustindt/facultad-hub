# Evidencias

> Una captura por ítem, con el 📸 y una línea de qué se está mirando.
> Las capturas las sacás vos: son la prueba de que corrió en tu máquina.

---

## TP2 — Contenedores

- [ ] 📸 **`docker compose up -d` desde cero, todos los servicios sanos**
      `docker compose ps` mostrando los tres en `healthy`.

- [ ] 📸 **Funcionalidad end-to-end**
      El hub abierto en `localhost:8080`, mostrando notas del vault (frontend →
      backend → filesystem) y una tarjeta de repaso calificada (frontend →
      backend → Postgres).

- [ ] 📸 **Prueba de persistencia**
      Tres capturas encadenadas:
      1. Calificás tarjetas en Repaso.
      2. `docker compose down` y `up -d` → el calendario sigue ahí.
      3. `docker compose down -v` y `up -d` → el calendario arrancó de cero.
      La diferencia entre 2 y 3 es todo el punto del volumen nombrado.

- [ ] 📸 **Comparación de tamaño**
      `docker images` con la imagen final del backend al lado de `node:22`.

- [ ] 📸 **Imágenes públicas en el registry**
      La página de los paquetes en ghcr.io con visibilidad pública.

- [ ] 📸 **`docker-compose.registry.yml up` sin código local**
      Desde una carpeta limpia, con sólo el `.yml` y el `.env`: baja las imágenes
      y levanta. Si esto anda, las imágenes publicadas están bien.

### Comandos que usé

```bash
# levantar
cp .env.example .env
docker compose up -d
docker compose ps

# persistencia
docker compose down && docker compose up -d      # los datos siguen
docker compose down -v && docker compose up -d   # los datos se fueron

# tamaños
docker images | grep -E "facultad-hub|node"

# publicar (completar con tu usuario)
echo $GHCR_TOKEN | docker login ghcr.io -u agustindt --password-stdin
docker build -t ghcr.io/agustindt/facultad-hub-backend:v0.1.0 ./backend
docker build -t ghcr.io/agustindt/facultad-hub-frontend:v0.1.0 ./frontend
docker push ghcr.io/agustindt/facultad-hub-backend:v0.1.0
docker push ghcr.io/agustindt/facultad-hub-frontend:v0.1.0

# probar desde el registry, en una carpeta vacía
docker compose -f docker-compose.registry.yml up -d
```

---
