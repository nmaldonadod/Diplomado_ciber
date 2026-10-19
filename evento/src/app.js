'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizarRut, formatearRut } = require('./rut');
const { extraerIdentidad, PREFIJO_TICKET } = require('./qr');
const { ErrorNegocio } = require('./db');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const CABECERAS_SEGURIDAD = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
};

const SESION_ESTUDIANTE_DIAS = 60;
const SESION_STAFF_HORAS = 14;
const MAX_CUERPO = 16 * 1024;

function crearApp({ config, db, staffPin, secreto, publicDir, trustProxy = false }) {
  if (!staffPin || String(staffPin).length < 4) throw new Error('STAFF_PIN debe tener al menos 4 caracteres');
  const pinHash = crypto.createHash('sha256').update(String(staffPin)).digest();
  const clave = secreto || crypto.randomBytes(32);
  const raizPublica = path.resolve(publicDir);
  const tallerPorId = new Map((config.talleres || []).map((t) => [t.id, t]));

  // ---------- utilidades HTTP ----------

  function enviar(res, status, cuerpo, tipo = 'application/json; charset=utf-8', extra = {}) {
    const datos = typeof cuerpo === 'string' || Buffer.isBuffer(cuerpo) ? cuerpo : JSON.stringify(cuerpo);
    res.writeHead(status, { ...CABECERAS_SEGURIDAD, 'Content-Type': tipo, 'Cache-Control': 'no-store', ...extra });
    res.end(datos);
  }

  const json = (res, status, obj) => enviar(res, status, obj);
  const error = (res, status, codigo, mensaje, extra) => json(res, status, { error: codigo, mensaje, ...extra });

  function leerJSON(req) {
    return new Promise((resolve, reject) => {
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
        return reject(new ErrorNegocio('TIPO_INVALIDO', 'Se esperaba JSON.', 415));
      }
      let total = 0;
      const partes = [];
      req.on('data', (c) => {
        total += c.length;
        if (total > MAX_CUERPO) {
          reject(new ErrorNegocio('MUY_GRANDE', 'Solicitud demasiado grande.', 413));
          req.destroy();
        } else partes.push(c);
      });
      req.on('end', () => {
        try {
          const obj = JSON.parse(Buffer.concat(partes).toString('utf8') || '{}');
          if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error();
          resolve(obj);
        } catch {
          reject(new ErrorNegocio('JSON_INVALIDO', 'JSON inválido.', 400));
        }
      });
      req.on('error', reject);
    });
  }

  function leerCookies(req) {
    const out = {};
    for (const parte of (req.headers.cookie || '').split(';')) {
      const i = parte.indexOf('=');
      if (i > 0) out[parte.slice(0, i).trim()] = decodeURIComponent(parte.slice(i + 1).trim());
    }
    return out;
  }

  const esHttps = (req) => Boolean(req.socket.encrypted) || (trustProxy && req.headers['x-forwarded-proto'] === 'https');

  function cookie(req, nombre, valor, maxAgeSeg) {
    return [
      `${nombre}=${encodeURIComponent(valor)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAgeSeg}`,
      esHttps(req) ? 'Secure' : '',
    ].filter(Boolean).join('; ');
  }

  function ipCliente(req) {
    if (trustProxy && req.headers['x-forwarded-for']) return req.headers['x-forwarded-for'].split(',')[0].trim();
    return req.socket.remoteAddress || '?';
  }

  // Limitador simple de intentos por ventana de tiempo (en memoria).
  const contadores = new Map();
  function permitir(claveLimite, maximo, ventanaMs) {
    const t = Date.now();
    const c = contadores.get(claveLimite);
    if (!c || c.hasta < t) {
      contadores.set(claveLimite, { n: 1, hasta: t + ventanaMs });
      return true;
    }
    c.n += 1;
    return c.n <= maximo;
  }
  const limpieza = setInterval(() => {
    const t = Date.now();
    for (const [k, v] of contadores) if (v.hasta < t) contadores.delete(k);
  }, 60_000);
  limpieza.unref();

  // ---------- sesiones ----------

  function estudianteDe(req) {
    return db.estudiantePorSesion(leerCookies(req).sid);
  }

  function firmar(texto) {
    return crypto.createHmac('sha256', clave).update(texto).digest('base64url');
  }

  function crearCookieStaff(operador) {
    const carga = Buffer.from(JSON.stringify({ o: operador, exp: Date.now() + SESION_STAFF_HORAS * 3600_000 })).toString('base64url');
    return `${carga}.${firmar(carga)}`;
  }

  function staffDe(req) {
    const valor = leerCookies(req).staff;
    if (!valor) return null;
    const [carga, firma] = valor.split('.');
    if (!carga || !firma) return null;
    const esperada = Buffer.from(firmar(carga));
    const recibida = Buffer.from(firma);
    if (esperada.length !== recibida.length || !crypto.timingSafeEqual(esperada, recibida)) return null;
    try {
      const datos = JSON.parse(Buffer.from(carga, 'base64url').toString('utf8'));
      return datos.exp > Date.now() ? { operador: datos.o } : null;
    } catch {
      return null;
    }
  }

  // ---------- validación ----------

  function texto(valor, max) {
    if (typeof valor !== 'string') return '';
    return valor.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function validarRegistro(b, { exigirConsentimiento }) {
    const errores = {};
    const rut = normalizarRut(b.rut);
    if (!rut) errores.rut = 'RUT inválido. Revisa el dígito verificador.';
    const nombre = texto(b.nombre, 100);
    if (nombre.length < 3 || !/\p{L}/u.test(nombre)) errores.nombre = 'Ingresa tu nombre completo.';
    const email = texto(b.email, 120).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errores.email = 'Correo electrónico inválido.';
    const telefono = texto(b.telefono, 20);
    if (telefono && !/^\+?[\d\s-]{8,16}$/.test(telefono)) errores.telefono = 'Teléfono inválido.';
    const carrera = texto(b.carrera, 100);
    const sede = texto(b.sede, 80);
    if (sede && Array.isArray(config.sedes) && config.sedes.length && !config.sedes.includes(sede)) errores.sede = 'Sede inválida.';
    if (exigirConsentimiento && b.consentimiento !== true) {
      errores.consentimiento = 'Debes aceptar el tratamiento de tus datos para inscribirte.';
    }
    return { errores, datos: { rut, nombre, email, telefono, carrera, sede } };
  }

  // ---------- vistas de datos ----------

  function perfil(e) {
    return {
      nombre: e.nombre,
      rut: formatearRut(e.rut),
      email: e.email,
      telefono: e.telefono,
      carrera: e.carrera,
      sede: e.sede,
      codigo: e.codigo,
      qr: PREFIJO_TICKET + e.codigo,
      acreditadoEn: e.acreditado_en,
      talleres: db.inscripcionesDe(e.id).map((t) => t.id),
    };
  }

  function fichaStaff(e) {
    return {
      id: e.id,
      nombre: e.nombre,
      rut: formatearRut(e.rut),
      email: e.email,
      carrera: e.carrera,
      sede: e.sede,
      origen: e.origen,
      acreditadoEn: e.acreditado_en,
      acreditadoPor: e.acreditado_por,
      talleres: db.inscripcionesDe(e.id).map((t) => ({ id: t.id, titulo: t.titulo, inicio: t.inicio, sala: tallerPorId.get(t.id)?.sala })),
    };
  }

  function eventoPublico() {
    const { nombre, organiza, descripcion, lugar, direccion, dias, agenda, sedes, maxTalleresPorEstudiante, contacto } = config;
    return {
      nombre, organiza, descripcion, lugar, direccion, dias, agenda, sedes, maxTalleresPorEstudiante, contacto,
      talleres: config.talleres,
      cupos: db.cupos(),
    };
  }

  // ---------- tiempo real (Server-Sent Events) ----------

  const clientes = new Set();
  function emitirCupos() {
    const msg = `event: cupos\ndata: ${JSON.stringify(db.cupos())}\n\n`;
    for (const res of clientes) res.write(msg);
  }
  const latido = setInterval(() => {
    for (const res of clientes) res.write(': ping\n\n');
  }, 25_000);
  latido.unref();

  function stream(req, res) {
    if (clientes.size >= 5000) return error(res, 503, 'OCUPADO', 'Demasiadas conexiones, reintenta.');
    res.writeHead(200, {
      ...CABECERAS_SEGURIDAD,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 4000\nevent: cupos\ndata: ${JSON.stringify(db.cupos())}\n\n`);
    clientes.add(res);
    req.on('close', () => clientes.delete(res));
  }

  // ---------- CSV ----------

  function csv(filas, columnas) {
    const celda = (v) => {
      let s = v == null ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // evita inyección de fórmulas en Excel
      return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lineas = [columnas.map((c) => c[0]).join(';')];
    for (const f of filas) lineas.push(columnas.map((c) => celda(c[1](f))).join(';'));
    return '﻿' + lineas.join('\r\n') + '\r\n';
  }

  // ---------- rutas API ----------

  const rutas = [];
  const ruta = (metodo, patron, fn, opciones = {}) => {
    const claves = [];
    const re = new RegExp('^' + patron.replace(/:(\w+)/g, (_, k) => (claves.push(k), '([^/]+)')) + '$');
    rutas.push({ metodo, re, claves, fn, ...opciones });
  };

  ruta('GET', '/api/evento', (req, res) => json(res, 200, eventoPublico()));
  ruta('GET', '/api/cupos', (req, res) => json(res, 200, db.cupos()));
  ruta('GET', '/api/stream', stream);

  ruta('POST', '/api/registro', async (req, res) => {
    if (!permitir('reg:' + ipCliente(req), 20, 10 * 60_000)) return error(res, 429, 'DEMASIADOS_INTENTOS', 'Demasiados intentos. Espera unos minutos.');
    const { errores, datos } = validarRegistro(await leerJSON(req), { exigirConsentimiento: true });
    if (Object.keys(errores).length) return error(res, 422, 'DATOS_INVALIDOS', 'Revisa los datos ingresados.', { errores });
    const est = db.registrar(datos, 'web');
    const token = db.crearSesion(est.id);
    enviar(res, 201, JSON.stringify(perfil(est)), undefined, {
      'Set-Cookie': cookie(req, 'sid', token, SESION_ESTUDIANTE_DIAS * 86400),
    });
  });

  ruta('POST', '/api/acceso', async (req, res) => {
    if (!permitir('acc:' + ipCliente(req), 10, 10 * 60_000)) return error(res, 429, 'DEMASIADOS_INTENTOS', 'Demasiados intentos. Espera unos minutos.');
    const b = await leerJSON(req);
    const rut = normalizarRut(b.rut);
    const email = texto(b.email, 120).toLowerCase();
    const est = rut && db.porRut(rut);
    const ok = est && est.email.length === email.length &&
      crypto.timingSafeEqual(Buffer.from(est.email), Buffer.from(email));
    if (!ok) return error(res, 401, 'NO_ENCONTRADO', 'No encontramos una inscripción con ese RUT y correo.');
    const token = db.crearSesion(est.id);
    enviar(res, 200, JSON.stringify(perfil(est)), undefined, {
      'Set-Cookie': cookie(req, 'sid', token, SESION_ESTUDIANTE_DIAS * 86400),
    });
  });

  ruta('POST', '/api/salir', (req, res) => {
    const sid = leerCookies(req).sid;
    if (sid) db.cerrarSesion(sid);
    enviar(res, 200, '{"ok":true}', undefined, { 'Set-Cookie': cookie(req, 'sid', '', 0) });
  });

  ruta('GET', '/api/yo', (req, res) => {
    const est = estudianteDe(req);
    json(res, 200, est ? perfil(est) : null); // null = sin sesión (evita errores 401 en la consola)
  });

  ruta('POST', '/api/talleres/:id/inscripcion', (req, res, p) => {
    const est = estudianteDe(req);
    if (!est) return error(res, 401, 'SIN_SESION', 'Debes inscribirte en el evento antes de elegir talleres.');
    if (!permitir('ins:' + est.id, 60, 60_000)) return error(res, 429, 'DEMASIADOS_INTENTOS', 'Vas muy rápido, espera un momento.');
    db.inscribir(est.id, p.id);
    emitirCupos();
    json(res, 200, { perfil: perfil(est), cupos: db.cupos() });
  });

  ruta('DELETE', '/api/talleres/:id/inscripcion', (req, res, p) => {
    const est = estudianteDe(req);
    if (!est) return error(res, 401, 'SIN_SESION', 'No has iniciado sesión.');
    if (db.desinscribir(est.id, p.id)) emitirCupos();
    json(res, 200, { perfil: perfil(est), cupos: db.cupos() });
  });

  // ----- staff / acreditación -----

  ruta('POST', '/api/staff/login', async (req, res) => {
    if (!permitir('pin:' + ipCliente(req), 8, 5 * 60_000)) return error(res, 429, 'DEMASIADOS_INTENTOS', 'Demasiados intentos. Espera 5 minutos.');
    const b = await leerJSON(req);
    const recibido = crypto.createHash('sha256').update(String(b.pin ?? '')).digest();
    if (!crypto.timingSafeEqual(recibido, pinHash)) return error(res, 401, 'PIN_INCORRECTO', 'PIN incorrecto.');
    const operador = texto(b.operador, 40) || 'staff';
    enviar(res, 200, JSON.stringify({ operador }), undefined, {
      'Set-Cookie': cookie(req, 'staff', crearCookieStaff(operador), SESION_STAFF_HORAS * 3600),
    });
  });

  ruta('POST', '/api/staff/logout', (req, res) => {
    enviar(res, 200, '{"ok":true}', undefined, { 'Set-Cookie': cookie(req, 'staff', '', 0) });
  });

  ruta('GET', '/api/staff/yo', (req, res, p, staff) => json(res, 200, staff), { staff: true });

  ruta('POST', '/api/staff/acreditar', async (req, res, p, staff) => {
    const b = await leerJSON(req);
    let est;
    let identidad = null;
    if (Number.isInteger(b.id)) {
      est = db.porId(b.id);
    } else {
      identidad = extraerIdentidad(b.texto ?? b.rut);
      if (!identidad) return json(res, 200, { resultado: 'NO_RECONOCIDO' });
      est = identidad.tipo === 'ticket' ? db.porCodigo(identidad.codigo) : db.porRut(identidad.rut);
    }
    if (!est) {
      return json(res, 200, {
        resultado: 'NO_REGISTRADO',
        rut: identidad?.tipo === 'rut' ? formatearRut(identidad.rut) : null,
      });
    }
    const nuevo = db.acreditar(est.id, staff.operador);
    json(res, 200, {
      resultado: nuevo ? 'ACREDITADO' : 'YA_ACREDITADO',
      fuente: identidad ? (identidad.tipo === 'ticket' ? 'ticket' : identidad.fuente) : 'manual',
      estudiante: fichaStaff(db.porId(est.id)),
    });
  }, { staff: true });

  ruta('DELETE', '/api/staff/acreditacion/:id', (req, res, p) => {
    const id = Number(p.id);
    if (!Number.isInteger(id) || !db.desacreditar(id)) return error(res, 404, 'NO_ENCONTRADO', 'Estudiante no encontrado.');
    json(res, 200, { estudiante: fichaStaff(db.porId(id)) });
  }, { staff: true });

  ruta('POST', '/api/staff/registro-presencial', async (req, res, p, staff) => {
    const { errores, datos } = validarRegistro(await leerJSON(req), { exigirConsentimiento: false });
    if (Object.keys(errores).length) return error(res, 422, 'DATOS_INVALIDOS', 'Revisa los datos ingresados.', { errores });
    const est = db.registrar(datos, 'presencial');
    db.acreditar(est.id, staff.operador);
    json(res, 201, { resultado: 'ACREDITADO', estudiante: fichaStaff(db.porId(est.id)) });
  }, { staff: true });

  ruta('GET', '/api/staff/buscar', (req, res, p, staff, url) => {
    json(res, 200, db.buscar(url.searchParams.get('q') || '').map(fichaStaff));
  }, { staff: true });

  ruta('GET', '/api/staff/estadisticas', (req, res) => {
    const e = db.estadisticas();
    const cupos = db.cupos();
    json(res, 200, {
      registrados: e.registrados || 0,
      acreditados: e.acreditados || 0,
      presenciales: e.presenciales || 0,
      porSede: e.porSede,
      ultimas: e.ultimas.map((u) => ({ ...u, rut: formatearRut(u.rut) })),
      talleres: (config.talleres || []).map((t) => ({ id: t.id, titulo: t.titulo, inicio: t.inicio, sala: t.sala, ...cupos[t.id] })),
    });
  }, { staff: true });

  ruta('GET', '/api/staff/exportar/registrados.csv', (req, res) => {
    const filas = db.todos();
    const cuerpo = csv(filas, [
      ['RUT', (f) => formatearRut(f.rut)], ['Nombre', (f) => f.nombre], ['Correo', (f) => f.email],
      ['Teléfono', (f) => f.telefono], ['Carrera', (f) => f.carrera], ['Sede', (f) => f.sede],
      ['Origen', (f) => f.origen], ['Registrado', (f) => f.creado_en],
      ['Acreditado', (f) => f.acreditado_en], ['Acreditó', (f) => f.acreditado_por],
    ]);
    enviar(res, 200, cuerpo, 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="registrados.csv"' });
  }, { staff: true });

  ruta('GET', '/api/staff/exportar/inscripciones.csv', (req, res) => {
    const cuerpo = csv(db.todasInscripciones(), [
      ['Taller', (f) => f.taller_id], ['Título', (f) => f.titulo], ['Inicio', (f) => f.inicio],
      ['RUT', (f) => formatearRut(f.rut)], ['Nombre', (f) => f.nombre], ['Correo', (f) => f.email],
      ['Carrera', (f) => f.carrera], ['Sede', (f) => f.sede], ['Acreditado', (f) => f.acreditado_en],
      ['Inscrito', (f) => f.creado_en],
    ]);
    enviar(res, 200, cuerpo, 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="inscripciones-talleres.csv"' });
  }, { staff: true });

  // ---------- archivos estáticos ----------

  const ALIAS = { '/': '/index.html', '/staff': '/staff.html', '/acreditacion': '/staff.html' };

  function estatico(req, res, pathname) {
    let relativo;
    try {
      relativo = decodeURIComponent(ALIAS[pathname] || pathname);
    } catch {
      return error(res, 400, 'RUTA_INVALIDA', 'Ruta inválida.');
    }
    const archivo = path.resolve(raizPublica, '.' + relativo);
    if (!archivo.startsWith(raizPublica + path.sep)) return error(res, 404, 'NO_ENCONTRADO', 'No encontrado.');
    fs.readFile(archivo, (err, datos) => {
      if (err) return enviar(res, 404, 'No encontrado', 'text/plain; charset=utf-8');
      const ext = path.extname(archivo).toLowerCase();
      res.writeHead(200, {
        ...CABECERAS_SEGURIDAD,
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      });
      res.end(req.method === 'HEAD' ? undefined : datos);
    });
  }

  // ---------- despachador ----------

  async function handler(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return error(res, 400, 'RUTA_INVALIDA', 'Ruta inválida.');
    }
    const { pathname } = url;

    try {
      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return error(res, 405, 'METODO', 'Método no permitido.');
        return estatico(req, res, pathname);
      }

      // Protección CSRF: las peticiones que modifican estado deben venir del mismo origen.
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin) {
        let host;
        try {
          host = new URL(req.headers.origin).host;
        } catch {
          host = null;
        }
        if (host !== req.headers.host) return error(res, 403, 'ORIGEN', 'Origen no permitido.');
      }

      let encontradaRuta = false;
      for (const r of rutas) {
        const m = pathname.match(r.re);
        if (!m) continue;
        encontradaRuta = true;
        if (r.metodo !== req.method) continue;
        const params = {};
        r.claves.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        let staff = null;
        if (r.staff) {
          staff = staffDe(req);
          if (!staff) return error(res, 401, 'SIN_SESION_STAFF', 'Sesión de staff requerida.');
        }
        return await r.fn(req, res, params, staff, url);
      }
      return encontradaRuta
        ? error(res, 405, 'METODO', 'Método no permitido.')
        : error(res, 404, 'NO_ENCONTRADO', 'Recurso no encontrado.');
    } catch (e) {
      if (e instanceof ErrorNegocio) {
        if (!res.headersSent) error(res, e.status, e.codigo, e.message);
        return;
      }
      console.error(e);
      if (!res.headersSent) error(res, 500, 'ERROR_INTERNO', 'Ocurrió un error inesperado.');
    }
  }

  function cerrar() {
    clearInterval(latido);
    clearInterval(limpieza);
    for (const res of clientes) res.end();
    clientes.clear();
  }

  return { handler, cerrar };
}

module.exports = { crearApp };
