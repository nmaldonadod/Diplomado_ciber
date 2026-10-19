'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

// ---------- contraseñas y códigos de acceso (scrypt) ----------

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

async function hashClave(clave) {
  const sal = crypto.randomBytes(16);
  const h = await scrypt(String(clave).normalize('NFKC'), sal, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${sal.toString('base64')}$${h.toString('base64')}`;
}

async function verificarClave(clave, guardado) {
  const partes = String(guardado || '').split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') return false;
  const [, N, r, p, sal, hash] = partes;
  const esperado = Buffer.from(hash, 'base64');
  const calculado = await scrypt(String(clave).normalize('NFKC'), Buffer.from(sal, 'base64'), esperado.length,
    { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(calculado, esperado);
}

// Hash ficticio para igualar tiempos cuando el usuario no existe (evita enumeración por tiempo).
let hashFicticio;
async function verificarFicticio(clave) {
  hashFicticio = hashFicticio || (await hashClave(crypto.randomBytes(16).toString('hex')));
  await verificarClave(clave, hashFicticio);
  return false;
}

// ---------- tokens ----------

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 símbolos, sin 0/O ni 1/I

function codigoAleatorio(largo) {
  let s = '';
  for (const b of crypto.randomBytes(largo)) s += ALFABETO[b & 31];
  return s;
}

const tokenSesion = () => crypto.randomBytes(32).toString('base64url');
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

// ---------- cifrado de datos personales en reposo (AES-256-GCM) ----------

function cargarClaveMaestra(archivo, desdeEntorno) {
  if (desdeEntorno) {
    const k = Buffer.from(desdeEntorno, 'base64');
    if (k.length !== 32) throw new Error('DATA_KEY debe ser 32 bytes en base64 (openssl rand -base64 32)');
    return k;
  }
  if (fs.existsSync(archivo)) return Buffer.from(fs.readFileSync(archivo, 'utf8').trim(), 'base64');
  const k = crypto.randomBytes(32);
  fs.writeFileSync(archivo, k.toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
  console.warn(`[seguridad] Se generó una clave de cifrado en ${archivo}. En producción define DATA_KEY y respáldala fuera del servidor.`);
  return k;
}

function crearCifrador(claveMaestra) {
  const derivar = (info) => Buffer.from(crypto.hkdfSync('sha256', claveMaestra, Buffer.alloc(0), info, 32));
  const kCifrado = derivar('evento:cifrado:v1');
  const kIndice = derivar('evento:indice:v1');
  return {
    cifrar(texto) {
      if (texto == null || texto === '') return null;
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', kCifrado, iv);
      const ct = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
      return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
    },
    descifrar(valor) {
      if (!valor) return null;
      const b = Buffer.from(String(valor).slice(3), 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', kCifrado, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    },
    // Índice ciego: permite buscar por igualdad sin guardar el dato en claro.
    indice: (texto) => crypto.createHmac('sha256', kIndice).update(String(texto).toLowerCase()).digest('hex'),
  };
}

// ---------- limitador de intentos ----------

function crearLimitador() {
  const mapa = new Map();
  const timer = setInterval(() => {
    const t = Date.now();
    for (const [k, v] of mapa) if (v.hasta < t) mapa.delete(k);
  }, 60_000);
  timer.unref();
  return {
    permitir(clave, maximo, ventanaMs) {
      const t = Date.now();
      const c = mapa.get(clave);
      if (!c || c.hasta < t) {
        mapa.set(clave, { n: 1, hasta: t + ventanaMs });
        return true;
      }
      c.n += 1;
      return c.n <= maximo;
    },
    reiniciar: (clave) => mapa.delete(clave),
    detener: () => clearInterval(timer),
  };
}

// ---------- imágenes ----------

// Valida que el archivo sea un JPEG y elimina metadatos (EXIF/GPS, XMP, comentarios).
function limpiarJPEG(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const partes = [buf.subarray(0, 2)];
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null;
    const tipo = buf[i + 1];
    if (tipo === 0xff) { i += 1; continue; }
    if (tipo === 0xd9) { partes.push(buf.subarray(i, i + 2)); return Buffer.concat(partes); }
    if (tipo === 0x01 || (tipo >= 0xd0 && tipo <= 0xd7)) { partes.push(buf.subarray(i, i + 2)); i += 2; continue; }
    if (i + 4 > buf.length) return null;
    const largo = buf.readUInt16BE(i + 2);
    if (largo < 2 || i + 2 + largo > buf.length) return null;
    if (tipo === 0xda) {
      // Inicio de datos de imagen: se copia el resto tal cual.
      partes.push(buf.subarray(i));
      const limpio = Buffer.concat(partes);
      return limpio[limpio.length - 2] === 0xff && limpio[limpio.length - 1] === 0xd9 ? limpio : null;
    }
    const metadato = (tipo >= 0xe1 && tipo <= 0xef) || tipo === 0xfe;
    if (!metadato) partes.push(buf.subarray(i, i + 2 + largo));
    i += 2 + largo;
  }
  return null;
}

module.exports = {
  hashClave, verificarClave, verificarFicticio, codigoAleatorio, tokenSesion, sha256,
  cargarClaveMaestra, crearCifrador, crearLimitador, limpiarJPEG,
};
