'use strict';

// Carga un evento desde un archivo JSON.
// Uso: npm run cargar-evento                    → carga el evento si aún no hay uno configurado
//      npm run cargar-evento -- --actualizar    → actualiza datos, agenda y talleres de un evento en curso,
//                                                  conservando inscripciones y fotos (los talleres se reconocen por sala y día)
//      npm run cargar-evento -- otro.json       → usa otro archivo
const fs = require('node:fs');
const path = require('node:path');
const { abrirDB } = require('../src/db');
const { cargarClaveMaestra, crearCifrador } = require('../src/seguridad');
const v = require('../src/validacion');

process.umask(0o077);
const args = process.argv.slice(2);
const actualizar = args.includes('--actualizar');
const archivo = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(__dirname, '..', 'config', 'mes-ciberseguridad-2026.json'));
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

if (db.evento.get() && !actualizar) {
  console.log('Ya existe un evento configurado; no se cargó nada. Para aplicar cambios usa: npm run cargar-evento -- --actualizar');
  process.exit(0);
}

let creados = 0;
let actualizados = 0;
try {
  db.tx(() => {
    db.evento.guardar(evento.datos);
    for (const a of db.agenda.listar()) db.agenda.eliminar(a.id);
    for (const a of agenda) db.agenda.crear(a.datos);
    const existentes = db.talleres.listar(false);
    for (const { datos: t } of talleres) {
      const previo = existentes.find((x) => x.sala === t.sala && x.inicio.slice(0, 10) === t.inicio.slice(0, 10));
      if (previo) {
        db.talleres.actualizar(previo.id, t);
        actualizados += 1;
      } else {
        db.talleres.crear(t);
        creados += 1;
      }
    }
  });
} catch (e) {
  console.error('No se aplicaron cambios:', e.message);
  process.exit(1);
}
const borradores = talleres.filter((t) => !t.datos.publicado).length;
console.log(`Evento «${evento.datos.nombre}» ${actualizar ? 'actualizado' : 'cargado'}: ${agenda.length} actividades, ` +
  `${creados} talleres nuevos y ${actualizados} actualizados` +
  (borradores ? ` (${borradores} en borrador: complétalos y publícalos desde /admin → Talleres).` : '.'));
db.cerrar();
