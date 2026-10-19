import test from 'node:test';
import assert from 'node:assert/strict';
import { levantarApp, cliente } from './apoyo.js';

// Estas pruebas levantan la app real: el Worker con `wrangler dev` (runtime de Cloudflare) o, con
// RUNTIME=node, el servidor Node que se usa en Docker.
const TOKEN = 'TOKENINICIAL1';
const CLAVE_ADMIN = 'Admin-Segura-2026';
const DATA_KEY = Buffer.alloc(32, 9).toString('base64');

const levantar = () => levantarApp({ TOKEN_CONFIGURACION: TOKEN, DATA_KEY });

const ESTUDIANTE = { nombres: 'Ana', apellidos: 'Pérez Soto', rut: '12.345.678-5', sede: 'Rancagua', email: 'ana.perez@inacapmail.cl', telefono: '9 1234 5678', consentimiento: true };

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
  r = await admin('PUT', `/api/admin/talleres/${tallerId}/foto`, new TextEncoder().encode('<svg/>'), { 'Content-Type': 'image/svg+xml' });
  assert.equal(r.status, 415);
  r = await admin('PUT', `/api/admin/talleres/${tallerId}/foto`, new TextEncoder().encode('no es jpeg'), { 'Content-Type': 'image/jpeg' });
  assert.equal(r.status, 422);
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0x33, 0xff, 0xd9]);
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
  assert.equal(r.body.perfil.rut, '12.345.678-5');
  const ticket = r.body.perfil.qr;
  assert.equal(r.body.perfil.telefono, '+56912345678');

  r = await anon('POST', '/api/registro', { ...ESTUDIANTE, email: 'ANA.PEREZ@inacapmail.cl' });
  assert.equal(r.body.error, 'YA_REGISTRADO');
  r = await anon('POST', '/api/registro', { ...ESTUDIANTE, email: 'otra@inacapmail.cl', rut: '123456785' });
  assert.equal(r.body.error, 'YA_REGISTRADO', 'un RUT no se puede inscribir dos veces');
  r = await anon('POST', '/api/registro', { ...ESTUDIANTE, email: 'otra@inacapmail.cl', rut: '12.345.678-9' });
  assert.ok(r.body.errores?.rut, 'valida el dígito verificador');

  // Otro estudiante: el taller quedó sin cupos.
  const beto = cliente(srv.base);
  r = await beto('POST', '/api/registro', { ...ESTUDIANTE, nombres: 'Beto', rut: '11.111.111-1', email: 'beto@inacapmail.cl' });
  r = await beto('POST', `/api/talleres/${tallerId}/inscripcion`, {});
  assert.equal(r.body.error, 'SIN_CUPOS');

  // Docentes y administrativos se inscriben con su correo @inacap.cl.
  const profe = cliente(srv.base);
  r = await profe('POST', '/api/registro', { ...ESTUDIANTE, tipo: 'docente', nombres: 'Rosa', rut: '7.654.321-6', email: 'rosa@inacapmail.cl' });
  assert.ok(r.body.errores?.email, 'un docente debe usar @inacap.cl');
  r = await profe('POST', '/api/registro', { ...ESTUDIANTE, tipo: 'docente', nombres: 'Rosa', rut: '7.654.321-6', email: 'rosa@inacap.cl' });
  assert.equal(r.status, 201);
  assert.equal(r.body.perfil.tipo, 'docente');

  // Recuperar la entrada desde otro dispositivo con RUT + correo + sede.
  const otroDispositivo = cliente(srv.base);
  r = await otroDispositivo('POST', '/api/recuperar', { rut: '12.345.678-5', email: ESTUDIANTE.email, sede: 'Talca' });
  assert.equal(r.status, 401, 'la sede debe coincidir');
  r = await otroDispositivo('POST', '/api/recuperar', { rut: '12.345.678-5', email: 'beto@inacapmail.cl', sede: 'Rancagua' });
  assert.equal(r.status, 401, 'el correo debe ser el de esa inscripción');
  r = await otroDispositivo('POST', '/api/recuperar', { rut: '12345678-5', email: 'ANA.PEREZ@inacapmail.cl', sede: 'Rancagua' });
  assert.equal(r.status, 200);
  assert.equal(r.body.qr, ticket, 'recupera la misma entrada');
  assert.equal((await otroDispositivo('GET', '/api/yo')).body.nombres, 'Ana');

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
  assert.match(r.body.estudiante.rut, /^[•.]+5\.678-5$/, 'RUT enmascarado');

  r = await acr('POST', '/api/acreditacion/acreditar', { texto: 'https://portal.sidiv.registrocivil.cl/docstatus?RUN=12345678-5&type=CEDULA&serial=1' });
  assert.equal(r.body.resultado, 'YA_ACREDITADO', 'reconoce el QR de la cédula');
  r = await acr('POST', '/api/acreditacion/acreditar', { texto: 'ana.perez@inacapmail.cl' });
  assert.equal(r.body.resultado, 'YA_ACREDITADO');
  r = await acr('POST', '/api/acreditacion/acreditar', { texto: 'nadie@inacapmail.cl' });
  assert.deepEqual(r.body, { resultado: 'NO_REGISTRADO', email: 'nadie@inacapmail.cl', rut: null });
  r = await acr('POST', '/api/acreditacion/acreditar', { texto: '22.222.222-2' });
  assert.deepEqual(r.body, { resultado: 'NO_REGISTRADO', email: null, rut: '22.222.222-2' });

  r = await acr('POST', '/api/acreditacion/registro-presencial', { ...ESTUDIANTE, nombres: 'Carla', rut: '22.222.222-2', email: 'carla@inacapmail.cl' });
  assert.equal(r.status, 201);
  assert.equal(r.body.codigoAcceso, undefined);

  r = await acr('GET', '/api/acreditacion/buscar?q=11.111.111-1');
  assert.deepEqual(r.body.map((e) => e.nombres), ['Beto'], 'busca por RUT exacto');

  r = await acr('GET', '/api/acreditacion/buscar?q=perez');
  assert.equal(r.body.length, 4, "Ana, Beto, Carla y la docente Rosa");

  // Admin ve los datos completos, exporta y todo queda auditado.
  r = await admin('GET', '/api/admin/estudiantes?q=ana');
  assert.equal(r.body.total, 1);
  assert.equal(r.body.filas[0].telefono, '+56912345678');
  r = await admin('GET', '/api/admin/exportar/estudiantes.csv');
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.body, /Ana;Pérez Soto;12\.345\.678-5;Rancagua;ana\.perez@inacapmail\.cl;912345678;/);
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
  assert.equal(r.body.eliminados, 4);
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

  for (const p of ['/%2e%2e/wrangler.jsonc', '/package.json', '/js/..%2f..%2fsrc/worker.js', '/fotos/..%2fx.jpg', '/.dev.vars', '/src/evento.js', '/config/mes-ciberseguridad-2026.json']) {
    assert.equal((await c('GET', p)).status, 404, p);
  }

  r = await c('POST', '/api/registro', new Uint8Array(40 * 1024).fill(97), { 'Content-Type': 'application/json' });
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
  for (let i = 0; i < 5; i++) await atacante('POST', '/api/recuperar', { rut: ESTUDIANTE.rut, email: ESTUDIANTE.email, sede: 'Talca' });
  r = await atacante('POST', '/api/recuperar', { rut: ESTUDIANTE.rut, email: ESTUDIANTE.email, sede: ESTUDIANTE.sede });
  assert.equal(r.body.error, 'BLOQUEADO', 'tras 5 intentos fallidos se bloquea aunque los datos sean correctos');

  // Los errores internos no exponen detalles.
  r = await c('GET', '/api/admin/talleres/abc/inscritos');
  assert.equal(r.status, 401);
});

test('tiempo real: los cupos llegan por WebSocket al inscribirse', async (t) => {
  const srv = await levantar();
  t.after(() => srv.cerrar());
  const admin = await prepararAdmin(srv.base);
  const { body: taller } = await admin('POST', '/api/admin/talleres', { titulo: 'Redes', inicio: '2026-11-12T10:00', fin: '2026-11-12T12:00', cupos: 10, publicado: true });

  const ws = new WebSocket(srv.base.replace('http', 'ws') + '/api/tiempo-real');
  const mensajes = [];
  ws.addEventListener('message', (e) => mensajes.push(e.data));
  await new Promise((ok, falla) => { ws.addEventListener('open', ok); ws.addEventListener('error', falla); });
  ws.send('ping');

  const est = cliente(srv.base);
  await est('POST', '/api/registro', { ...ESTUDIANTE, talleres: [taller.id] });
  for (let i = 0; i < 40 && !mensajes.some((m) => m.includes('"inscritos":1')); i++) await new Promise((r) => setTimeout(r, 50));
  ws.close();
  assert.ok(mensajes.includes('pong'), 'responde ping sin despertar al objeto');
  const cupos = mensajes.filter((m) => m !== 'pong').map((m) => JSON.parse(m));
  assert.equal(cupos[0].tipo, 'cupos', 'al conectar recibe el estado actual');
  assert.ok(cupos.some((m) => m.tipo === 'cupos' && m.datos[taller.id]?.inscritos === 1), 'recibe la actualización');
});

test('carga inicial del Mes de la Ciberseguridad e importación desde archivo', async (t) => {
  const srv = await levantarApp({ TOKEN_CONFIGURACION: TOKEN, DATA_KEY, EVENTO_INICIAL: 'si' });
  t.after(() => srv.cerrar());
  const anon = cliente(srv.base);
  let r = await anon('GET', '/api/evento');
  assert.equal(r.body.evento.nombre, 'Mes de la Ciberseguridad');
  assert.equal(r.body.agenda.length, 7);
  assert.deepEqual(r.body.talleres.map((x) => x.sala).sort(), ['Lab 404', 'Lab 409', 'Sala 101'], 'sólo los talleres publicados');
  assert.equal(r.body.talleres.find((x) => x.sala === 'Lab 409').nivel, 'Intermedio');

  const admin = cliente(srv.base);
  await admin('POST', '/api/staff/configuracion-inicial', { token: TOKEN, nombre: 'Admin', email: 'admin@inacap.cl', clave: CLAVE_ADMIN });
  await admin('POST', '/api/staff/login', { email: 'admin@inacap.cl', clave: CLAVE_ADMIN });
  r = await admin('GET', '/api/admin/talleres');
  const lab409 = r.body.find((x) => x.sala === 'Lab 409');
  r = await admin('POST', '/api/admin/importar', { datos: { evento: { nombre: 'X' }, agenda: [], talleres: [] } });
  assert.equal(r.status, 422, 'valida el archivo antes de aplicar');
  const archivo = {
    evento: { nombre: 'Mes de la Ciberseguridad', lema: 'Modo Seguro', fecha_inicio: '2026-10-21', fecha_fin: '2026-10-21', max_talleres: 1, inscripciones_abiertas: 1, talleres_abiertos: 1 },
    agenda: [{ tipo: 'charla', titulo: 'Cierre', inicio: '2026-10-21T17:30', fin: '2026-10-21T17:40' }],
    talleres: [
      { titulo: 'Taller nuevo en Lab 409', docente: 'Docente', nivel: 'Avanzado', sala: 'Lab 409', inicio: '2026-10-21T16:10', fin: '2026-10-21T17:30', cupos: 25, publicado: true },
      { titulo: 'Taller en la biblioteca', docente: 'Felipe León', sala: 'CREA Empresa (Biblioteca) ampliada', inicio: '2026-10-21T16:10', fin: '2026-10-21T17:30', cupos: 30, publicado: false },
    ],
  };
  r = await admin('POST', '/api/admin/importar', { datos: archivo });
  assert.deepEqual(r.body, { creados: 0, actualizados: 2, actividades: 1 }, 'reconoce también la sala con más detalle');
  r = await admin('GET', '/api/admin/talleres');
  const actualizado = r.body.find((x) => x.sala === 'Lab 409');
  assert.equal(actualizado.id, lab409.id, 'reconoce el taller por sala y día');
  assert.equal(actualizado.titulo, 'Taller nuevo en Lab 409');
  assert.equal(actualizado.nivel, 'Avanzado');
});

test('servidor Node: la IP del cliente no se puede falsificar para evadir límites', { skip: process.env.RUNTIME !== 'node' }, async (t) => {
  const srv = await levantar();
  t.after(() => srv.cerrar());
  const c = cliente(srv.base);
  let ultimo;
  for (let i = 0; i < 20; i++) {
    ultimo = await c('POST', '/api/staff/login', { email: 'x@y.cl', clave: 'z' }, { 'CF-Connecting-IP': `10.0.0.${i}`, 'X-Forwarded-For': `10.0.1.${i}` });
  }
  assert.equal(ultimo.status, 429, 'cuenta todos los intentos como la misma IP real');
});
