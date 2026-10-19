// Primitivas de seguridad sobre WebCrypto (disponible en Cloudflare Workers y en Node ≥ 20).

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = globalThis.crypto.subtle;

const aB64 = (bytes) => Buffer.from(bytes).toString('base64');
const deB64 = (texto) => new Uint8Array(Buffer.from(texto, 'base64'));
const aHex = (buf) => Buffer.from(buf).toString('hex');
const aleatorio = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

// Comparación en tiempo constante.
export function iguales(a, b) {
  const x = typeof a === 'string' ? enc.encode(a) : a;
  const y = typeof b === 'string' ? enc.encode(b) : b;
  if (x.length !== y.length) return false;
  let r = 0;
  for (let i = 0; i < x.length; i++) r |= x[i] ^ y[i];
  return r === 0;
}

// ---------- contraseñas del staff: PBKDF2-HMAC-SHA256 (recomendación OWASP: 600.000 iteraciones) ----------

async function pbkdf2(clave, sal, iteraciones) {
  const base = await subtle.importKey('raw', enc.encode(String(clave).normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: sal, iterations: iteraciones }, base, 256));
}

export async function hashClave(clave, iteraciones = 600000) {
  const sal = aleatorio(16);
  return `pbkdf2-sha256$${iteraciones}$${aB64(sal)}$${aB64(await pbkdf2(clave, sal, iteraciones))}`;
}

export async function verificarClave(clave, guardado) {
  const partes = String(guardado || '').split('$');
  if (partes.length !== 4 || partes[0] !== 'pbkdf2-sha256') return false;
  const iteraciones = Number(partes[1]);
  if (!Number.isInteger(iteraciones) || iteraciones < 1000 || iteraciones > 5_000_000) return false;
  return iguales(await pbkdf2(clave, deB64(partes[2]), iteraciones), deB64(partes[3]));
}

// Cálculo equivalente cuando el usuario no existe: iguala tiempos y evita enumerar cuentas.
export async function verificarFicticio(clave, iteraciones = 600000) {
  await pbkdf2(clave, aleatorio(16), iteraciones);
  return false;
}

// ---------- tokens y códigos ----------

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 símbolos, sin 0/O ni 1/I

export function codigoAleatorio(largo) {
  let s = '';
  for (const b of aleatorio(largo)) s += ALFABETO[b & 31];
  return s;
}

export const tokenSesion = () => Buffer.from(aleatorio(32)).toString('base64url');

export async function sha256(texto) {
  return aHex(await subtle.digest('SHA-256', enc.encode(String(texto))));
}

// ---------- cifrado de datos personales en reposo ----------

// A partir de la clave maestra (32 bytes en base64) se derivan claves independientes con HKDF:
//  - AES-256-GCM para correo y teléfono
//  - HMAC para el índice ciego del correo (búsqueda exacta sin guardarlo en claro)
//  - HMAC para los códigos de acceso de estudiantes (secretos aleatorios de 40 bits)
export async function crearCifrador(claveMaestraB64) {
  const maestra = deB64(String(claveMaestraB64 || ''));
  if (maestra.length !== 32) throw new Error('DATA_KEY debe ser de 32 bytes en base64 (openssl rand -base64 32).');
  const ikm = await subtle.importKey('raw', maestra, 'HKDF', false, ['deriveKey']);
  const derivar = (info, alg, usos) => subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) }, ikm, alg, false, usos);
  const kCifrado = await derivar('evento:cifrado:v1', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']);
  const kIndice = await derivar('evento:indice:v1', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']);
  const kCodigo = await derivar('evento:codigo-acceso:v1', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']);

  return {
    async cifrar(texto) {
      if (texto == null || texto === '') return null;
      const iv = aleatorio(12);
      const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, kCifrado, enc.encode(String(texto))));
      const out = new Uint8Array(12 + ct.length);
      out.set(iv);
      out.set(ct, 12);
      return 'v1:' + aB64(out);
    },
    async descifrar(valor) {
      if (!valor) return null;
      const b = deB64(String(valor).slice(3));
      return dec.decode(await subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12) }, kCifrado, b.subarray(12)));
    },
    indice: async (texto) => aHex(await subtle.sign('HMAC', kIndice, enc.encode(String(texto).toLowerCase()))),
    hashCodigo: async (codigo) => 'hmac$' + aHex(await subtle.sign('HMAC', kCodigo, enc.encode(String(codigo).toUpperCase()))),
  };
}

// ---------- limitador de intentos (en memoria del Durable Object) ----------

export function crearLimitador() {
  const mapa = new Map();
  let ultimaLimpieza = Date.now();
  return {
    permitir(clave, maximo, ventanaMs) {
      const t = Date.now();
      if (t - ultimaLimpieza > 60_000) {
        for (const [k, v] of mapa) if (v.hasta < t) mapa.delete(k);
        ultimaLimpieza = t;
      }
      const c = mapa.get(clave);
      if (!c || c.hasta < t) {
        mapa.set(clave, { n: 1, hasta: t + ventanaMs });
        return true;
      }
      c.n += 1;
      return c.n <= maximo;
    },
  };
}

// ---------- imágenes ----------

// Valida que sea un JPEG y elimina metadatos (EXIF/GPS, XMP, comentarios). Devuelve null si no es válido.
export function limpiarJPEG(entrada) {
  const buf = entrada instanceof Uint8Array ? entrada : new Uint8Array(entrada);
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const partes = [buf.subarray(0, 2)];
  const unir = () => {
    const total = partes.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of partes) { out.set(p, o); o += p.length; }
    return out;
  };
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null;
    const tipo = buf[i + 1];
    if (tipo === 0xff) { i += 1; continue; }
    if (tipo === 0xd9) { partes.push(buf.subarray(i, i + 2)); return unir(); }
    if (tipo === 0x01 || (tipo >= 0xd0 && tipo <= 0xd7)) { partes.push(buf.subarray(i, i + 2)); i += 2; continue; }
    if (i + 4 > buf.length) return null;
    const largo = (buf[i + 2] << 8) | buf[i + 3];
    if (largo < 2 || i + 2 + largo > buf.length) return null;
    if (tipo === 0xda) {
      partes.push(buf.subarray(i));
      const limpio = unir();
      return limpio[limpio.length - 2] === 0xff && limpio[limpio.length - 1] === 0xd9 ? limpio : null;
    }
    const metadato = (tipo >= 0xe1 && tipo <= 0xef) || tipo === 0xfe;
    if (!metadato) partes.push(buf.subarray(i, i + 2 + largo));
    i += 2 + largo;
  }
  return null;
}
