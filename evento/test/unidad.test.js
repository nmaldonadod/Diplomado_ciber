'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizarRut, formatearRut, calcularDV } = require('../src/rut');
const { extraerIdentidad } = require('../src/qr');
const { abrirDB } = require('../src/db');

test('RUT: dígito verificador y normalización', () => {
  assert.equal(calcularDV('12345678'), '5');
  assert.equal(calcularDV('11111111'), '1');
  assert.equal(normalizarRut('12.345.678-5'), '12345678-5');
  assert.equal(normalizarRut('123456785'), '12345678-5');
  assert.equal(normalizarRut('12.345.678-6'), null);
  assert.equal(normalizarRut('1-9'), null);
  assert.equal(normalizarRut(''), null);
  assert.equal(normalizarRut(null), null);
  assert.equal(formatearRut('12345678-5'), '12.345.678-5');
  // RUT con dígito verificador K
  assert.equal(normalizarRut('10.000.013-k'), '10000013-K');
});

test('QR: entrada propia, cédula chilena, credencial y texto', () => {
  assert.deepEqual(extraerIdentidad('EVT1:ABCDEFGHJKLMNPQR'), { tipo: 'ticket', codigo: 'ABCDEFGHJKLMNPQR' });
  assert.deepEqual(
    extraerIdentidad('https://portal.sidiv.registrocivil.cl/docstatus?RUN=12345678-5&type=CEDULA&serial=123456789&mrz=123'),
    { tipo: 'rut', rut: '12345678-5', fuente: 'cedula' });
  assert.equal(extraerIdentidad('https://portal.sidiv.registrocivil.cl/docstatus?RUN=12345678-4&type=CEDULA'), null);
  assert.deepEqual(extraerIdentidad('12.345.678-5'), { tipo: 'rut', rut: '12345678-5', fuente: 'texto' });
  assert.deepEqual(extraerIdentidad('ALUMNO;PEREZ JUAN;12.345.678-5;INACAP'), { tipo: 'rut', rut: '12345678-5', fuente: 'credencial' });
  assert.equal(extraerIdentidad('https://www.inacap.cl'), null);
  assert.equal(extraerIdentidad('hola mundo'), null);
  assert.equal(extraerIdentidad(''), null);
});

const config = {
  maxTalleresPorEstudiante: 2,
  talleres: [
    { id: 'a', titulo: 'A', inicio: '2026-11-12T10:00', fin: '2026-11-12T12:00', cupos: 2 },
    { id: 'b', titulo: 'B', inicio: '2026-11-12T11:00', fin: '2026-11-12T13:00', cupos: 5 },
    { id: 'c', titulo: 'C', inicio: '2026-11-12T12:00', fin: '2026-11-12T14:00', cupos: 5 },
    { id: 'd', titulo: 'D', inicio: '2026-11-13T10:00', fin: '2026-11-13T12:00', cupos: 5 },
  ],
};

function estudiante(db, rut, nombre = 'Estudiante Prueba') {
  return db.registrar({ rut, nombre, email: `${rut}@test.cl` });
}

test('DB: registro, cupos, topes de horario y máximo de talleres', () => {
  const db = abrirDB(':memory:', config);
  const e1 = estudiante(db, '12345678-5');
  const e2 = estudiante(db, '11111111-1');
  const e3 = estudiante(db, '22222222-2');
  assert.match(e1.codigo, /^[A-Z2-9]{16}$/);
  assert.throws(() => estudiante(db, '12345678-5'), { codigo: 'YA_REGISTRADO' });

  db.inscribir(e1.id, 'a');
  db.inscribir(e2.id, 'a');
  assert.throws(() => db.inscribir(e3.id, 'a'), { codigo: 'SIN_CUPOS' });
  assert.deepEqual(db.cupos().a, { cupos: 2, inscritos: 2 });

  // B se cruza con A; C empieza justo cuando termina A (no hay tope).
  assert.throws(() => db.inscribir(e1.id, 'b'), { codigo: 'CHOQUE_HORARIO' });
  db.inscribir(e1.id, 'c');
  assert.throws(() => db.inscribir(e1.id, 'd'), { codigo: 'MAXIMO_TALLERES' });
  assert.deepEqual(db.inscribir(e1.id, 'c'), { yaInscrito: true });

  // Al liberar un cupo, otro estudiante puede tomarlo.
  assert.equal(db.desinscribir(e2.id, 'a'), true);
  db.inscribir(e3.id, 'a');
  assert.throws(() => db.inscribir(e1.id, 'zzz'), { codigo: 'TALLER_INEXISTENTE' });
  db.cerrar();
});

test('DB: acreditación idempotente y sesiones', () => {
  const db = abrirDB(':memory:', config);
  const e = estudiante(db, '12345678-5');
  assert.equal(db.acreditar(e.id, 'puerta 1'), true);
  assert.equal(db.acreditar(e.id, 'puerta 2'), false);
  assert.equal(db.porId(e.id).acreditado_por, 'puerta 1');
  assert.equal(db.desacreditar(e.id), true);
  assert.equal(db.porId(e.id).acreditado_en, null);

  const token = db.crearSesion(e.id);
  assert.equal(db.estudiantePorSesion(token).id, e.id);
  assert.equal(db.estudiantePorSesion('otro'), undefined);
  db.cerrarSesion(token);
  assert.equal(db.estudiantePorSesion(token), undefined);
  assert.equal(db.buscar('12.345').length, 1);
  assert.equal(db.buscar('Prueba').length, 1);
  assert.equal(db.buscar('%').length, 0);
  db.cerrar();
});
