# Decisiones

> Se escribe hacia abajo: cada TP agrega su sección, no se reemplaza. El historial
> del semestre es uno solo.

---

## TP2 — Contenedores

### Qué app elegí y por qué

**Facultad Hub**: la app que uso para estudiar. Backend Node + frontend SPA + Postgres.

Contra los criterios de la guía:

| Criterio | Cómo lo cumple |
|---|---|
| Buildea y corre localmente hoy, sin dependencias pagas | Sí. `node backend/server.js` y anda. Cero servicios externos. |
| Tiene tests (requisito del TP5) | Sí, `npm test` en `backend/`. Hoy cubren el almacén. |
| Código comprensible para modificarlo | Lo escribí yo. Es la razón principal de la elección. |
| Escala manejable: CRUD + 2-3 pantallas | **No del todo.** Son ~10 vistas. Ver abajo. |
| Individual y distinta a la de mis compañeros | Sí: es una app propia, no un repo de ejemplo. |

<!-- ⚠️ COMPLETAR VOS: el último criterio es el que va a preguntar el docente.
El argumento a favor es que la defensa vale 50 % y la regla es "si no lo podés
explicar, no lo aprobás": conviene una app grande que entendés a una chica que
clonaste. Pero decidilo y escribilo con tus palabras — es tu defensa, no la mía. -->

### Decisiones de contenerización

**Imágenes base.** `node:22-alpine` para el backend y `nginx:1.27-alpine` para el
frontend. Alpine porque el backend no necesita nada compilado.

<!-- ⚠️ COMPLETAR: pegá acá la comparación de tamaños real, la que sacaste con
`docker images`. Es una de las evidencias 📸. -->

**Multi-stage.** El backend separa la instalación de dependencias de la ejecución:
la imagen final no lleva npm ni el cache. El frontend separa la verificación de
assets del servidor nginx.

<!-- ⚠️ COMPLETAR: ¿qué pasaría si NO fuera multi-stage? Es pregunta de defensa. -->

**Qué persiste y qué no.** Tres cosas distintas:

| Qué | Dónde vive | Por qué |
|---|---|---|
| Las notas (`.md`) | Bind mount del vault desde el host | Son la fuente de verdad y las abre Obsidian. Meterlas en la base rompería eso. |
| Repaso, eventos, log de IA | Postgres, volumen nombrado `datos-db` | Estado propio de la app. Es lo que tiene que sobrevivir a `down` y morir con `down -v`. |
| Clave de API y token | `datos-hub`, archivo con permisos 600 | Secretos: no van a la base ni al repo. |

**Por qué apareció una dependencia.** El hub era de cero dependencias por diseño.
El TP pide un servicio de base de datos, y eso obliga a un cliente: `pg`. Lo aislé
en `backend/db/almacen.js`, que expone la misma interfaz con Postgres o con
archivos JSON según haya o no `DATABASE_URL`. El resto del servidor no se entera.

**Healthcheck.** `pg_isready` en la base y `/api/vivo` en el backend. El
`depends_on: condition: service_healthy` cuelga de eso.

<!-- ⚠️ COMPLETAR: ¿por qué depends_on solo no alcanza? Es pregunta de defensa. -->

**Buffering de nginx apagado en `/api/`.** El asistente responde por SSE. Con el
buffering por defecto, nginx acumula la respuesta y el streaming se ve de golpe al
final. `proxy_buffering off` lo arregla.

### Problemas que encontré y cómo los resolví

<!-- ⚠️ ESTA SECCIÓN ES LA MÁS IMPORTANTE Y LA TENÉS QUE ESCRIBIR VOS.
La cátedra lo dice literal: "un repo con cicatrices bien explicadas vale más que
uno perfecto defendido con silencios". Anotá cada cosa que te rompió mientras lo
levantabas, aunque parezca boba. Especialmente:
- la primera vez que el backend no encontró la base
- qué pasó con los permisos del bind mount del vault
- si el frontend cargó pero /api daba 502 -->

### Declaración de uso de IA

<!-- El hub genera esta sección sola desde su registro real de llamadas:
vista Código → Entregables → "Generar la declaración de uso de IA".
Pegala acá y completá el último párrafo, el de qué NO delegaste. -->

---
