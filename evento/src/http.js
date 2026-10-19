'use strict';

const { ErrorNegocio } = require('./db');

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

function cabecerasSeguridad(https) {
  const h = {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()',
  };
  if (https) h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return h;
}

function crearHttp({ trustProxy }) {
  const esHttps = (req) => Boolean(req.socket.encrypted) || (trustProxy && req.headers['x-forwarded-proto'] === 'https');

  function enviar(req, res, status, cuerpo, tipo = 'application/json; charset=utf-8', extra = {}) {
    const datos = typeof cuerpo === 'string' || Buffer.isBuffer(cuerpo) ? cuerpo : JSON.stringify(cuerpo);
    res.writeHead(status, { ...cabecerasSeguridad(esHttps(req)), 'Content-Type': tipo, 'Cache-Control': 'no-store', ...extra });
    res.end(req.method === 'HEAD' ? undefined : datos);
  }

  function leerCuerpo(req, { max, tipos }) {
    return new Promise((resolve, reject) => {
      const tipo = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!tipos.includes(tipo)) return reject(new ErrorNegocio('TIPO_INVALIDO', 'Tipo de contenido no permitido.', 415));
      const declarado = Number(req.headers['content-length']);
      if (declarado > max) return reject(new ErrorNegocio('MUY_GRANDE', 'Solicitud demasiado grande.', 413));
      let total = 0;
      const partes = [];
      req.on('data', (c) => {
        total += c.length;
        if (total > max) {
          reject(new ErrorNegocio('MUY_GRANDE', 'Solicitud demasiado grande.', 413));
          req.destroy();
        } else partes.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(partes)));
      req.on('error', reject);
    });
  }

  async function leerJSON(req) {
    const buf = await leerCuerpo(req, { max: 32 * 1024, tipos: ['application/json'] });
    try {
      const obj = JSON.parse(buf.toString('utf8') || '{}');
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error();
      return obj;
    } catch {
      throw new ErrorNegocio('JSON_INVALIDO', 'JSON inválido.', 400);
    }
  }

  function leerCookies(req) {
    const out = {};
    for (const parte of String(req.headers.cookie || '').split(';')) {
      const i = parte.indexOf('=');
      if (i <= 0) continue;
      try {
        out[parte.slice(0, i).trim()] = decodeURIComponent(parte.slice(i + 1).trim());
      } catch { /* cookie mal formada: se ignora */ }
    }
    return out;
  }

  // Bajo HTTPS se usa el prefijo __Host- (obliga Secure, Path=/ y sin Domain).
  const nombreCookie = (req, base) => (esHttps(req) ? `__Host-${base}` : base);
  const leerCookie = (req, base) => leerCookies(req)[nombreCookie(req, base)];

  function cookie(req, base, valor, { maxAge, sameSite = 'Lax' }) {
    return [
      `${nombreCookie(req, base)}=${encodeURIComponent(valor)}`, 'Path=/', 'HttpOnly', `SameSite=${sameSite}`,
      `Max-Age=${maxAge}`, esHttps(req) ? 'Secure' : '',
    ].filter(Boolean).join('; ');
  }

  function ip(req) {
    if (trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim().slice(0, 64);
    return req.socket.remoteAddress || '?';
  }

  // Protección CSRF: las peticiones que modifican datos deben originarse en este mismo sitio.
  function mismoOrigen(req) {
    const origen = req.headers.origin;
    if (origen) {
      try {
        return new URL(origen).host === req.headers.host;
      } catch {
        return false;
      }
    }
    const sfs = req.headers['sec-fetch-site'];
    return !sfs || sfs === 'same-origin' || sfs === 'none';
  }

  return { esHttps, enviar, leerCuerpo, leerJSON, leerCookie, cookie, ip, mismoOrigen };
}

// Enrutador mínimo con parámetros (:id) y metadatos por ruta (rol requerido, etc.).
function crearRouter() {
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

module.exports = { crearHttp, crearRouter, cabecerasSeguridad };
