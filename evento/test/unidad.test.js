'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { extraerIdentidad } = require('../src/qr');
const { abrirDB } = require('../src/db');
const seg = require('../src/seguridad');
const v = require('../src/validacion');

const cifrador = seg.crearCifrador(crypto.randomBytes(32));

test('validación del registro de estudiantes', () => {
  const ok = v.validarRegistro({ nombres: 'María José', apellidos: "Pérez O'Higgins", sede: 'Curicó', email: 'Maria.Perez@INACAPMAIL.cl', telefono: '9 8765 4321' });
  assert.deepEqual(ok.errores, {});
  assert.equal(ok.datos.email, 'maria.perez@inacapmail.cl');
  assert.equal(ok.datos.telefono, '+56987654321');

  const malo = v.validarRegistro({ nombres: '<script>', apellidos: '', sede: 'Arica', email: 'x@gmail.com', telefono: '123' });
  assert.deepEqual(Object.keys(malo.errores).sort(), ['apellidos', 'email', 'nombres', 'sede', 'telefono']);

  assert.equal(v.telefonoChile('+56 9 1234 5678'), '+56912345678');
  assert.equal(v.telefonoChile('56912345678'), '+56912345678');
  assert.equal(v.correoInstitucional('a..b@inacapmail.cl'), null);
  assert.equal(v.correoInstitucional('juan@inacapmail.cl.evil.com'), null);
  assert.equal(v.linea('  hola\u0000‮ mundo  ', 50), 'hola mundo');
});

test('validación de talleres y contraseñas', () => {
  const t = v.validarTaller({ titulo: 'Taller', inicio: '2026-11-12T10:00', fin: '2026-11-12T09:00', cupos: 0 });
  assert.ok(t.errores.fin && t.errores.cupos);
  assert.ok(v.validarTaller({ titulo: 'Taller', inicio: '2026-02-30T10:00', fin: '2026-03-01T10:00', cupos: 5 }).errores.inicio);
  assert.equal(v.validarClave('corta'), 'La contraseña debe tener al menos 12 caracteres.');
  assert.ok(v.validarClave('solominusculasaaa'));
  assert.equal(v.validarClave('Clave-Segura-2026'), null);
});

test('QR: entrada propia, código escrito y correo institucional', () => {
  assert.deepEqual(extraerIdentidad('EVT1:ABCDEFGHJKLMNPQR'), { tipo: 'ticket', codigo: 'ABCDEFGHJKLMNPQR' });
  assert.deepEqual(extraerIdentidad('abcd efgh jklm npqr'), { tipo: 'ticket', codigo: 'ABCDEFGHJKLMNPQR' });
  assert.deepEqual(extraerIdentidad('Juan.Soto@inacapmail.cl'), { tipo: 'email', email: 'juan.soto@inacapmail.cl' });
  assert.equal(extraerIdentidad('https://www.inacap.cl'), null);
  assert.equal(extraerIdentidad(''), null);
});

test('seguridad: hash de contraseñas, cifrado y JPEG', async () => {
  const h = await seg.hashClave('Clave-Segura-2026');
  assert.match(h, /^scrypt\$/);
  assert.equal(await seg.verificarClave('Clave-Segura-2026', h), true);
  assert.equal(await seg.verificarClave('otra', h), false);

  const c = cifrador.cifrar('+56912345678');
  assert.notEqual(c, cifrador.cifrar('+56912345678'), 'IV aleatorio');
  assert.equal(cifrador.descifrar(c), '+56912345678');
  const alterado = c.slice(0, -4) + (c.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  assert.throws(() => cifrador.descifrar(alterado), 'GCM detecta manipulación');
  assert.equal(cifrador.indice('A@inacapmail.cl'), cifrador.indice('a@inacapmail.cl'));

  // JPEG mínimo con un segmento EXIF (APP1) que debe eliminarse.
  const exif = Buffer.from([0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0x11, 0x22, 0xff, 0xd9]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, exif, sos]);
  const limpio = seg.limpiarJPEG(jpeg);
  assert.ok(limpio);
  assert.equal(limpio.includes(Buffer.from('Exif')), false);
  assert.equal(limpio.length, jpeg.length - exif.length);
  assert.equal(seg.limpiarJPEG(Buffer.from('<svg onload=alert(1)>')), null);
  assert.equal(seg.limpiarJPEG(Buffer.from([0x89, 0x50, 0x4e, 0x47])), null);
});

const EVENTO = {
  nombre: 'Evento', descripcion: '', lugar: '', direccion: '', contacto: '', fecha_inicio: '2026-11-12', fecha_fin: '2026-11-13',
  max_talleres: 2, inscripciones_abiertas: 1, talleres_abiertos: 1,
};

function base() {
  const db = abrirDB(':memory:', cifrador);
  db.evento.guardar(EVENTO);
  const taller = (titulo, inicio, fin, cupos) => db.talleres.crear({ titulo, descripcion: '', docente: '', sala: '', inicio, fin, cupos, publicado: true });
  const est = (n) => db.estudiantes.crear({ nombres: 'Est', apellidos: `Nro ${n}`, sede: 'Talca', email: `e${n}@inacapmail.cl`, telefono: '+56911111111' }, 'x');
  return { db, taller, est };
}

test('DB: datos personales cifrados en reposo', () => {
  const { db, est } = base();
  const e = est(1);
  const fila = db.db.prepare('SELECT * FROM estudiantes WHERE id = ?').get(e.id);
  assert.equal(fila.email_cif.includes('inacapmail'), false);
  assert.equal(fila.telefono_cif.includes('911111111'), false);
  assert.equal(db.estudiantes.porEmail('E1@inacapmail.cl').id, e.id);
  assert.throws(() => est(1), { codigo: 'YA_REGISTRADO' });
  db.cerrar();
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
  db.inscripciones.inscribir(e1.id, c.id); // empieza justo cuando termina A
  assert.throws(() => db.inscripciones.inscribir(e1.id, d.id), { codigo: 'MAXIMO_TALLERES' });
  assert.throws(() => db.talleres.actualizar(a.id, { ...a, cupos: 1 }), { codigo: 'CUPOS_INSUFICIENTES' });

  db.evento.guardar({ ...EVENTO, talleres_abiertos: 0 });
  assert.throws(() => db.inscripciones.inscribir(e3.id, d.id), { codigo: 'TALLERES_CERRADOS' });
  assert.equal(db.inscripciones.inscribir(e3.id, d.id, { forzar: true }), true);

  // Al eliminar un estudiante se liberan sus cupos.
  db.estudiantes.eliminar(e2.id);
  assert.deepEqual(db.talleres.cupos()[a.id], { cupos: 2, inscritos: 1 });
  db.cerrar();
});

test('DB: sesiones con expiración por inactividad según rol', async () => {
  const { db } = base();
  const u = db.usuarios.crear({ email: 'a@x.cl', nombre: 'A', rol: 'admin' }, 'h');
  const token = db.sesiones.crearUsuario(u.id, 8);
  assert.equal(db.sesiones.usuario(token, { admin: 60, acreditador: 180 }).rol, 'admin');
  db.db.prepare('UPDATE sesiones_usuarios SET ultimo_uso = ?').run(new Date(Date.now() - 61 * 60_000).toISOString());
  assert.equal(db.sesiones.usuario(token, { admin: 60, acreditador: 180 }), null);
  db.cerrar();
});
