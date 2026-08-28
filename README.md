# facultad-hub

Un hub web sobre un vault de Obsidian. Lee y escribe **los mismos archivos `.md`**:
no hay copia, ni base de datos, ni sincronización que se pueda desincronizar.
Obsidian y el hub pueden estar abiertos al mismo tiempo sobre el mismo vault.

Servidor Node con **cero dependencias de npm** (solo stdlib: `http`, `fs`, `path`, `url`, `https`)
y un front-end de un solo archivo. Las librerías de terceros están vendorizadas en
`public/vendor/`, así que funciona sin internet.

```bash
# suelto, sin contenedores
node backend/server.js            →  http://localhost:4177

# con docker compose (TP2 de Ingeniería de Software III)
cp .env.example .env && docker compose up -d    →  http://localhost:8080
```

---

## Qué hace

| Vista | Qué muestra |
|---|---|
| **Hub** | Próximo hito con cuenta regresiva, estado de estudio por materia, salud del vault, repaso de hoy |
| **Repaso** | Repaso espaciado con tarjetas derivadas de las notas, planificado hacia atrás desde cada parcial |
| **Capturar** | Hoja en blanco para escribir en clase, con autosave y el frontmatter oculto |
| **Cobertura** | Los temas del programa de la cátedra contra las notas que existen |
| **Importar PDF** | Un PDF de cátedra entra; salen borradores de nota de unidad y de conceptos |
| **Código** | GitHub: novedades del repo de la cátedra, matriz de actividad, checklist de entregables, creación de repos |
| **Asistente** | Chat sobre el vault: corre el CLI de Claude Code como proceso hijo, en solo lectura |
| **Drive** | Bajar material de cátedra, publicar una unidad como HTML, backup del vault |
| **Notas** | Índice con búsqueda y filtros por materia, tipo y estado |
| **Editor** | Markdown con vista previa en vivo (Mermaid + LaTeX), barra de inserción y autocompletado de wikilinks |
| **Calendario** | Fechas extraídas de las tablas de `00-Seguimiento/` + eventos propios + export `.ics` |
| **Mapa** | Grafo de wikilinks en d3-force |
| **Gráficos** | Curvas de Economía generadas desde las funciones, interactivas |
| **Salud** | Validador de `Convenciones.md`: wikilinks rotos, stems duplicados, `estado` fuera de convención, conceptos huérfanos |
| **Administrar** | Alta, edición y baja de materias |
| **⌘K** | Búsqueda full-text sobre el contenido de todas las notas, insensible a tildes |

Documentación de usuario completa: [`LEEME.txt`](LEEME.txt).

---

## Arquitectura

```
backend/server.js         ~3.000 líneas · stdlib de Node
backend/db/almacen.js     Postgres si hay DATABASE_URL, archivos JSON si no
backend/test/             node --test, sin dependencias de test
backend/Dockerfile        multi-stage: deps → runtime alpine
frontend/public/          SPA de un solo archivo · sin build step
frontend/public/vendor/   marked · d3 · mermaid · katex · pdf.js
frontend/nginx.conf       estáticos + proxy /api + fallback SPA
frontend/Dockerfile       multi-stage: verificación → nginx alpine
docker-compose.yml        frontend + backend + postgres con healthcheck
datos/                    NO versionado — clave de API, token, secretos
```

## Arquitectura en contenedores

```
navegador → :8080 → [frontend nginx] ──/api/──→ [backend node:4177] ──→ [postgres]
                          │                            │                     │
                     public/ estático          bind mount del vault    volumen datos-db
```

Tres cosas persisten de forma distinta y a propósito:

| Qué | Dónde | Sobrevive a `down` | Sobrevive a `down -v` |
|---|---|---|---|
| Las notas `.md` | bind mount del host | Sí | Sí — están en tu disco |
| Repaso, eventos, log de IA | volumen `datos-db` | Sí | **No** |
| Clave de API y token | volumen `datos-hub` | Sí | No |

Las notas nunca entran a la base. Esa es la decisión que define el proyecto: la
fuente de verdad es el markdown, y Obsidian tiene que poder abrirlo.

El vault se resuelve así:

```js
const VAULT = path.resolve(process.env.VAULT_DIR || path.join(__dirname, '..', '..'));
```

Es decir: por defecto asume que el repo vive en `<vault>/00-Sistema/_hub/`.
Si está en otro lado, se define `VAULT_DIR`.

**No hay build.** No hay `package.json` con dependencias, no hay bundler, no hay
transpilación. `git clone` + `node server.js`.

### API

| Método | Ruta | |
|---|---|---|
| GET | `/api/estado` | índice completo: materias, notas, hitos, salud |
| GET/PUT/POST | `/api/nota` | leer, guardar, crear |
| GET | `/api/buscar?q=` | full-text con normalización de tildes |
| GET | `/api/grafo` | nodos y aristas de wikilinks |
| GET | `/api/salud` | validaciones de `Convenciones.md` |
| GET/POST/DELETE | `/api/eventos` | eventos propios (JSON aparte, no tocan el markdown) |
| GET | `/api/calendario.ics` | export iCal con avisos a 3 y 1 día |
| POST/PATCH/DELETE | `/api/materia` | alta, edición, baja |
| GET | `/api/materia-impacto` | wikilinks entrantes antes de dar de baja |
| GET/POST | `/api/config` | ajustes (la clave de API nunca vuelve entera) |
| GET | `/api/modelos` | modelos disponibles, consultados en vivo |
| POST | `/api/ordenar` | ordenar una nota con Claude |
| GET | `/api/plantilla` | plantillas de `00-Sistema/Plantillas/` |
| GET/POST/DELETE | `/api/repaso` | cola del día, calificar una tarjeta, reiniciar |
| GET | `/api/cobertura` | programa vs. vault, por unidad y por tema |
| POST | `/api/captura` | crea la nota de captura rápida |
| POST | `/api/ingerir` | texto de un PDF → propuesta de notas |
| GET | `/api/github/estado` | token, usuario, repos vinculados, rate limit |
| POST/DELETE | `/api/github/vinculo` | vincular un repo a una materia |
| GET | `/api/github/novedades` | commits nuevos desde el último visto, por repo |
| GET | `/api/github/actividad` | matriz de contribuciones (GraphQL) o commits de los repos |
| GET | `/api/github/entregables` | checklist del repo contra lo que pide la cátedra |
| POST | `/api/github/repo` | crear repo con el andamiaje de la materia |
| GET | `/api/github/declaracion-ia` | declaración de uso de IA desde el log real |
| GET | `/api/agente/estado` | ¿está el CLI instalado? versión y herramientas |
| POST | `/api/agente` | un turno del asistente, respuesta SSE en streaming |
| GET | `/api/drive/estado` | credenciales, conexión, cuenta, espacio |
| GET | `/api/drive/auth` · `/api/drive/callback` | flujo OAuth 2.0 con redirect al loopback |
| GET | `/api/drive/listar` | navegar carpetas o buscar, con migas de pan |
| POST | `/api/drive/bajar` | archivo de Drive → ruta del vault (exporta Docs a PDF) |
| POST | `/api/drive/backup` | tar.gz del vault → carpeta de backups |
| POST | `/api/drive/publicar` | materia o unidad → HTML de un archivo → Drive |
| GET | `/api/motor` | qué motor se va a usar: CLI (suscripción) o API (por token) |
| GET | `/api/git/estado` | rama, HEAD, archivos sucios |
| POST | `/api/git/init` | inicializa el repo del vault con su .gitignore |
| POST | `/api/git/checkpoint` | punto de restauración antes de escribir |
| POST | `/api/git/revertir` | `reset --hard` + `clean -fd` a un sha |
| GET | `/api/git/diff` | contenido antes/ahora de un archivo contra un sha |

---

## Convenciones del vault

El hub no impone un formato propio: implementa el que ya está escrito en
`00-Sistema/Convenciones.md` del vault.

- Frontmatter YAML: `tipo`, `materia`, `unidad`, `parcial`, `estado`, `tags`
- **Wikilinks siempre**, nunca rutas relativas
- **Sin stems duplicados entre materias** — Obsidian resuelve por nombre de archivo
- Diagramas en Mermaid, nunca ASCII art
- Paleta fija: `#7C5CFF` violeta · `#4DB6AC` verde · `#FFA726` naranja (siempre con `color:#fff`)
- Notas de concepto atómicas, con bloque `## Conexiones` de 3 a 6 enlaces

La vista **Salud** existe para mostrar dónde el vault se desvía de eso, no para
reescribirlo por su cuenta.

---

## Repaso espaciado

Las tarjetas no se guardan en ninguna base: se **derivan** de los bloques
`## En el parcial` que ya están escritos en las notas. El frente es la consigna;
el dorso, el resumen de la nota y su bloque `## Conexiones`. Lo único que persiste
es el calendario, en `datos/repaso.json` — ninguna nota se modifica.

El scheduler es SM-2 recortado. El recorte es la parte que importa:

```js
if (tope != null && iv > Math.max(1, tope)) { iv = Math.max(1, tope); recortado = true; }
```

`tope` son los días que faltan para el parcial de esa materia, sacados del
calendario que el hub ya deriva de `00-Seguimiento/`. Un intervalo nunca salta por
encima del examen: un repaso programado para después no sirve para nada.

Sobre eso, la planificación hacia atrás: cuántas tarjetas sin ver hay, cuántos días
quedan, y cuántas nuevas por día hacen falta para llegar con todo visto una vez.
Si el ritmo no alcanza, lo dice en lugar de dejarlo pasar.

## Cobertura

`Salud` valida sintaxis. `Cobertura` valida contenido: qué temas dice el programa
que entran y cuáles están escritos.

La fuente es `<Materia>/00-Seguimiento/programa-<sufijo>.md`, con una tabla de
`Unidad | Tema | Nota`. Sin ese archivo, la materia aparece como "sin programa" —
el hub no lo inventa.

El matching es por conjuntos de raíces, con **F1 y no recall**: si el título de la
nota trae palabras que el tema no tiene, el match vale menos. Cada fila muestra la
nota elegida y las otras candidatas, porque la heurística falla y conviene que se
vea. La columna `Nota` del archivo de programa es el override manual.

## Google Drive

OAuth 2.0 con redirect al loopback (`http://127.0.0.1:PORT/api/drive/callback`), sin
dependencias: `googleForm()` para el intercambio de tokens y `driveApi()` para la API. El
`refresh_token` va a `datos/config.json` y el access token se renueva solo; `conToken()`
reintenta una vez si venció en el medio.

**Los scopes son la decisión de diseño.** `drive.readonly` + `drive.file` en vez de `drive`
completo: el hub lee todo, pero sólo puede escribir los archivos que él mismo creó. Un bug o
una instrucción inyectada no pueden tocar nada preexistente.

La subida arma el `multipart/related` a mano — metadata JSON + bytes, con boundary propio —
porque no hace falta un SDK para eso.

`publicar` genera un HTML autocontenido: `marked` embebido (43 KB, sin él no renderiza nada) y
KaTeX/Mermaid desde CDN (4 MB juntos, opcionales, y algo que se comparte por link se abre con
internet). Los wikilinks a notas incluidas se convierten en anclas internas; los que apuntan
afuera quedan como texto punteado, no como enlaces rotos. `previsualizar: true` devuelve el
HTML sin tocar Drive.

## Asistente

El servidor lanza el CLI de Claude Code con `child_process.spawn` (stdlib — la propiedad de
cero dependencias se mantiene), parado en la raíz del vault, y hace proxy de su salida
`stream-json` al navegador por SSE.

```js
const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose',
              '--include-partial-messages', '--allowedTools', 'Read,Glob,Grep',
              '--append-system-prompt', sistema];
if (sesion) args.push('--resume', sesion);
return spawn('claude', args, { cwd: VAULT, env: entornoLimpio() });
```

### Dos modos

`propuesta` (por defecto) corre con `--allowedTools Read,Glob,Grep`. `directo` agrega
`Write,Edit,MultiEdit` y `--permission-mode acceptEdits`.

El modo directo **no existe sin git**. Antes de cada turno:

```js
const checkpoint = await gitCheckpoint('antes del asistente');
if (!checkpoint.repo) return json(res, { error: 'El modo directo necesita git…' }, 409);
```

y al cerrar el turno el servidor devuelve `gitCambiosDesde(checkpoint.sha)`, que el cliente
pinta como lista de archivos con su diff y un botón de deshacer (`reset --hard` + `clean -fd`).

El `.gitignore` del vault excluye `00-Sistema/_hub/` entero: el hub tiene su propio repo, y
versionarlo también en el vault hace que un "deshacer" sobre las notas revierta el código de
la app. Y cada subcarpeta vacía de materia lleva un `.gitkeep`, porque git no versiona
directorios vacíos y `clean -fd` se llevaría la estructura.

### Tres decisiones deliberadas

**Sin herramientas de escritura en modo propuesta.** Para cambiar un archivo el agente emite un bloque
` ```hub:escribir <ruta> ` con el contenido completo. El servidor lo extrae, lee la versión
actual del disco y manda las dos al cliente, que las muestra como diff. La escritura la hace
el hub por su `/api/nota`. En modo `-p` el CLI no puede pedir permiso interactivo, así que
ésta es la única forma real de tener confirmación — y cierra el vector de inyección por
contenido leído.

**`entornoLimpio()` borra `ANTHROPIC_API_KEY`.** Con esa variable presente, Claude Code
factura la API en vez de consumir la suscripción Pro/Max. El hub guarda una clave para otras
funciones; que se filtrara al hijo sería un cobro silencioso.

**Sin `--bare`.** El flag acelera el arranque pero no lee las credenciales de la suscripción
y no carga los `CLAUDE.md` — que es de donde sale la mitad del contexto útil de este vault.

## GitHub

Ingeniería de Software III no se cursa en el campus: el material vive en un repo de la
cátedra y la entrega es un repo propio. El módulo `Código` conecta las dos puntas.

**Novedades.** Guarda el SHA del último commit visto por repo en `datos/github.json` y
muestra sólo lo posterior. La primera vez no marca todo como novedad — sería ruido; muestra
los últimos y espera que marques visto.

**Actividad.** Con token usa la GraphQL de GitHub (`contributionsCollection`), que es el
calendario real. Sin token lo deriva de los commits de los repos vinculados y **lo declara
como tal en la UI**, porque no es lo mismo. Los cortes de color son cuartiles de los días con
actividad del propio usuario, no umbrales fijos.

La rampa es secuencial de un solo tono, validada con el validador de dataviz contra las dos
superficies reales del hub: L monótona, saltos ≥ 0.06 y el paso más claro despegando de la
superficie (2.00:1 en claro, 2.12:1 en oscuro). El nivel 0 es el gris de grilla, no un verde
desvaído. Hay vista de tabla para no depender del color.

**Entregables.** Verifica contra la API lo que la cátedra pide y se puede verificar solo:
archivos en la raíz, `.env` fuera del repo, tag semver, release, PR mergeado, `main`
protegido. Cada fila declara de qué TP sale la exigencia. No pretende reemplazar la defensa
oral, que es el 50 % de la nota.

**Declaración de uso de IA.** La cátedra la exige dentro de `decisiones.md`. Se genera desde
`datos/ia-log.json` — el registro real de cada llamada del hub — con números, no estimaciones.

**Escrituras.** Lo único que el hub escribe en GitHub es crear un repo, y sólo con el botón.
No commitea ni pushea por su cuenta. Los repos nacen privados por defecto.

`GITHUB_API_HOST` permite apuntar a otro host (GitHub Enterprise, o un mock para probar).

## Ordenar notas con Claude (opcional)

El botón *"✨ Ordenar con Claude"* manda el texto crudo junto con `Convenciones.md`
y la lista exacta de notas que existen, y devuelve la nota ordenada.

Tres cosas que hace a propósito:

1. **No pisa nada solo.** Muestra un diff línea por línea y hay que aceptar; aceptar
   tampoco guarda.
2. **Verifica del lado del servidor.** Cada wikilink de la propuesta se chequea contra
   el índice real de stems. Si el modelo inventó una nota, sale en rojo. No se confía
   en la salida del modelo.
3. **Deja registro.** Cada llamada queda en `datos/ia-log.json` con fecha, nota, modelo
   y tokens.

La ingesta de PDFs (`/api/ingerir`) sigue el mismo criterio, y agrega el chequeo de
colisión de stems entre materias — la regla que rompe el grafo de Obsidian. El PDF
se lee en el navegador con pdf.js y nunca se sube: al servidor sólo llega el texto.

Requiere una clave de API de Anthropic, que se carga desde Ajustes y se guarda en
`datos/config.json` con permisos `600`. Es la **única** salida a internet del hub.

---

## Privacidad

- El server escucha en `127.0.0.1`: no es visible desde la red local.
- `datos/` está en `.gitignore` — ahí viven la clave de API, los eventos propios y el
  log de uso de IA.
- **El vault no está en este repo y no debería estarlo.** Contiene notas, notas de
  cursada y seguimiento personal. Este repo es código, nada más.

---

## Configuración

```bash
cp .env.example .env     # referencia; el server lee variables de entorno directamente

VAULT_DIR=~/Documents/Facultad node server.js
PORT=4188 node server.js
```

---

## Nota sobre deploy

Esto es un servidor local que lee y escribe archivos `.md` de un disco. En un runtime
serverless (Vercel, Netlify Functions) no hay vault y el filesystem es de solo lectura
salvo `/tmp`, que además es efímero. Subirlo tal cual no va a funcionar: no es un
problema de configuración, es que falta la mitad del sistema, que son los archivos.

Para que corra hosteado hay que reemplazar la capa de I/O — leer y escribir el vault
contra una API en vez de contra `fs`. Está aislada: todo el acceso a disco pasa por
las funciones de índice y de lectura/escritura de nota en `server.js`.

---

## Estado

En uso. Node 18+.

<!-- TP4: PR de relleno para mostrar Update branch cuando main se mueve. -->
