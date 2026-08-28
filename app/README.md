# Facultad Hub — app de macOS

La app es una ventana nativa sobre el mismo hub de siempre: `main.js` lanza
`backend/server.js` como proceso hijo (el server de cero dependencias no cambió)
y abre una ventana con la sidebar translúcida y la barra de título integrada.

## Correr en desarrollo

```bash
cd app
npm install        # baja Electron (una sola vez)
npm start
```

La primera vez, si no encuentra el vault, lo pide con un diálogo. El orden de
resolución es: `VAULT_DIR` del entorno → vault elegido en la app → `.env` del
repo → la convención `<vault>/00-Sistema/_hub/`.

## Empaquetar (`Facultad Hub.app` + DMG)

```bash
cd app
npm run dist       # deja el .dmg en app/dist/
```

Sin firma (`identity: null`): para abrirla la primera vez, clic derecho → Abrir.

## Datos

- **Notas `.md`**: siempre en el vault, como hasta ahora.
- **Repaso, eventos, log de IA, secretos**: en desarrollo van a `datos/` del
  repo; empaquetada, a `~/Library/Application Support/facultad-hub-app/datos/`.
- **Postgres**: si hay `DATABASE_URL` (entorno, `.env` del repo o
  `config-app.json` de la app) se usa Postgres; si no, archivos JSON. Igual que
  el server suelto.

## Atajos

`⌘K` buscar · `⌘J` asistente · `⌘N` nueva nota · `⇧⌘N` capturar ·
`⌘1…⌘4` vistas · `⇧⌘T` tema (auto/claro/oscuro)
