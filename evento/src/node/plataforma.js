// Equivalentes en Node.js de los servicios de Cloudflare que usa la app:
//  - ctx.storage (SQLite del Durable Object)  → node:sqlite en un archivo
//  - R2 (fotos de docentes)                    → carpeta en disco
//  - ASSETS (archivos del frontend)            → carpeta public/
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

// Imita ctx.storage.sql + transactionSync de un Durable Object.
export function almacenamientoSqlite(archivo = ':memory:') {
  const db = new DatabaseSync(archivo);
  if (archivo !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;');
  return {
    db,
    sql: {
      exec(q, ...args) {
        const st = db.prepare(q);
        const filas = st.columns().length ? st.all(...args) : (st.run(...args), []);
        return { toArray: () => filas, one: () => filas[0] };
      },
    },
    transactionSync(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const r = fn();
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    cerrar: () => db.close(),
  };
}

// Contexto del objeto: almacenamiento y registro de WebSockets abiertos.
export function crearContexto(storage) {
  const sockets = new Set();
  let autoRespuesta = null;
  let listo = Promise.resolve();
  return {
    storage,
    blockConcurrencyWhile(fn) {
      listo = Promise.resolve().then(fn);
      return listo;
    },
    get listo() {
      return listo;
    },
    setWebSocketAutoResponse(par) {
      autoRespuesta = par;
    },
    get autoRespuesta() {
      return autoRespuesta;
    },
    acceptWebSocket: (ws) => sockets.add(ws),
    soltarWebSocket: (ws) => sockets.delete(ws),
    getWebSockets: () => [...sockets],
  };
}

// Par petición/respuesta automática (en Cloudflare responde "pong" a "ping" sin despertar al objeto).
export class ParAutoRespuesta {
  constructor(peticion, respuesta) {
    this.peticion = peticion;
    this.respuesta = respuesta;
  }
}

// Almacén de fotos con la misma interfaz que usa la app de R2: put / get / delete.
export function fotosEnDisco(dir) {
  const ruta = (nombre) => {
    if (!/^[a-f0-9]{32}\.jpg$/.test(nombre)) throw new Error('Nombre de foto inválido');
    return path.join(dir, nombre);
  };
  return {
    async put(nombre, bytes) {
      await writeFile(ruta(nombre), bytes, { mode: 0o600, flag: 'wx' });
    },
    async get(nombre) {
      try {
        const datos = await readFile(ruta(nombre));
        return { body: datos, httpEtag: `"${createHash('sha1').update(datos).digest('hex')}"` };
      } catch {
        return null;
      }
    },
    async delete(nombre) {
      await rm(ruta(nombre), { force: true });
    },
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

// Archivos del frontend con ETag (respuestas 304 cuando no cambiaron). Se cargan en memoria al iniciar.
export function archivosEstaticos(raiz) {
  const cache = new Map();
  const base = path.resolve(raiz);
  return {
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const archivo = path.resolve(base, '.' + decodeURIComponent(pathname));
      if (!archivo.startsWith(base + path.sep)) return new Response(null, { status: 404 });
      let entrada = cache.get(archivo);
      if (!entrada) {
        try {
          const datos = await readFile(archivo);
          entrada = { datos, etag: `"${createHash('sha1').update(datos).digest('hex')}"`, tipo: MIME[path.extname(archivo)] || 'application/octet-stream' };
          cache.set(archivo, entrada);
        } catch {
          return new Response(null, { status: 404 });
        }
      }
      if (request.headers.get('If-None-Match') === entrada.etag) return new Response(null, { status: 304, headers: { ETag: entrada.etag } });
      return new Response(request.method === 'HEAD' ? null : entrada.datos, { headers: { 'Content-Type': entrada.tipo, ETag: entrada.etag } });
    },
  };
}
