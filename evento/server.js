'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { abrirDB } = require('./src/db');
const { crearApp } = require('./src/app');
const { cargarClaveMaestra, crearCifrador, codigoAleatorio } = require('./src/seguridad');

process.umask(0o077); // archivos creados por la app: sólo legibles por su usuario

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const cifrador = crearCifrador(cargarClaveMaestra(path.join(DATA_DIR, 'clave.key'), process.env.DATA_KEY));
const db = abrirDB(path.join(DATA_DIR, 'evento.db'), cifrador);

// Si aún no hay administrador, se genera un token de un solo uso para crearlo desde /admin.
let tokenInicial = null;
if (!db.usuarios.hayAdmin()) {
  tokenInicial = codigoAleatorio(12);
  console.log(`\n[configuración inicial] Abre /admin y usa este token para crear el primer administrador: ${tokenInicial}\n`);
}

const app = crearApp({
  db,
  publicDir: path.join(__dirname, 'public'),
  fotosDir: path.join(DATA_DIR, 'fotos'),
  trustProxy: process.env.TRUST_PROXY === '1',
  tokenInicial,
});

const tls = process.env.TLS_CERT && process.env.TLS_KEY
  ? { cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY), minVersion: 'TLSv1.2' }
  : null;

const server = tls ? https.createServer(tls, app.handler) : http.createServer(app.handler);
server.headersTimeout = 20_000;
server.requestTimeout = 30_000;
server.maxHeadersCount = 60;

server.listen(PORT, HOST, () => {
  const base = `${tls ? 'https' : 'http'}://localhost:${PORT}`;
  console.log('Plataforma de eventos');
  console.log(`  Estudiantes:     ${base}/`);
  console.log(`  Acreditación:    ${base}/acreditacion`);
  console.log(`  Administración:  ${base}/admin`);
  if (!tls && process.env.TRUST_PROXY !== '1') {
    console.log('  Aviso: sin HTTPS. En producción usa TLS_CERT/TLS_KEY o un proxy HTTPS con TRUST_PROXY=1.');
  }
});

function apagar() {
  app.cerrar();
  server.close(() => {
    db.cerrar();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', apagar);
process.on('SIGTERM', apagar);
