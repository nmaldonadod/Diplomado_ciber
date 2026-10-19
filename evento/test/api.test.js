'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { abrirDB } = require('../src/db');
const { crearApp } = require('../src/app');

const config = {
  nombre: 'Evento de prueba',
  maxTalleresPorEstudiante: 3,
  sedes: ['Santiago Centro'],
  dias: [{ fecha: '2026-11-12' }],
  agenda: [],
  talleres: [{ id: 't1', titulo: 'Taller 1', sala: 'Lab', inicio: '2026-11-12T10:00', fin: '2026-11-12T12:00', cupos: 1 }],
};

async function levantar() {
  const db = abrirDB(':memory:', config);
  const app = crearApp({ config, db, staffPin: '4321', publicDir: path.join(__dirname, '..', 'public') });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    async cerrar() {
      app.cerrar();
      await new Promise((r) => server.close(r));
      db.cerrar();
    },
  };
}

function cliente(base) {
  let cookies = {};
  return async function pedir(metodo, ruta, cuerpo, extra = {}) {
    const headers = { Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '), ...extra };
    if (cuerpo !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + ruta, { method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
    for (const c of res.headers.getSetCookie()) {
      const [par] = c.split(';');
      const [k, v] = par.split('=');
      cookies[k] = v;
    }
    const tipo = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: tipo.includes('json') ? await res.json() : await res.text() };
  };
}

test('flujo completo: registro → taller → acreditación por QR de cédula', async (t) => {
  const srv = await levantar();
  t.after(() => srv.cerrar());
  const alumno = cliente(srv.base);
  const otro = cliente(srv.base);
  const staff = cliente(srv.base);

  let r = await alumno('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);

  r = await alumno('POST', '/api/registro', { rut: '12.345.678-5', nombre: 'Ana Pérez', email: 'Ana@Test.cl', sede: 'Santiago Centro' });
  assert.equal(r.status, 422, 'exige consentimiento');
  assert.ok(r.body.errores.consentimiento);

  r = await alumno('POST', '/api/registro', { rut: '12.345.678-5', nombre: 'Ana Pérez', email: 'Ana@Test.cl', sede: 'Santiago Centro', consentimiento: true });
  assert.equal(r.status, 201);
  assert.equal(r.body.rut, '12.345.678-5');
  assert.match(r.body.qr, /^EVT1:/);

  r = await otro('POST', '/api/registro', { rut: '123456785', nombre: 'Ana Pérez', email: 'x@test.cl', consentimiento: true });
  assert.equal(r.body.error, 'YA_REGISTRADO');

  r = await otro('POST', '/api/talleres/t1/inscripcion', {});
  assert.equal(r.status, 401);

  r = await alumno('POST', '/api/talleres/t1/inscripcion', {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.perfil.talleres, ['t1']);
  assert.deepEqual(r.body.cupos.t1, { cupos: 1, inscritos: 1 });

  await otro('POST', '/api/registro', { rut: '11.111.111-1', nombre: 'Beto Soto', email: 'b@test.cl', consentimiento: true });
  r = await otro('POST', '/api/talleres/t1/inscripcion', {});
  assert.equal(r.body.error, 'SIN_CUPOS');

  // Recuperar acceso desde otro dispositivo
  const tercero = cliente(srv.base);
  r = await tercero('POST', '/api/acceso', { rut: '12345678-5', email: 'otro@test.cl' });
  assert.equal(r.status, 401);
  r = await tercero('POST', '/api/acceso', { rut: '12345678-5', email: 'ana@test.cl' });
  assert.equal(r.status, 200);
  assert.equal(r.body.nombre, 'Ana Pérez');

  // Staff
  r = await staff('POST', '/api/staff/acreditar', { texto: '12345678-5' });
  assert.equal(r.status, 401);
  r = await staff('POST', '/api/staff/login', { pin: '0000' });
  assert.equal(r.status, 401);
  r = await staff('POST', '/api/staff/login', { pin: '4321', operador: 'Puerta 1' });
  assert.equal(r.status, 200);

  r = await staff('POST', '/api/staff/acreditar', { texto: 'https://portal.sidiv.registrocivil.cl/docstatus?RUN=12345678-5&type=CEDULA&serial=1' });
  assert.equal(r.body.resultado, 'ACREDITADO');
  assert.equal(r.body.fuente, 'cedula');
  assert.equal(r.body.estudiante.talleres[0].id, 't1');
  assert.equal(r.body.estudiante.acreditadoPor, 'Puerta 1');

  const ticket = (await alumno('GET', '/api/yo')).body.qr;
  r = await staff('POST', '/api/staff/acreditar', { texto: ticket });
  assert.equal(r.body.resultado, 'YA_ACREDITADO');

  r = await staff('POST', '/api/staff/acreditar', { texto: '22.222.222-2' });
  assert.deepEqual(r.body, { resultado: 'NO_REGISTRADO', rut: '22.222.222-2' });
  r = await staff('POST', '/api/staff/registro-presencial', { rut: '22.222.222-2', nombre: 'Carla Díaz', email: 'c@test.cl' });
  assert.equal(r.status, 201);
  assert.equal(r.body.resultado, 'ACREDITADO');

  r = await staff('POST', '/api/staff/acreditar', { texto: 'cualquier cosa' });
  assert.equal(r.body.resultado, 'NO_RECONOCIDO');

  r = await staff('GET', '/api/staff/estadisticas');
  assert.equal(r.body.registrados, 3);
  assert.equal(r.body.acreditados, 2);
  assert.equal(r.body.presenciales, 1);

  r = await staff('GET', '/api/staff/exportar/registrados.csv');
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.body, /12\.345\.678-5;Ana Pérez;ana@test\.cl/);
});

test('seguridad: origen cruzado, path traversal y JSON obligatorio', async (t) => {
  const srv = await levantar();
  t.after(() => srv.cerrar());
  const c = cliente(srv.base);

  let r = await c('POST', '/api/staff/login', { pin: '4321' }, { Origin: 'https://evil.example' });
  assert.equal(r.status, 403);

  r = await fetch(srv.base + '/api/staff/login', { method: 'POST', body: 'pin=4321', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.status, 415);

  r = await c('GET', '/%2e%2e/server.js');
  assert.equal(r.status, 404);
  r = await c('GET', '/../package.json');
  assert.equal(r.status, 404);

  // Limitador de intentos del PIN
  let ultimo;
  for (let i = 0; i < 10; i++) ultimo = await c('POST', '/api/staff/login', { pin: 'x' });
  assert.equal(ultimo.status, 429);
});
