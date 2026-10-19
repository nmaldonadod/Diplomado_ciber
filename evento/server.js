'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { abrirDB } = require('./src/db');
const { crearApp } = require('./src/app');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const CONFIG = path.resolve(process.env.EVENTO_CONFIG || path.join(__dirname, 'config', 'evento.json'));

const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = abrirDB(path.join(DATA_DIR, 'evento.db'), config);

let staffPin = process.env.STAFF_PIN;
if (!staffPin) {
  staffPin = String(crypto.randomInt(100000, 1000000));
  console.warn(`[aviso] STAFF_PIN no definido. PIN temporal de acreditación: ${staffPin}`);
}

const app = crearApp({
  config,
  db,
  staffPin,
  secreto: process.env.SESSION_SECRET,
  publicDir: path.join(__dirname, 'public'),
  trustProxy: process.env.TRUST_PROXY === '1',
});

const tls = process.env.TLS_CERT && process.env.TLS_KEY
  ? { cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }
  : null;

const server = tls ? https.createServer(tls, app.handler) : http.createServer(app.handler);
server.headersTimeout = 20_000;
server.requestTimeout = 30_000;

server.listen(PORT, HOST, () => {
  console.log(`${config.nombre}`);
  console.log(`  Estudiantes:   ${tls ? 'https' : 'http'}://localhost:${PORT}/`);
  console.log(`  Acreditación:  ${tls ? 'https' : 'http'}://localhost:${PORT}/staff`);
  if (!tls) console.log('  (La cámara del teléfono requiere HTTPS: usa TLS_CERT/TLS_KEY o un proxy/túnel HTTPS.)');
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
