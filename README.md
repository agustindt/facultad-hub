# facultad-hub

Un hub web sobre un vault de Obsidian. Lee y escribe **los mismos archivos `.md`**:
no hay copia, ni base de datos, ni sincronización que se pueda desincronizar.
Obsidian y el hub pueden estar abiertos al mismo tiempo sobre el mismo vault.

Servidor Node con **cero dependencias de npm** (solo stdlib: `http`, `fs`, `path`, `url`, `https`)
y un front-end de un solo archivo. Las librerías de terceros están vendorizadas en
`public/vendor/`, así que funciona sin internet.

```
node server.js          →  http://localhost:4177
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
server.js            ~1.200 líneas · stdlib de Node · escucha en 127.0.0.1
public/index.html    SPA de un solo archivo · sin build step
public/vendor/       marked 12.0.2 · d3 7.9.0 · mermaid 10.9.1 · katex 0.16.11 · pdf.js 4.2.67
datos/               NO versionado — clave de API, eventos propios, log de IA
```

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
