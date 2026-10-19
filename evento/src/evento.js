// «EventoDO»: un único objeto concentra la base de datos (SQLite), las reglas de negocio (cupos,
// topes, roles) y el tiempo real (WebSockets). En Cloudflare es un Durable Object; en Docker lo
// hospeda src/node/servidor.js con la misma interfaz (ctx.storage.sql, WebSockets).
import { crearDB, ErrorNegocio } from './db.js';
import { json, contexto, leerCookie, cookie, mismoOrigen, leerCuerpo, leerJSON, crearRouter } from './http.js';
import { extraerIdentidad, PREFIJO_TICKET } from './qr.js';
import * as seg from './seguridad.js';
import * as v from './validacion.js';
import { normalizarRut, formatearRut, enmascararRut } from './rut.js';
import eventoInicial from '../config/mes-ciberseguridad-2026.json' with { type: 'json' };

const SESION = {
  estudianteDias: 30,
  admin: { horas: 8, inactividadMin: 60 },
  acreditador: { horas: 12, inactividadMin: 180 },
};
const INACTIVIDAD = { admin: SESION.admin.inactividadMin, acreditador: SESION.acreditador.inactividadMin };
const MAX_CONEXIONES = 5000;

const fallo = (codigo, mensaje, status) => new ErrorNegocio(codigo, mensaje, status);
const errValidacion = (errores) => Object.assign(fallo('DATOS_INVALIDOS', 'Revisa los datos ingresados.', 422), { errores });
const actorDe = (u) => `${u.rol}:${u.id} ${u.email}`;

const id = (valor) => {
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0) throw fallo('NO_ENCONTRADO', 'Recurso no encontrado.', 404);
  return n;
};

function enmascararEmail(email) {
  const [u, d] = String(email).split('@');
  return `${u.slice(0, 2)}${'•'.repeat(Math.max(2, Math.min(u.length - 2, 6)))}@${d}`;
}

// CSV protegido contra inyección de fórmulas, con BOM para que Excel lea bien los acentos.
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

// Valida un archivo de evento (mismo formato que config/mes-ciberseguridad-2026.json).
export function validarArchivoEvento(datos) {
  const problemas = [];
  if (!datos || typeof datos !== 'object' || !datos.evento || !Array.isArray(datos.agenda) || !Array.isArray(datos.talleres)) {
    throw errValidacion({ archivo: 'El archivo debe tener las secciones «evento», «agenda» y «talleres».' });
  }
  const evento = v.validarEvento({
    ...datos.evento,
    inscripciones_abiertas: Boolean(datos.evento.inscripciones_abiertas),
    talleres_abiertos: Boolean(datos.evento.talleres_abiertos),
  });
  if (v.hayErrores(evento.errores)) problemas.push(`evento: ${Object.values(evento.errores).join(' ')}`);
  const agenda = datos.agenda.slice(0, 200).map((a, i) => {
    const r = v.validarAgenda(a || {});
    if (v.hayErrores(r.errores)) problemas.push(`agenda ${i + 1}: ${Object.values(r.errores).join(' ')}`);
    return r.datos;
  });
  const talleres = datos.talleres.slice(0, 200).map((t, i) => {
    const r = v.validarTaller(t || {});
    if (v.hayErrores(r.errores)) problemas.push(`taller ${i + 1}: ${Object.values(r.errores).join(' ')}`);
    return r.datos;
  });
  if (problemas.length) throw errValidacion({ archivo: problemas.slice(0, 8).join(' · ') });
  return { evento: evento.datos, agenda, talleres };
}

export class EventoDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.limitador = seg.crearLimitador();
    this.router = crearRouter();
    this.ultimaPurga = 0;
    // Los WebSockets responden "pong" a "ping" sin despertar al objeto (ahorro de recursos).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      this.db = crearDB(ctx.storage);
      if (!this.db.evento.get() && env.EVENTO_INICIAL !== 'no') this.importar(validarArchivoEvento(eventoInicial), false);
    });
    this.definirRutas();
  }

  // ---------- configuración y utilidades ----------

  async cifrador() {
    if (!this._cifrador) {
      if (!this.env.DATA_KEY) throw fallo('SIN_CONFIGURAR', 'La plataforma no está configurada (falta DATA_KEY).', 503);
      this._cifrador = await seg.crearCifrador(this.env.DATA_KEY);
    }
    return this._cifrador;
  }

  get iteraciones() {
    return Number(this.env.ITERACIONES_CLAVE) || 600000;
  }

  limitar(clave, max, ventanaMs) {
    if (!this.limitador.permitir(clave, max, ventanaMs)) throw fallo('DEMASIADOS_INTENTOS', 'Demasiados intentos. Espera unos minutos.', 429);
  }

  audit(c, actor, accion, detalle) {
    this.db.auditoria.registrar(actor, accion, detalle, c.ip);
  }

  // Descifra RUT, correo y teléfono de una fila de estudiante.
  async hidratar(e) {
    if (!e) return e;
    const cif = await this.cifrador();
    return {
      ...e,
      email: await cif.descifrar(e.email_cif),
      telefono: await cif.descifrar(e.telefono_cif),
      rut: e.rut_cif ? await cif.descifrar(e.rut_cif) : null,
    };
  }

  // Índice ciego del RUT (separado del índice de correos con un prefijo propio).
  async indiceRut(rut) {
    return (await this.cifrador()).indice('rut:' + rut);
  }

  // Cifra los datos personales de un registro antes de guardarlo.
  async datosCifrados(datos) {
    const cif = await this.cifrador();
    return {
      ...datos,
      email_cif: await cif.cifrar(datos.email),
      email_idx: await cif.indice(datos.email),
      rut_cif: await cif.cifrar(datos.rut),
      rut_idx: await this.indiceRut(datos.rut),
      telefono_cif: await cif.cifrar(datos.telefono),
    };
  }

  hidratarTodos(filas) {
    return Promise.all(filas.map((f) => this.hidratar(f)));
  }

  perfil(e) {
    return {
      tipo: e.tipo, nombres: e.nombres, apellidos: e.apellidos, rut: formatearRut(e.rut), sede: e.sede, email: e.email, telefono: e.telefono,
      codigo: e.codigo, qr: PREFIJO_TICKET + e.codigo, acreditadoEn: e.acreditado_en,
      talleres: this.db.inscripciones.de(e.id).map((t) => t.id),
    };
  }

  // Lo que ve el acreditador: lo mínimo para identificar y orientar al estudiante.
  fichaAcreditador(e) {
    return {
      id: e.id, tipo: e.tipo, nombres: e.nombres, apellidos: e.apellidos, rut: enmascararRut(e.rut), sede: e.sede, email: enmascararEmail(e.email),
      acreditadoEn: e.acreditado_en, talleres: this.db.inscripciones.de(e.id),
    };
  }

  fichaAdmin(e) {
    return {
      ...this.fichaAcreditador(e), rut: formatearRut(e.rut), email: e.email, telefono: e.telefono, origen: e.origen,
      creadoEn: e.creado_en, consentimientoEn: e.consentimiento_en,
    };
  }

  tallerPublico(t) {
    return { ...t, foto: t.foto ? `/fotos/${t.foto}` : null, publicado: Boolean(t.publicado) };
  }

  conInscritos(t) {
    return { ...this.tallerPublico(t), inscritos: this.db.db.prepare('SELECT COUNT(*) AS n FROM inscripciones WHERE taller_id = ?').get(t.id).n };
  }

  eventoPublico() {
    const ev = this.db.evento.get();
    return {
      configurado: Boolean(ev),
      evento: ev && {
        nombre: ev.nombre, lema: ev.lema, descripcion: ev.descripcion, lugar: ev.lugar, direccion: ev.direccion, contacto: ev.contacto,
        fechaInicio: ev.fecha_inicio, fechaFin: ev.fecha_fin, maxTalleres: ev.max_talleres,
        inscripcionesAbiertas: Boolean(ev.inscripciones_abiertas), talleresAbiertos: Boolean(ev.talleres_abiertos),
      },
      sedes: v.SEDES,
      dominioCorreo: v.DOMINIO_CORREO,
      tiposParticipante: v.TIPOS_PARTICIPANTE,
      niveles: v.NIVELES,
      agenda: this.db.agenda.listar(),
      talleres: this.db.talleres.listar(true).map((t) => this.tallerPublico(t)),
      cupos: this.db.talleres.cupos(),
    };
  }

  // Carga o actualiza evento, agenda y talleres (los talleres se reconocen por sala y día).
  importar({ evento, agenda, talleres }, actualizar) {
    let creados = 0;
    let actualizados = 0;
    this.db.tx(() => {
      if (this.db.evento.get() && !actualizar) throw fallo('YA_CONFIGURADO', 'Ya hay un evento configurado.');
      this.db.evento.guardar(evento);
      for (const a of this.db.agenda.listar()) this.db.agenda.eliminar(a.id);
      for (const a of agenda) this.db.agenda.crear(a);
      const existentes = this.db.talleres.listar(false);
      for (const t of talleres) {
        // Misma sala (o una variante más detallada, p. ej. «CREA Empresa» → «CREA Empresa (Biblioteca)») y mismo día.
        const misma = (a, b) => a === b || (a.length > 2 && b.length > 2 && (a.startsWith(b) || b.startsWith(a)));
        const previo = existentes.find((x) => x.inicio.slice(0, 10) === t.inicio.slice(0, 10) && misma(x.sala, t.sala));
        if (previo) {
          this.db.talleres.actualizar(previo.id, t);
          actualizados += 1;
        } else {
          this.db.talleres.crear(t);
          creados += 1;
        }
      }
    });
    return { creados, actualizados, actividades: agenda.length };
  }

  // ---------- sesiones ----------

  async estudianteDe(c) {
    const token = leerCookie(c, 'sid');
    return token ? this.db.sesiones.estudiante(await seg.sha256(token)) : null;
  }

  async usuarioDe(c) {
    const token = leerCookie(c, 'ses');
    return token ? this.db.sesiones.usuario(await seg.sha256(token), INACTIVIDAD) : null;
  }

  async abrirSesionEstudiante(c, est) {
    const token = seg.tokenSesion();
    this.db.sesiones.crearEstudiante(await seg.sha256(token), est.id, SESION.estudianteDias);
    return { 'Set-Cookie': cookie(c, 'sid', token, { maxAge: SESION.estudianteDias * 86400 }) };
  }

  // ---------- tiempo real ----------

  emitir(mensaje) {
    const texto = JSON.stringify(mensaje);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(texto);
      } catch { /* conexión cerrada */ }
    }
  }

  emitirCupos() {
    this.emitir({ tipo: 'cupos', datos: this.db.talleres.cupos() });
  }

  emitirEvento() {
    this.emitir({ tipo: 'evento' });
  }

  conectarTiempoReal(c) {
    if (c.req.headers.get('Upgrade') !== 'websocket') return json(426, { error: 'SE_ESPERA_WEBSOCKET' });
    const origen = c.req.headers.get('Origin');
    if (origen && new URL(origen).host !== c.url.host) return json(403, { error: 'ORIGEN' });
    if (this.ctx.getWebSockets().length >= MAX_CONEXIONES) return json(503, { error: 'OCUPADO' });
    const [cliente, servidor] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(servidor);
    servidor.send(this.mensajeInicial());
    return new Response(null, { status: 101, webSocket: cliente });
  }

  // Estado que recibe cada cliente al conectarse en tiempo real.
  mensajeInicial() {
    return JSON.stringify({ tipo: 'cupos', datos: this.db.talleres.cupos() });
  }

  webSocketMessage() {
    // Los clientes sólo reciben; los "ping" se responden automáticamente.
  }

  webSocketClose(ws, code) {
    try {
      ws.close(code === 1005 ? 1000 : code, 'cerrado');
    } catch { /* ya cerrado */ }
  }

  // ---------- fotos (R2) ----------

  async borrarFoto(nombre) {
    if (nombre && /^[a-f0-9]{32}\.jpg$/.test(nombre)) await this.env.FOTOS.delete(nombre).catch(() => {});
  }

  // ---------- despachador ----------

  async fetch(req) {
    const c = contexto(req);
    try {
      if (c.url.pathname === '/api/tiempo-real') return this.conectarTiempoReal(c);
      this.limitar('api:' + c.ip, 2500, 60_000);
      const lectura = req.method === 'GET' || req.method === 'HEAD';
      if (!lectura && !mismoOrigen(c)) throw fallo('ORIGEN', 'Origen no permitido.', 403);
      if (Date.now() - this.ultimaPurga > 10 * 60_000) {
        this.db.sesiones.purgarExpiradas();
        this.ultimaPurga = Date.now();
      }

      const { ruta, params, existe } = this.router.buscar(req.method, c.url.pathname);
      if (!ruta) throw existe ? fallo('METODO', 'Método no permitido.', 405) : fallo('NO_ENCONTRADO', 'Recurso no encontrado.', 404);

      let usuario = null;
      if (ruta.rol) {
        usuario = await this.usuarioDe(c);
        if (!usuario) throw fallo('SIN_SESION_STAFF', 'Tu sesión expiró. Ingresa nuevamente.', 401);
        if (ruta.rol === 'admin' && usuario.rol !== 'admin') {
          this.audit(c, actorDe(usuario), 'acceso_denegado', `${req.method} ${c.url.pathname}`);
          throw fallo('PROHIBIDO', 'No tienes permisos para esta acción.', 403);
        }
      }
      return await ruta.fn(c, params, usuario);
    } catch (e) {
      if (e instanceof ErrorNegocio) {
        return json(e.status, { error: e.codigo, mensaje: e.message, ...(e.errores ? { errores: e.errores } : {}) });
      }
      // No se exponen detalles internos al cliente.
      console.error(req.method, c.url.pathname, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e);
      return json(500, { error: 'ERROR_INTERNO', mensaje: 'Ocurrió un error inesperado.' });
    } finally {
      // Un cuerpo no leído (rechazado por tamaño o que la ruta no usa) se descarta leyéndolo, para no dejar la
      // conexión colgada. El Worker ya rechazó antes cualquier cuerpo mayor a 2,5 MB.
      if (req.body && !req.bodyUsed) await req.arrayBuffer().catch(() => {});
    }
  }

  // =====================================================================
  // Rutas
  // =====================================================================

  definirRutas() {
    const R = (metodo, patron, fn, opciones) => this.router.agregar(metodo, patron, fn, opciones);
    const ACRED = { rol: 'acreditador' };
    const ADMIN = { rol: 'admin' };
    const db = () => this.db;

    // ----- público -----
    R('GET', '/api/evento', () => json(200, this.eventoPublico()));
    R('GET', '/api/cupos', () => json(200, db().talleres.cupos()));

    // ----- estudiantes -----
    R('POST', '/api/registro', async (c) => {
      this.limitar('registro:' + c.ip, 250, 10 * 60_000);
      const ev = db().evento.get();
      if (!ev?.inscripciones_abiertas) throw fallo('INSCRIPCIONES_CERRADAS', 'Las inscripciones al evento están cerradas.');
      const b = await leerJSON(c.req);
      const { errores, datos } = v.validarRegistro(b);
      if (b.consentimiento !== true) errores.consentimiento = 'Debes aceptar el tratamiento de tus datos para inscribirte.';
      if (v.hayErrores(errores)) throw errValidacion(errores);

      const fila = db().estudiantes.crear(await this.datosCifrados(datos), '', 'web');
      this.audit(c, `estudiante:${fila.id}`, 'registro', null);

      // Talleres elegidos en el mismo formulario (opcional). Si alguno falla, la inscripción al evento igual queda hecha.
      const rechazados = [];
      const pedidos = Array.isArray(b.talleres) ? [...new Set(b.talleres)].slice(0, 20) : [];
      for (const tid of pedidos) {
        try {
          db().inscripciones.inscribir(fila.id, id(tid));
        } catch (e) {
          if (!(e instanceof ErrorNegocio)) throw e;
          rechazados.push({ id: tid, motivo: e.message });
        }
      }
      if (pedidos.length) this.emitirCupos();
      const est = await this.hidratar(fila);
      return json(201, { perfil: this.perfil(est), rechazados }, await this.abrirSesionEstudiante(c, est));
    });

    // Recuperar la entrada en otro dispositivo: RUT + INACAPMAIL + sede deben coincidir con la inscripción.
    R('POST', '/api/recuperar', async (c) => {
      this.limitar('recuperar:' + c.ip, 80, 10 * 60_000);
      const b = await leerJSON(c.req);
      const rut = normalizarRut(b.rut);
      if (!rut) throw errValidacion({ rut: 'RUT inválido. Revisa el dígito verificador.' });
      const cif = await this.cifrador();
      const email = v.correoInstitucional(b.email) || '';
      const sede = v.SEDES.includes(b.sede) ? b.sede : '';
      const fila = db().estudiantes.porRutIdx(await this.indiceRut(rut));
      const noCoincide = () => fallo('NO_COINCIDE', 'Los datos no coinciden con ninguna inscripción. Revisa tu RUT, correo y sede.', 401);
      if (!fila) throw noCoincide();
      if (fila.acceso_bloqueado_hasta && Date.parse(fila.acceso_bloqueado_hasta) > Date.now()) {
        throw fallo('BLOQUEADO', 'Demasiados intentos fallidos. Intenta en 15 minutos o pide ayuda en la acreditación.', 429);
      }
      const correoOk = seg.iguales(await cif.indice(email), fila.email_idx);
      if (!correoOk || sede !== fila.sede) {
        db().estudiantes.registrarFalloAcceso(fila.id);
        throw noCoincide();
      }
      db().estudiantes.accesoCorrecto(fila.id);
      this.audit(c, `estudiante:${fila.id}`, 'recuperacion_entrada', null);
      const est = await this.hidratar(fila);
      return json(200, this.perfil(est), await this.abrirSesionEstudiante(c, est));
    });

    R('POST', '/api/salir', async (c) => {
      const sid = leerCookie(c, 'sid');
      if (sid) db().sesiones.cerrarEstudiante(await seg.sha256(sid));
      return json(200, { ok: true }, { 'Set-Cookie': cookie(c, 'sid', '', { maxAge: 0 }) });
    });

    R('GET', '/api/yo', async (c) => {
      const est = await this.hidratar(await this.estudianteDe(c));
      return json(200, est ? this.perfil(est) : null);
    });

    R('POST', '/api/talleres/:id/inscripcion', async (c, p) => {
      const fila = await this.estudianteDe(c);
      if (!fila) throw fallo('SIN_SESION', 'Debes inscribirte en el evento antes de elegir talleres.', 401);
      this.limitar('insc:' + fila.id, 40, 60_000);
      db().inscripciones.inscribir(fila.id, id(p.id));
      this.emitirCupos();
      return json(200, { perfil: this.perfil(await this.hidratar(fila)), cupos: db().talleres.cupos() });
    });

    R('DELETE', '/api/talleres/:id/inscripcion', async (c, p) => {
      const fila = await this.estudianteDe(c);
      if (!fila) throw fallo('SIN_SESION', 'No has iniciado sesión.', 401);
      this.limitar('insc:' + fila.id, 40, 60_000);
      if (db().inscripciones.cancelar(fila.id, id(p.id))) this.emitirCupos();
      return json(200, { perfil: this.perfil(await this.hidratar(fila)), cupos: db().talleres.cupos() });
    });

    // ----- cuentas de staff -----
    R('GET', '/api/staff/yo', async (c) => json(200, { usuario: await this.usuarioDe(c), requiereConfiguracion: !db().usuarios.hayAdmin() }));

    // Primer administrador: requiere el secreto TOKEN_CONFIGURACION y sólo funciona mientras no exista uno.
    R('POST', '/api/staff/configuracion-inicial', async (c) => {
      this.limitar('setup:' + c.ip, 5, 15 * 60_000);
      if (db().usuarios.hayAdmin() || !this.env.TOKEN_CONFIGURACION) throw fallo('YA_CONFIGURADO', 'La plataforma ya tiene un administrador.', 403);
      const b = await leerJSON(c.req);
      if (!seg.iguales(await seg.sha256(String(b.token || '')), await seg.sha256(this.env.TOKEN_CONFIGURACION))) {
        throw fallo('TOKEN_INVALIDO', 'Token de configuración incorrecto.', 401);
      }
      const { errores, datos } = v.validarUsuario({ ...b, rol: 'admin' }, { exigirClave: true });
      if (v.hayErrores(errores)) throw errValidacion(errores);
      const u = db().usuarios.crear(datos, await seg.hashClave(datos.clave, this.iteraciones));
      this.audit(c, actorDe(u), 'configuracion_inicial', null);
      return json(201, { ok: true });
    });

    R('POST', '/api/staff/login', async (c) => {
      this.limitar('login:' + c.ip, 15, 15 * 60_000);
      const b = await leerJSON(c.req);
      const email = v.linea(b.email, 120).toLowerCase();
      const clave = typeof b.clave === 'string' ? b.clave.slice(0, 200) : '';
      const u = db().usuarios.conClave(email);
      const invalido = () => fallo('CREDENCIALES', 'Correo o contraseña incorrectos.', 401);
      if (!u || !u.activo) {
        await seg.verificarFicticio(clave, this.iteraciones);
        this.audit(c, 'anonimo', 'login_fallido', email.slice(0, 120));
        throw invalido();
      }
      if (u.bloqueado_hasta && Date.parse(u.bloqueado_hasta) > Date.now()) {
        this.audit(c, actorDe(u), 'login_bloqueado', null);
        throw fallo('BLOQUEADO', 'Cuenta bloqueada temporalmente por intentos fallidos.', 429);
      }
      if (!(await seg.verificarClave(clave, u.clave_hash))) {
        db().usuarios.registrarFallo(u.id);
        this.audit(c, actorDe(u), 'login_fallido', null);
        throw invalido();
      }
      db().usuarios.accesoCorrecto(u.id);
      const conf = SESION[u.rol];
      const token = seg.tokenSesion();
      db().sesiones.crearUsuario(await seg.sha256(token), u.id, conf.horas);
      this.audit(c, actorDe(u), 'login', null);
      return json(200, { usuario: db().usuarios.porId(u.id) }, {
        'Set-Cookie': cookie(c, 'ses', token, { maxAge: conf.horas * 3600, sameSite: 'Strict' }),
      });
    });

    R('POST', '/api/staff/logout', async (c) => {
      const token = leerCookie(c, 'ses');
      if (token) db().sesiones.cerrarUsuario(await seg.sha256(token));
      return json(200, { ok: true }, { 'Set-Cookie': cookie(c, 'ses', '', { maxAge: 0, sameSite: 'Strict' }) });
    });

    R('POST', '/api/staff/clave', async (c, p, u) => {
      this.limitar('clave:' + u.id, 5, 15 * 60_000);
      const b = await leerJSON(c.req);
      const actual = db().usuarios.conClave(u.email);
      if (!(await seg.verificarClave(String(b.actual || ''), actual.clave_hash))) throw fallo('CREDENCIALES', 'La contraseña actual no es correcta.', 401);
      const e = v.validarClave(b.nueva);
      if (e) throw errValidacion({ nueva: e });
      db().usuarios.cambiarClave(u.id, await seg.hashClave(b.nueva, this.iteraciones));
      db().sesiones.cerrarTodasUsuario(u.id);
      this.audit(c, actorDe(u), 'cambio_clave', null);
      return json(200, { ok: true }, { 'Set-Cookie': cookie(c, 'ses', '', { maxAge: 0, sameSite: 'Strict' }) });
    }, ACRED);

    // ----- acreditación -----
    R('POST', '/api/acreditacion/acreditar', async (c, p, u) => {
      this.limitar('acred:' + u.id, 120, 60_000);
      const b = await leerJSON(c.req);
      let fila;
      let fuente = 'manual';
      if (Number.isInteger(b.id)) {
        fila = db().estudiantes.porId(b.id);
      } else {
        const ident = extraerIdentidad(b.texto);
        if (!ident) return json(200, { resultado: 'NO_RECONOCIDO' });
        if (ident.tipo === 'ticket') fila = db().estudiantes.porCodigo(ident.codigo);
        else if (ident.tipo === 'rut') fila = db().estudiantes.porRutIdx(await this.indiceRut(ident.rut));
        else fila = db().estudiantes.porEmailIdx(await (await this.cifrador()).indice(ident.email));
        fuente = ident.fuente || ident.tipo;
        if (!fila) return json(200, { resultado: 'NO_REGISTRADO', email: ident.email || null, rut: ident.rut ? formatearRut(ident.rut) : null });
      }
      if (!fila) throw fallo('NO_ENCONTRADO', 'Estudiante no encontrado.', 404);
      const nuevo = db().estudiantes.acreditar(fila.id, u.id);
      if (nuevo) this.audit(c, actorDe(u), 'acreditar', `estudiante:${fila.id} (${fuente})`);
      const est = await this.hidratar(db().estudiantes.porId(fila.id));
      return json(200, { resultado: nuevo ? 'ACREDITADO' : 'YA_ACREDITADO', estudiante: this.fichaAcreditador(est) });
    }, ACRED);

    R('DELETE', '/api/acreditacion/:id', async (c, p, u) => {
      const eid = id(p.id);
      if (!db().estudiantes.desacreditar(eid)) throw fallo('NO_ENCONTRADO', 'Estudiante no encontrado.', 404);
      this.audit(c, actorDe(u), 'deshacer_acreditacion', `estudiante:${eid}`);
      return json(200, { estudiante: this.fichaAcreditador(await this.hidratar(db().estudiantes.porId(eid))) });
    }, ACRED);

    R('GET', '/api/acreditacion/buscar', async (c, p, u) => {
      this.limitar('buscar:' + u.id, 120, 60_000);
      const q = (c.url.searchParams.get('q') || '').trim();
      if (q.length < 2) return json(200, []);
      const email = q.includes('@') ? v.correoInstitucional(q) : null;
      const emailIdx = email ? await (await this.cifrador()).indice(email) : null;
      if (q.includes('@') && !email) return json(200, []);
      const rut = !email && /^[\d.\s-]+[\dkK]$/.test(q) ? normalizarRut(q) : null;
      const rutIdx = rut ? await this.indiceRut(rut) : null;
      const filas = await this.hidratarTodos(db().estudiantes.buscar({ q, emailIdx, rutIdx, limite: 25 }).filas);
      return json(200, filas.map((e) => this.fichaAcreditador(e)));
    }, ACRED);

    R('GET', '/api/acreditacion/resumen', () => {
      const e = db().estadisticas();
      return json(200, { registrados: e.registrados, acreditados: e.acreditados });
    }, ACRED);

    R('POST', '/api/acreditacion/registro-presencial', async (c, p, u) => {
      const b = await leerJSON(c.req);
      const { errores, datos } = v.validarRegistro(b);
      if (b.consentimiento !== true) errores.consentimiento = 'Confirma que el estudiante aceptó el tratamiento de sus datos.';
      if (v.hayErrores(errores)) throw errValidacion(errores);
      const fila = db().estudiantes.crear(await this.datosCifrados(datos), '', 'presencial');
      db().estudiantes.acreditar(fila.id, u.id);
      this.audit(c, actorDe(u), 'registro_presencial', `estudiante:${fila.id}`);
      const est = await this.hidratar(db().estudiantes.porId(fila.id));
      return json(201, { resultado: 'ACREDITADO', estudiante: this.fichaAcreditador(est) });
    }, ACRED);

    // ----- administración: evento -----
    R('GET', '/api/admin/resumen', () => json(200, {
      evento: db().evento.get(),
      ...db().estadisticas(),
      talleres: db().talleres.listar(false).map((t) => this.conInscritos(t)),
    }), ADMIN);

    R('PUT', '/api/admin/evento', async (c, p, u) => {
      const { errores, datos } = v.validarEvento(await leerJSON(c.req));
      if (v.hayErrores(errores)) throw errValidacion(errores);
      const ev = db().evento.guardar(datos);
      this.audit(c, actorDe(u), 'evento_actualizado', null);
      this.emitirEvento();
      return json(200, ev);
    }, ADMIN);

    // Carga/actualiza el evento desde un archivo JSON (formato de config/mes-ciberseguridad-2026.json).
    R('POST', '/api/admin/importar', async (c, p, u) => {
      const b = await leerJSON(c.req, 128 * 1024);
      const r = this.importar(validarArchivoEvento(b.datos), true);
      this.audit(c, actorDe(u), 'evento_importado', `${r.creados} talleres nuevos, ${r.actualizados} actualizados`);
      this.emitirEvento();
      this.emitirCupos();
      return json(200, r);
    }, ADMIN);

    // ----- administración: talleres -----
    R('GET', '/api/admin/talleres', () => json(200, db().talleres.listar(false).map((t) => this.conInscritos(t))), ADMIN);

    R('POST', '/api/admin/talleres', async (c, p, u) => {
      const { errores, datos } = v.validarTaller(await leerJSON(c.req));
      if (v.hayErrores(errores)) throw errValidacion(errores);
      const t = db().talleres.crear(datos);
      this.audit(c, actorDe(u), 'taller_creado', `taller:${t.id} ${t.titulo}`);
      this.emitirEvento();
      this.emitirCupos();
      return json(201, this.conInscritos(t));
    }, ADMIN);

    R('PUT', '/api/admin/talleres/:id', async (c, p, u) => {
      const tid = id(p.id);
      if (!db().talleres.get(tid)) throw fallo('NO_ENCONTRADO', 'Taller no encontrado.', 404);
      const { errores, datos } = v.validarTaller(await leerJSON(c.req));
      if (v.hayErrores(errores)) throw errValidacion(errores);
      const t = db().talleres.actualizar(tid, datos);
      this.audit(c, actorDe(u), 'taller_actualizado', `taller:${tid}`);
      this.emitirEvento();
      this.emitirCupos();
      return json(200, this.conInscritos(t));
    }, ADMIN);

    R('DELETE', '/api/admin/talleres/:id', async (c, p, u) => {
      const tid = id(p.id);
      const t = db().talleres.get(tid);
      if (!t) throw fallo('NO_ENCONTRADO', 'Taller no encontrado.', 404);
      db().talleres.eliminar(tid);
      await this.borrarFoto(t.foto);
      this.audit(c, actorDe(u), 'taller_eliminado', `taller:${tid} ${t.titulo}`);
      this.emitirEvento();
      this.emitirCupos();
      return json(200, { ok: true });
    }, ADMIN);

    // Foto del docente: sólo JPEG (el navegador la redimensiona y convierte), máx. 2 MB, sin metadatos.
    R('PUT', '/api/admin/talleres/:id/foto', async (c, p, u) => {
      const tid = id(p.id);
      const t = db().talleres.get(tid);
      if (!t) throw fallo('NO_ENCONTRADO', 'Taller no encontrado.', 404);
      const limpio = seg.limpiarJPEG(await leerCuerpo(c.req, { max: 2 * 1024 * 1024, tipos: ['image/jpeg'] }));
      if (!limpio) throw fallo('IMAGEN_INVALIDA', 'La imagen no es un JPEG válido.', 422);
      const nombre = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(16))).toString('hex') + '.jpg';
      await this.env.FOTOS.put(nombre, limpio, { httpMetadata: { contentType: 'image/jpeg' } });
      db().talleres.ponerFoto(tid, nombre);
      await this.borrarFoto(t.foto);
      this.audit(c, actorDe(u), 'taller_foto', `taller:${tid}`);
      this.emitirEvento();
      return json(200, this.conInscritos(db().talleres.get(tid)));
    }, ADMIN);

    R('DELETE', '/api/admin/talleres/:id/foto', async (c, p, u) => {
      const tid = id(p.id);
      const t = db().talleres.get(tid);
      if (!t) throw fallo('NO_ENCONTRADO', 'Taller no encontrado.', 404);
      db().talleres.ponerFoto(tid, null);
      await this.borrarFoto(t.foto);
      this.audit(c, actorDe(u), 'taller_foto_eliminada', `taller:${tid}`);
      this.emitirEvento();
      return json(200, this.conInscritos(db().talleres.get(tid)));
    }, ADMIN);

    R('GET', '/api/admin/talleres/:id/inscritos', async (c, p) => {
      const filas = await this.hidratarTodos(db().talleres.inscritos(id(p.id)));
      return json(200, filas.map((e) => this.fichaAdmin(e)));
    }, ADMIN);

    // ----- administración: agenda -----
    R('GET', '/api/admin/agenda', () => json(200, db().agenda.listar()), ADMIN);

    R('POST', '/api/admin/agenda', async (c, p, u) => {
      const { errores, datos } = v.validarAgenda(await leerJSON(c.req));
      if (v.hayErrores(errores)) throw errValidacion(errores);
      const a = db().agenda.crear(datos);
      this.audit(c, actorDe(u), 'agenda_creada', `agenda:${a.id}`);
      this.emitirEvento();
      return json(201, a);
    }, ADMIN);

    R('PUT', '/api/admin/agenda/:id', async (c, p, u) => {
      const aid = id(p.id);
      if (!db().agenda.get(aid)) throw fallo('NO_ENCONTRADO', 'Actividad no encontrada.', 404);
      const { errores, datos } = v.validarAgenda(await leerJSON(c.req));
      if (v.hayErrores(errores)) throw errValidacion(errores);
      const a = db().agenda.actualizar(aid, datos);
      this.audit(c, actorDe(u), 'agenda_actualizada', `agenda:${aid}`);
      this.emitirEvento();
      return json(200, a);
    }, ADMIN);

    R('DELETE', '/api/admin/agenda/:id', (c, p, u) => {
      const aid = id(p.id);
      if (!db().agenda.eliminar(aid)) throw fallo('NO_ENCONTRADO', 'Actividad no encontrada.', 404);
      this.audit(c, actorDe(u), 'agenda_eliminada', `agenda:${aid}`);
      this.emitirEvento();
      return json(200, { ok: true });
    }, ADMIN);

    // ----- administración: estudiantes -----
    R('GET', '/api/admin/estudiantes', async (c) => {
      const s = c.url.searchParams;
      const q = (s.get('q') || '').trim();
      const email = q.includes('@') ? v.correoInstitucional(q) : null;
      const r = db().estudiantes.buscar({
        q: q.includes('@') ? '' : q,
        emailIdx: email ? await (await this.cifrador()).indice(email) : q.includes('@') ? 'sin-coincidencias' : null,
        rutIdx: !q.includes('@') && /^[\d.\s-]+[\dkK]$/.test(q) && normalizarRut(q) ? await this.indiceRut(normalizarRut(q)) : null,
        sede: v.SEDES.includes(s.get('sede')) ? s.get('sede') : '',
        tipo: Object.hasOwn(v.TIPOS_PARTICIPANTE, s.get('tipo') || '') ? s.get('tipo') : '',
        estado: s.get('estado') || '', limite: 50, desde: Number(s.get('desde')) || 0,
      });
      const filas = await this.hidratarTodos(r.filas);
      return json(200, { total: r.total, filas: filas.map((e) => this.fichaAdmin(e)) });
    }, ADMIN);

    R('GET', '/api/admin/estudiantes/:id', async (c, p) => {
      const e = await this.hidratar(db().estudiantes.porId(id(p.id)));
      if (!e) throw fallo('NO_ENCONTRADO', 'Estudiante no encontrado.', 404);
      return json(200, this.fichaAdmin(e));
    }, ADMIN);

    R('DELETE', '/api/admin/estudiantes/:id', (c, p, u) => {
      const eid = id(p.id);
      if (!db().estudiantes.eliminar(eid)) throw fallo('NO_ENCONTRADO', 'Estudiante no encontrado.', 404);
      this.audit(c, actorDe(u), 'estudiante_eliminado', `estudiante:${eid}`);
      this.emitirCupos();
      return json(200, { ok: true });
    }, ADMIN);

    R('POST', '/api/admin/estudiantes/:id/talleres/:tid', async (c, p, u) => {
      const eid = id(p.id);
      if (!db().estudiantes.porId(eid)) throw fallo('NO_ENCONTRADO', 'Estudiante no encontrado.', 404);
      db().inscripciones.inscribir(eid, id(p.tid), { forzar: true });
      this.audit(c, actorDe(u), 'inscripcion_admin', `estudiante:${eid} taller:${p.tid}`);
      this.emitirCupos();
      return json(200, this.fichaAdmin(await this.hidratar(db().estudiantes.porId(eid))));
    }, ADMIN);

    R('DELETE', '/api/admin/estudiantes/:id/talleres/:tid', async (c, p, u) => {
      const eid = id(p.id);
      if (!db().estudiantes.porId(eid)) throw fallo('NO_ENCONTRADO', 'Estudiante no encontrado.', 404);
      if (db().inscripciones.cancelar(eid, id(p.tid), { forzar: true })) this.emitirCupos();
      this.audit(c, actorDe(u), 'desinscripcion_admin', `estudiante:${eid} taller:${p.tid}`);
      return json(200, this.fichaAdmin(await this.hidratar(db().estudiantes.porId(eid))));
    }, ADMIN);

    // Eliminación masiva al terminar el evento (derecho de supresión / retención mínima).
    R('POST', '/api/admin/estudiantes/eliminar-todos', async (c, p, u) => {
      const b = await leerJSON(c.req);
      if (b.confirmacion !== 'ELIMINAR TODO') throw errValidacion({ confirmacion: 'Escribe ELIMINAR TODO para confirmar.' });
      const actual = db().usuarios.conClave(u.email);
      if (!(await seg.verificarClave(String(b.clave || ''), actual.clave_hash))) throw fallo('CREDENCIALES', 'Contraseña incorrecta.', 401);
      const n = db().estudiantes.eliminarTodos();
      this.audit(c, actorDe(u), 'estudiantes_eliminados_todos', `${n} registros`);
      this.emitirCupos();
      return json(200, { eliminados: n });
    }, ADMIN);

    // ----- administración: usuarios -----
    R('GET', '/api/admin/usuarios', () => json(200, db().usuarios.listar()), ADMIN);

    R('POST', '/api/admin/usuarios', async (c, p, u) => {
      const { errores, datos } = v.validarUsuario(await leerJSON(c.req), { exigirClave: true });
      if (v.hayErrores(errores)) throw errValidacion(errores);
      const nuevo = db().usuarios.crear(datos, await seg.hashClave(datos.clave, this.iteraciones));
      this.audit(c, actorDe(u), 'usuario_creado', `${nuevo.rol}:${nuevo.id} ${nuevo.email}`);
      return json(201, nuevo);
    }, ADMIN);

    R('PUT', '/api/admin/usuarios/:id', async (c, p, u) => {
      const uid = id(p.id);
      const actual = db().usuarios.porId(uid);
      if (!actual) throw fallo('NO_ENCONTRADO', 'Usuario no encontrado.', 404);
      const b = await leerJSON(c.req);
      const nombre = v.linea(b.nombre, 80) || actual.nombre;
      const rol = v.ROLES.includes(b.rol) ? b.rol : actual.rol;
      const activo = typeof b.activo === 'boolean' ? b.activo : Boolean(actual.activo);
      const dejaDeSerAdmin = actual.rol === 'admin' && actual.activo && (rol !== 'admin' || !activo);
      if (dejaDeSerAdmin && db().usuarios.adminsActivos() <= 1) throw fallo('ULTIMO_ADMIN', 'Debe quedar al menos un administrador activo.');
      db().usuarios.actualizar(uid, { nombre, rol, activo });
      if (!activo || rol !== actual.rol) db().sesiones.cerrarTodasUsuario(uid);
      this.audit(c, actorDe(u), 'usuario_actualizado', `usuario:${uid} rol=${rol} activo=${activo}`);
      return json(200, db().usuarios.porId(uid));
    }, ADMIN);

    R('POST', '/api/admin/usuarios/:id/clave', async (c, p, u) => {
      const uid = id(p.id);
      if (!db().usuarios.porId(uid)) throw fallo('NO_ENCONTRADO', 'Usuario no encontrado.', 404);
      const b = await leerJSON(c.req);
      const e = v.validarClave(b.clave);
      if (e) throw errValidacion({ clave: e });
      db().usuarios.cambiarClave(uid, await seg.hashClave(b.clave, this.iteraciones));
      db().sesiones.cerrarTodasUsuario(uid);
      this.audit(c, actorDe(u), 'usuario_clave_restablecida', `usuario:${uid}`);
      return json(200, { ok: true });
    }, ADMIN);

    R('DELETE', '/api/admin/usuarios/:id', (c, p, u) => {
      const uid = id(p.id);
      const actual = db().usuarios.porId(uid);
      if (!actual) throw fallo('NO_ENCONTRADO', 'Usuario no encontrado.', 404);
      if (uid === u.id) throw fallo('NO_PERMITIDO', 'No puedes eliminar tu propia cuenta.');
      if (actual.rol === 'admin' && actual.activo && db().usuarios.adminsActivos() <= 1) throw fallo('ULTIMO_ADMIN', 'Debe quedar al menos un administrador activo.');
      db().usuarios.eliminar(uid);
      this.audit(c, actorDe(u), 'usuario_eliminado', `usuario:${uid} ${actual.email}`);
      return json(200, { ok: true });
    }, ADMIN);

    R('GET', '/api/admin/auditoria', () => json(200, db().auditoria.listar(300)), ADMIN);

    // ----- exportaciones (contienen datos personales: quedan auditadas) -----
    R('GET', '/api/admin/exportar/estudiantes.csv', async (c, p, u) => {
      this.audit(c, actorDe(u), 'exportar_estudiantes', null);
      const filas = await this.hidratarTodos(db().estudiantes.todos());
      const cuerpo = csv(filas, [
        ['Tipo', (f) => f.tipo], ['Nombres', (f) => f.nombres], ['Apellidos', (f) => f.apellidos], ['RUT', (f) => formatearRut(f.rut)], ['Sede', (f) => f.sede],
        ['INACAPMAIL', (f) => f.email], ['Teléfono', (f) => telefonoLocal(f.telefono)], ['Origen', (f) => f.origen],
        ['Inscrito', (f) => f.creado_en], ['Acreditado', (f) => f.acreditado_en],
        ['Talleres', (f) => db().inscripciones.de(f.id).map((t) => t.titulo).join(' | ')],
      ]);
      return new Response(cuerpo, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="estudiantes.csv"' } });
    }, ADMIN);

    R('GET', '/api/admin/exportar/talleres.csv', async (c, p, u) => {
      this.audit(c, actorDe(u), 'exportar_talleres', null);
      const filas = await this.hidratarTodos(db().inscripciones.todas());
      const cuerpo = csv(filas, [
        ['Taller', (f) => f.titulo], ['Inicio', (f) => f.inicio], ['Sala', (f) => f.sala],
        ['Tipo', (f) => f.tipo], ['Nombres', (f) => f.nombres], ['Apellidos', (f) => f.apellidos], ['RUT', (f) => formatearRut(f.rut)], ['Sede', (f) => f.sede],
        ['INACAPMAIL', (f) => f.email], ['Teléfono', (f) => telefonoLocal(f.telefono)], ['Acreditado', (f) => f.acreditado_en],
      ]);
      return new Response(cuerpo, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="inscripciones-talleres.csv"' } });
    }, ADMIN);
  }
}
