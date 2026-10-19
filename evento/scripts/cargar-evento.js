'use strict';

// Carga un evento desde un archivo JSON (sólo si aún no hay evento configurado).
// Uso: npm run cargar-evento [-- config/otro-evento.json]
const fs = require('node:fs');
const path = require('node:path');
const { abrirDB } = require('../src/db');
const { cargarClaveMaestra, crearCifrador } = require('../src/seguridad');
const v = require('../src/validacion');

process.umask(0o077);
const archivo = path.resolve(process.argv[2] || path.join(__dirname, '..', 'config', 'mes-ciberseguridad-2026.json'));
const datos = JSON.parse(fs.readFileSync(archivo, 'utf8'));

// Se valida con las mismas reglas que usa la administración.
const errores = [];
const evento = v.validarEvento({ ...datos.evento, inscripciones_abiertas: Boolean(datos.evento.inscripciones_abiertas), talleres_abiertos: Boolean(datos.evento.talleres_abiertos) });
if (v.hayErrores(evento.errores)) errores.push(['evento', evento.errores]);
const agenda = datos.agenda.map((a, i) => ({ i, ...v.validarAgenda(a) }));
const talleres = datos.talleres.map((t, i) => ({ i, ...v.validarTaller(t) }));
for (const x of agenda) if (v.hayErrores(x.errores)) errores.push([`agenda[${x.i}]`, x.errores]);
for (const x of talleres) if (v.hayErrores(x.errores)) errores.push([`talleres[${x.i}]`, x.errores]);
if (errores.length) {
  console.error('El archivo tiene errores:', JSON.stringify(errores, null, 2));
  process.exit(1);
}

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const db = abrirDB(path.join(DATA_DIR, 'evento.db'), crearCifrador(cargarClaveMaestra(path.join(DATA_DIR, 'clave.key'), process.env.DATA_KEY)));

if (db.evento.get()) {
  console.log('Ya existe un evento configurado; no se cargó nada. Edítalo desde /admin.');
  process.exit(0);
}

db.tx(() => {
  db.evento.guardar(evento.datos);
  for (const a of agenda) db.agenda.crear(a.datos);
  for (const t of talleres) db.talleres.crear(t.datos);
});
const borradores = talleres.filter((t) => !t.datos.publicado).length;
console.log(`Evento «${evento.datos.nombre}» cargado: ${agenda.length} actividades y ${talleres.length} talleres` +
  (borradores ? ` (${borradores} en borrador: complétalos y publícalos desde /admin → Talleres).` : '.'));
db.cerrar();
