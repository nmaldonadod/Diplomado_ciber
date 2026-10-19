// Utilidades HTTP sobre la Fetch API (Cloudflare Workers).
import { ErrorNegocio } from './db.js';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// Se aplican a todas las respuestas (páginas, archivos y API) desde el Worker.
export function aplicarCabecerasSeguridad(headers, https) {
  headers.set('Content-Security-Policy', CSP);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  headers.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()');
  if (https) headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

export function json(status, cuerpo, extra = {}) {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

// Contexto de una petición: URL, IP real del cliente (la pone Cloudflare) y cookies.
export function contexto(req) {
  const url = new URL(req.url);
  const cookies = {};
  for (const parte of String(req.headers.get('Cookie') || '').split(';')) {
    const i = parte.indexOf('=');
    if (i <= 0) continue;
    try {
      cookies[parte.slice(0, i).trim()] = decodeURIComponent(parte.slice(i + 1).trim());
    } catch { /* cookie mal formada: se ignora */ }
  }
  return {
    req,
    url,
    https: url.protocol === 'https:',
    ip: (req.headers.get('CF-Connecting-IP') || '127.0.0.1').slice(0, 64),
    cookies,
  };
}

// Bajo HTTPS se usa el prefijo __Host- (obliga Secure, Path=/ y sin Domain).
const nombreCookie = (c, base) => (c.https ? `__Host-${base}` : base);
export const leerCookie = (c, base) => c.cookies[nombreCookie(c, base)];

export function cookie(c, base, valor, { maxAge, sameSite = 'Lax' }) {
  return [
    `${nombreCookie(c, base)}=${encodeURIComponent(valor)}`, 'Path=/', 'HttpOnly', `SameSite=${sameSite}`,
    `Max-Age=${maxAge}`, c.https ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

// Protección CSRF: las peticiones que modifican datos deben originarse en este mismo sitio.
export function mismoOrigen(c) {
  const origen = c.req.headers.get('Origin');
  if (origen) {
    try {
      return new URL(origen).host === c.url.host;
    } catch {
      return false;
    }
  }
  const sfs = c.req.headers.get('Sec-Fetch-Site');
  return !sfs || sfs === 'same-origin' || sfs === 'none';
}

// Lee el cuerpo con límite de tamaño, sin cargar más de lo permitido en memoria.
export async function leerCuerpo(req, { max, tipos }) {
  const tipo = String(req.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!tipos.includes(tipo)) throw new ErrorNegocio('TIPO_INVALIDO', 'Tipo de contenido no permitido.', 415);
  if (Number(req.headers.get('Content-Length')) > max) throw new ErrorNegocio('MUY_GRANDE', 'Solicitud demasiado grande.', 413);
  if (!req.body) return new Uint8Array(0);
  const lector = req.body.getReader();
  const partes = [];
  let total = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await lector.cancel();
      throw new ErrorNegocio('MUY_GRANDE', 'Solicitud demasiado grande.', 413);
    }
    partes.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of partes) { out.set(p, o); o += p.length; }
  return out;
}

export async function leerJSON(req, max = 32 * 1024) {
  const bytes = await leerCuerpo(req, { max, tipos: ['application/json'] });
  try {
    const obj = JSON.parse(new TextDecoder().decode(bytes) || '{}');
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error();
    return obj;
  } catch {
    throw new ErrorNegocio('JSON_INVALIDO', 'JSON inválido.', 400);
  }
}

// Enrutador mínimo con parámetros (:id) y metadatos por ruta (rol requerido).
export function crearRouter() {
  const rutas = [];
  return {
    agregar(metodo, patron, fn, opciones = {}) {
      const claves = [];
      const re = new RegExp('^' + patron.replace(/:(\w+)/g, (_, k) => (claves.push(k), '([^/]+)')) + '$');
      rutas.push({ metodo, re, claves, fn, ...opciones });
    },
    buscar(metodo, pathname) {
      let existe = false;
      for (const r of rutas) {
        const m = pathname.match(r.re);
        if (!m) continue;
        existe = true;
        if (r.metodo !== metodo && !(metodo === 'HEAD' && r.metodo === 'GET')) continue;
        const params = {};
        r.claves.forEach((k, i) => (params[k] = m[i + 1]));
        return { ruta: r, params };
      }
      return { existe };
    },
  };
}

// Rango «bytes=a-b» de una petición (Safari en iPhone sólo reproduce video si el servidor los acepta).
// Devuelve null si no hay rango, false si es inválido o múltiple, o [inicio, fin] inclusivo.
export function rangoPedido(cabecera, total) {
  if (!cabecera) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(cabecera.trim());
  if (!m || (m[1] === '' && m[2] === '')) return false;
  let inicio, fin;
  if (m[1] === '') { // sufijo: los últimos N bytes
    inicio = Math.max(0, total - Number(m[2]));
    fin = total - 1;
  } else {
    inicio = Number(m[1]);
    fin = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
  }
  return inicio <= fin && inicio < total ? [inicio, fin] : false;
}
