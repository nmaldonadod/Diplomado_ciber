'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { abrirDB } = require('../src/db');
const { crearApp } = require('../src/app');
const seg = require('../src/seguridad');

const TOKEN = 'TOKENINICIAL1';
const CLAVE_ADMIN = 'Admin-Segura-2026';

async function levantar() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evento-test-'));
  const db = abrirDB(':memory:', seg.crearCifrador(crypto.randomBytes(32)));
  const app = crearApp({ db, publicDir: path.join(__dirname, '..', 'public'), fotosDir: path.join(dir, 'fotos'), tokenInicial: TOKEN });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    db,
    async cerrar() {
      app.cerrar();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      db.cerrar();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function cliente(base) {
  const cookies = {};
  return async function pedir(metodo, ruta, cuerpo, extra = {}) {
    const headers = { Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '), ...extra };
    let body;
    if (Buffer.isBuffer(cuerpo)) body = cuerpo;
    else if (cuerpo !== undefined) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      body = JSON.stringify(cuerpo);
    }
    const res = await fetch(base + ruta, { method: metodo, headers, body });
    for (const c of res.headers.getSetCookie()) {
      const [par] = c.split(';');
      const i = par.indexOf('=');
      cookies[par.slice(0, i)] = par.slice(i + 1);
    }
    const tipo = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: tipo.includes('json') ? await res.json() : await res.text() };
  };
}

const ESTUDIANTE = { nombres: 'Ana', apellidos: 'Pérez Soto', sede: 'Rancagua', email: 'ana.perez@inacapmail.cl', telefono: '9 1234 5678', consentimiento: true };

async function prepararAdmin(base) {
  const admin = cliente(base);
  let r = await admin('POST', '/api/staff/configuracion-inicial', { token: 'MALO', nombre: 'Admin', email: 'admin@inacap.cl', clave: CLAVE_ADMIN });
  assert.equal(r.status, 401);
  r = await admin('POST', '/api/staff/configuracion-inicial', { token: TOKEN, nombre: 'Admin', email: 'admin@inacap.cl', clave: CLAVE_ADMIN });
  assert.equal(r.status, 201);
  r = await admin('POST', '/api/staff/configuracion-inicial', { token: TOKEN, nombre: 'Otro', email: 'otro@inacap.cl', clave: CLAVE_ADMIN });
  assert.equal(r.status, 403, 'el token sólo sirve mientras no exista un administrador');
  r = await admin('POST', '/api/staff/login', { email: 'admin@inacap.cl', clave: CLAVE_ADMIN });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  r = await admin('PUT', '/api/admin/evento', {
    nombre: 'Semana de la Tecnología', descripcion: 'Desc', lugar: 'Sede', direccion: '', contacto: 'eventos@inacap.cl',
    fecha_inicio: '2026-11-12', fecha_fin: '2026-11-13', max_talleres: 2, inscripciones_abiertas: true, talleres_abiertos: true,
  });
  assert.equal(r.status, 200);
  return admin;
}

test('flujo completo: admin configura → estudiante se inscribe con taller → acreditador lo acredita', async (t) => {
  const srv = await levantar();
  t.after(() => srv.cerrar());
  const anon = cliente(srv.base);

  let r = await anon('GET', '/api/evento');
  assert.equal(r.body.configurado, false);
  assert.deepEqual(r.body.sedes, ['Santiago Centro', 'Santiago Sur', 'Rancagua', 'Talca', 'Curicó', 'Apoquindo', 'Valparaíso']);

  const admin = await prepararAdmin(srv.base);
  r = await admin('POST', '/api/admin/talleres', { titulo: 'Robótica', descripcion: 'Arduino', docente: 'Prof. Rojas', sala: 'Lab 1', inicio: '2026-11-12T10:00', fin: '2026-11-12T12:00', cupos: 1, publicado: true });
  assert.equal(r.status, 201);
  const tallerId = r.body.id;
  r = await admin('POST', '/api/admin/talleres', { titulo: 'Borrador', inicio: '2026-11-12T10:00', fin: '2026-11-12T12:00', cupos: 5, publicado: false });
  const borradorId = r.body.id;
  r = await admin('POST', '/api/admin/agenda', { tipo: 'charla', titulo: 'Inauguración', inicio: '2026-11-12T09:00', fin: '2026-11-12T09:30' });
  assert.equal(r.status, 201);

  // Foto del docente: se rechaza lo que no es JPEG y se limpia el EXIF.
  r = await admin('PUT', `/api/admin/talleres/${tallerId}/foto`, Buffer.from('<svg/>'), { 'Content-Type': 'image/svg+xml' });
  assert.equal(r.status, 415);
  r = await admin('PUT', `/api/admin/talleres/${tallerId}/foto`, Buffer.from('no es jpeg'), { 'Content-Type': 'image/jpeg' });
  assert.equal(r.status, 422);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0x33, 0xff, 0xd9]);
  r = await admin('PUT', `/api/admin/talleres/${tallerId}/foto`, jpeg, { 'Content-Type': 'image/jpeg' });
  assert.equal(r.status, 200);
  assert.match(r.body.foto, /^\/fotos\/[a-f0-9]{32}\.jpg$/);
  const foto = await anon('GET', r.body.foto);
  assert.equal(foto.status, 200);
  assert.equal(foto.headers.get('content-type'), 'image/jpeg');
  assert.equal(foto.headers.get('x-content-type-options'), 'nosniff');

  r = await anon('GET', '/api/evento');
  assert.equal(r.body.configurado, true);
  assert.deepEqual(r.body.talleres.map((x) => x.titulo), ['Robótica'], 'los borradores no se publican');

  // Inscripción con taller elegido en el mismo formulario.
  const ana = cliente(srv.base);
  r = await ana('POST', '/api/registro', { ...ESTUDIANTE, consentimiento: false });
  assert.equal(r.status, 422);
  r = await ana('POST', '/api/registro', { ...ESTUDIANTE, email: 'ana@gmail.com' });
  assert.ok(r.body.errores.email);
  r = await ana('POST', '/api/registro', { ...ESTUDIANTE, talleres: [tallerId, borradorId] });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.perfil.talleres, [tallerId]);
  assert.equal(r.body.rechazados.length, 1, 'el borrador no se puede elegir');
  assert.match(r.body.codigoAcceso, /^[A-Z2-9]{8}$/);
  const codigoAcceso = r.body.codigoAcceso;
  const ticket = r.body.perfil.qr;
  assert.equal(r.body.perfil.telefono, '+56912345678');

  r = await anon('POST', '/api/registro', { ...ESTUDIANTE, email: 'ANA.PEREZ@inacapmail.cl' });
  assert.equal(r.body.error, 'YA_REGISTRADO');

  // Otro estudiante: el taller quedó sin cupos.
  const beto = cliente(srv.base);
  r = await beto('POST', '/api/registro', { ...ESTUDIANTE, nombres: 'Beto', email: 'beto@inacapmail.cl' });
  r = await beto('POST', `/api/talleres/${tallerId}/inscripcion`, {});
  assert.equal(r.body.error, 'SIN_CUPOS');

  // Acceso desde otro dispositivo con correo + código.
  const otroDispositivo = cliente(srv.base);
  r = await otroDispositivo('POST', '/api/acceso', { email: ESTUDIANTE.email, codigo: 'AAAAAAAA' });
  assert.equal(r.status, 401);
  r = await otroDispositivo('POST', '/api/acceso', { email: ESTUDIANTE.email, codigo: codigoAcceso.toLowerCase() });
  assert.equal(r.status, 200);

  // El estudiante no puede usar la API de staff.
  r = await ana('GET', '/api/admin/estudiantes');
  assert.equal(r.status, 401);

  // Admin crea un acreditador.
  r = await admin('POST', '/api/admin/usuarios', { nombre: 'Puerta 1', email: 'puerta1@inacap.cl', rol: 'acreditador', clave: 'corta' });
  assert.equal(r.status, 422);
  r = await admin('POST', '/api/admin/usuarios', { nombre: 'Puerta 1', email: 'puerta1@inacap.cl', rol: 'acreditador', clave: 'Acreditar-2026!' });
  assert.equal(r.status, 201);
  const acreditadorId = r.body.id;

  const acr = cliente(srv.base);
  r = await acr('POST', '/api/staff/login', { email: 'puerta1@inacap.cl', clave: 'Acreditar-2026!' });
  assert.equal(r.status, 200);

  r = await acr('GET', '/api/admin/estudiantes');
  assert.equal(r.status, 403, 'el acreditador no accede a administración');
  r = await acr('GET', '/api/admin/exportar/estudiantes.csv');
  assert.equal(r.status, 403);

  r = await acr('POST', '/api/acreditacion/acreditar', { texto: ticket });
  assert.equal(r.body.resultado, 'ACREDITADO');
  assert.equal(r.body.estudiante.nombres, 'Ana');
  assert.equal(r.body.estudiante.talleres[0].titulo, 'Robótica');
  assert.equal(r.body.estudiante.telefono, undefined, 'el acreditador no ve teléfonos');
  assert.match(r.body.estudiante.email, /^an•+@inacapmail\.cl$/, 'correo enmascarado');

  r = await acr('POST', '/api/acreditacion/acreditar', { texto: 'ana.perez@inacapmail.cl' });
  assert.equal(r.body.resultado, 'YA_ACREDITADO');
  r = await acr('POST', '/api/acreditacion/acreditar', { texto: 'nadie@inacapmail.cl' });
  assert.deepEqual(r.body, { resultado: 'NO_REGISTRADO', email: 'nadie@inacapmail.cl' });

  r = await acr('POST', '/api/acreditacion/registro-presencial', { ...ESTUDIANTE, nombres: 'Carla', email: 'carla@inacapmail.cl' });
  assert.equal(r.status, 201);
  assert.match(r.body.codigoAcceso, /^[A-Z2-9]{8}$/);

  r = await acr('GET', '/api/acreditacion/buscar?q=perez');
  assert.equal(r.body.length, 3);

  // Admin ve los datos completos, exporta y todo queda auditado.
  r = await admin('GET', '/api/admin/estudiantes?q=ana');
  assert.equal(r.body.total, 1);
  assert.equal(r.body.filas[0].telefono, '+56912345678');
  r = await admin('GET', '/api/admin/exportar/estudiantes.csv');
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.body, /Ana;Pérez Soto;Rancagua;ana\.perez@inacapmail\.cl;912345678;/);
  r = await admin('GET', '/api/admin/auditoria');
  const acciones = r.body.map((a) => a.accion);
  for (const a of ['configuracion_inicial', 'login', 'taller_creado', 'acreditar', 'registro_presencial', 'exportar_estudiantes', 'acceso_denegado']) {
    assert.ok(acciones.includes(a), `auditoría incluye ${a}`);
  }
  assert.equal(JSON.stringify(r.body).includes('+56912345678'), false, 'la auditoría no guarda datos personales');

  // Desactivar al acreditador cierra sus sesiones.
  r = await admin('PUT', `/api/admin/usuarios/${acreditadorId}`, { activo: false });
  assert.equal(r.status, 200);
  r = await acr('GET', '/api/acreditacion/resumen');
  assert.equal(r.status, 401);

  // No se puede dejar la plataforma sin administradores.
  const adminId = (await admin('GET', '/api/staff/yo')).body.usuario.id;
  r = await admin('PUT', `/api/admin/usuarios/${adminId}`, { rol: 'acreditador' });
  assert.equal(r.body.error, 'ULTIMO_ADMIN');

  // Eliminación masiva requiere confirmación y contraseña.
  r = await admin('POST', '/api/admin/estudiantes/eliminar-todos', { confirmacion: 'ELIMINAR TODO', clave: 'mala' });
  assert.equal(r.status, 401);
  r = await admin('POST', '/api/admin/estudiantes/eliminar-todos', { confirmacion: 'ELIMINAR TODO', clave: CLAVE_ADMIN });
  assert.equal(r.body.eliminados, 3);
  r = await ana('GET', '/api/yo');
  assert.equal(r.body, null, 'las sesiones de estudiantes eliminados dejan de funcionar');
});

test('seguridad: CSRF, cabeceras, archivos, bloqueo de cuentas y límites', async (t) => {
  const srv = await levantar();
  t.after(() => srv.cerrar());
  const admin = await prepararAdmin(srv.base);
  const c = cliente(srv.base);

  let r = await c('GET', '/');
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  for (const p of ['/admin', '/acreditacion', '/privacidad']) assert.equal((await c('GET', p)).status, 200);

  r = await admin('POST', '/api/admin/talleres', { titulo: 'X', inicio: '2026-11-12T10:00', fin: '2026-11-12T11:00', cupos: 3, publicado: true }, { Origin: 'https://evil.example' });
  assert.equal(r.status, 403, 'origen cruzado bloqueado');
  r = await admin('POST', '/api/admin/talleres', { titulo: 'X', inicio: '2026-11-12T10:00', fin: '2026-11-12T11:00', cupos: 3, publicado: true }, { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(r.status, 403);
  r = await fetch(srv.base + '/api/staff/login', { method: 'POST', body: 'email=a&clave=b', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.status, 415);

  for (const p of ['/%2e%2e/server.js', '/../package.json', '/js/../../server.js', '/fotos/../evento.db', '/data/clave.key', '/src/app.js']) {
    assert.equal((await c('GET', p)).status, 404, p);
  }

  r = await c('POST', '/api/registro', Buffer.alloc(40 * 1024, 'a'), { 'Content-Type': 'application/json' });
  assert.equal(r.status, 413);

  // Bloqueo de cuenta tras intentos fallidos (aunque luego se use la contraseña correcta).
  for (let i = 0; i < 5; i++) await c('POST', '/api/staff/login', { email: 'admin@inacap.cl', clave: 'incorrecta' });
  r = await c('POST', '/api/staff/login', { email: 'admin@inacap.cl', clave: CLAVE_ADMIN });
  assert.equal(r.body.error, 'BLOQUEADO');

  // Mensaje idéntico para usuario inexistente (no permite enumerar cuentas).
  const inexistente = await cliente(srv.base)('POST', '/api/staff/login', { email: 'nadie@inacap.cl', clave: 'x' });
  assert.equal(inexistente.body.mensaje, 'Correo o contraseña incorrectos.');

  // Bloqueo del código de acceso de estudiantes.
  const est = cliente(srv.base);
  await est('POST', '/api/registro', ESTUDIANTE);
  const atacante = cliente(srv.base);
  for (let i = 0; i < 5; i++) await atacante('POST', '/api/acceso', { email: ESTUDIANTE.email, codigo: 'ZZZZZZZZ' });
  r = await atacante('POST', '/api/acceso', { email: ESTUDIANTE.email, codigo: 'ZZZZZZZZ' });
  assert.equal(r.body.error, 'BLOQUEADO');

  // Los errores internos no exponen detalles.
  r = await c('GET', '/api/admin/talleres/abc/inscritos');
  assert.equal(r.status, 401);
});
