'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ErrorNegocio } = require('./db');
const { crearHttp, crearRouter, cabecerasSeguridad } = require('./http');
const { extraerIdentidad, PREFIJO_TICKET } = require('./qr');
const seg = require('./seguridad');
const v = require('./validacion');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const PAGINAS = { '/': 'index.html', '/acreditacion': 'acreditacion.html', '/admin': 'admin.html', '/privacidad': 'privacidad.html' };

const SESION = {
  estudianteDias: 30,
  admin: { horas: 8, inactividadMin: 60 },
  acreditador: { horas: 12, inactividadMin: 180 },
};

function crearApp({ db, publicDir, fotosDir, trustProxy = false, tokenInicial = null }) {
  const http = crearHttp({ trustProxy });
  const router = crearRouter();
  const limitador = seg.crearLimitador();
  const raizPublica = path.resolve(publicDir);
  fs.mkdirSync(fotosDir, { recursive: true, mode: 0o700 });

  const json = (req, res, status, obj, extra) => http.enviar(req, res, status, obj, undefined, extra);
  const fallo = (codigo, mensaje, status) => new ErrorNegocio(codigo, mensaje, status);
  const errValidacion = (errores) => Object.assign(fallo('DATOS_INVALIDOS', 'Revisa los datos ingresados.', 422), { errores });

  function limitar(clave, max, ventanaMs) {
    if (!limitador.permitir(clave, max, ventanaMs)) throw fallo('DEMASIADOS_INTENTOS', 'Demasiados intentos. Espera unos minutos.', 429);
  }

  const audit = (req, actor, accion, detalle) => db.auditoria.registrar(actor, accion, detalle, http.ip(req));
  const actorDe = (u) => `${u.rol}:${u.id} ${u.email}`;

  // ---------- vistas de datos (minimización según quién consulta) ----------

  const fotoUrl = (t) => (t.foto ? `/fotos/${t.foto}` : null);
  const tallerPublico = (t) => ({ ...t, foto: fotoUrl(t), publicado: Boolean(t.publicado) });

  function enmascararEmail(email) {
    const [u, d] = String(email).split('@');
    return `${u.slice(0, 2)}${'•'.repeat(Math.max(2, Math.min(u.length - 2, 6)))}@${d}`;
  }

  function perfil(e) {
    return {
      nombres: e.nombres,
      apellidos: e.apellidos,
      sede: e.sede,
      email: e.email,
      telefono: e.telefono,
      codigo: e.codigo,
      qr: PREFIJO_TICKET + e.codigo,
      acreditadoEn: e.acreditado_en,
      talleres: db.inscripciones.de(e.id).map((t) => t.id),
    };
  }

  // Lo que ve el acreditador: lo mínimo para identificar y orientar al estudiante.
  function fichaAcreditador(e) {
    return {
      id: e.id,
      nombres: e.nombres,
      apellidos: e.apellidos,
      sede: e.sede,
      email: enmascararEmail(e.email),
      acreditadoEn: e.acreditado_en,
      talleres: db.inscripciones.de(e.id),
    };
  }

  function fichaAdmin(e) {
    return {
      ...fichaAcreditador(e),
      email: e.email,
      telefono: e.telefono,
      origen: e.origen,
      creadoEn: e.creado_en,
      consentimientoEn: e.consentimiento_en,
    };
  }

  function eventoPublico() {
    const ev = db.evento.get();
    return {
      configurado: Boolean(ev),
      evento: ev && {
        nombre: ev.nombre, lema: ev.lema, descripcion: ev.descripcion, lugar: ev.lugar, direccion: ev.direccion, contacto: ev.contacto,
        fechaInicio: ev.fecha_inicio, fechaFin: ev.fecha_fin, maxTalleres: ev.max_talleres,
        inscripcionesAbiertas: Boolean(ev.inscripciones_abiertas), talleresAbiertos: Boolean(ev.talleres_abiertos),
      },
      sedes: v.SEDES,
      dominioCorreo: v.DOMINIO_CORREO,
      agenda: db.agenda.listar(),
      talleres: db.talleres.listar(true).map(tallerPublico),
      cupos: db.talleres.cupos(),
    };
  }

  // ---------- sesiones ----------

  const estudianteDe = (req) => db.sesiones.estudiante(http.leerCookie(req, 'sid'));

  const INACTIVIDAD = { admin: SESION.admin.inactividadMin, acreditador: SESION.acreditador.inactividadMin };
  const usuarioDe = (req) => db.sesiones.usuario(http.leerCookie(req, 'ses'), INACTIVIDAD);

  // ---------- tiempo real (SSE) ----------

  const clientes = new Set();
  function emitirCupos() {
    const msg = `event: cupos\ndata: ${JSON.stringify(db.talleres.cupos())}\n\n`;
    for (const res of clientes) res.write(msg);
  }
  function emitirEvento() {
    for (const res of clientes) res.write('event: evento\ndata: {}\n\n');
  }
  const latido = setInterval(() => {
    for (const res of clientes) res.write(': ping\n\n');
    db.sesiones.purgarExpiradas();
  }, 25_000);
  latido.unref();

  // ---------- CSV (protegido contra inyección de fórmulas) ----------

  function csv(filas, columnas) {
    const celda = (valor) => {
      let s = valor == null ? '' : String(valor);
      if (/^[=+\-@\t\r|%]/.test(s)) s = "'" + s;
      return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lineas = [columnas.map((c) => c[0]).join(';')];
    for (const f of filas) lineas.push(columnas.map((c) => celda(c[1](f))).join(';'));
    return '﻿' + lineas.join('\r\n') + '\r\n';
  }

  // Sin el "+56" inicial: un "+" al inicio de una celda se interpreta como fórmula en planillas.
  const telefonoLocal = (t) => String(t || '').replace(/^\+56/, '');

  const id = (valor) => {
    const n = Number(valor);
    if (!Number.isInteger(n) || n <= 0) throw fallo('NO_ENCONTRADO', 'Recurso no encontrado.', 404);
    return n;
  };

  const R = (metodo, patron, fn, opciones) => router.agregar(metodo, patron, fn, opciones);

  // =====================================================================
  // Público
  // =====================================================================

  R('GET', '/api/evento', (req, res) => json(req, res, 200, eventoPublico()));
  R('GET', '/api/cupos', (req, res) => json(req, res, 200, db.talleres.cupos()));

  R('GET', '/api/stream', (req, res) => {
    if (clientes.size >= 5000) throw fallo('OCUPADO', 'Demasiadas conexiones, reintenta.', 503);
    res.writeHead(200, {
      ...cabecerasSeguridad(http.esHttps(req)),
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 4000\nevent: cupos\ndata: ${JSON.stringify(db.talleres.cupos())}\n\n`);
    clientes.add(res);
    req.on('close', () => clientes.delete(res));
  });

  // =====================================================================
  // Estudiantes
  // =====================================================================

  function abrirSesionEstudiante(req, est) {
    const token = db.sesiones.crearEstudiante(est.id, SESION.estudianteDias);
    return { 'Set-Cookie': http.cookie(req, 'sid', token, { maxAge: SESION.estudianteDias * 86400 }) };
  }

  R('POST', '/api/registro', async (req, res) => {
    limitar('registro:' + http.ip(req), 60, 10 * 60_000);
    const ev = db.evento.get();
    if (!ev?.inscripciones_abiertas) throw fallo('INSCRIPCIONES_CERRADAS', 'Las inscripciones al evento están cerradas.');
    const b = await http.leerJSON(req);
    const { errores, datos } = v.validarRegistro(b);
    if (b.consentimiento !== true) errores.consentimiento = 'Debes aceptar el tratamiento de tus datos para inscribirte.';
    if (v.hayErrores(errores)) throw errValidacion(errores);

    const codigoAcceso = seg.codigoAleatorio(8);
    const est = db.estudiantes.crear(datos, await seg.hashClave(codigoAcceso), 'web');
    audit(req, `estudiante:${est.id}`, 'registro', null);

    // Talleres elegidos en el mismo formulario (opcional). Si alguno falla, la inscripción al evento igual queda hecha.
    const rechazados = [];
    const pedidos = Array.isArray(b.talleres) ? [...new Set(b.talleres)].slice(0, 20) : [];
    for (const tid of pedidos) {
      try {
        db.inscripciones.inscribir(est.id, id(tid));
      } catch (e) {
        if (!(e instanceof ErrorNegocio)) throw e;
        rechazados.push({ id: tid, motivo: e.message });
      }
    }
    if (pedidos.length) emitirCupos();
    json(req, res, 201, { perfil: perfil(est), codigoAcceso, rechazados }, abrirSesionEstudiante(req, est));
  });

  R('POST', '/api/acceso', async (req, res) => {
    limitar('acceso:' + http.ip(req), 30, 10 * 60_000);
    const b = await http.leerJSON(req);
    const email = v.correoInstitucional(b.email);
    const codigo = String(b.codigo || '').toUpperCase().replace(/[\s-]/g, '').slice(0, 16);
    const est = email && db.estudiantes.porEmail(email);
    const noValido = () => fallo('ACCESO_INVALIDO', 'Correo o código de acceso incorrecto.', 401);
    if (!est) {
      await seg.verificarFicticio(codigo);
      throw noValido();
    }
    if (est.acceso_bloqueado_hasta && Date.parse(est.acceso_bloqueado_hasta) > Date.now()) {
      throw fallo('BLOQUEADO', 'Demasiados intentos fallidos. Intenta en 15 minutos o pide ayuda en la acreditación.', 429);
    }
    if (!(await seg.verificarClave(codigo, est.acceso_hash))) {
      db.estudiantes.registrarFalloAcceso(est.id);
      throw noValido();
    }
    db.estudiantes.accesoCorrecto(est.id);
    json(req, res, 200, perfil(est), abrirSesionEstudiante(req, est));
  });

  R('POST', '/api/salir', (req, res) => {
    const sid = http.leerCookie(req, 'sid');
    if (sid) db.sesiones.cerrarEstudiante(sid);
    json(req, res, 200, { ok: true }, { 'Set-Cookie': http.cookie(req, 'sid', '', { maxAge: 0 }) });
  });

  R('GET', '/api/yo', (req, res) => {
    const est = estudianteDe(req);
    json(req, res, 200, est ? perfil(est) : null);
  });

  R('POST', '/api/talleres/:id/inscripcion', (req, res, p) => {
    const est = estudianteDe(req);
    if (!est) throw fallo('SIN_SESION', 'Debes inscribirte en el evento antes de elegir talleres.', 401);
    limitar('insc:' + est.id, 40, 60_000);
    db.inscripciones.inscribir(est.id, id(p.id));
    emitirCupos();
    json(req, res, 200, { perfil: perfil(est), cupos: db.talleres.cupos() });
  });

  R('DELETE', '/api/talleres/:id/inscripcion', (req, res, p) => {
    const est = estudianteDe(req);
    if (!est) throw fallo('SIN_SESION', 'No has iniciado sesión.', 401);
    limitar('insc:' + est.id, 40, 60_000);
    if (db.inscripciones.cancelar(est.id, id(p.id))) emitirCupos();
    json(req, res, 200, { perfil: perfil(est), cupos: db.talleres.cupos() });
  });

  // =====================================================================
  // Cuentas de staff (administrador y acreditador)
  // =====================================================================

  R('GET', '/api/staff/yo', (req, res) => {
    const u = usuarioDe(req);
    json(req, res, 200, { usuario: u, requiereConfiguracion: !db.usuarios.hayAdmin() });
  });

  // Primer administrador: requiere el token de un solo uso que el servidor muestra en consola.
  R('POST', '/api/staff/configuracion-inicial', async (req, res) => {
    limitar('setup:' + http.ip(req), 5, 15 * 60_000);
    if (db.usuarios.hayAdmin() || !tokenInicial) throw fallo('YA_CONFIGURADO', 'La plataforma ya tiene un administrador.', 403);
    const b = await http.leerJSON(req);
    const a = Buffer.from(seg.sha256(String(b.token || '')));
    const t = Buffer.from(seg.sha256(tokenInicial));
    if (!crypto.timingSafeEqual(a, t)) throw fallo('TOKEN_INVALIDO', 'Token de configuración incorrecto.', 401);
    const { errores, datos } = v.validarUsuario({ ...b, rol: 'admin' }, { exigirClave: true });
    if (v.hayErrores(errores)) throw errValidacion(errores);
    const u = db.usuarios.crear(datos, await seg.hashClave(datos.clave));
    audit(req, actorDe(u), 'configuracion_inicial', null);
    json(req, res, 201, { ok: true });
  });

  R('POST', '/api/staff/login', async (req, res) => {
    limitar('login:' + http.ip(req), 15, 15 * 60_000);
    const b = await http.leerJSON(req);
    const email = v.linea(b.email, 120).toLowerCase();
    const clave = typeof b.clave === 'string' ? b.clave.slice(0, 200) : '';
    const u = db.usuarios.conClave(email);
    const invalido = () => fallo('CREDENCIALES', 'Correo o contraseña incorrectos.', 401);
    if (!u || !u.activo) {
      await seg.verificarFicticio(clave);
      audit(req, 'anonimo', 'login_fallido', email.slice(0, 120));
      throw invalido();
    }
    if (u.bloqueado_hasta && Date.parse(u.bloqueado_hasta) > Date.now()) {
      audit(req, actorDe(u), 'login_bloqueado', null);
      throw fallo('BLOQUEADO', 'Cuenta bloqueada temporalmente por intentos fallidos.', 429);
    }
    if (!(await seg.verificarClave(clave, u.clave_hash))) {
      db.usuarios.registrarFallo(u.id);
      audit(req, actorDe(u), 'login_fallido', null);
      throw invalido();
    }
    db.usuarios.accesoCorrecto(u.id);
    const conf = SESION[u.rol];
    const token = db.sesiones.crearUsuario(u.id, conf.horas);
    audit(req, actorDe(u), 'login', null);
    json(req, res, 200, { usuario: db.usuarios.porId(u.id) }, {
      'Set-Cookie': http.cookie(req, 'ses', token, { maxAge: conf.horas * 3600, sameSite: 'Strict' }),
    });
  });

  R('POST', '/api/staff/logout', (req, res) => {
    const token = http.leerCookie(req, 'ses');
    if (token) db.sesiones.cerrarUsuario(token);
    json(req, res, 200, { ok: true }, { 'Set-Cookie': http.cookie(req, 'ses', '', { maxAge: 0, sameSite: 'Strict' }) });
  });

  R('POST', '/api/staff/clave', async (req, res, p, u) => {
    limitar('clave:' + u.id, 5, 15 * 60_000);
    const b = await http.leerJSON(req);
    const actual = db.usuarios.conClave(u.email);
    if (!(await seg.verificarClave(String(b.actual || ''), actual.clave_hash))) throw fallo('CREDENCIALES', 'La contraseña actual no es correcta.', 401);
    const e = v.validarClave(b.nueva);
    if (e) throw errValidacion({ nueva: e });
    db.usuarios.cambiarClave(u.id, await seg.hashClave(b.nueva));
    db.sesiones.cerrarTodasUsuario(u.id);
    audit(req, actorDe(u), 'cambio_clave', null);
    json(req, res, 200, { ok: true }, { 'Set-Cookie': http.cookie(req, 'ses', '', { maxAge: 0, sameSite: 'Strict' }) });
  }, { rol: 'acreditador' });

  // =====================================================================
  // Acreditación (rol acreditador o admin)
  // =====================================================================

  R('POST', '/api/acreditacion/acreditar', async (req, res, p, u) => {
    limitar('acred:' + u.id, 120, 60_000);
    const b = await http.leerJSON(req);
    let est;
    let fuente = 'manual';
    if (Number.isInteger(b.id)) {
      est = db.estudiantes.porId(b.id);
    } else {
      const ident = extraerIdentidad(b.texto);
      if (!ident) return json(req, res, 200, { resultado: 'NO_RECONOCIDO' });
      fuente = ident.tipo;
      est = ident.tipo === 'ticket' ? db.estudiantes.porCodigo(ident.codigo) : db.estudiantes.porEmail(ident.email);
      if (!est) return json(req, res, 200, { resultado: 'NO_REGISTRADO', email: ident.email || null });
    }
    if (!est) throw fallo('NO_ENCONTRADO', 'Estudiante no encontrado.', 404);
    const nuevo = db.estudiantes.acreditar(est.id, u.id);
    if (nuevo) audit(req, actorDe(u), 'acreditar', `estudiante:${est.id} (${fuente})`);
    json(req, res, 200, { resultado: nuevo ? 'ACREDITADO' : 'YA_ACREDITADO', estudiante: fichaAcreditador(db.estudiantes.porId(est.id)) });
  }, { rol: 'acreditador' });

  R('DELETE', '/api/acreditacion/:id', (req, res, p, u) => {
    const eid = id(p.id);
    if (!db.estudiantes.desacreditar(eid)) throw fallo('NO_ENCONTRADO', 'Estudiante no encontrado.', 404);
    audit(req, actorDe(u), 'deshacer_acreditacion', `estudiante:${eid}`);
    json(req, res, 200, { estudiante: fichaAcreditador(db.estudiantes.porId(eid)) });
  }, { rol: 'acreditador' });

  R('GET', '/api/acreditacion/buscar', (req, res, p, u, url) => {
    limitar('buscar:' + u.id, 120, 60_000);
    const q = url.searchParams.get('q') || '';
    if (q.trim().length < 2) return json(req, res, 200, []);
    json(req, res, 200, db.estudiantes.buscar({ q, limite: 25 }).filas.map(fichaAcreditador));
  }, { rol: 'acreditador' });

  R('GET', '/api/acreditacion/resumen', (req, res) => {
    const e = db.estadisticas();
    json(req, res, 200, { registrados: e.registrados, acreditados: e.acreditados });
  }, { rol: 'acreditador' });

  R('POST', '/api/acreditacion/registro-presencial', async (req, res, p, u) => {
    const b = await http.leerJSON(req);
    const { errores, datos } = v.validarRegistro(b);
    if (b.consentimiento !== true) errores.consentimiento = 'Confirma que el estudiante aceptó el tratamiento de sus datos.';
    if (v.hayErrores(errores)) throw errValidacion(errores);
    const codigoAcceso = seg.codigoAleatorio(8);
    const est = db.estudiantes.crear(datos, await seg.hashClave(codigoAcceso), 'presencial');
    db.estudiantes.acreditar(est.id, u.id);
    audit(req, actorDe(u), 'registro_presencial', `estudiante:${est.id}`);
    json(req, res, 201, { resultado: 'ACREDITADO', codigoAcceso, estudiante: fichaAcreditador(db.estudiantes.porId(est.id)) });
  }, { rol: 'acreditador' });

  // =====================================================================
  // Administración (sólo rol admin)
  // =====================================================================

  const ADMIN = { rol: 'admin' };

  R('GET', '/api/admin/resumen', (req, res) => {
    const ev = db.evento.get();
    json(req, res, 200, {
      evento: ev,
      ...db.estadisticas(),
      talleres: db.talleres.listar(false).map(conInscritos),
    });
  }, ADMIN);

  R('PUT', '/api/admin/evento', async (req, res, p, u) => {
    const { errores, datos } = v.validarEvento(await http.leerJSON(req));
    if (v.hayErrores(errores)) throw errValidacion(errores);
    const ev = db.evento.guardar(datos);
    audit(req, actorDe(u), 'evento_actualizado', null);
    emitirEvento();
    json(req, res, 200, ev);
  }, ADMIN);

  // ----- talleres -----
  function conInscritos(t) {
    return { ...tallerPublico(t), inscritos: db.db.prepare('SELECT COUNT(*) AS n FROM inscripciones WHERE taller_id = ?').get(t.id).n };
  }

  R('GET', '/api/admin/talleres', (req, res) => json(req, res, 200, db.talleres.listar(false).map(conInscritos)), ADMIN);

  R('POST', '/api/admin/talleres', async (req, res, p, u) => {
    const { errores, datos } = v.validarTaller(await http.leerJSON(req));
    if (v.hayErrores(errores)) throw errValidacion(errores);
    const t = db.talleres.crear(datos);
    audit(req, actorDe(u), 'taller_creado', `taller:${t.id} ${t.titulo}`);
    emitirEvento();
    emitirCupos();
    json(req, res, 201, conInscritos(t));
  }, ADMIN);

  R('PUT', '/api/admin/talleres/:id', async (req, res, p, u) => {
    const tid = id(p.id);
    if (!db.talleres.get(tid)) throw fallo('NO_ENCONTRADO', 'Taller no encontrado.', 404);
    const { errores, datos } = v.validarTaller(await http.leerJSON(req));
    if (v.hayErrores(errores)) throw errValidacion(errores);
    const t = db.talleres.actualizar(tid, datos);
    audit(req, actorDe(u), 'taller_actualizado', `taller:${tid}`);
    emitirEvento();
    emitirCupos();
    json(req, res, 200, conInscritos(t));
  }, ADMIN);

  function borrarFoto(nombre) {
    if (nombre && /^[a-f0-9]{32}\.jpg$/.test(nombre)) fs.rm(path.join(fotosDir, nombre), { force: true }, () => {});
  }

  R('DELETE', '/api/admin/talleres/:id', (req, res, p, u) => {
    const tid = id(p.id);
    const t = db.talleres.get(tid);
    if (!t) throw fallo('NO_ENCONTRADO', 'Taller no encontrado.', 404);
    db.talleres.eliminar(tid);
    borrarFoto(t.foto);
    audit(req, actorDe(u), 'taller_eliminado', `taller:${tid} ${t.titulo}`);
    emitirEvento();
    emitirCupos();
    json(req, res, 200, { ok: true });
  }, ADMIN);

  // Foto del docente: sólo JPEG (el navegador la redimensiona y convierte), máx. 2 MB, sin metadatos.
  R('PUT', '/api/admin/talleres/:id/foto', async (req, res, p, u) => {
    const tid = id(p.id);
    const t = db.talleres.get(tid);
    if (!t) throw fallo('NO_ENCONTRADO', 'Taller no encontrado.', 404);
    const crudo = await http.leerCuerpo(req, { max: 2 * 1024 * 1024, tipos: ['image/jpeg'] });
    const limpio = seg.limpiarJPEG(crudo);
    if (!limpio) throw fallo('IMAGEN_INVALIDA', 'La imagen no es un JPEG válido.', 422);
    const nombre = crypto.randomBytes(16).toString('hex') + '.jpg';
    await fs.promises.writeFile(path.join(fotosDir, nombre), limpio, { mode: 0o600, flag: 'wx' });
    db.talleres.ponerFoto(tid, nombre);
    borrarFoto(t.foto);
    audit(req, actorDe(u), 'taller_foto', `taller:${tid}`);
    emitirEvento();
    json(req, res, 200, conInscritos(db.talleres.get(tid)));
  }, ADMIN);

  R('DELETE', '/api/admin/talleres/:id/foto', (req, res, p, u) => {
    const tid = id(p.id);
    const t = db.talleres.get(tid);
    if (!t) throw fallo('NO_ENCONTRADO', 'Taller no encontrado.', 404);
    db.talleres.ponerFoto(tid, null);
    borrarFoto(t.foto);
    audit(req, actorDe(u), 'taller_foto_eliminada', `taller:${tid}`);
    emitirEvento();
    json(req, res, 200, conInscritos(db.talleres.get(tid)));
  }, ADMIN);

  R('GET', '/api/admin/talleres/:id/inscritos', (req, res, p) => {
    json(req, res, 200, db.talleres.inscritos(id(p.id)).map(fichaAdmin));
  }, ADMIN);

  // ----- agenda -----
  R('GET', '/api/admin/agenda', (req, res) => json(req, res, 200, db.agenda.listar()), ADMIN);

  R('POST', '/api/admin/agenda', async (req, res, p, u) => {
    const { errores, datos } = v.validarAgenda(await http.leerJSON(req));
    if (v.hayErrores(errores)) throw errValidacion(errores);
    const a = db.agenda.crear(datos);
    audit(req, actorDe(u), 'agenda_creada', `agenda:${a.id}`);
    emitirEvento();
    json(req, res, 201, a);
  }, ADMIN);

  R('PUT', '/api/admin/agenda/:id', async (req, res, p, u) => {
    const aid = id(p.id);
    if (!db.agenda.get(aid)) throw fallo('NO_ENCONTRADO', 'Actividad no encontrada.', 404);
    const { errores, datos } = v.validarAgenda(await http.leerJSON(req));
    if (v.hayErrores(errores)) throw errValidacion(errores);
    const a = db.agenda.actualizar(aid, datos);
    audit(req, actorDe(u), 'agenda_actualizada', `agenda:${aid}`);
    emitirEvento();
    json(req, res, 200, a);
  }, ADMIN);

  R('DELETE', '/api/admin/agenda/:id', (req, res, p, u) => {
    const aid = id(p.id);
    if (!db.agenda.eliminar(aid)) throw fallo('NO_ENCONTRADO', 'Actividad no encontrada.', 404);
    audit(req, actorDe(u), 'agenda_eliminada', `agenda:${aid}`);
    emitirEvento();
    json(req, res, 200, { ok: true });
  }, ADMIN);

  // ----- estudiantes -----
  R('GET', '/api/admin/estudiantes', (req, res, p, u, url) => {
    const s = url.searchParams;
    const r = db.estudiantes.buscar({
      q: s.get('q') || '', sede: v.SEDES.includes(s.get('sede')) ? s.get('sede') : '',
      estado: s.get('estado') || '', limite: 50, desde: Number(s.get('desde')) || 0,
    });
    json(req, res, 200, { total: r.total, filas: r.filas.map(fichaAdmin) });
  }, ADMIN);

  R('GET', '/api/admin/estudiantes/:id', (req, res, p) => {
    const e = db.estudiantes.porId(id(p.id));
    if (!e) throw fallo('NO_ENCONTRADO', 'Estudiante no encontrado.', 404);
    json(req, res, 200, fichaAdmin(e));
  }, ADMIN);

  R('DELETE', '/api/admin/estudiantes/:id', (req, res, p, u) => {
    const eid = id(p.id);
    if (!db.estudiantes.eliminar(eid)) throw fallo('NO_ENCONTRADO', 'Estudiante no encontrado.', 404);
    audit(req, actorDe(u), 'estudiante_eliminado', `estudiante:${eid}`);
    emitirCupos();
    json(req, res, 200, { ok: true });
  }, ADMIN);

  R('POST', '/api/admin/estudiantes/:id/codigo-acceso', async (req, res, p, u) => {
    const eid = id(p.id);
    if (!db.estudiantes.porId(eid)) throw fallo('NO_ENCONTRADO', 'Estudiante no encontrado.', 404);
    const codigoAcceso = seg.codigoAleatorio(8);
    db.estudiantes.cambiarAcceso(eid, await seg.hashClave(codigoAcceso));
    db.sesiones.cerrarTodasEstudiante(eid);
    audit(req, actorDe(u), 'codigo_acceso_regenerado', `estudiante:${eid}`);
    json(req, res, 200, { codigoAcceso });
  }, ADMIN);

  R('POST', '/api/admin/estudiantes/:id/talleres/:tid', (req, res, p, u) => {
    const eid = id(p.id);
    if (!db.estudiantes.porId(eid)) throw fallo('NO_ENCONTRADO', 'Estudiante no encontrado.', 404);
    db.inscripciones.inscribir(eid, id(p.tid), { forzar: true });
    audit(req, actorDe(u), 'inscripcion_admin', `estudiante:${eid} taller:${p.tid}`);
    emitirCupos();
    json(req, res, 200, fichaAdmin(db.estudiantes.porId(eid)));
  }, ADMIN);

  R('DELETE', '/api/admin/estudiantes/:id/talleres/:tid', (req, res, p, u) => {
    const eid = id(p.id);
    if (!db.estudiantes.porId(eid)) throw fallo('NO_ENCONTRADO', 'Estudiante no encontrado.', 404);
    if (db.inscripciones.cancelar(eid, id(p.tid), { forzar: true })) emitirCupos();
    audit(req, actorDe(u), 'desinscripcion_admin', `estudiante:${eid} taller:${p.tid}`);
    json(req, res, 200, fichaAdmin(db.estudiantes.porId(eid)));
  }, ADMIN);

  // Eliminación masiva al terminar el evento (derecho de supresión / retención mínima).
  R('POST', '/api/admin/estudiantes/eliminar-todos', async (req, res, p, u) => {
    const b = await http.leerJSON(req);
    if (b.confirmacion !== 'ELIMINAR TODO') throw errValidacion({ confirmacion: 'Escribe ELIMINAR TODO para confirmar.' });
    const actual = db.usuarios.conClave(u.email);
    if (!(await seg.verificarClave(String(b.clave || ''), actual.clave_hash))) throw fallo('CREDENCIALES', 'Contraseña incorrecta.', 401);
    const n = db.estudiantes.eliminarTodos();
    audit(req, actorDe(u), 'estudiantes_eliminados_todos', `${n} registros`);
    emitirCupos();
    json(req, res, 200, { eliminados: n });
  }, ADMIN);

  // ----- usuarios -----
  R('GET', '/api/admin/usuarios', (req, res) => json(req, res, 200, db.usuarios.listar()), ADMIN);

  R('POST', '/api/admin/usuarios', async (req, res, p, u) => {
    const { errores, datos } = v.validarUsuario(await http.leerJSON(req), { exigirClave: true });
    if (v.hayErrores(errores)) throw errValidacion(errores);
    const nuevo = db.usuarios.crear(datos, await seg.hashClave(datos.clave));
    audit(req, actorDe(u), 'usuario_creado', `${nuevo.rol}:${nuevo.id} ${nuevo.email}`);
    json(req, res, 201, nuevo);
  }, ADMIN);

  R('PUT', '/api/admin/usuarios/:id', async (req, res, p, u) => {
    const uid = id(p.id);
    const actual = db.usuarios.porId(uid);
    if (!actual) throw fallo('NO_ENCONTRADO', 'Usuario no encontrado.', 404);
    const b = await http.leerJSON(req);
    const nombre = v.linea(b.nombre, 80) || actual.nombre;
    const rol = v.ROLES.includes(b.rol) ? b.rol : actual.rol;
    const activo = typeof b.activo === 'boolean' ? b.activo : Boolean(actual.activo);
    const dejaDeSerAdmin = actual.rol === 'admin' && actual.activo && (rol !== 'admin' || !activo);
    if (dejaDeSerAdmin && db.usuarios.adminsActivos() <= 1) throw fallo('ULTIMO_ADMIN', 'Debe quedar al menos un administrador activo.');
    db.usuarios.actualizar(uid, { nombre, rol, activo });
    if (!activo || rol !== actual.rol) db.sesiones.cerrarTodasUsuario(uid);
    audit(req, actorDe(u), 'usuario_actualizado', `usuario:${uid} rol=${rol} activo=${activo}`);
    json(req, res, 200, db.usuarios.porId(uid));
  }, ADMIN);

  R('POST', '/api/admin/usuarios/:id/clave', async (req, res, p, u) => {
    const uid = id(p.id);
    if (!db.usuarios.porId(uid)) throw fallo('NO_ENCONTRADO', 'Usuario no encontrado.', 404);
    const b = await http.leerJSON(req);
    const e = v.validarClave(b.clave);
    if (e) throw errValidacion({ clave: e });
    db.usuarios.cambiarClave(uid, await seg.hashClave(b.clave));
    db.sesiones.cerrarTodasUsuario(uid);
    audit(req, actorDe(u), 'usuario_clave_restablecida', `usuario:${uid}`);
    json(req, res, 200, { ok: true });
  }, ADMIN);

  R('DELETE', '/api/admin/usuarios/:id', (req, res, p, u) => {
    const uid = id(p.id);
    const actual = db.usuarios.porId(uid);
    if (!actual) throw fallo('NO_ENCONTRADO', 'Usuario no encontrado.', 404);
    if (uid === u.id) throw fallo('NO_PERMITIDO', 'No puedes eliminar tu propia cuenta.');
    if (actual.rol === 'admin' && actual.activo && db.usuarios.adminsActivos() <= 1) throw fallo('ULTIMO_ADMIN', 'Debe quedar al menos un administrador activo.');
    db.usuarios.eliminar(uid);
    audit(req, actorDe(u), 'usuario_eliminado', `usuario:${uid} ${actual.email}`);
    json(req, res, 200, { ok: true });
  }, ADMIN);

  R('GET', '/api/admin/auditoria', (req, res) => json(req, res, 200, db.auditoria.listar(300)), ADMIN);

  // ----- exportaciones -----
  R('GET', '/api/admin/exportar/estudiantes.csv', (req, res, p, u) => {
    audit(req, actorDe(u), 'exportar_estudiantes', null);
    const cuerpo = csv(db.estudiantes.todos(), [
      ['Nombres', (f) => f.nombres], ['Apellidos', (f) => f.apellidos], ['Sede', (f) => f.sede],
      ['INACAPMAIL', (f) => f.email], ['Teléfono', (f) => telefonoLocal(f.telefono)], ['Origen', (f) => f.origen],
      ['Inscrito', (f) => f.creado_en], ['Acreditado', (f) => f.acreditado_en],
      ['Talleres', (f) => db.inscripciones.de(f.id).map((t) => t.titulo).join(' | ')],
    ]);
    http.enviar(req, res, 200, cuerpo, 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="estudiantes.csv"' });
  }, ADMIN);

  R('GET', '/api/admin/exportar/talleres.csv', (req, res, p, u) => {
    audit(req, actorDe(u), 'exportar_talleres', null);
    const cuerpo = csv(db.inscripciones.todas(), [
      ['Taller', (f) => f.titulo], ['Inicio', (f) => f.inicio], ['Sala', (f) => f.sala],
      ['Nombres', (f) => f.nombres], ['Apellidos', (f) => f.apellidos], ['Sede', (f) => f.sede],
      ['INACAPMAIL', (f) => f.email], ['Teléfono', (f) => telefonoLocal(f.telefono)], ['Acreditado', (f) => f.acreditado_en],
    ]);
    http.enviar(req, res, 200, cuerpo, 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="inscripciones-talleres.csv"' });
  }, ADMIN);

  // =====================================================================
  // Archivos estáticos y fotos
  // =====================================================================

  function servirArchivo(req, res, archivo, cache) {
    fs.readFile(archivo, (err, datos) => {
      if (err) return http.enviar(req, res, 404, 'No encontrado', 'text/plain; charset=utf-8');
      const ext = path.extname(archivo).toLowerCase();
      res.writeHead(200, {
        ...cabecerasSeguridad(http.esHttps(req)),
        'Content-Type': ext === '.jpg' ? 'image/jpeg' : MIME[ext] || 'application/octet-stream',
        'Cache-Control': cache,
      });
      res.end(req.method === 'HEAD' ? undefined : datos);
    });
  }

  function estatico(req, res, pathname) {
    const foto = pathname.match(/^\/fotos\/([a-f0-9]{32}\.jpg)$/);
    if (foto) return servirArchivo(req, res, path.join(fotosDir, foto[1]), 'public, max-age=86400');
    if (PAGINAS[pathname]) return servirArchivo(req, res, path.join(raizPublica, PAGINAS[pathname]), 'no-cache');
    // Sólo se sirven recursos de las carpetas públicas conocidas, con nombres simples.
    if (!/^\/(css|js|vendor|img|fuentes)\/[\w.-]+$|^\/[\w-]+\.(webmanifest|svg)$/.test(pathname) || pathname.includes('..')) {
      return http.enviar(req, res, 404, 'No encontrado', 'text/plain; charset=utf-8');
    }
    const archivo = path.resolve(raizPublica, '.' + pathname);
    if (!archivo.startsWith(raizPublica + path.sep)) return http.enviar(req, res, 404, 'No encontrado', 'text/plain; charset=utf-8');
    servirArchivo(req, res, archivo, 'public, max-age=300');
  }

  // =====================================================================
  // Despachador
  // =====================================================================

  async function handler(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return http.enviar(req, res, 400, { error: 'RUTA_INVALIDA' });
    }
    const { pathname } = url;
    const metodo = req.method;
    const lectura = metodo === 'GET' || metodo === 'HEAD';

    try {
      if (!pathname.startsWith('/api/')) {
        if (!lectura) throw fallo('METODO', 'Método no permitido.', 405);
        return estatico(req, res, pathname);
      }
      limitar('api:' + http.ip(req), 900, 60_000);
      if (!lectura && !http.mismoOrigen(req)) throw fallo('ORIGEN', 'Origen no permitido.', 403);

      const { ruta, params, existe } = router.buscar(metodo, pathname);
      if (!ruta) throw existe ? fallo('METODO', 'Método no permitido.', 405) : fallo('NO_ENCONTRADO', 'Recurso no encontrado.', 404);

      let usuario = null;
      if (ruta.rol) {
        usuario = usuarioDe(req);
        if (!usuario) throw fallo('SIN_SESION_STAFF', 'Tu sesión expiró. Ingresa nuevamente.', 401);
        if (ruta.rol === 'admin' && usuario.rol !== 'admin') {
          audit(req, actorDe(usuario), 'acceso_denegado', `${metodo} ${pathname}`);
          throw fallo('PROHIBIDO', 'No tienes permisos para esta acción.', 403);
        }
      }
      return await ruta.fn(req, res, params, usuario, url);
    } catch (e) {
      if (res.headersSent) return;
      if (e instanceof ErrorNegocio) {
        return http.enviar(req, res, e.status, { error: e.codigo, mensaje: e.message, ...(e.errores ? { errores: e.errores } : {}) });
      }
      // No se exponen detalles internos al cliente.
      console.error(new Date().toISOString(), metodo, pathname, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e);
      http.enviar(req, res, 500, { error: 'ERROR_INTERNO', mensaje: 'Ocurrió un error inesperado.' });
    }
  }

  function cerrar() {
    clearInterval(latido);
    limitador.detener();
    for (const res of clientes) res.end();
    clientes.clear();
  }

  return { handler, cerrar };
}

module.exports = { crearApp };
