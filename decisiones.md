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
| Escala manejable: CRUD + 2-3 pantallas | **No del todo.** Son ~10 vistas. |
| Individual y distinta a la de mis compañeros | Sí: es una app propia, no un repo de ejemplo. |

Elegí esta app a pesar de ser más grande que el CRUD de 2–3 pantallas porque la
defensa es el 50 %: si no lo puedo explicar, no apruebo. Prefiero una app grande
que uso y entiendo a una chica que cloné. El sample de la cátedra queda para
practicar, no para entregar.

### Decisiones de contenerización

**Imágenes base.** `node:22-alpine` para el backend y `nginx:1.27-alpine` para el
frontend. Alpine porque el backend no necesita nada compilado (no hay gcc).

Tamaños medidos en esta máquina (Colima, linux/arm64):

| Imagen | Tamaño |
|---|---|
| `node:22` (equivalente al SDK: Debian + npm + toolchain) | **1.63 GB** |
| `node:22-alpine` | 229 MB |
| `facultad-hub-backend` (imagen final) | **230 MB** |
| `nginx:1.27-alpine` | 76.8 MB |
| `facultad-hub-frontend` | **84.3 MB** |

El backend casi no suma sobre alpine: el runtime de Node *es* la imagen. Lo que
ahorra el multi-stage es no llevarse `node:22` de 1.63 GB. Si no fuera
multi-stage, la imagen final llevaría npm, el cache de instalación y las
herramientas de build: más superficie de ataque y más tiempo de pull.

El frontend no tiene `npm run build`: es un `index.html` con vendor. La etapa
1 solo verifica que existan los assets; la 2 es nginx. Si no hubiera etapa 2,
estaríamos sirviendo estáticos con Node, innecesario.

**Qué persiste y qué no.**

| Qué | Dónde vive | Por qué |
|---|---|---|
| Las notas (`.md`) | Bind mount del vault desde el host | Son la fuente de verdad y las abre Obsidian. |
| Repaso, eventos, log de IA | Postgres, volumen nombrado `datos-db` | Sobrevive a `down`; se borra con `down -v`. |
| Clave de API y token | volumen `datos-hub` | Secretos: no van a la base ni al repo. |

**Cómo se encuentran los servicios.** Compose crea una red con DNS: el backend
habla con `db:5432` (no `localhost`). El browser no está en esa red: la SPA
llama a `/api/...` (mismo origen) y nginx, que sí está en la red, proxea a
`backend:4177`. Por eso no hay CORS que configurar.

**Healthcheck vs `depends_on`.** `depends_on` solo espera a que el contenedor
*arrancó*. Postgres acepta conexiones unos segundos después. Sin
`condition: service_healthy` + `pg_isready`, el backend se moría hablando con
una base que todavía no escuchaba.

**Secretos.** `.env` no está en el repo (está en `.gitignore`). `.env.example`
sí. En un pipeline esos valores van a secrets de la plataforma (TP4/TP6).

**Arquitectura.** Las imágenes se construyeron en una Mac ARM (Colima). Un
runner amd64 no las puede correr tal cual: en TP7 se resuelve con `buildx`.

### Problemas que encontré y cómo los resolví

- **502 después de recrear el backend.** nginx resolvió `backend` *al
  arrancar* y cacheó `172.18.0.4`. Recrear el contenedor le cambia la IP:
  `connect() failed (111: Connection refused)`. Lo arreglé con
  `resolver 127.0.0.11` y `proxy_pass` por variable, como avisa la guía.
- **Docker Desktop no está instalado.** El motor es Colima. `docker compose`
  pide el plugin buildx (no está en esta máquina): para el TP2 alcanza el
  builder clásico; el cache de capas del TP4 corre en los runners de GitHub,
  que sí tienen buildx.
- **`docker login` a ghcr da Succeeded y el push falla** con
  `token provided does not match expected scopes`. El token de `gh` traía
  `repo`/`workflow`/`project`, no `write:packages`. Hay que refrescar el
  alcance (y el token tiene que ser classic: los fine-grained no sirven para
  ghcr).
- **Los packages nacen privados y la API no cambia visibilidad** (PATCH 404).
  Se pasa a público a mano: perfil → Packages → Package settings → Danger
  Zone. La URL `.../settings` directa da 404 si el package no está linkeado
  al repo. La prueba de que quedó público es `docker logout` + `docker pull`
  + `docker compose -f docker-compose.registry.yml up -d`.

### Declaración de uso de IA

Cursor armó Dockerfiles, compose y esta redacción. Verifiqué yo el
`docker compose ps` en healthy, el 502 y el arreglo del resolver, la
prueba de persistencia (`down` deja el evento; `down -v` lo borra) y el
pull anónimo desde ghcr con `docker-compose.registry.yml`.

No delegué la decisión de dejar las notas fuera de Postgres ni el proxy
same-origin.

---

## TP3 — Planificación y trazabilidad

### Duración del sprint

**7 días**, del 28/8 al 3/9. El formulario de P1 cierra el 2/9 y la defensa
es el 4/9: un sprint de dos semanas “para no complicarme” no tendría objetivo
comprobable esta semana. El Sprint Goal es dejar TPs 1–4 defendibles, no
vaciar el backlog del semestre.

### Límite de trabajo en progreso

**2** (personas + 1, trabajando solo). El +1 es la válvula para cuando algo
queda esperando (una revisión, un `write:packages`). Si lo subo a diez, el
límite deja de limitar: empiezo de más y termino de menos. Señal de que está
alto: nunca lo alcanzo.

### Diagnóstico de la historia mal escrita

“Como desarrollador quiero crear la tabla usuarios para guardar los datos”
no es una historia: es una **tarea disfrazada**. El rol es quien programa, no
quien recibe valor; no hay beneficio observable; no es negociable ni testeable
como incremento. La reescribiría: *Como estudiante quiero que mis eventos de
cursada sobrevivan a recrear los contenedores para no perder el calendario al
hacer `compose down`.* Criterio: `down` conserva; `down -v` borra.

### Problemas que encontré y cómo los resolví

- Un Project creado con `gh project create` **no auto-agrega** issues: hay
  que `item-add` o encender el workflow *Auto-add* eligiendo el repo. Lo
  hice a mano.
- `gh` 2.82 no tiene `--add-sub-issue` (llegó en 2.94). La jerarquía la armé
  con la mutación GraphQL `addSubIssue`. Las task-lists no cuentan: no son
  navegables padre→hijo.
- El bug #8 no colgó de la historia: es un defecto de algo ya entregado (el
  502 de nginx), no trabajo que faltaba adentro de una historia abierta.

### Declaración de uso de IA

Cursor ejecutó los comandos de `gh`/`graphql` y redactó esta sección. Verifiqué
la jerarquía (épica #4 → historia #5 → tareas #6 y #7), el Project público
(https://github.com/users/agustindt/projects/5) y que el bug #8 está al
costado. El `Closes #6` del PR del esqueleto de CI lo revisé en el issue
antes de mergear.

No delegué la duración del sprint ni el número del WIP: salen del calendario
de P1 y de la regla de la cátedra.

---

## TP4 — CI: pipelines as code

### Estructura del pipeline

Dos jobs, `build-backend` y `build-frontend`, **sin `needs:`**: corren en
paralelo, cada uno en su runner. No comparten filesystem ni capas: por eso cada
uno hace su propio `checkout` y tiene su propio `scope` de cache (`backend` /
`frontend`). Si compartieran el estante default (`buildkit`), el último en
terminar pisaría el cache del otro.

No hay un job de tests: eso es el TP5. Hoy el pipeline verifica que las
**imágenes del TP2 se construyan** en una máquina limpia.

Triggers: `pull_request` a `main` (verifica *antes* del merge, alimenta el
gate) y `push` a `main` (deja la corrida que lee el badge y el cache que
después reutilizan los PRs).

### Qué cachea y qué pasa si desaparece

Cachea **capas de Docker**, no artefactos. `cache-from`/`cache-to: type=gha`
con `mode=max`. En la segunda corrida del PR #11 ambos jobs mostraron
`CACHED` (backend #8–#13, frontend #11–#15):
https://github.com/agustindt/facultad-hub/actions/runs/33191229066

Si el cache desaparece, el pipeline **sigue en verde**: tarda más, no falla.
Si fallara sin cache, no era cache: era una dependencia escondida.

### Por qué construye con el Dockerfile y no con `npm`/`node` a mano

Hay **una** definición de build: el Dockerfile del TP2. Si el pipeline
corriera `npm install` por su cuenta, verificaríamos otra receta que la que
después se despliega, y las dos divergen. El YAML no sabe Node: sabe `docker
build` con `context: ./backend` y `./frontend`.

El hub **no compila ni empaqueta**. Un `import` inventado no rompe `docker
build`. Para demostrar el gate rompí **las dependencias**:
`estonoexiste-tp4` en `package.json` → `npm install` del Dockerfile → 404 →
job `build-backend` en rojo → merge `BLOCKED`. El fix lo sacó. PR #13:
https://github.com/agustindt/facultad-hub/pull/13

`strict: true` se ve en el PR #12: después de mergear el #13 quedó
`mergeStateStatus: BEHIND` y hubo que *Update branch*.
https://github.com/agustindt/facultad-hub/pull/12

### Problemas que encontré y cómo los resolví

- **El PUT de protecciones reescribe todo.** Hay que re-declarar 0 approvals
  + `enforce_admins: true` junto con los status checks. Si omitís eso, el
  dueño vuelve a poder pushear a `main`.
- **Los checks no aparecen en el buscador hasta que corrieron.** Por eso el
  workflow entra primero (PR #11), y el gate se configura después.
- **`strict: true` no se ve con un solo PR.** Dejé abierto el #12: cuando
  mergeé el #13, el #12 pidió *Update branch*.
- **ghcr nace privado** y la API no cambia visibilidad (PATCH 404). Hay que
  hacerlo a mano en Package settings → Change visibility.

### Declaración de uso de IA

Cursor armó el YAML (el de la guía de la cátedra, adaptado a estos
Dockerfiles), los comandos de `gh` y esta redacción. Verifiqué yo: las dos
corridas del #11 con `CACHED`, el PUT del gate, el `docker build ./backend`
en rojo por el 404, el PR #13 en `BLOCKED` y el merge después del fix.

No delegué los nombres de los jobs (`build-backend` / `build-frontend`): son
el id que exige el gate.
