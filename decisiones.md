# Decisiones

> Se escribe hacia abajo: cada TP agrega su sección, no se reemplaza. El historial
> del semestre es uno solo.

---

## TP1 — Git colaborativo

### Por qué Git no pudo resolver el conflicto solo

Las ramas `feature/titulo-a` y `feature/titulo-b` nacieron las dos de `main` y
cambiaron **la misma primera línea** de `README.md` (versión A vs versión B).
Git fusiona solo cuando los cambios tocan regiones distintas: compara las dos
puntas contra el ancestro común y, si el mismo hunk divergió, no tiene criterio
para elegir. Por eso aparecieron los marcadores `<<<<<<<`, `=======` y
`>>>>>>>` en el PR #2.

Para que el conflicto nunca apareciera habría bastado una de estas dos cosas:
que las ramas tocaran líneas distintas, o que la rama B naciera **después** de
mergear A (integración frecuente: el ancestro común ya traería la versión A y
Git haría fast-forward o un merge limpio).

Resolví tomando la versión B (era la rama que estaba mergeando) y borré los
marcadores. El título real del repo se restauró en el PR de esta sección.

### Qué problemas encontré y cómo los resolví

- **El repo nació privado.** La API de protecciones de GitHub Free responde 403
  en repos privados (`Upgrade to GitHub Pro or make this repository public`).
  Lo pasé a público y recién ahí pude poner la regla sobre `main`.
- **La protección hay que probarla.** Configurarla no alcanza: el checkpoint es
  que `git push origin main` falle. Falló con `GH006` / `protected branch hook
  declined`. Después `git reset --hard HEAD~1` para no dejar el commit de
  prueba local.
- **Cero approvals, y `enforce_admins`.** Si dejaba 1 approval no podía
  mergear nunca: GitHub no deja aprobar tu propio PR. Sin `enforce_admins` la
  regla no me alcanzaba a mí, que soy el dueño.
- **La rama B tiene que nacer de `main`, no de A.** Si B sale de A, no hay
  conflicto. La fabriqué a propósito en ese orden: abrí los dos PRs, mergeé A
  (#1) y el #2 quedó `mergeable: CONFLICTING`.

### Declaración de uso de IA

Usé Cursor (agente) para armar los comandos de `gh`/`git`, redactar este
archivo y generar las capturas a partir de la salida real de la terminal. Lo
que verifiqué yo: el push a `main` rechazado, el PR #2 en estado CONFLICTING,
los marcadores en `README.md`, y que los dos PRs quedaron mergeados con squash.

No delegué la decisión de contenido del conflicto (quedó versión B) ni la
configuración de la protección (0 approvals + `enforce_admins: true`).

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
| Clave de IA y token | `datos-hub`, archivo con permisos 600 | Secretos: no van a la base ni al repo. |

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
