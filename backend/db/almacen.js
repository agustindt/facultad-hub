'use strict';
/**
 * Capa de almacenamiento.
 *
 * El hub nació guardando su estado en archivos JSON dentro de datos/. Eso está
 * bien para una app que corre en una sola máquina, pero el TP2 pide un servicio
 * de base de datos con volumen y healthcheck, así que hay dos backends:
 *
 *   - Postgres, cuando hay DATABASE_URL. Es el modo de docker compose.
 *   - Archivos JSON, cuando no la hay. Es el modo "doble clic en iniciar-hub".
 *
 * La interfaz es la misma en los dos casos, así que el resto del servidor no se
 * entera. Esa es la razón de que exista este archivo: si mañana el TP pide otra
 * cosa, se cambia acá y nada más.
 *
 * Qué vive en la base y qué no:
 *   SÍ  → repaso (calendario de tarjetas), eventos propios, registro de uso de IA
 *   NO  → las notas. Las notas son archivos .md del vault y esa es la decisión
 *         que define todo el proyecto: la fuente de verdad es el markdown, no
 *         una base. Meter las notas en Postgres rompería Obsidian.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

let pg = null;
try {
  pg = require('pg');
} catch {
  // Sin el paquete instalado, sólo queda el modo archivos. Es lo esperado
  // cuando el hub corre suelto, sin contenedores.
}

const URL_BD = process.env.DATABASE_URL || null;

class AlmacenArchivos {
  constructor(dir) {
    this.dir = dir;
    this.modo = 'archivos';
  }
  async iniciar() {
    await fsp.mkdir(this.dir, { recursive: true });
  }
  _ruta(n) {
    return path.join(this.dir, `${n}.json`);
  }
  async leer(nombre, porDefecto) {
    try {
      return JSON.parse(await fsp.readFile(this._ruta(nombre), 'utf8'));
    } catch {
      return porDefecto;
    }
  }
  async escribir(nombre, valor) {
    await fsp.mkdir(this.dir, { recursive: true });
    await fsp.writeFile(this._ruta(nombre), JSON.stringify(valor, null, 2), 'utf8');
  }
  async salud() {
    return { ok: true, modo: 'archivos', detalle: this.dir };
  }
  async cerrar() {}
}

class AlmacenPostgres {
  constructor(url) {
    this.modo = 'postgres';
    this.pool = new pg.Pool({ connectionString: url, max: 4 });
  }
  async iniciar() {
    // Una sola tabla clave-valor con JSONB. No hace falta más: son tres
    // documentos chicos y el valor de la base acá es la persistencia y el
    // healthcheck, no un modelo relacional que nadie va a consultar.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS estado (
        clave       TEXT PRIMARY KEY,
        valor       JSONB NOT NULL,
        actualizado TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
  }
  async leer(nombre, porDefecto) {
    const r = await this.pool.query('SELECT valor FROM estado WHERE clave = $1', [nombre]);
    return r.rows.length ? r.rows[0].valor : porDefecto;
  }
  async escribir(nombre, valor) {
    await this.pool.query(
      `INSERT INTO estado (clave, valor, actualizado) VALUES ($1, $2, now())
       ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado = now()`,
      [nombre, JSON.stringify(valor)]
    );
  }
  async salud() {
    try {
      const r = await this.pool.query('SELECT count(*)::int AS n FROM estado');
      return { ok: true, modo: 'postgres', detalle: `${r.rows[0].n} claves` };
    } catch (err) {
      return { ok: false, modo: 'postgres', detalle: err.message };
    }
  }
  async cerrar() {
    await this.pool.end();
  }
}

function crearAlmacen(dirDatos) {
  if (URL_BD && pg) return new AlmacenPostgres(URL_BD);
  if (URL_BD && !pg) {
    console.warn('⚠️  DATABASE_URL está definida pero el paquete `pg` no está instalado. Sigo con archivos.');
  }
  return new AlmacenArchivos(dirDatos);
}

module.exports = { crearAlmacen, AlmacenArchivos, AlmacenPostgres };
