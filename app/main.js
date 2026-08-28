/**
 * Facultad Hub — app de macOS.
 *
 * Electron acá es una ventana y nada más: el server sigue siendo el mismo
 * backend/server.js de cero dependencias, lanzado como proceso hijo con Node
 * (utilityProcess). La app no duplica lógica: levanta el server, espera a que
 * /api/vivo responda y abre la ventana apuntando a él.
 *
 * Almacén: igual que siempre — si hay DATABASE_URL (en el entorno, en el .env
 * del repo o en la config de la app) usa Postgres; si no, archivos JSON.
 */

'use strict';

const { app, BrowserWindow, Menu, Tray, dialog, shell, utilityProcess,
        globalShortcut, Notification, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');

// ---------------------------------------------------------------------------
// Rutas: en desarrollo el código vive en el repo; empaquetado, en Resources/.
// ---------------------------------------------------------------------------

const RAIZ = app.isPackaged
  ? process.resourcesPath
  : path.resolve(__dirname, '..');

const SERVER_JS = path.join(RAIZ, 'backend', 'server.js');
const PUBLIC_DIR = path.join(RAIZ, 'frontend', 'public');

// Config propia de la app (vault elegido, DATABASE_URL opcional).
const CONFIG_APP = path.join(app.getPath('userData'), 'config-app.json');

function leerConfigApp() {
  try { return JSON.parse(fs.readFileSync(CONFIG_APP, 'utf8')); }
  catch { return {}; }
}
function guardarConfigApp(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_APP), { recursive: true });
  fs.writeFileSync(CONFIG_APP, JSON.stringify(cfg, null, 2));
}

// .env del repo: solo en desarrollo, como referencia de VAULT_DIR/DATABASE_URL.
// Parser mínimo — clave=valor, sin expansiones.
function leerEnvRepo() {
  const out = {};
  if (app.isPackaged) return out;
  try {
    for (const linea of fs.readFileSync(path.join(RAIZ, '.env'), 'utf8').split('\n')) {
      const m = linea.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !linea.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return out;
}

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

function resolverVault() {
  const env = leerEnvRepo();
  // VAULT_PATH es el nombre que usa el docker-compose en el .env; VAULT_DIR el
  // del server suelto. La app acepta los dos.
  const candidatos = [
    process.env.VAULT_DIR,
    leerConfigApp().vaultDir,
    env.VAULT_DIR,
    env.VAULT_PATH,
  ].filter(Boolean);
  for (const c of candidatos) {
    const abs = path.resolve(c.replace(/^~(?=$|\/)/, app.getPath('home')));
    if (fs.existsSync(abs)) return abs;
  }
  // La convención `<vault>/00-Sistema/_hub/` solo vale si de verdad parece un
  // vault: si el repo está clonado en cualquier otro lado, `../..` es una
  // carpeta cualquiera (p. ej. Documents) y cada subcarpeta aparecería como
  // materia. Mejor preguntar que adivinar mal.
  if (!app.isPackaged) {
    const porConvencion = path.resolve(RAIZ, '..', '..');
    if (fs.existsSync(path.join(porConvencion, '00-Sistema'))) return porConvencion;
  }
  return null;
}

async function elegirVault(win) {
  const r = await dialog.showOpenDialog(win, {
    title: 'Elegí el vault de Obsidian',
    message: 'El hub lee y escribe los .md de tu vault. Elegí la carpeta raíz.',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Usar este vault',
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const cfg = leerConfigApp();
  cfg.vaultDir = r.filePaths[0];
  guardarConfigApp(cfg);
  return cfg.vaultDir;
}

// ---------------------------------------------------------------------------
// Server hijo
// ---------------------------------------------------------------------------

let servidor = null;   // utilityProcess
let puerto = null;

function puertoLibre(desde) {
  return new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => { s.close(); res(puertoLibre(desde + 1)); });
    s.listen(desde, '127.0.0.1', () => s.close(() => res(desde)));
  });
}

function esperarVivo(port, intentos = 60) {
  return new Promise((res, rej) => {
    const tick = (n) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/vivo', timeout: 900 }, (r) => {
        r.resume();
        if (r.statusCode === 200) return res();
        reintento(n);
      });
      req.on('error', () => reintento(n));
      req.on('timeout', () => { req.destroy(); reintento(n); });
    };
    const reintento = (n) => n <= 0
      ? rej(new Error('El server no respondió a tiempo'))
      : setTimeout(() => tick(n - 1), 250);
    tick(intentos);
  });
}

async function lanzarServer(vault) {
  const env = leerEnvRepo();
  const cfg = leerConfigApp();
  puerto = await puertoLibre(4177);

  const entorno = {
    ...process.env,
    PORT: String(puerto),
    HOST: '127.0.0.1',
    VAULT_DIR: vault,
    PUBLIC_DIR,
  };
  // Empaquetado, Resources/ es de solo lectura: los datos van a Application Support.
  if (app.isPackaged) entorno.DATA_DIR = path.join(app.getPath('userData'), 'datos');
  // Postgres si está configurado en cualquiera de los tres lados; JSON si no.
  const db = process.env.DATABASE_URL || cfg.databaseUrl || env.DATABASE_URL;
  if (db) entorno.DATABASE_URL = db;

  servidor = utilityProcess.fork(SERVER_JS, [], { env: entorno, stdio: 'pipe' });
  servidor.stdout?.on('data', (d) => process.stdout.write(`[server] ${d}`));
  servidor.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await esperarVivo(puerto);
}

function matarServer() {
  if (servidor) { try { servidor.kill(); } catch {} servidor = null; }
}

// ---------------------------------------------------------------------------
// Ventana
// ---------------------------------------------------------------------------

let ventana = null;
let tray = null;
let capturaWin = null;

function apiGet(ruta) {
  return new Promise((res, rej) => {
    const req = http.get({ host: '127.0.0.1', port: puerto, path: ruta, timeout: 4000 }, (r) => {
      let b = '';
      r.on('data', (d) => (b += d));
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    });
    req.on('error', rej);
    req.on('timeout', () => { req.destroy(); rej(new Error('timeout')); });
  });
}

/** Trae la ventana principal al frente y navega a una vista. */
function irAlHub(hash) {
  if (!ventana) crearVentana();
  if (ventana.isMinimized()) ventana.restore();
  ventana.show();
  ventana.focus();
  ventana.webContents.executeJavaScript(`location.hash='${hash}'`, true).catch(() => {});
}

// ---------------------------------------------------------------------------
// Captura global: ⌥⌘C desde cualquier app abre una ventana flotante con el
// modo foco de Capturar. Esc (la página sale de #/capturar) o perder el foco
// la esconden; la nota ya quedó en el vault por el autosave de /api/captura.
// ---------------------------------------------------------------------------

function ventanaCaptura() {
  if (capturaWin) return capturaWin;
  capturaWin = new BrowserWindow({
    width: 700, height: 460, show: false,
    frame: false, alwaysOnTop: true, skipTaskbar: true,
    minimizable: false, fullscreenable: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: true },
  });
  capturaWin.loadURL(`http://127.0.0.1:${puerto}/#/capturar`);
  capturaWin.on('blur', () => capturaWin?.hide());
  capturaWin.on('closed', () => { capturaWin = null; });
  capturaWin.webContents.on('did-navigate-in-page', (_e, u) => {
    if (!u.includes('#/capturar')) {
      capturaWin.hide();
      capturaWin.loadURL(`http://127.0.0.1:${puerto}/#/capturar`);
    }
  });
  return capturaWin;
}

function toggleCaptura() {
  const w = ventanaCaptura();
  if (w.isVisible()) { w.hide(); return; }
  w.center();
  w.show();
  w.focus();
}

// ---------------------------------------------------------------------------
// Barra de menú, badge del Dock y notificaciones. Todo sale de los endpoints
// que ya existen: /api/repaso (cola de hoy) y /api/estado (eventos).
// ---------------------------------------------------------------------------

function armarTray(nRepaso, prox) {
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'build', 'trayTemplate.png')));
    tray.setToolTip('Facultad Hub');
  }
  // Cuenta regresiva del próximo hito en la barra de menú, solo si está cerca.
  const prim = prox[0];
  tray.setTitle(prim && prim.dias <= 14 ? (prim.dias === 0 ? 'HOY' : `${prim.dias} d`) : '');

  const items = [];
  items.push(nRepaso > 0
    ? { label: `${nRepaso} tarjeta${nRepaso === 1 ? '' : 's'} para hoy — Empezar repaso`, click: () => irAlHub('#/repaso') }
    : { label: 'Repaso al día ✓', click: () => irAlHub('#/repaso') });
  if (prox.length) {
    items.push({ type: 'separator' });
    for (const e of prox.slice(0, 3)) {
      const cuando = e.dias === 0 ? 'Hoy' : e.dias === 1 ? 'Mañana' : `En ${e.dias} días`;
      items.push({ label: `${cuando} — ${e.titulo}${e.materia ? ` (${e.materia})` : ''}`, click: () => irAlHub('#/calendario') });
    }
  }
  items.push({ type: 'separator' });
  items.push({ label: 'Capturar\t⌥⌘C', click: toggleCaptura });
  items.push({ label: 'Abrir Facultad Hub', click: () => irAlHub('#/hub') });
  items.push({ type: 'separator' });
  items.push({ label: 'Salir de Facultad Hub', role: 'quit' });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

/** Notificaciones con memoria diaria: cada aviso sale una sola vez por día. */
function avisar(nRepaso, prox) {
  const hoyISO = new Date().toISOString().slice(0, 10);
  const f = path.join(app.getPath('userData'), 'avisos.json');
  let reg = {};
  try { reg = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  if (reg.dia !== hoyISO) reg = { dia: hoyISO, vistos: [] };

  const mostrar = (clave, titulo, cuerpo, hash) => {
    if (reg.vistos.includes(clave)) return;
    reg.vistos.push(clave);
    const n = new Notification({ title: titulo, body: cuerpo });
    n.on('click', () => irAlHub(hash));
    n.show();
  };

  if (nRepaso > 0)
    mostrar('repaso', `${nRepaso} tarjeta${nRepaso === 1 ? '' : 's'} para repasar hoy`,
      'Tocá para empezar la sesión.', '#/repaso');
  for (const e of prox)
    if (e.dias <= 3)
      mostrar(`ev:${e.id}`,
        e.dias === 0 ? `HOY: ${e.titulo}` : `En ${e.dias} día${e.dias === 1 ? '' : 's'}: ${e.titulo}`,
        e.materia ? `Materia: ${e.materia}` : '', '#/calendario');

  try { fs.writeFileSync(f, JSON.stringify(reg)); } catch {}
}

async function refrescarEstado() {
  try {
    const [rep, est] = await Promise.all([apiGet('/api/repaso'), apiGet('/api/estado')]);
    const nRepaso = (rep.hoy || []).length;
    if (app.dock) app.dock.setBadge(nRepaso > 0 ? String(nRepaso) : '');

    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    const prox = (est.eventos || [])
      .filter((e) => e.tipo !== 'feriado')
      .map((e) => ({ ...e, dias: Math.round((new Date(`${e.fecha}T00:00:00`) - hoy) / 86400000) }))
      .filter((e) => e.dias >= 0)
      .sort((a, b) => a.dias - b.dias);

    armarTray(nRepaso, prox);
    avisar(nRepaso, prox);
  } catch { /* el server puede estar reiniciándose; el próximo tick lo agarra */ }
}

function crearVentana() {
  ventana = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 880,
    minHeight: 560,
    show: false,
    // Barra de título integrada: los semáforos flotan sobre la sidebar.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 20 },
    // La sidebar es translúcida de verdad: el material lo pone macOS.
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  ventana.loadURL(`http://127.0.0.1:${puerto}/`);
  ventana.once('ready-to-show', () => ventana.show());
  ventana.on('closed', () => { ventana = null; });

  // Todo lo que no sea el hub (OAuth de Drive, links de GitHub) va al navegador.
  const esDelHub = (u) => {
    try { return new URL(u).host === `127.0.0.1:${puerto}`; } catch { return false; }
  };
  ventana.webContents.setWindowOpenHandler(({ url }) => {
    if (!esDelHub(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  ventana.webContents.on('will-navigate', (ev, url) => {
    if (!esDelHub(url)) { ev.preventDefault(); shell.openExternal(url); }
  });
}

// ---------------------------------------------------------------------------
// Menú — en castellano, con los atajos que la página ya escucha.
// ---------------------------------------------------------------------------

function armarMenu() {
  const js = (codigo) => () => ventana?.webContents.executeJavaScript(codigo, true);
  const plantilla = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: 'Acerca de Facultad Hub' },
        { type: 'separator' },
        {
          label: 'Cambiar vault…',
          click: async () => {
            const v = await elegirVault(ventana);
            if (v) { matarServer(); await lanzarServer(v); ventana?.loadURL(`http://127.0.0.1:${puerto}/`); }
          },
        },
        {
          label: 'Abrir al iniciar sesión',
          type: 'checkbox',
          checked: app.getLoginItemSettings().openAtLogin,
          click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
        },
        { type: 'separator' },
        { role: 'hide', label: 'Ocultar Facultad Hub' },
        { role: 'hideOthers', label: 'Ocultar otros' },
        { role: 'unhide', label: 'Mostrar todo' },
        { type: 'separator' },
        { role: 'quit', label: 'Salir de Facultad Hub' },
      ],
    },
    {
      label: 'Archivo',
      submenu: [
        { label: 'Nueva nota', accelerator: 'Cmd+N', click: js("location.hash='#/nueva'") },
        { label: 'Capturar clase', accelerator: 'Shift+Cmd+N', click: js("location.hash='#/capturar'") },
        { label: 'Captura rápida (global)', accelerator: 'Alt+Cmd+C', click: toggleCaptura },
        { type: 'separator' },
        { label: 'Buscar en el vault', accelerator: 'Cmd+K', click: js('openOmni()') },
        { type: 'separator' },
        { role: 'close', label: 'Cerrar ventana' },
      ],
    },
    { role: 'editMenu', label: 'Edición' },
    {
      label: 'Ver',
      submenu: [
        { label: 'Hub', accelerator: 'Cmd+1', click: js("location.hash='#/hub'") },
        { label: 'Repaso', accelerator: 'Cmd+2', click: js("location.hash='#/repaso'") },
        { label: 'Notas', accelerator: 'Cmd+3', click: js("location.hash='#/notas'") },
        { label: 'Calendario', accelerator: 'Cmd+4', click: js("location.hash='#/calendario'") },
        { type: 'separator' },
        { label: 'Asistente', accelerator: 'Cmd+J', click: js('togglePanel()') },
        { type: 'separator' },
        { label: 'Tema', accelerator: 'Shift+Cmd+T', click: js('toggleTheme()') },
        { type: 'separator' },
        { role: 'reload', label: 'Recargar' },
        { role: 'toggleDevTools', label: 'Herramientas de desarrollo' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Pantalla completa' },
      ],
    },
    { role: 'windowMenu', label: 'Ventana' },
    {
      label: 'Ayuda',
      role: 'help',
      submenu: [
        { label: 'Abrir en el navegador', click: () => shell.openExternal(`http://127.0.0.1:${puerto}/`) },
        { label: 'LEEME del hub', click: () => shell.openPath(path.join(RAIZ, 'LEEME.txt')) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(plantilla));
}

// ---------------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  let vault = resolverVault();
  if (!vault) vault = await elegirVault(null);
  if (!vault) { app.quit(); return; }

  try {
    await lanzarServer(vault);
  } catch (err) {
    dialog.showErrorBox('Facultad Hub', `No pude levantar el server del hub:\n${err.message}`);
    app.quit();
    return;
  }

  armarMenu();
  crearVentana();

  // ⌥⌘C desde cualquier app: captura rápida al vault.
  globalShortcut.register('Alt+Command+C', toggleCaptura);

  // Badge del Dock, barra de menú y avisos: ahora y cada 15 minutos.
  setTimeout(refrescarEstado, 3000);
  setInterval(refrescarEstado, 15 * 60 * 1000);

  app.on('activate', () => { if (!ventana) crearVentana(); });
});

app.on('will-quit', () => globalShortcut.unregisterAll());

// Un PDF abierto con la app (o soltado en el Dock) lleva a Importar PDF.
app.on('open-file', (ev, ruta) => {
  ev.preventDefault();
  if (String(ruta).toLowerCase().endsWith('.pdf'))
    app.whenReady().then(() => irAlHub('#/ingerir'));
});

// Convención de macOS: cerrar la ventana no cierra la app; el server queda
// listo y ⌘Tab + clic en el Dock la reabren al instante.
app.on('window-all-closed', () => { /* nada: la app vive en el Dock */ });
app.on('before-quit', matarServer);
process.on('exit', matarServer);
