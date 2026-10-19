// Servidor Node.js para ejecutar la plataforma fuera de Cloudflare (por ejemplo en Docker).
// Reutiliza exactamente el mismo código: el Worker (src/worker.js) y el objeto EventoDO (src/evento.js).
import http from 'node:http';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import worker, { EventoDO } from '../worker.js';
import { almacenamientoSqlite, crearContexto, ParAutoRespuesta, fotosEnDisco, archivosEstaticos } from './plataforma.js';

process.umask(0o077); // archivos creados por la app: sólo legibles por su usuario

const PUERTO = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const DATOS = path.resolve(process.env.DATA_DIR || './datos');
// Sólo si hay un proxy de confianza delante (p. ej. cloudflared): se aceptan sus cabeceras de IP y protocolo.
const PROXY_CONFIABLE = process.env.TRUST_PROXY === '1';
const RAIZ = path.resolve(import.meta.dirname, '..', '..');

globalThis.WebSocketRequestResponsePair = ParAutoRespuesta;

// ---------- secretos: variables de entorno o, si faltan, generados una vez en el volumen de datos ----------
mkdirSync(path.join(DATOS, 'fotos'), { recursive: true, mode: 0o700 });
const archivoSecretos = path.join(DATOS, 'secretos.json');
const guardados = existsSync(archivoSecretos) ? JSON.parse(readFileSync(archivoSecretos, 'utf8')) : {};
const secretos = {
  DATA_KEY: process.env.DATA_KEY || guardados.DATA_KEY || randomBytes(32).toString('base64'),
  TOKEN_CONFIGURACION: process.env.TOKEN_CONFIGURACION || guardados.TOKEN_CONFIGURACION || randomBytes(12).toString('hex'),
};
if (!process.env.DATA_KEY || !process.env.TOKEN_CONFIGURACION) {
  writeFileSync(archivoSecretos, JSON.stringify({ ...guardados, ...secretos }, null, 2), { mode: 0o600 });
}

// ---------- entorno equivalente al de Cloudflare ----------
const storage = almacenamientoSqlite(path.join(DATOS, 'evento.db'));
const ctx = crearContexto(storage);
const env = {
  ...secretos,
  ITERACIONES_CLAVE: process.env.ITERACIONES_CLAVE || '600000',
  EVENTO_INICIAL: process.env.EVENTO_INICIAL || 'si',
  ASSETS: archivosEstaticos(path.join(RAIZ, 'public')),
  FOTOS: fotosEnDisco(path.join(DATOS, 'fotos')),
};
const evento = new EventoDO(ctx, env);
env.EVENTO = { idFromName: () => 'principal', get: () => ({ fetch: (req) => evento.fetch(req) }) };
await ctx.listo;

// ---------- traducción Node ↔ Fetch API ----------
function ipCliente(req) {
  if (PROXY_CONFIABLE && req.headers['cf-connecting-ip']) return String(req.headers['cf-connecting-ip']);
  return req.socket.remoteAddress || '127.0.0.1';
}

function aRequest(req) {
  const https = PROXY_CONFIABLE && req.headers['x-forwarded-proto'] === 'https';
  const url = new URL(req.url, `${https ? 'https' : 'http'}://${req.headers.host || 'localhost'}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.startsWith(':')) continue;
    headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  }
  // La IP del cliente la fija este servidor: un cliente no puede falsificarla para evadir límites.
  headers.set('CF-Connecting-IP', ipCliente(req));
  const conCuerpo = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, { method: req.method, headers, body: conCuerpo ? Readable.toWeb(req) : undefined, duplex: 'half' });
}

async function responder(res, respuesta) {
  const cabeceras = {};
  respuesta.headers.forEach((v, k) => {
    if (k !== 'set-cookie') cabeceras[k] = v;
  });
  const cookies = respuesta.headers.getSetCookie();
  if (cookies.length) cabeceras['set-cookie'] = cookies;
  res.writeHead(respuesta.status, cabeceras);
  if (!respuesta.body) return res.end();
  Readable.fromWeb(respuesta.body).pipe(res);
}

const servidor = http.createServer(async (req, res) => {
  try {
    await responder(res, await worker.fetch(aRequest(req), env));
  } catch (e) {
    console.error(req.method, req.url, e?.message);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Error interno');
  }
});
servidor.headersTimeout = 20_000;
servidor.requestTimeout = 60_000;
servidor.maxHeadersCount = 60;

// ---------- tiempo real (WebSocket) ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
servidor.on('upgrade', (req, socket, cabeza) => {
  const url = new URL(req.url, 'http://x');
  const origen = req.headers.origin;
  let mismoOrigen = true;
  try {
    mismoOrigen = !origen || new URL(origen).host === req.headers.host;
  } catch {
    mismoOrigen = false;
  }
  if (url.pathname !== '/api/tiempo-real' || !mismoOrigen || ctx.getWebSockets().length >= 5000) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, cabeza, (ws) => {
    ctx.acceptWebSocket(ws);
    ws.send(evento.mensajeInicial());
    const par = ctx.autoRespuesta;
    ws.on('message', (datos) => {
      if (par && String(datos) === par.peticion) ws.send(par.respuesta);
    });
    ws.on('close', () => ctx.soltarWebSocket(ws));
    ws.on('error', () => ctx.soltarWebSocket(ws));
  });
});

servidor.listen(PUERTO, HOST, () => {
  console.log(`Plataforma de eventos escuchando en http://localhost:${PUERTO}`);
  console.log(`  Estudiantes:     /        Acreditación: /acreditacion        Administración: /admin`);
  if (!evento.db.usuarios.hayAdmin()) {
    console.log(`\n[configuración inicial] Token para crear el primer administrador en /admin: ${env.TOKEN_CONFIGURACION}\n`);
  }
});

function apagar() {
  for (const ws of ctx.getWebSockets()) ws.close(1001, 'apagando');
  servidor.close(() => {
    storage.cerrar();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', apagar);
process.on('SIGTERM', apagar);
