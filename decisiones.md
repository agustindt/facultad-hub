# Decisiones

> Se escribe hacia abajo: cada TP agrega su sección, no se reemplaza. El historial
> del semestre es uno solo.

---

## TP7 — La imagen que se probó es la que corre

### Enlaces del TP7

| Qué | Dónde |
|---|---|
| `image:` en los dos compose, la cadena deploy → integración → e2e → PROD, y el entrypoint del vault | https://github.com/agustindt/facultad-hub/pull/24 |
| Esa cadena en verde (QA, integración y e2e). PROD rechazado: todavía no había un freno rojo | https://github.com/agustindt/facultad-hub/actions/runs/39289130490 |
| El botón del calendario deja de decir Agregar. El cambio está en la app | https://github.com/agustindt/facultad-hub/pull/25 |
| QA hizo pull de `sha-6fc87b9e464565bc4940a37dc235b8ed565a13c1`, la integración quedó verde, la e2e no encontró el botón y `deploy-prod` salió skipped | https://github.com/agustindt/facultad-hub/actions/runs/39448719101 |
| El botón vuelve a decir Agregar. Integración y e2e verdes, PROD aprobado de `5809fa9eed504bf377306dafef0aaab9184f858c` | https://github.com/agustindt/facultad-hub/actions/runs/39450167435 |
| Backend y frontend de ese tag | https://github.com/users/agustindt/packages/container/package/facultad-hub-backend |

El rechazo de `39289130490` está en el environment `production`. La e2e de `39448719101` esperó `getByRole('button', { name: 'Agregar' })` y los tres casos vencieron a los 30s; `deploy-prod` no arrancó. El commit que devuelve el texto Agregar es el que corresponde promover: la corrida anterior ya mostró el freno.

### Por qué QA y PROD dejan de construir

En el TP6 el deploy hacía `docker compose up --build`. La imagen publicada y la que corría podían no ser la misma: otro `npm install` en el runner, otra resolución. Acá los dos compose usan `image:` con `${IMAGE_TAG:?falta IMAGE_TAG}`. Si el tag no está, Compose se niega. El job hace `pull` y después `up`, sin `--build`. El log tiene que mostrar el `pull` de `sha-<commit>` de esa corrida. El runner es arm64 y las imágenes salen de un runner amd64, así que cada servicio de la app lleva `platform: linux/amd64`. Postgres no: su imagen es multi-arch y conviene la nativa.

La misma etiqueta va a QA y a PROD. No hay un tag distinto para cada entorno.

### Por qué las pruebas le hablan a QA y no a una base armada en el job

`integracion` y `e2e` corren en el runner de esta máquina, después de `deploy-qa`, contra `localhost:8080` y `localhost:3000`. Un Postgres levantado en el job sería otra base, no la de QA. Las de integración no abren navegador: alta de un evento, rechazo de título vacío, y alta de una nota con borrado. Las tres de navegador usan el calendario, que es lo que se carga a mano todos los días: crear, ver el error si falta el título, y comprobar que el evento sigue después de recargar. Cada una borra lo que creó.

`e2e` necesita a `integracion`, y `deploy-prod` necesita a `e2e`. Si la e2e falla, PROD no arranca. No hay `continue-on-error` ni `if: always()` en ese job. El environment `production` sigue pidiendo reviewer.

La integración le pega a Postgres (los eventos) y al vault de QA (las notas). Los dos son el almacenamiento de ese entorno, no un doble. El volumen del vault nace de root y el proceso es `node`: sin un `chown` al arrancar, crear una nota devolvía permiso denegado. El entrypoint de la imagen lo corrige y después baja a `node`.

### Declaración de uso de IA

Cursor escribió los specs, el `image:` de los compose y los jobs. El calendario es el flujo de todos los días que ya escribe en la base de QA. No delegué el gate: `deploy-prod` necesita a `e2e`, y si esa falla PROD no arranca.

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

---

## TP5 — Testing en el pipeline

### Enlaces

| Qué | Dónde |
|---|---|
| La suite en verde, con el reporte en el summary y el artifact | https://github.com/agustindt/facultad-hub/actions/runs/39268489239 |
| La corrida **roja por umbral de líneas** (53 tests en verde, 93.42% < 96%) | https://github.com/agustindt/facultad-hub/actions/runs/39268908621 |
| Esa misma rama, después de los tests, en verde | https://github.com/agustindt/facultad-hub/actions/runs/39269121134 |
| La secuencia rojo → tests → verde → merge | https://github.com/agustindt/facultad-hub/pull/17 |
| El freno vigente, abierto y en rojo | https://github.com/agustindt/facultad-hub/pull/18 |

### Qué lógica testié y por qué esa

Cuatro reglas del backend, no ocho variantes de leer un JSON:

1. **`programar`** — el intervalo del repaso. Un bug acá adelanta o atrasa el
   calendario y no se nota hasta el parcial. El caso que más importa es el
   recorte: si el intervalo calculado pasa el margen que queda, se baja a ese
   margen (`recortado: true`). Invertir el `>` por `>=` deja un repaso
   programado para después del examen, y el test del tope se pone en rojo.
2. **`classifyEvento`** — el orden de las reglas. "Recuperatorio del parcial"
   tiene que salir `recuperatorio`, no `examen`. Si el `parcial` se evalúa
   antes, esa fecha se pinta como parcial.
3. **`evaluarTema`** — el match del programa contra las notas usa F1, no
   recall. El corte es 0.6 en el título y 0.8 en el cuerpo. Un test arma un
   F1 de 0.67 (pasa) y otro de 0.5 (no casa por el título).
4. **`nuevasPorDia`** — cuántas tarjetas nuevas por día hacen falta para
   llegar al parcial. Cero tarjetas es 0; un resto se redondea para arriba;
   un margen de cero días es un error, no un infinito.

En el frontend, las reglas que el usuario ve al guardar y en el panel de
GitHub: `avisosDeNota`, `fechaRel`, `diffLineas`, el color de la matriz
(`nivelActividad`) y `cargarIndice`.

### El mock, y el refactor para poder inyectarlo

`AlmacenPostgres` abría `pg.Pool` adentro del constructor. No había forma de
probar el SQL sin una base. El constructor ahora recibe el pool como segundo
argumento; en producción no se pasa y sigue creando el Pool. El test le pasa
un doble que registra el SQL y devuelve filas. El assert mira el `INSERT ...
ON CONFLICT` y que una query que tira no se propaga: `salud()` devuelve
`ok: false`.

En el frontend, `cargarIndice(cliente)` no llama a `fetch`. El arranque le
pasa `api`. El test le pasa un `vi.fn` y comprueba que la única ruta pedida
es `/api/estado`, y que un índice sin `materias` se rechaza con `code: 'INDICE'`.

### Umbral

**96% de líneas y 80% de ramas**, sobre `dominio.js` y `db/almacen.js` en el
backend, y sobre `public/reglas.js` en el frontend (90/75, que es el
`coverage.thresholds` de vitest). El número sale de la medición, no de un
ejemplo: la suite deja el backend en **99.58% de líneas y 85.38% de ramas**.
96 está debajo de eso, así que el verde es holgado, y arriba de lo que queda
si entra una función nueva sin tests: ~20 líneas sin cubrir bajan el total
de 96. Subirlo diez puntos (a 96 de ramas, o a 100 de líneas) frenaría la
suite de hoy por las dos líneas que dejé afuera a propósito.

La métrica del umbral es **línea**. La de **rama** también está puesta (80)
y el reporte la muestra siempre. Hoy da 85.38%.

### Qué dejé afuera de la cuenta

- **`server.js` entero.** Es HTTP, el vault y el proceso que escucha. Un test
  que lo importe levanta el puerto. Las reglas que importan están en
  `dominio.js`; el resto es cableado. Entrá con
  `--test-coverage-include=dominio.js` y `--test-coverage-include=db/almacen.js`.
- **`index.html` y `vendor/`.** DOM y librerías de terceros. Lo testeable
  del cliente está en `public/reglas.js` (`include` de vitest).
- **`crearAlmacen` cuando hay `DATABASE_URL` y no está `pg`**
  (`db/almacen.js`, líneas 114-115). Es el aviso que deja seguir con archivos
  si alguien define la variable y no instaló el paquete. Para cubrirla hay
  que hacer fallar el `require('pg')` con el módulo ya cargado. No la agregué:
  en esta máquina `pg` está instalado, y el camino que usa el compose es el
  otro (hay `pg` y hay URL).
- **`fechaRel` cuando pasaron 30 días o más** (`public/reglas.js`, líneas
  92-93). La entrada que lo recorre es una fecha de más de un mes atrás, por
  ejemplo `fechaRel('2026-08-01T15:00:00Z', fechaDel19DeOctubre)`. Cae en
  `toLocaleDateString('es-AR')`. No lo agregué: el string depende del locale
  del runner y el assert se pondría rojo en CI sin que la regla cambie. El
  reporte de la corrida marca esas dos líneas.

### Por qué un coverage alto no dice que el código funciona

`dominio.js` está en 100% de líneas. Eso no prueba el repaso. Un test puede
recorrer `programar` y assertar `typeof r.intervalo === 'number'`: suma línea
y no verifica el recorte. El test que sí lo verifica es el del tope 2, que
exige `intervalo === 2` y `recortado === true`. Si mañana el recorte se borra,
la cobertura puede seguir alta y ese assert no.

### Herramientas

El stack no es el de la cátedra (.NET + vitest en el back). La tabla, fila JS:

| Qué | Con qué |
|---|---|
| Dónde viven los tests | `backend/test/*.test.js` al lado del código, `frontend/test/` |
| Parametrizado | tabla + `for` en `node:test` (back); `it.each` de vitest (front) |
| Inyectar la dependencia | segundo argumento del constructor; parámetro `cliente` |
| El doble | objeto con `query` (back); `vi.fn` (front) |
| Medir | `node --test --experimental-test-coverage`; `vitest run --coverage` (v8) |
| Umbral que rompe | `--test-coverage-lines=96 --test-coverage-branches=80`; `coverage.thresholds` |
| Qué entra | `--test-coverage-include`; `coverage.include` |
| Reporte | tabla en el log del job, `lcov.info` como artifact |

Los jobs siguen llamándose `build-backend` y `build-frontend`: son el id que
el gate de `main` ya exige desde el TP4. El umbral corre **adentro** de esos
jobs, antes del `docker build`. La etapa `test` del Dockerfile también corre
`npm test`, así que una imagen no se construye si el número no da.

### Problemas que encontré y cómo los resolví

- **`server.js` no se puede importar desde un test.** Al cargarlo hace
  `listen`. Saqué las reglas a `dominio.js`.
- **El aviso de "menos de 3 conexiones" no disparaba** cuando esa sección era
  la última. El regex usaba `\Z`, que en JavaScript no es el final del texto.
  Lo reemplacé por un corte hasta el próximo `##`.
- **El `.dockerignore` del backend excluía `test/`.** Tenía sentido cuando la
  imagen no corría tests. La etapa de test necesita esa carpeta en el
  contexto; la imagen final no la copia.

### Declaración de uso de IA

Cursor escribió los tests, el módulo `dominio.js`, la extracción a
`reglas.js` y esta sección. Verifiqué yo: `npm test` en los dos lados con el
umbral prendido (53 tests de backend, 17 de frontend), que `node --check`
pasa sobre `server.js`, y que el reporte marca las líneas 114-115 de
`almacen.js` y las 92-93 de `reglas.js`, que son las que decidí no cubrir.

No delegué el número del umbral ni qué reglas entraban en la suite.

---

## TP6 — CD: environments y aprobación

### Enlaces de este TP

| Qué | Dónde |
|---|---|
| Workflow, compose de QA y de PROD, y la cadena | https://github.com/agustindt/facultad-hub/pull/20 |
| En el PR, "Entrar al registry" salteado y `push: false` | https://github.com/agustindt/facultad-hub/actions/runs/39273154233 |
| Primer push a main: ghcr rechaza el manifest | https://github.com/agustindt/facultad-hub/actions/runs/39272493130 |
| Segundo push, sin atestación: el mismo `write_package` | https://github.com/agustindt/facultad-hub/actions/runs/39273355559 |
| Publicó las dos imágenes, QA verde, PROD rechazado | https://github.com/agustindt/facultad-hub/actions/runs/39275588120 |
| Backend `sha-2ca583e276508268a3612d7a55fd9751e0f1f587` | https://github.com/users/agustindt/packages/container/package/facultad-hub-backend |
| Frontend con el mismo tag | https://github.com/users/agustindt/packages/container/package/facultad-hub-frontend |

El rechazo está en esa corrida, environment `production`, comentario de agustindt: QA respondió `almacen.ok` y `modo postgres` en el `3000`, y no había evidencia de que `db_data_prod` fuera otra base. El commit que agrega esta tabla es el que tiene que poder promoverse: la corrida anterior ya mostró el freno.

### Por qué la imagen se publica sólo si la verificación pasó

El registry es la prueba de que lo publicado es lo que se verificó. Si se publicara igual con los tests en rojo, un `sha-…` dejaría de significar "este commit pasó". Hay tres eslabones, y los tres están en el workflow:

1. Nada entra a `main` sin los checks en verde (el gate del TP4, ahora también por cobertura).
2. Sólo un `push` a `main` publica: `push: github.event_name == 'push' && github.ref == 'refs/heads/main'`. En un PR, "Entrar al registry" sale salteado.
3. "Construir y publicar la imagen" es el último paso del job, después de los tests. Si los tests fallan, ese paso no se ejecuta.

Lo que esto no garantiza: un `docker push` a mano entra al registry igual. El tag no es un digest. Y los entornos de este TP **reconstruyen** con `docker compose up --build`: no corren la imagen que acaba de publicarse. Esa diferencia es el TP7. La imagen publicada queda etiquetada `sha-<commit>` para poder usarla ahí.

### Continuous Delivery, no Deployment

QA se despliega solo cuando el merge queda verde. PROD no. Falta un reviewer. Eso es Continuous Delivery: el artefacto está listo para producción, y una persona decide. Continuous Deployment sería que PROD subiera sin esa espera. No lo quiero en esta app: un hub con las notas de la cursada no se promueve solo. El gate compra una mirada antes de pisar el entorno que se defiende.

### La cadena y el alcance de cada secret

`deploy-qa` y `deploy-prod` tienen `needs: [build-backend, build-frontend]`. PROD además necesita a QA: si el smoke de QA falla, PROD no arranca. Los dos jobs declaran `environment`. `DB_PASSWORD` es un secret del environment, no del repo: el job de QA lee el de `qa`, el de PROD lee el de `production`. El `GITHUB_TOKEN` que publica en ghcr vive lo que dura el job y no está guardado en ningún secret.

`permissions: packages: write` está dentro de cada job que publica, no en el workflow. Un job que no publica no recibe ese permiso. `contents: read` va junto porque, si listás permisos, lo que no listás se apaga y el checkout deja de poder leer.

### Qué miro antes de aprobar

1. Los dos builds en verde, cobertura incluida.
2. El smoke de QA: `/api/vivo` con `almacen.modo == postgres` y `almacen.ok`, más el front en 3000.
3. Que el deploy de PROD esté esperando review y no haya arrancado solo.

### Plan C, y qué se pierde

No usé Render ni Neon. Colima es el motor de esta máquina (Docker Desktop no está) y el plan C de la cátedra es entrega válida: un self-hosted runner y dos proyectos de Compose. Se pierde la URL pública, el cold start de un free tier y un entorno que no es mi notebook. En la defensa los dos tienen que estar levantados por una corrida, no por mí.

QA escucha en `http://localhost:3000` (front) y `http://localhost:8080` (API). PROD en `3001` y `8081`. El `name:` del compose es `qa` o `prod`, y los volúmenes se llaman `db_data_qa` y `db_data_prod`. Sin eso, el segundo deploy mata al primero.

`BACKEND_URL` entra al frontend al arrancar, por la plantilla de nginx. No está en la imagen. En los dos entornos vale `http://backend:4177`: cada proyecto tiene su propia red, así que ese nombre resuelve al backend de ese entorno.

### Qué prueba el smoke, y qué no

Prueba que la API responde, que Postgres aceptó la consulta (`almacen.salud`) y que el front sirve el index. No dice qué commit está corriendo: el compose reconstruye la punta del checkout, y el checkout es el SHA de la corrida, pero el smoke no lee esa etiqueta. La versión se mira en el job y en Deployments.

### Patrón para una producción con usuarios, y el rollback de ahora

Para esta app, con un solo usuario y sin tráfico que partir, usaría **rolling** de un solo réplica: reemplazar el contenedor y volver al anterior si el smoke falla. Blue-green duplica toda la pila (front, back y base) para un corte que hoy hago apagando un compose. Canary pide poder mandar un porcentaje del tráfico a la versión nueva y ver el error rate; no tengo ni balanceador ni métricas. Sin eso, canary es un deploy con un nombre lindo.

Rollback de hoy: `docker compose -f compose.prod.yml up -d --build` sobre el checkout del commit anterior. El número lo mido en la corrida que lo hace, no de memoria. Lo que no deshace: los datos. `db_data_prod` sobrevive al cambio de código. Un rollback de imagen no vuelve atrás un evento escrito en la base. Para eso haría falta un backup previo o una migración reversible. Hoy no hay.

### Problemas que encontré y cómo los resolví

- **Actions no puede escribir los packages que publicó el PAT en el TP2.** [Corrida 39272493130](https://github.com/agustindt/facultad-hub/actions/runs/39272493130) y, después de apagar la atestación, [39273355559](https://github.com/agustindt/facultad-hub/actions/runs/39273355559). En las dos el token decía `Packages: write`, "Entrar al registry" pasó, y el push murió con `denied: permission_denied: write_package`. Subí el permiso por defecto del repo a write y volvió a fallar: no era el techo del token. Los packages `facultad-hub-backend` y `facultad-hub-frontend` existen desde agosto, creados con un PAT. ghcr no le da write al `GITHUB_TOKEN` sobre un package creado así hasta que el repo figura en *Manage Actions access* con rol Write. `provenance: false` quedó, porque la atestación no hace falta para el tag `sha-`, pero no era la causa.

### Declaración de uso de IA

Cursor armó el workflow, los dos compose y esta sección. Verifiqué yo el orden de los pasos en la corrida, que el PR no publica, que QA sube solo y que PROD queda esperando. No delegué el patrón de deploy ni la decisión de usar el plan C.

---

## TP8 — Preprod nace y muere con un comando

Riel: **plan C**. Terraform 1.16.6 y el provider `kreuzwerker/docker` 4.6.0, fijado en `infra/.terraform.lock.hcl`. No hay Neon ni Render: QA y PROD siguen siendo los compose del TP7, y preprod es un tercer conjunto de contenedores que no comparte red, volumen ni puerto con ellos.

La imagen es la del TP7, tag `sha-5809fa9eed504bf377306dafef0aaab9184f858c`, la misma en el backend y en el frontend (`platform = linux/amd64`). La cadena de la API sale del nombre del contenedor de la base: `postgres://hub:<clave>@${docker_container.db.name}:5432/hub`. `BACKEND_URL` del front sale del nombre del contenedor de la API. Ninguna de las dos está copiada de QA. La clave no está en el HCL: entra por `local.tfvars`, que el `.gitignore` cubre junto con `.terraform/` y el estado. El estado vive en `$HOME/tfstate/facultad-hub.tfstate`, fuera del repo, porque un checkout de Actions borra también lo ignorado.

El endpoint de vida de esta app es `/api/vivo`, no `/health`. En el `8090` respondió `almacen.ok` y `modo postgres`. Un POST de evento quedó en esa base y no apareció en QA. El front, en el `3010`, proxya a su propia API. QA (`3000`) y PROD (`3001`) siguieron respondiendo durante el apply y durante el destroy.

El segundo `plan` dijo «No changes». Borrar `facultad-hub-preprod-api` a mano hizo que el plan siguiente pidiera crearlo (`1 to add`), y el apply lo reconstruyó. Con `prevent_destroy` en el volumen de la base, `plan -destroy` se negó y nombró el recurso; saqué la línea porque preprod tiene que poder morir. `destroy` bajó los 10 recursos y QA/PROD siguieron vivos. Un `apply` los volvió a crear, `/api/vivo` respondió otra vez (la base vacía: el volumen se había ido), y volví a destruir. Para la defensa preprod tiene que nacer delante del docente, no estar ya prendido.

`depends_on` espera a que el contenedor de Postgres exista, no a que acepte conexiones. Por eso la API tiene `restart = unless-stopped`.

### Problemas

- Homebrew no instala Terraform en esta máquina: las Command Line Tools no soportan macOS 27. Bajé el binario 1.16.6 de `releases.hashicorp.com` a `~/.local/bin`. No está en el repo.
- El provider no usa el context de Colima. Sin `host` habla con `/var/run/docker.sock`, que acá no existe. El socket está en la variable `docker_host`.

### Declaración de uso de IA

Cursor escribió el HCL a partir del plan C de la guía, adaptado a los puertos y a `DATABASE_URL` de esta app. Verifiqué yo el apply, el «No changes», el drift, el rechazo de `prevent_destroy`, el destroy y el apply que lo rehace. No delegué dejar preprod destruido ni el path del estado.

---

## TP9 — Lo que mira cada guardián, y lo que no

El PR de Dependabot que mergeé es el [#34](https://github.com/agustindt/facultad-hub/pull/34): `actions/checkout` de la 6 a la 7. Es un **major**. El corte de la 7 es que, en `pull_request_target` y en `workflow_run`, checkout deja de bajar el código de un fork. Este workflow no usa esos eventos: baja la rama del push o del PR. El pipeline del PR estaba verde (tests, umbral, imágenes). Por eso lo mergeé. Dependabot también alertó vitest y tinypool en el lock del frontend (dos críticas, dos medias). Los PRs que suben vitest a la 5 dejan rojo `build-frontend`, así que no los mergeé.

CodeQL está en default setup (JavaScript y Actions) y el primer análisis terminó. Secret scanning y push protection están activos. Dependabot corre cada semana sobre `/backend`, `/frontend` y las actions, con alertas y security updates prendidos. El config entró en el [#28](https://github.com/agustindt/facultad-hub/pull/28).

Sentry está en los dos lados de PROD. El backend manda solo si existe `SENTRY_DSN` (secreto del entorno production; QA no lo tiene). El del browser va en el HTML: es una clave pública. Errores guardados: [FACULTAD-HUB-1](https://clubgest.sentry.io/issues/FACULTAD-HUB-1) (`GET /api/falla`, «Falla de prueba del TP9») y [FACULTAD-HUB-AF-1](https://clubgest.sentry.io/issues/FACULTAD-HUB-AF-1) (`ReferenceError: myUndefinedFunction is not defined` en `/`). El endpoint de prueba sigue en el código para poder repetirlo en la defensa; la tarjeta dice sacarlo después.

En las últimas 24 h, spans `http.server` del proyecto `facultad-hub`:

| Ruta | Pedidos | p95 |
| --- | ---: | ---: |
| `GET /status` | 5790 | 10 ms |
| `GET /message` | 4233 | 8 ms |
| `GET /api/vivo` | 1084 | 41 ms |
| `GET /api/falla` | 2 | 506 ms |

`/status` y `/message` no son rutas de la app: el pedido llega, no matchea, y Sentry igual lo cuenta. De las rutas que existen, la más usada es `GET /api/vivo` (el healthcheck y el smoke) y la más lenta es `GET /api/falla`, porque el catch espera `Sentry.flush` antes de responder 500. De ese dato salió la tarjeta [#39](https://github.com/agustindt/facultad-hub/issues/39) en el tablero del TP3, en Todo.

El monitor externo todavía no tiene el par DOWN/UP. PROD es localhost y no hay cuenta de UptimeRobot: un servicio de afuera no llega al `8081` sin un túnel, y no lo dejé abierto. El endpoint que tiene que mirar es `/api/vivo` (un HEAD ya responde 200, que es lo que pregunta el plan gratis). El tiempo de detección se anota cuando se haga la caída, y el monitor se pausa al terminar.

### Problemas

- Un miembro de la organización no puede crear proyectos en Sentry (403). Los creé en la UI: `facultad-hub` (Node) y `facultad-hub-af` (browser). El nombre del segundo lo acortó Sentry.
- El DSN que mostraba el asistente de instalación no era el de la clave viva del proyecto. El secreto de production usa la clave que `find_dsns` devuelve para `facultad-hub`.
- La primera corrida del front en main murió en integración porque el runner aceptó el job y no lo ejecutó. Lo maté y la reejecución pasó. PROD de esa corrida es `f86f3fb`.

### Declaración de uso de IA

Cursor escribió `instrument.js`, el loader del browser, la tarjeta #39 y esta sección. Los números de la tabla los leí de las trazas de Sentry, y el #34 estaba verde antes de mergearlo. No delegué cuál PR mergear ni dejar el monitor sin el par DOWN/UP.
