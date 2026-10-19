'use strict';

// Carga un evento de ejemplo (sólo si aún no hay evento configurado). Uso: npm run ejemplo
const fs = require('node:fs');
const path = require('node:path');
const { abrirDB } = require('../src/db');
const { cargarClaveMaestra, crearCifrador } = require('../src/seguridad');

process.umask(0o077);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const db = abrirDB(path.join(DATA_DIR, 'evento.db'), crearCifrador(cargarClaveMaestra(path.join(DATA_DIR, 'clave.key'), process.env.DATA_KEY)));

if (db.evento.get()) {
  console.log('Ya existe un evento configurado; no se cargó el ejemplo.');
  process.exit(0);
}

db.evento.guardar({
  nombre: 'Semana de la Tecnología INACAP 2026',
  descripcion: 'Charlas, talleres prácticos y actividades para estudiantes de todas las sedes. Inscríbete, elige tus talleres y acredítate con tu entrada digital.',
  lugar: 'INACAP Sede Santiago Centro',
  direccion: 'Dirección por confirmar',
  contacto: 'eventos@inacap.cl',
  fecha_inicio: '2026-11-12',
  fecha_fin: '2026-11-13',
  max_talleres: 2,
  inscripciones_abiertas: 1,
  talleres_abiertos: 1,
});

const agenda = [
  ['acreditacion', 'Acreditación y bienvenida', '', 'Hall central', '2026-11-12T08:30', '2026-11-12T09:15'],
  ['charla', 'Inauguración', 'Autoridades de la sede', 'Auditorio', '2026-11-12T09:15', '2026-11-12T10:00'],
  ['charla', 'Charla inaugural: tendencias tecnológicas 2027', 'Invitado por confirmar', 'Auditorio', '2026-11-12T10:00', '2026-11-12T11:00'],
  ['pausa', 'Coffee break', '', 'Hall central', '2026-11-12T11:00', '2026-11-12T11:30'],
  ['pausa', 'Almuerzo libre', '', '', '2026-11-12T13:30', '2026-11-12T14:30'],
  ['charla', 'Cierre del día', '', 'Auditorio', '2026-11-12T16:30', '2026-11-12T17:00'],
  ['acreditacion', 'Acreditación día 2', '', 'Hall central', '2026-11-13T08:45', '2026-11-13T09:15'],
  ['charla', 'Panel: empleabilidad y mundo laboral', 'Empresas invitadas', 'Auditorio', '2026-11-13T09:15', '2026-11-13T10:30'],
  ['charla', 'Premiación y clausura', '', 'Auditorio', '2026-11-13T15:30', '2026-11-13T16:15'],
];
for (const [tipo, titulo, expositor, lugar, inicio, fin] of agenda) db.agenda.crear({ tipo, titulo, descripcion: '', expositor, lugar, inicio, fin });

const talleres = [
  ['Introducción a la ciberseguridad', 'Conceptos básicos, amenazas comunes y cómo protegerte.', 'Docente por confirmar', 'Laboratorio 1', '2026-11-12T11:30', '2026-11-12T13:30', 30],
  ['Desarrollo web con JavaScript', 'Crea tu primera aplicación web paso a paso.', 'Docente por confirmar', 'Laboratorio 2', '2026-11-12T11:30', '2026-11-12T13:30', 25],
  ['Robótica e IoT', 'Sensores, microcontroladores y prototipos conectados.', 'Docente por confirmar', 'Sala 301', '2026-11-12T14:30', '2026-11-12T16:30', 20],
  ['Análisis de datos con Excel y Power BI', 'Limpieza de datos y dashboards para la toma de decisiones.', 'Docente por confirmar', 'Laboratorio 1', '2026-11-13T10:45', '2026-11-13T12:45', 35],
  ['Inteligencia artificial aplicada', 'Usos prácticos de la IA en distintas carreras.', 'Docente por confirmar', 'Auditorio B', '2026-11-13T10:45', '2026-11-13T12:45', 60],
];
for (const [titulo, descripcion, docente, sala, inicio, fin, cupos] of talleres) {
  db.talleres.crear({ titulo, descripcion, docente, sala, inicio, fin, cupos, publicado: true });
}
console.log('Evento de ejemplo cargado. Edítalo desde /admin.');
db.cerrar();
