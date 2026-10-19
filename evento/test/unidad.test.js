import test from 'node:test';
import assert from 'node:assert/strict';
import { extraerIdentidad } from '../src/qr.js';
import { normalizarRut, formatearRut, enmascararRut, calcularDV } from '../src/rut.js';
import { crearDB } from '../src/db.js';
import * as seg from '../src/seguridad.js';
import * as v from '../src/validacion.js';
import { almacenamientoFalso } from './apoyo.js';
import { rangoPedido } from '../src/http.js';

const claveB64 = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('base64');

test('validación del registro de estudiantes', () => {
  const ok = v.validarRegistro({ nombres: 'María José', apellidos: "Pérez O'Higgins", rut: '12.345.678-5', sede: 'Curicó', email: 'Maria.Perez@INACAPMAIL.cl', telefono: '9 8765 4321' });
  assert.deepEqual(ok.errores, {});
  assert.equal(ok.datos.email, 'maria.perez@inacapmail.cl');
  assert.equal(ok.datos.telefono, '+56987654321');

  const malo = v.validarRegistro({ nombres: '<script>', apellidos: '', sede: 'Arica', email: 'x@gmail.com', telefono: '123' });
  assert.deepEqual(Object.keys(malo.errores).sort(), ['apellidos', 'email', 'nombres', 'rut', 'sede', 'telefono']);
  assert.equal(ok.datos.rut, '12345678-5');

  assert.equal(v.telefonoChile('+56 9 1234 5678'), '+56912345678');
  assert.equal(v.correoInstitucional('a..b@inacapmail.cl'), null);
  assert.equal(v.correoInstitucional('juan@inacapmail.cl.evil.com'), null);
  assert.equal(v.correoInstitucional('profe@inacap.cl'), 'profe@inacap.cl');
  assert.equal(v.correoInstitucional('profe@inacap.cl', 'inacapmail.cl'), null);
  const docente = v.validarRegistro({ tipo: 'docente', nombres: 'Ana', apellidos: 'Soto', rut: '12.345.678-5', sede: 'Talca', email: 'ana.soto@inacap.cl', telefono: '912345678' });
  assert.deepEqual(docente.errores, {});
  assert.equal(docente.datos.tipo, 'docente');
  assert.ok(v.validarRegistro({ ...docente.datos, rut: '12.345.678-5', email: 'ana@inacapmail.cl' }).errores.email, 'un docente usa @inacap.cl');
  assert.equal(v.validarRegistro({ tipo: 'hacker' }).datos.tipo, 'estudiante');
  assert.equal(v.linea('  hola\u0000‮ mundo  ', 50), 'hola mundo');
});

test('validación de talleres y contraseñas', () => {
  const t = v.validarTaller({ titulo: 'Taller', inicio: '2026-11-12T10:00', fin: '2026-11-12T09:00', cupos: 0 });
  assert.ok(t.errores.fin && t.errores.cupos);
  assert.equal(v.validarTaller({ titulo: 'T', nivel: 'Avanzado' }).datos.nivel, 'Avanzado');
  assert.equal(v.validarTaller({ titulo: 'T', nivel: '<b>' }).datos.nivel, '');
  assert.ok(v.validarTaller({ titulo: 'Taller', inicio: '2026-02-30T10:00', fin: '2026-03-01T10:00', cupos: 5 }).errores.inicio);
  assert.ok(v.validarClave('corta'));
  assert.ok(v.validarClave('solominusculasaaa'));
  assert.equal(v.validarClave('Clave-Segura-2026'), null);
});

test('RUT: dígito verificador, formatos y enmascarado', () => {
  assert.equal(calcularDV('12345678'), '5');
  assert.equal(normalizarRut('12.345.678-5'), '12345678-5');
  assert.equal(normalizarRut('123456785'), '12345678-5');
  assert.equal(normalizarRut('10.000.013-k'), '10000013-K');
  assert.equal(normalizarRut('12.345.678-6'), null);
  assert.equal(normalizarRut(''), null);
  assert.equal(formatearRut('12345678-5'), '12.345.678-5');
  assert.equal(enmascararRut('12345678-5'), '••.••5.678-5');
});

test('QR: entrada propia, cédula, RUT, código escrito y correo institucional', () => {
  assert.deepEqual(extraerIdentidad('https://portal.sidiv.registrocivil.cl/docstatus?RUN=12345678-5&type=CEDULA&serial=1'), { tipo: 'rut', rut: '12345678-5', fuente: 'cedula' });
  assert.equal(extraerIdentidad('https://portal.sidiv.registrocivil.cl/docstatus?RUN=12345678-4'), null);
  assert.deepEqual(extraerIdentidad('12.345.678-5'), { tipo: 'rut', rut: '12345678-5', fuente: 'texto' });
  assert.deepEqual(extraerIdentidad('EVT1:ABCDEFGHJKLMNPQR'), { tipo: 'ticket', codigo: 'ABCDEFGHJKLMNPQR' });
  assert.deepEqual(extraerIdentidad('abcd efgh jklm npqr'), { tipo: 'ticket', codigo: 'ABCDEFGHJKLMNPQR' });
  assert.deepEqual(extraerIdentidad('Juan.Soto@inacapmail.cl'), { tipo: 'email', email: 'juan.soto@inacapmail.cl' });
  assert.equal(extraerIdentidad('https://www.inacap.cl'), null);
  assert.equal(extraerIdentidad(''), null);
});

test('seguridad: PBKDF2, cifrado AES-GCM, índices y JPEG', async () => {
  const h = await seg.hashClave('Clave-Segura-2026', 2000);
  assert.match(h, /^pbkdf2-sha256\$2000\$/);
  assert.equal(await seg.verificarClave('Clave-Segura-2026', h), true);
  assert.equal(await seg.verificarClave('otra', h), false);
  assert.equal(await seg.verificarClave('x', 'pbkdf2-sha256$10$AA==$AA=='), false, 'rechaza iteraciones ridículas');

  await assert.rejects(seg.crearCifrador('corta'));
  const cif = await seg.crearCifrador(claveB64);
  const c = await cif.cifrar('+56912345678');
  assert.notEqual(c, await cif.cifrar('+56912345678'), 'IV aleatorio');
  assert.equal(await cif.descifrar(c), '+56912345678');
  const alterado = c.slice(0, -4) + (c.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  await assert.rejects(cif.descifrar(alterado), 'GCM detecta manipulación');
  assert.equal(await cif.indice('A@inacapmail.cl'), await cif.indice('a@inacapmail.cl'));
  const otro = await seg.crearCifrador(Buffer.alloc(32, 7).toString('base64'));
  assert.notEqual(await otro.indice('a@inacapmail.cl'), await cif.indice('a@inacapmail.cl'), 'depende de la clave');

  const exif = [0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
  const app0 = [0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46];
  const sos = [0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0x11, 0x22, 0xff, 0xd9];
  const jpeg = Uint8Array.from([0xff, 0xd8, ...app0, ...exif, ...sos]);
  const limpio = seg.limpiarJPEG(jpeg);
  assert.ok(limpio);
  assert.equal(Buffer.from(limpio).includes(Buffer.from('Exif')), false);
  assert.equal(limpio.length, jpeg.length - exif.length);
  assert.equal(seg.limpiarJPEG(new TextEncoder().encode('<svg onload=alert(1)>')), null);
});

const EVENTO = {
  nombre: 'Evento', lema: '', descripcion: '', lugar: '', direccion: '', contacto: '', fecha_inicio: '2026-11-12', fecha_fin: '2026-11-13',
  max_talleres: 2, inscripciones_abiertas: 1, talleres_abiertos: 1,
};

function base() {
  const db = crearDB(almacenamientoFalso());
  db.evento.guardar(EVENTO);
  const taller = (titulo, inicio, fin, cupos) => db.talleres.crear({ titulo, descripcion: '', docente: '', sala: '', inicio, fin, cupos, publicado: true });
  const est = (n) => db.estudiantes.crear({ nombres: 'Est', apellidos: `Nro ${n}`, sede: 'Talca', email_cif: 'v1:x', email_idx: `idx${n}`, telefono_cif: 'v1:y' }, 'hmac$x');
  return { db, taller, est };
}

test('DB: unicidad del correo y búsqueda sin tildes', () => {
  const { db, est } = base();
  const e = est(1);
  assert.throws(() => est(1), { codigo: 'YA_REGISTRADO' });
  assert.equal(db.estudiantes.porEmailIdx('idx1').id, e.id);
  db.estudiantes.crear({ nombres: 'Ana', apellidos: 'Pérez Soto', sede: 'Talca', email_cif: 'v1:x', email_idx: 'idx-ana', telefono_cif: 'v1:y' }, 'h');
  assert.equal(db.estudiantes.buscar({ q: 'perez' }).total, 1);
  assert.equal(db.estudiantes.buscar({ q: '%%' }).total, 0, 'los comodines se escapan');
});

test('DB: cupos, topes de horario, máximo y elección cerrada', () => {
  const { db, taller, est } = base();
  const a = taller('A', '2026-11-12T10:00', '2026-11-12T12:00', 2);
  const b = taller('B', '2026-11-12T11:00', '2026-11-12T13:00', 5);
  const c = taller('C', '2026-11-12T12:00', '2026-11-12T14:00', 5);
  const d = taller('D', '2026-11-13T10:00', '2026-11-13T12:00', 5);
  const [e1, e2, e3] = [est(1), est(2), est(3)];

  db.inscripciones.inscribir(e1.id, a.id);
  db.inscripciones.inscribir(e2.id, a.id);
  assert.throws(() => db.inscripciones.inscribir(e3.id, a.id), { codigo: 'SIN_CUPOS' });
  assert.throws(() => db.inscripciones.inscribir(e1.id, b.id), { codigo: 'CHOQUE_HORARIO' });
  db.inscripciones.inscribir(e1.id, c.id);
  assert.throws(() => db.inscripciones.inscribir(e1.id, d.id), { codigo: 'MAXIMO_TALLERES' });
  assert.throws(() => db.talleres.actualizar(a.id, { ...a, cupos: 1 }), { codigo: 'CUPOS_INSUFICIENTES' });

  db.evento.guardar({ ...EVENTO, talleres_abiertos: 0 });
  assert.throws(() => db.inscripciones.inscribir(e3.id, d.id), { codigo: 'TALLERES_CERRADOS' });
  assert.equal(db.inscripciones.inscribir(e3.id, d.id, { forzar: true }), true);

  db.estudiantes.eliminar(e2.id);
  assert.deepEqual(db.talleres.cupos()[a.id], { cupos: 2, inscritos: 1 }, 'al eliminar un estudiante se liberan sus cupos');
});

test('DB: transacciones atómicas y sesiones con expiración por inactividad', () => {
  const almacen = almacenamientoFalso();
  const db = crearDB(almacen);
  db.evento.guardar(EVENTO);
  assert.throws(() => db.tx(() => {
    db.agenda.crear({ tipo: 'charla', titulo: 'X', descripcion: '', expositor: '', lugar: '', inicio: '2026-11-12T10:00', fin: '2026-11-12T11:00' });
    throw new Error('falla a mitad');
  }));
  assert.equal(db.agenda.listar().length, 0, 'se revierte todo');

  const u = db.usuarios.crear({ email: 'a@x.cl', nombre: 'A', rol: 'admin' }, 'h');
  db.sesiones.crearUsuario('hash-token', u.id, 8);
  assert.equal(db.sesiones.usuario('hash-token', { admin: 60, acreditador: 180 }).rol, 'admin');
  almacen.db.prepare('UPDATE sesiones_usuarios SET ultimo_uso = ?').run(new Date(Date.now() - 61 * 60_000).toISOString());
  assert.equal(db.sesiones.usuario('hash-token', { admin: 60, acreditador: 180 }), null);
});

test('rangos de bytes para el video', () => {
  assert.equal(rangoPedido(null, 100), null);
  assert.deepEqual(rangoPedido('bytes=0-1', 100), [0, 1]);
  assert.deepEqual(rangoPedido('bytes=90-', 100), [90, 99]);
  assert.deepEqual(rangoPedido('bytes=-10', 100), [90, 99]);
  assert.deepEqual(rangoPedido('bytes=50-500', 100), [50, 99]);
  for (const malo of ['bytes=100-', 'bytes=5-2', 'bytes=-', 'bytes=0-1,5-6', 'items=0-1']) assert.equal(rangoPedido(malo, 100), false, malo);
});
