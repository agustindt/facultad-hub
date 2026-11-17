# Defensa: respuestas sobre mi repo

> Cada respuesta está pensada para decirla en voz alta (30–60 s) y después **mostrar** algo.
> 📂 = qué abrir. ⚠️ = la pregunta asume algo que en mi repo es distinto, o hay un hueco.
> Revisado contra el repo y GitHub el 6/11/2026.

---

## ⚠️ Antes de la defensa (huecos reales)

| # | Qué | Por qué importa |
|---|---|---|
| 1 | **CodeQL tiene 2 alertas ABIERTAS**: `js/reflected-xss` (error) en `server.js:3440` y `js/incomplete-sanitization` (warning) en `server.js:2673`. | La pregunta 56 dice "¿cómo lo arreglaste?". Hoy no está arreglado. |
| 2 | **El monitor externo no tiene el par DOWN/UP.** | La pregunta 59 pide cuánto tardó el aviso. No hay número. |
| 3 | **Colima está apagado**, así que QA (3000/8080) y PROD (3001/8081) no responden. | `colima start` y los contenedores vuelven solos (`restart: unless-stopped`). Hay que verificar `/api/vivo` antes de entrar. |
| 4 | `decisiones.md` TP6 dice que el rollback es `up -d --build`. | Desde el TP7 eso es viejo: el rollback es cambiar `IMAGE_TAG` (ver la 20). |
| 5 | `decisiones.md` TP5 dice "subirlo diez puntos (a 96 de ramas…)". | La cuenta está mal: 80 + 10 = **90** de ramas. Ver la 9. |
| 6 | El smoke **no verifica qué versión corre** (`/api/vivo` devuelve `version: 3` fijo). | La pregunta 35 apunta justo a eso. |

---

## TP5 — Testing

### 1. Un test con mock. ¿Arrange, Act, Assert? ¿Qué es el mock?
📂 [almacen.test.js:104](../backend/test/almacen.test.js:104) (`Postgres escribe con upsert…`) y el doble en [almacen.test.js:77](../backend/test/almacen.test.js:77).

- **Arrange:** `const pool = poolFalso();` y `new AlmacenPostgres('postgres://no-existe/hub', pool)`. La URL no existe a propósito: si el test tocara la red, fallaría.
- **Act:** `await a.escribir('eventos', [{ id: 'tp5' }])`.
- **Assert:** que el SQL registrado tenga `ON CONFLICT (clave) DO UPDATE` y que los parámetros sean `'eventos'` y el JSON con `id: 'tp5'`.
- **El mock** es `poolFalso`: reemplaza al `pg.Pool`. Tiene `query()` y `end()`, guarda cada SQL en `queries` y devuelve las filas que preparó el test. No abre ninguna conexión.

Para poder inyectarlo **refactoricé el constructor**: `AlmacenPostgres(url, pool)` ([almacen.js:71](../backend/db/almacen.js:71)). En producción no se pasa el pool y se crea el `pg.Pool` real.

En el front, lo mismo con `vi.fn`: [reglas.test.js:100](../frontend/test/reglas.test.js:100). `cargarIndice(cliente)` recibe el cliente HTTP y el test verifica que la única ruta pedida es `/api/estado`.

### 2. ¿Qué es `patch` y por qué se parchea `services.checkout_service…` y no `repositories…`? ⚠️
Esa pregunta viene del sample de Python de la cátedra. **Yo no uso `patch`.**

- `patch` (de `unittest.mock`) reemplaza un nombre **en un módulo** mientras dura el test.
- Se parchea **donde se usa, no donde se define**. Si `checkout_service` hace `from repositories import X`, al importar se copia la referencia a `X` en el namespace de `checkout_service`. Parchear `repositories.X` cambia el original, pero el servicio sigue apuntando al viejo. Hay que parchear `services.checkout_service.X`, que es el nombre que el código busca al ejecutarse.
- **En mi repo** elegí **inyección de dependencias**: el doble entra por el constructor (back) o por un parámetro (front). No hay magia de módulos: el test muestra explícitamente de qué depende el código. El equivalente JS de `patch` sería `vi.mock('modulo')`.

### 3. ¿Mock vs stub? ¿El tuyo cuál es?
- **Stub:** devuelve respuestas preparadas. Se verifica el **estado/resultado** del código bajo prueba.
- **Mock:** se verifica **la interacción**, o sea qué llamadas recibió el doble.
- `poolFalso` hace las dos cosas según el test:
  - En `la salud de Postgres cuenta las claves…` funciona como **stub**: devuelve 2 filas y el assert mira `s.detalle === '2 claves'`.
  - En `escribe con upsert` funciona como **mock** (técnicamente un *spy*, porque registra y verifico después): el assert mira **qué SQL le mandaron**.
- El `vi.fn` del front es mock: `toHaveBeenCalledOnce()` verifica la interacción.

### 4. ¿Qué lógica testeaste y por qué?
Las reglas donde un bug **no se nota hasta el parcial** ([dominio.js](../backend/dominio.js)):
1. `programar` (SM-2 recortado): el caso clave es el **recorte**. Si el intervalo pasa el margen hasta el examen, se baja al margen (`recortado: true`). Test: [dominio.test.js:65](../backend/test/dominio.test.js:65). Si cambio `>` por `>=` en [dominio.js:241](../backend/dominio.js:241), se pone rojo.
2. `classifyEvento`: el orden importa. "Recuperatorio del parcial" tiene que salir `recuperatorio`, no `examen`.
3. `evaluarTema`: match por F1 (0.6 en el título, 0.8 en el cuerpo).
4. `nuevasPorDia`: el redondeo para arriba, y que margen 0 sea un error y no infinito.
5. El almacén de Postgres, con el mock.

Front: `fechaRel`, `diffLineas`, `nivelActividad` y `cargarIndice`, que son lo que el usuario ve.
No testeé "leer un JSON" ocho veces: busqué reglas con lógica que se puede romper.

### 5. ¿Umbral, qué métrica y por qué ese número?
📂 [backend/package.json](../backend/package.json) (`--test-coverage-lines=96 --test-coverage-branches=80`) y [vitest.config.js](../frontend/vitest.config.js) (`lines 90, branches 75, functions 90, statements 90`).
- Backend: **96 % de líneas y 80 % de ramas**, medido solo sobre `dominio.js` y `db/almacen.js`.
- El número **sale de la medición**: la suite da **99,58 % de líneas y 85,38 % de ramas**. 96 me deja margen para no romper por una línea, y alcanza para frenar una función nueva sin tests (~20 líneas sin cubrir lo bajan de 96).
- Lo probé: la corrida roja del PR #17 dio **93,42 % < 96** con 53 tests en verde.

### 6. ¿Line vs branch coverage? Ejemplo de rama sin cubrir.
- **Línea:** ¿se ejecutó esa línea? **Rama:** ¿se recorrieron los dos lados de cada `if`/`?:`/`&&`? Una línea como `if (a) x()` puede quedar 100 % cubierta por líneas y 50 % por ramas si `a` nunca fue falso.
- Mis ramas sin cubrir, a propósito:
  - [almacen.js:113-115](../backend/db/almacen.js:113): `DATABASE_URL` definida **sin** el paquete `pg`. Para cubrirla tendría que hacer fallar un `require('pg')` que ya está cargado.
  - [reglas.js:92](../frontend/public/reglas.js:92): `fechaRel` con 30 días o más. Cae en `toLocaleDateString('es-AR')`, que depende del locale del runner, y el test sería flaky en CI.

### 7. "Tu coverage es del 32 %. ¿Prueba que funciona?" ⚠️
Mi coverage **no es 32 %**: es 99,58 % de líneas y 85,38 % de ramas en el backend. Pero la respuesta es la misma: **no prueba nada por sí solo**.
Coverage mide qué código **se ejecutó**, no qué se **verificó**. Un test que llama a `programar()` y hace `assert(typeof r.intervalo === 'number')` suma 100 % de líneas y no detecta que se borró el recorte. Lo que protege es el assert `intervalo === 2 && recortado === true` del test del tope.
Coverage bajo dice "acá seguro no hay tests". Coverage alto no dice "acá está bien".

### 8. Tu PR compilaba y pasaba los tests. ¿Por qué no se podía mergear?
📂 PR #18 "prioridadDeRepaso sin tests (freno abierto)", que sigue **abierto** a propósito. `build-backend` = FAILURE.
Los tests pasan, pero agregué una función sin tests y la cobertura de líneas quedó debajo de 96. `node --test` sale con código ≠ 0 → el step falla → el job `build-backend` (check requerido por la protección de `main`) queda rojo → el merge queda **bloqueado**.
La secuencia completa (rojo → agrego tests → verde → merge) está en el PR #17.

### 9. ¿Si mañana subís el umbral 10 puntos?
- Líneas 96 → **106**: imposible, ninguna suite llega. Siempre rojo.
- Ramas 80 → **90**: hoy tengo 85,38 %, así que **rojo**. Y nadie cambió una línea de código: el pipeline frenaría todos los PRs.
- Front 90/75 → 100/85: rojo por las líneas de `fechaRel` que dejé afuera.

El umbral es un freno contra **bajar** la cobertura, no una meta. Si lo ponés arriba de lo que medís, la gente escribe tests vacíos para llegar al número.

### 10. ¿Qué dejaste fuera de la cuenta y por qué?
- **`server.js` entero:** es HTTP, el vault y el proceso que escucha. Importarlo hace `listen`. Las reglas las saqué a `dominio.js`. Lo filtro con `--test-coverage-include`.
- **`index.html` y `vendor/`:** DOM y librerías de terceros. Lo testeable del cliente está en `reglas.js` (`coverage.include`).
- **Dos ramas puntuales** (ver la 6).

### 11. ¿Cómo se entera el CI de que un test falló?
Por el **código de salida** del proceso. 📂 [ci.yml:31-46](../.github/workflows/ci.yml:31)
- `node --test` y `vitest` salen con ≠ 0 si falla un test **o** si no se llega al umbral.
- Ojo con el detalle: hago `npm test | tee archivo`, y en un pipe el código que queda es el de `tee` (siempre 0). Por eso guardo `status=${PIPESTATUS[0]}` y termino con `exit "$status"`.
- Step ≠ 0 → el runner marca el step como failed → los steps siguientes no corren (default `if: success()`) → el job queda rojo → el check requerido bloquea el merge.
- Además el Dockerfile tiene una etapa `test` con `RUN npm test` ([backend/Dockerfile:22](../backend/Dockerfile:22)). Si falla, no hay imagen.

### 12. Pirámide de testing en tu repo
Muchos tests rápidos abajo, pocos lentos arriba:
- **Unitarios** (53 back + 17 front, en milisegundos, sin red): `node:test` y `vitest`. Corren en cada PR.
- **Integración** (3, [api.spec.js](../frontend/e2e/api.spec.js)): HTTP real contra la API y el Postgres de QA.
- **e2e** (3, [calendario.spec.js](../frontend/e2e/calendario.spec.js)): Chromium manejando el calendario.

Los de arriba son lentos y frágiles, por eso hay pocos y cubren solo el flujo que más uso.

---

## TP6 — CD

### 13. ¿CI vs Continuous Delivery vs Continuous Deployment?
- **CI:** integrar seguido a `main` y verificar cada cambio (build + tests) automáticamente.
- **Continuous Delivery:** cada cambio verde queda **listo** para producción. Una persona decide cuándo sale.
- **Continuous Deployment:** sale a producción solo, sin humano.
- **Hice Delivery:** QA se despliega solo y PROD espera un reviewer (environment `production` con `required_reviewers`). Para una app con mis notas de cursada no quiero que PROD cambie sin mirar. Y no tengo canary ni métricas que justifiquen promover solo.

### 14. ¿Por qué QA solo y PROD no? ¿Qué compra la aprobación?
QA existe para romperse: es donde corren integración y e2e. PROD es lo que se usa y lo que defiendo. La aprobación compra **una mirada humana con evidencia** (QA verde, smoke, e2e) antes de pisar el entorno real, y un registro de quién aprobó y cuándo (queda en Deployments).

### 15. ¿Qué mirás antes de aprobar?
1. `build-backend` y `build-frontend` verdes, con cobertura.
2. El smoke de QA: `/api/vivo` con `ok`, `almacen.ok` y `modo == postgres`, más el front en 3000.
3. Integración y e2e verdes.
4. Que el `IMAGE_TAG` del log sea `sha-<commit de esa corrida>`.
5. Que PROD esté *waiting*, no arrancado solo.

### 16. ¿Por qué rechazaste lo que rechazaste?
- **Corrida 39275588120 (TP6):** QA respondía `almacen.ok` y `modo postgres`, pero **no tenía evidencia de que `db_data_prod` fuera otra base** que la de QA. Sin eso, aprobar podía hacer que PROD escribiera en la base de QA.
- **Corrida 39289130490 (TP7):** QA, integración y e2e en verde, pero **todavía no había mostrado el freno rojo** de la e2e. Rechacé para que la siguiente corrida demostrara que una e2e roja frena PROD (PR #25) antes de promover.

### 17. ¿Por qué los secrets de PROD en el environment y no en el repo?
- **Alcance:** un secret del environment solo lo lee un job que declara `environment: production`, y ese job **solo arranca después de la aprobación**. Un secret del repo lo lee cualquier job, incluso uno de un PR.
- Así **QA y PROD tienen claves distintas** con el mismo nombre (`DB_PASSWORD`).
- `SENTRY_DSN` solo existe en `production`, por eso QA no reporta a Sentry.
- Hoy: `qa` tiene `DB_PASSWORD`; `production` tiene `DB_PASSWORD` y `SENTRY_DSN`; el repo no tiene ninguno.

### 18. ¿Cómo probás que lo publicado es lo que pasó la verificación?
- La imagen se etiqueta `sha-${{ github.sha }}` en el **mismo job** que corrió los tests, y solo se publica si los tests pasaron.
- La etapa de tests está **dentro** del Dockerfile: `COPY --from=test` ([backend/Dockerfile:46](../backend/Dockerfile:46)). Sin tests no hay imagen.
- QA y PROD hacen `pull` de **ese** tag, sin `--build`. `${IMAGE_TAG:?falta IMAGE_TAG}` hace que Compose se niegue si falta.
- Límite: un tag es mutable (un `docker push` a mano lo pisaría). La prueba fuerte es el **digest** (`sha256:…`). Lo puedo comparar con `docker inspect` y `docker buildx imagetools inspect`.

### 19. ¿Por qué se publica solo en verde? ¿Dónde está en el YAML?
Porque si publicara con rojo, `sha-X` dejaría de significar "este commit pasó". 📂 [ci.yml:66-76](../.github/workflows/ci.yml:66)
1. "Construir y publicar" es el **último step**, después de los tests. Si falla un step anterior, no corre.
2. `push: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}`: en un PR construye pero no publica.
3. "Entrar al registry" tiene `if: github.event_name == 'push'`: en un PR ni siquiera se loguea.
4. A `main` no entra nada sin los checks verdes (protección de rama).

### 20. PROD roto después de un deploy aprobado. ¿Qué hacés y cuánto tarda?
Rollback **a la imagen anterior**, no un fix apurado:
- **Opción pipeline:** en Actions abro la última corrida buena de `main` y hago *Re-run* de `deploy-prod`. Usa el `github.sha` de **esa** corrida, entonces `IMAGE_TAG` es el anterior. Pide aprobación otra vez.
- **Opción manual en el runner:**
  ```bash
  IMAGE_TAG=sha-<commit anterior> DB_PASSWORD=… docker compose -f compose.prod.yml up -d --wait
  ```
- Tiempo: la imagen vieja ya está en el host, así que no hay pull. Es recrear el contenedor + healthcheck (`start_period: 40s`). **Menos de un minuto**, aunque conviene medirlo y decir el número real.
- **Lo que no deshace:** los datos. `db_data_prod` sobrevive. Si la versión mala escribió algo en la base, el rollback de imagen no lo vuelve atrás. Para eso hace falta backup o migraciones reversibles.

### 21. ¿Deploy ≠ release? ¿Qué patrón usarías?
- **Deploy** = el código nuevo está corriendo. **Release** = los usuarios lo ven. Con feature flags podés deployar apagado y liberar después.
- **Blue-green:** dos entornos completos y movés el tráfico de golpe. Rollback instantáneo, pero duplica todo (front, back, base).
- **Canary:** un % del tráfico va a la versión nueva y mirás el error rate. Necesita balanceador y métricas.
- **Flags:** separan deploy de release dentro del código.
- **Para esta app:** rolling de una réplica + rollback por tag. Un solo usuario y sin balanceador: canary sería un deploy con nombre lindo. En una app con usuarios reales usaría **canary + flags**, y miraría el error rate en Sentry.

### 22. Cadena `needs` / `if` / `environment`
📂 [ci.yml:149-295](../.github/workflows/ci.yml:149)
```
build-backend ─┐
               ├─▶ deploy-qa ─▶ integracion ─▶ e2e ─▶ deploy-prod
build-frontend ┘   (env: qa)                         (env: production + reviewer)
```
- `needs`: el job espera a los anteriores **y solo corre si terminaron en verde**. Si falla cualquiera, todo lo de abajo sale *skipped*.
- `if: github.event_name == 'push' && github.ref == 'refs/heads/main'`: en un PR solo corren los dos builds.
- `environment`: le da al job los secrets de ese entorno, la URL en Deployments y las reglas de protección (reviewer en PROD).
- No hay `continue-on-error` ni `if: always()` en la cadena, a propósito.

---

## TP7 — Contenedores, integración, e2e

### 23. ¿Cuántas imágenes construís? ¿Las mismas en QA y PROD?
**Dos**: `facultad-hub-backend` y `facultad-hub-frontend`. Postgres es la oficial (`postgres:16-alpine`). **Sí, las mismas:** las dos llevan el tag `sha-<commit>` y QA y PROD hacen pull de ese tag. No hay un tag por entorno.

### 24. Dockerfile multi-stage
📂 [backend/Dockerfile](../backend/Dockerfile)
- **`test`** (`node:22-alpine`): `npm ci` + `npm test` con el umbral. Si no llega, el build se corta.
- **`deps`:** copia solo `package.json` e instala `--omit=dev`. Copio primero el manifiesto para que la capa se cachee mientras no cambien las dependencias.
- **`runtime`:** copia `node_modules` de `deps`, `dominio.js` **de la etapa `test`** (si esa etapa no corrió, no hay imagen) y el código. `NODE_ENV=production`, `HOST=0.0.0.0`, healthcheck a `/api/vivo`, y un entrypoint que hace `chown` del volumen y baja a usuario `node`.
- Resultado: 230 MB contra 1,63 GB de `node:22`. Sin npm cache ni toolchain en la imagen final, hay menos superficie de ataque.

Frontend ([frontend/Dockerfile](../frontend/Dockerfile)): `test` (vitest) → `build` (verifica que estén `index.html`, `reglas.js` y `vendor/`) → **`nginx:1.27-alpine`** con los estáticos. Pesa 84 MB.

### 25. ¿Cómo le dice el pipeline a Render qué imagen correr? ⚠️
**No uso Render: usé el plan C de la cátedra** (self-hosted runner en mi Mac + Compose).
El pipeline le pasa la imagen por la variable `IMAGE_TAG: sha-${{ github.sha }}` en el step, y el compose la usa en `image: ghcr.io/agustindt/facultad-hub-backend:${IMAGE_TAG:?falta IMAGE_TAG}`. Después hace `docker compose pull` + `up -d --wait`.
(En Render sería un *deploy hook* o la API con la URL de la imagen + el tag.)

### 26. ¿Cómo la misma imagen sirve para QA y PROD? ¿Dónde cambia la URL del backend?
La URL **no está en la imagen**. 📂 [nginx.conf](../frontend/nginx.conf)
- nginx copia la config como **plantilla** (`/etc/nginx/templates/default.conf.template`). Al **arrancar**, el entrypoint de nginx reemplaza `${BACKEND_URL}` con la variable de entorno del contenedor.
- En los dos compose vale `http://backend:4177`, pero cada proyecto (`name: qa` / `name: prod`) tiene **su propia red**, así que `backend` resuelve al backend de ese entorno.
- `resolver 127.0.0.11` + `proxy_pass` con variable: resuelve el nombre en cada pedido. Así se arregló el 502 del TP2.
- Lo que cambia entre entornos son los puertos del host (3000/8080 vs 3001/8081), los volúmenes y los secrets.

### 27. ¿Cómo sabe tu app que está en QA y no en PROD?
**La app no lo decide: se lo dice la configuración de afuera** (las variables de entorno).
- Backend: `SENTRY_ENVIRONMENT=production` y `SENTRY_DSN` solo vienen en `compose.prod.yml`. QA no tiene DSN y no reporta.
- `DATABASE_URL` apunta a la base de su propio proyecto.
- Front: Sentry pone `environment` según el puerto (`3001` → production, `3000` → qa) ([index.html:10](../frontend/public/index.html:10)).
- La imagen es idéntica en los dos entornos.

### 28. ¿Cómo llegan las variables de entorno al backend?
Secret del environment de GitHub → `env:` del job (`DB_PASSWORD: ${{ secrets.DB_PASSWORD }}`) → Compose interpola `${DB_PASSWORD}` en el YAML → `environment:` del servicio (`DATABASE_URL: postgres://hub:${DB_PASSWORD}@db:5432/hub`) → `process.env` en Node.
`IMAGE_TAG` sigue el mismo camino desde el `env:` del step. En el Dockerfile van las que no cambian (`NODE_ENV`, `HOST`, `PORT`).

### 29. ¿La imagen con la que configuraste Render es la que corre ahora en QA? ⚠️
No hay Render. Cada deploy de QA hace `pull` del tag de **esa** corrida, así que la imagen cambia en cada push a `main`. Para saberlo, ver la 30.

### 30. ¿Cómo identificás qué imagen corre en QA y PROD?
```bash
docker compose -f compose.qa.yml images
```
```bash
docker ps --format '{{.Names}}\t{{.Image}}'
```
```bash
docker inspect prod-backend-1 --format '{{.Config.Image}} {{.Image}}'
```
El primer valor es el tag (`sha-…`) y el segundo el **digest** de la imagen local. También está en el log del job (`IMAGE_TAG=sha-…`), en la pestaña Deployments de GitHub y, en PROD, en Sentry como `release` (`SENTRY_RELEASE: ${IMAGE_TAG}`).

### 31. ¿Tag vs digest? ¿`sha-` vs `v7.0.0`? ¿Por qué no `latest`?
- **Tag:** un nombre que apunta a una imagen y **se puede mover**. **Digest** (`sha256:…`): el hash del contenido, inmutable. Mismo digest = mismos bytes.
- **`sha-<commit>`:** ata la imagen al commit exacto. Lo genera el pipeline y no lo elijo yo. **`v7.0.0`:** semver para humanos, se pone en una release. Lo usé en el TP2 (`v0.1.0` en `docker-compose.registry.yml`).
- **`latest`:** no dice qué versión es, cambia con cada push, y dos `pull` en momentos distintos traen cosas distintas. No podría saber qué corre en PROD ni volver atrás.

### 32. ¿Quién puede escribir en tu registry y con qué credencial?
- **El pipeline:** `GITHUB_TOKEN` efímero (dura lo que el job), con `permissions: packages: write` declarado **solo en los jobs de build**. Solo hace login en `push` a `main`. El repo tiene rol **Write** en *Manage Actions access* de cada package (sin eso daba `write_package` denied, porque los packages los había creado con un PAT en el TP2).
- **Yo:** con un PAT **classic** con `write:packages` (los fine-grained no sirven para ghcr).
- **Leer:** cualquiera, porque los packages son públicos (pull anónimo probado en el TP2).

### 33. ¿Qué es el smoke test, dónde está, qué hace, cuándo corre?
📂 [ci.yml:173-190](../.github/workflows/ci.yml:173) (QA) y [ci.yml:309-326](../.github/workflows/ci.yml:309) (PROD).
Es una prueba mínima de "¿arrancó?", **no** de funcionalidad. Corre **justo después** del `up -d --wait` en `deploy-qa` y en `deploy-prod`. Hasta 30 intentos cada 10 s:
1. `curl /api/vivo` → `ok`, `almacen.ok` y `almacen.modo == "postgres"` (la API está viva **y** habla con Postgres, no cayó a archivos).
2. `curl` al front `/` → nginx sirve el index.

Si en 5 min no responde, `exit 1` y el job falla.

### 34. ¿Cómo sabe el smoke si es QA o PROD?
No lo "sabe": **cada job le pasa sus URLs** por `env:`. `deploy-qa` usa `URL_API=localhost:8080` y `URL_FRONT=localhost:3000`; `deploy-prod` usa `8081` y `3001`. Es el mismo script con otra configuración.

### 35. ¿Cómo detecta el smoke que corre la imagen nueva y no un 200 de la vieja? ⚠️
**Honestamente, el smoke solo no lo detecta.** `/api/vivo` devuelve `version: 3` fijo y no compara el tag. Lo que sí lo garantiza es el resto de la cadena:
- El compose **solo puede** referenciar `sha-${{ github.sha }}`. Si ese tag no existe, `pull` falla.
- `up -d` **recrea** el contenedor cuando cambió la imagen, y `--wait` falla si el nuevo no llega a healthy.
- La e2e sí lo demostró: en el PR #25 cambié el texto del botón y la e2e se puso roja. Eso es la imagen nueva corriendo.

**Mejora:** exponer `IMAGE_TAG` en `/api/vivo` y que el smoke compare `d["imagen"] == "sha-$GITHUB_SHA"`.

### 36. ¿Unitario vs integración vs e2e?
| | Contra qué | Velocidad | Cuándo |
|---|---|---|---|
| Unitario | Una función, con dobles. Sin red ni base | ms | En cada PR, antes del build |
| Integración | La **API real de QA** por HTTP, con Postgres y vault reales, sin navegador | segundos | Después de deploy-qa |
| e2e | El **front de QA** en Chromium, como un usuario (front → nginx → API → base) | decenas de s | Después de la integración, antes de PROD |

Unitario para la lógica. Integración para el contrato HTTP y la persistencia. e2e para el flujo crítico (el calendario).

### 37. Mostrame un test de integración. ¿Dónde corre?
📂 [api.spec.js](../frontend/e2e/api.spec.js), test `el alta de un evento queda en la base, y el borrado lo saca`: hace `POST /api/eventos`, verifica que aparece en `GET /api/estado`, lo borra y verifica que ya no está. Usa un título único (`Date.now()`) y limpia lo que creó.
Corre en el job `integracion`, en el **self-hosted runner** (mi Mac), contra `API_BASE_URL=http://localhost:8080`, que es la API de **QA**.

### 38. ¿Por qué estaría mal correr la integración antes del build y el deploy?
Porque probaría **la versión vieja** que está en QA, no el commit nuevo. Daría verde (o rojo) por código que no es el que voy a promover. La integración tiene sentido contra el artefacto ya construido y desplegado: es lo que prueba que **esa imagen** funciona con **esa base**. Por eso `integracion` tiene `needs: deploy-qa`.

### 39. Integración verde y e2e roja: ¿qué te dice sin leer el código?
Que la **API y la base andan**: el contrato HTTP y la persistencia están bien. El problema está **arriba**: en el front (HTML/JS, un selector, un texto), en nginx (proxy, plantilla) o en la interacción del navegador. Fue exactamente lo del PR #25.

### 40. ¿Cómo rompiste la app para ver la e2e roja?
PR #25: el botón del calendario dejó de decir **"Agregar"**. Corrida 39448719101: QA hizo pull de `sha-6fc87b9…`, la **integración quedó verde** (la API no cambió) y la e2e esperó `getByRole('button', { name: 'Agregar' })`. Los 3 casos vencieron a los 30 s y **`deploy-prod` salió skipped**. El PR #26 lo volvió atrás. Corrida 39450167435: verde, y aprobé PROD de `5809fa9`.

### 41. ¿Test flaky? ¿Qué hace tu config? ¿Cold start?
**Flaky:** pasa o falla sin que cambie el código (timing, orden, datos compartidos, red).
📂 [playwright.config.js](../frontend/playwright.config.js)
- `workers: 1` y `fullyParallel: false`: los tests no se pisan sobre la misma base.
- `retries: 0`: **a propósito**. Un retry tapa la flakiness en vez de mostrarla.
- `forbidOnly` en CI, para que un `.only` olvidado no saltee tests.
- Datos únicos (`Date.now()`) y cada test **borra lo que creó**.
- Assertions de Playwright (`toBeVisible`, `toHaveCount`) que **esperan** solas, sin `sleep` fijo.
- `trace` y `screenshot` cuando falla, para diagnosticar.

**Cold start:** el contenedor tarda en estar listo. Lo cubren los healthchecks con `start_period: 40s`, el `up --wait` (no sigue hasta que esté healthy) y el smoke con 30 reintentos. Las pruebas arrancan cuando QA ya respondió.

### 42. ¿Qué es `github.sha` y por qué es tan importante?
El hash del commit que disparó la corrida. Es **el hilo que une todo**: el tag de la imagen (`sha-…`), lo que despliega QA, lo que se aprueba en PROD y el `release` en Sentry. Gracias a eso puedo responder "¿qué código corre en PROD?" con un commit exacto, y hacer rollback re-ejecutando una corrida vieja.

### 43. ¿De dónde salen `secrets.GITHUB_TOKEN` y `secrets.ADMIN_PASSWORD`? ⚠️
- **`GITHUB_TOKEN`:** lo **crea GitHub automáticamente en cada job**. No lo cargué yo, vence al terminar el job y sus permisos se acotan con `permissions:`.
- **`ADMIN_PASSWORD` no existe en mi repo.** Mis secrets son **`DB_PASSWORD`** (environments `qa` y `production`, cada uno el suyo) y **`SENTRY_DSN`** (solo `production`). Los cargué a mano en Settings → Environments.

---

## TP8 — Terraform

### 44. ¿IaC? ¿Declarativo vs imperativo?
**IaC:** la infraestructura se describe en archivos versionados, revisables y repetibles, en vez de clicks.
- **Imperativo:** los pasos ("creá la red, después el volumen, después…"). Es un script de `docker run`.
- **Declarativo:** el **estado deseado** ("tiene que existir esta red, este contenedor con estas variables"). Terraform calcula la diferencia con lo que hay y decide los pasos y el orden. Si ya está, no hace nada.

### 45. Explicame `main.tf`
📂 [infra/main.tf](../infra/main.tf)
- `terraform {}`: versión de Terraform (`>= 1.5, < 2.0`), provider `kreuzwerker/docker ~> 4.0` y `backend "local"` con el path del estado pasado en el `init`.
- `provider "docker"`: `host = var.docker_host`, que apunta al socket de Colima.
- **Red** `facultad-hub-preprod`, **3 volúmenes** (base, vault, datos) y **3 imágenes** (postgres y las mías con `var.image_tag`, `platform = linux/amd64`).
- **3 contenedores:** `db` (con healthcheck `pg_isready`), `api` (`DATABASE_URL` armada con `docker_container.db.name`, puerto 8090) y `front` (`BACKEND_URL` con `docker_container.api.name`, puerto 3010).
- `variables.tf`: `db_password` es `sensitive`, y `image_tag` tiene una `validation` que exige `sha-` + 40 hex.

### 46. Corré un plan. ¿Qué dice?
Hoy preprod está **destruido** (el estado tiene 0 recursos), así que dice **`Plan: 10 to add, 0 to change, 0 to destroy`**: 1 red, 3 volúmenes, 3 imágenes y 3 contenedores.
```bash
colima start
```
```bash
cd infra && terraform init -backend-config="path=$HOME/tfstate/facultad-hub.tfstate"
```
```bash
terraform plan -var-file=local.tfvars -var image_tag=sha-5809fa9eed504bf377306dafef0aaab9184f858c
```
`+` = crear, `~` = cambiar en el lugar, `-/+` = reemplazar, `-` = destruir. "(known after apply)" son valores que da el provider al crear, como los IDs.

### 47. ¿Si aplicás dos veces seguidas?
La segunda vez: **"No changes. Your infrastructure matches the configuration."** Es **idempotente**: Terraform compara el código, el estado y lo real, y si coinciden no toca nada. Lo verifiqué en el TP8.

### 48. ¿Dónde vive el estado, qué tiene y por qué no está en el repo?
- En **`$HOME/tfstate/facultad-hub.tfstate`**, fuera del repo, con backend `local`.
- Tiene el mapa recurso de Terraform ↔ objeto real (IDs de contenedores, imágenes, red) y **todos los atributos**, incluida la variable de entorno con la **clave de la base en texto plano**. `sensitive` solo la oculta en la salida de la consola.
- No va al repo porque tiene secretos. Además, `actions/checkout` hace `git clean -ffdx` y borraría un estado ignorado dentro del workspace. En equipo iría a un **backend remoto con lock** (S3 + DynamoDB, Terraform Cloud).

### 49. ¿De dónde sale la cadena de conexión de la API? ¿Y el backend del front?
- `DATABASE_URL = "postgres://hub:${var.db_password}@${docker_container.db.name}:5432/hub"`: el host es el **nombre del contenedor de la base** y la clave viene de `local.tfvars` (ignorado).
- `BACKEND_URL = "http://${docker_container.api.name}:4177"`.

Ninguna está copiada de QA: son **referencias** a otros recursos. Por eso Terraform también sabe el orden (dependencias implícitas).

### 50. ¿Qué se destruye primero y quién decide el orden?
**Terraform**, a partir del **grafo de dependencias** (referencias + `depends_on`). Destruye en el **orden inverso** al de creación:
`front` (depende de api) → `api` (depende de db, imagen, volúmenes, red) → `db` → imágenes, volúmenes y red.
Yo no escribí el orden: lo dedujo de que `front` referencia a `api.name` y `api` referencia a `db.name`.

### 51. ¿Qué es el drift? ¿Qué pasó en tus experimentos?
**Drift:** la infraestructura real cambió por fuera de Terraform y ya no coincide con el estado.
- Borré `facultad-hub-preprod-api` a mano → el siguiente `plan` dijo **`1 to add`** → `apply` lo recreó.
- Con `prevent_destroy` en el volumen de la base, `plan -destroy` **se negó** y nombró el recurso. Lo saqué porque preprod tiene que poder morir.
- `destroy` bajó los 10 recursos y QA/PROD siguieron vivos. Un `apply` los rehízo con la base vacía (el volumen se había ido).

### 52. ¿Qué versión de cada provider y por qué?
- `kreuzwerker/docker` con restricción **`~> 4.0`** (≥ 4.0 y < 5.0, o sea minors sí, majors no) y **fijado en 4.6.0** con hashes en `.terraform.lock.hcl`, que **sí** está versionado.
- Terraform `>= 1.5, < 2.0` (usé 1.16.6).
- Por qué: reproducibilidad. Otro `init` en otra máquina baja exactamente la misma versión, y un major del provider que cambie el schema no me rompe sin avisar. Para actualizar se usa `terraform init -upgrade` y el cambio queda en el lock, revisable en un PR.

### 53. ¿Por qué un entorno nuevo (preprod) y qué sigue siendo artesanal?
Preprod demuestra que un entorno **nace y muere con un comando** sin tocar QA/PROD (otra red, otros volúmenes, otros puertos: 8090/3010). Si lo hubiera hecho sobre QA, un error de Terraform me rompía el pipeline.
**Artesanal todavía:**
- QA y PROD (los compose, que los maneja el pipeline pero no Terraform).
- Los environments de GitHub, sus reviewers y secrets.
- La protección de `main`.
- El self-hosted runner.
- La visibilidad y *Actions access* de los packages de ghcr.
- Los proyectos de Sentry.
- Colima y `local.tfvars`.

---

## TP9 — DevSecOps y observabilidad

### 54. ¿Shift-left?
Mover los controles (seguridad, calidad) **a la izquierda del ciclo**: al PR o al commit, no a producción. Un problema encontrado en el PR cuesta un comentario; en PROD cuesta un incidente. En mi repo: CodeQL y los tests corren en cada PR, Dependabot abre PRs, y push protection frena un secreto **antes** de que entre al historial.

### 55. ¿Dependabot vs CodeQL vs secret scanning?
| | Qué evalúa | Contra qué |
|---|---|---|
| **Dependabot** | El código **de terceros** (dependencias del lockfile y versiones de actions) | Base de vulnerabilidades conocidas (GitHub Advisory DB). Además abre PRs de actualización ([dependabot.yml](../.github/dependabot.yml): `/backend`, `/frontend` y actions, semanal) |
| **CodeQL** | **Mi** código | Análisis estático: sigue el flujo de datos desde una entrada del usuario (*source*) hasta algo peligroso (*sink*) |
| **Secret scanning** | El historial de git y los pushes | Patrones de credenciales conocidas (tokens de GitHub, AWS, etc.). Push protection bloquea el push |

### 56. ¿Qué lee CodeQL? ¿Qué encontró y cómo lo arreglaste? ⚠️
CodeQL convierte el código en una **base de datos** (AST + flujo de datos) y le corre queries. Lo tengo en *default setup* para **JavaScript y Actions**.
Encontró **2 alertas, y las dos siguen ABIERTAS**:
1. **`js/reflected-xss` (error), [server.js:3440](../backend/server.js:3440):** en `/api/drive/callback`, `q.error` viene de la **query string** y se mete sin escapar en el HTML que devuelve el server: `<p>Google devolvió: ${String(q.error)}</p>`. Un link `…/callback?error=<script>…</script>` ejecutaría JS en mi origen.
   **Fix:** escapar `& < > " '` antes de interpolar, o no reflejar el valor.
2. **`js/incomplete-sanitization` (warning), [server.js:2673](../backend/server.js:2673):** escapa `'` pero **no** `\`. Con un `\` al final se rompe el escape de la query de Drive. Dos líneas arriba ([server.js:2669](../backend/server.js:2669)) está bien hecho con `/['\\]/g`.
   **Fix:** usar el mismo regex.

→ **Hay que arreglarlas antes de la defensa.** Después del PR, CodeQL las marca *Fixed* solo.

### 57. ¿Qué actualizaba tu PR de Dependabot y por qué lo mergeaste?
PR #34: **`actions/checkout` de la 6 a la 7**. Es un major. Leí qué cambia: en `pull_request_target` y `workflow_run`, checkout deja de bajar código de forks. Mi workflow **no usa esos eventos**, y el pipeline del PR estaba **verde** (tests, umbral, las dos imágenes). Eso me dio confianza: los tests verifican el cambio, no mi intuición.
**No mergeé** los que suben vitest a la 5: dejan rojo `build-frontend`.
Si preguntan por las alertas abiertas (2 críticas de `tinypool`, medias de `vitest`): son **devDependencies** que solo existen en la etapa `test` del Dockerfile. La imagen final es nginx con estáticos y no las lleva. El riesgo está en el runner de CI, no en PROD. Igual está pendiente.

### 58. ¿Qué secreto NO detectaría el escáner?
Cualquiera **sin un patrón reconocible**: una contraseña genérica como mi `DB_PASSWORD` (no tiene prefijo como `ghp_` o `AKIA`). También:
- Secretos **fuera del repo**: el `.tfstate` (tiene la clave en plano), `local.tfvars`, `.env`.
- Secretos dentro de **capas de una imagen** o en logs.
- Secretos ofuscados o partidos (base64, concatenados).

El escáner busca formatos de proveedores conocidos, no "cosas que parecen claves".

### 59. ¿Cómo provocaste la caída y cuánto tardó el aviso? ⚠️
**No está hecho.** PROD es `localhost:8081` y un monitor externo (UptimeRobot) no llega sin un túnel. No tengo el par DOWN/UP.
Para hacerlo antes de la defensa:
1. Exponer PROD temporalmente (por ejemplo `cloudflared tunnel --url http://localhost:8081`).
2. Monitor HTTP a `/api/vivo` cada 5 min (mínimo del plan gratis).
3. Tirar el backend:
   ```bash
   docker stop prod-backend-1
   ```
4. Anotar la hora → hora del mail DOWN.
5. Levantarlo:
   ```bash
   docker start prod-backend-1
   ```
6. Anotar el UP, pausar el monitor y cerrar el túnel.

Lo esperable es **hasta ~5 min** (el intervalo + la confirmación). Si no se llega, decirlo así, honesto.

### 60. El monitor dice que está viva. ¿Qué te dice Sentry que el monitor no?
El monitor responde **"¿contesta `/api/vivo` con 200?"**, de afuera y de forma binaria. Sentry dice **qué falla adentro mientras la app "está viva"**:
- La excepción con stack trace.
- La ruta (`GET /api/falla` dio 500 mientras `/api/vivo` daba 200).
- El `release` (qué imagen) y el entorno.
- Cuántas veces y desde cuándo.
- Errores **del navegador** (el `ReferenceError` del front, que el server nunca ve).
- Latencias por ruta (p95).

### 61. ¿Cómo subiste Sentry al back y al front? ¿Por qué el DSN público no es problema?
- **Back:** [instrument.js](../backend/instrument.js) es lo **primero** que requiere `server.js` (línea 12), antes de `http`, para que Sentry pueda instrumentarlo. Solo hace `init` si existe `SENTRY_DSN`, que viene del secret del environment `production` → compose → env. Así QA y los tests no mandan eventos. `environment: production` y `release: IMAGE_TAG`.
- **Front:** el **Loader Script** de Sentry en el `<head>` de [index.html](../frontend/public/index.html) con `sentryOnLoad`. El `environment` sale del puerto.
- **El DSN es público por diseño:** solo permite **enviar** eventos a ese proyecto (ingesta). No permite leer issues ni datos. Va igual en el JS de cualquier sitio. El peor caso es que alguien mande eventos basura, y eso se limita con *Allowed Domains* y rate limits en Sentry. Lo que **sí** es secreto es un auth token de la API de Sentry.

### 62. ¿Qué error viste en Sentry? Causa.
- **FACULTAD-HUB-1:** `Error: Falla de prueba del TP9` en `GET /api/falla`. Es un endpoint que **tira a propósito** ([server.js:3391](../backend/server.js:3391)) para verificar que el back reporta. La causa es el `throw` explícito, que el handler captura y responde 500.
- **FACULTAD-HUB-AF-1:** `ReferenceError: myUndefinedFunction is not defined` en `/`, desde el front. Llamé a una función que no existe para probar el SDK del navegador.

### 63. ¿Tu operación más lenta y qué harías con ese dato?
De las trazas `http.server` (24 h): **`GET /api/falla` con p95 de 506 ms**, porque el catch **espera `Sentry.flush`** antes de responder 500. De las rutas reales, la más usada es `GET /api/vivo` (1084 pedidos, p95 de 41 ms: el healthcheck y el smoke).
Con ese dato abrí la tarjeta **#39** en el tablero: *Sacar `/api/falla`*. El dato se convierte en trabajo planificado, no en un "lo miro después".
(`/status` y `/message` aparecen con miles de pedidos, pero no son rutas de la app: es algo de afuera pegándole al puerto, y Sentry igual cuenta la transacción.)

### 64. ¿Qué hace que una alerta sirva? ¿Blameless?
Una alerta sirve si es:
- **Accionable**: alguien tiene que hacer algo.
- Sobre un **síntoma que siente el usuario** (no anda, va lento), no sobre cada causa interna.
- Con **pocos falsos positivos**, porque si suena siempre se ignora.
- Dirigida a **un dueño**, y con contexto (qué, dónde, desde cuándo, link al runbook o al issue).
- Con umbral **y duración** (no por un solo pico).

**Blameless:** el postmortem busca **qué del sistema y del proceso** permitió el error, no **quién** se equivocó. Si culpás a la persona, la próxima vez esconde el error. Si arreglás el proceso (un test, un gate, una alerta), no se repite.
