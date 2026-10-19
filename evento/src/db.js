'use strict';

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

class ErrorNegocio extends Error {
  constructor(codigo, mensaje, status = 409) {
    super(mensaje);
    this.codigo = codigo;
    this.status = status;
  }
}

const ALFABETO_CODIGO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 símbolos, sin 0/O ni 1/I

function nuevoCodigo() {
  let codigo = '';
  for (const b of crypto.randomBytes(16)) codigo += ALFABETO_CODIGO[b & 31];
  return codigo;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

const ahora = () => new Date().toISOString();

const ESQUEMA = `
  CREATE TABLE IF NOT EXISTS estudiantes (
    id             INTEGER PRIMARY KEY,
    rut            TEXT NOT NULL UNIQUE,
    nombre         TEXT NOT NULL,
    email          TEXT NOT NULL,
    telefono       TEXT,
    carrera        TEXT,
    sede           TEXT,
    codigo         TEXT NOT NULL UNIQUE,
    origen         TEXT NOT NULL DEFAULT 'web',
    creado_en      TEXT NOT NULL,
    acreditado_en  TEXT,
    acreditado_por TEXT
  );
  CREATE TABLE IF NOT EXISTS sesiones (
    token_hash    TEXT PRIMARY KEY,
    estudiante_id INTEGER NOT NULL REFERENCES estudiantes(id) ON DELETE CASCADE,
    creado_en     TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS talleres (
    id     TEXT PRIMARY KEY,
    titulo TEXT NOT NULL,
    inicio TEXT NOT NULL,
    fin    TEXT NOT NULL,
    cupos  INTEGER NOT NULL,
    activo INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS inscripciones (
    estudiante_id INTEGER NOT NULL REFERENCES estudiantes(id) ON DELETE CASCADE,
    taller_id     TEXT NOT NULL REFERENCES talleres(id),
    creado_en     TEXT NOT NULL,
    PRIMARY KEY (estudiante_id, taller_id)
  );
  CREATE INDEX IF NOT EXISTS ix_inscripciones_taller ON inscripciones(taller_id);
  CREATE INDEX IF NOT EXISTS ix_estudiantes_acreditado ON estudiantes(acreditado_en);
`;

function abrirDB(archivo, config) {
  const db = new DatabaseSync(archivo);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(ESQUEMA);

  const maxTalleres = Number(config.maxTalleresPorEstudiante) || 0;

  function transaccion(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  // Sincroniza los talleres definidos en la configuración (las inscripciones se conservan).
  transaccion(() => {
    db.prepare('UPDATE talleres SET activo = 0').run();
    const upsert = db.prepare(`
      INSERT INTO talleres (id, titulo, inicio, fin, cupos, activo) VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET titulo = excluded.titulo, inicio = excluded.inicio,
        fin = excluded.fin, cupos = excluded.cupos, activo = 1`);
    for (const t of config.talleres || []) upsert.run(t.id, t.titulo, t.inicio, t.fin, t.cupos);
  });

  const q = {
    insertarEstudiante: db.prepare(`
      INSERT INTO estudiantes (rut, nombre, email, telefono, carrera, sede, codigo, origen, creado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    porId: db.prepare('SELECT * FROM estudiantes WHERE id = ?'),
    porRut: db.prepare('SELECT * FROM estudiantes WHERE rut = ?'),
    porCodigo: db.prepare('SELECT * FROM estudiantes WHERE codigo = ?'),
    porSesion: db.prepare(`SELECT e.* FROM sesiones s JOIN estudiantes e ON e.id = s.estudiante_id WHERE s.token_hash = ?`),
    insertarSesion: db.prepare('INSERT INTO sesiones (token_hash, estudiante_id, creado_en) VALUES (?, ?, ?)'),
    borrarSesion: db.prepare('DELETE FROM sesiones WHERE token_hash = ?'),
    taller: db.prepare('SELECT * FROM talleres WHERE id = ? AND activo = 1'),
    inscritosTaller: db.prepare('SELECT COUNT(*) AS n FROM inscripciones WHERE taller_id = ?'),
    inscripcionesDe: db.prepare(`
      SELECT t.id, t.titulo, t.inicio, t.fin FROM inscripciones i JOIN talleres t ON t.id = i.taller_id
      WHERE i.estudiante_id = ? AND t.activo = 1 ORDER BY t.inicio`),
    existeInscripcion: db.prepare('SELECT 1 FROM inscripciones WHERE estudiante_id = ? AND taller_id = ?'),
    insertarInscripcion: db.prepare('INSERT INTO inscripciones (estudiante_id, taller_id, creado_en) VALUES (?, ?, ?)'),
    borrarInscripcion: db.prepare('DELETE FROM inscripciones WHERE estudiante_id = ? AND taller_id = ?'),
    cupos: db.prepare(`
      SELECT t.id, t.cupos, COUNT(i.estudiante_id) AS inscritos
      FROM talleres t LEFT JOIN inscripciones i ON i.taller_id = t.id
      WHERE t.activo = 1 GROUP BY t.id`),
    acreditar: db.prepare('UPDATE estudiantes SET acreditado_en = ?, acreditado_por = ? WHERE id = ? AND acreditado_en IS NULL'),
    desacreditar: db.prepare('UPDATE estudiantes SET acreditado_en = NULL, acreditado_por = NULL WHERE id = ?'),
    buscar: db.prepare(`
      SELECT * FROM estudiantes WHERE rut LIKE ? ESCAPE '\\' OR nombre LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\'
      ORDER BY nombre LIMIT 25`),
    totales: db.prepare(`
      SELECT COUNT(*) AS registrados, COUNT(acreditado_en) AS acreditados,
             SUM(origen = 'presencial') AS presenciales FROM estudiantes`),
    porSede: db.prepare(`
      SELECT COALESCE(NULLIF(sede, ''), 'Sin sede') AS sede, COUNT(*) AS registrados, COUNT(acreditado_en) AS acreditados
      FROM estudiantes GROUP BY 1 ORDER BY 2 DESC`),
    ultimasAcreditaciones: db.prepare(`
      SELECT id, nombre, rut, acreditado_en, acreditado_por FROM estudiantes
      WHERE acreditado_en IS NOT NULL ORDER BY acreditado_en DESC LIMIT ?`),
    todos: db.prepare('SELECT * FROM estudiantes ORDER BY creado_en'),
    todasInscripciones: db.prepare(`
      SELECT t.id AS taller_id, t.titulo, t.inicio, e.rut, e.nombre, e.email, e.carrera, e.sede, e.acreditado_en, i.creado_en
      FROM inscripciones i JOIN talleres t ON t.id = i.taller_id JOIN estudiantes e ON e.id = i.estudiante_id
      WHERE t.activo = 1 ORDER BY t.inicio, t.id, e.nombre`),
  };

  function registrar(datos, origen = 'web') {
    return transaccion(() => {
      if (q.porRut.get(datos.rut)) throw new ErrorNegocio('YA_REGISTRADO', 'Este RUT ya está registrado en el evento.');
      let codigo;
      do codigo = nuevoCodigo(); while (q.porCodigo.get(codigo));
      const r = q.insertarEstudiante.run(datos.rut, datos.nombre, datos.email, datos.telefono || null,
        datos.carrera || null, datos.sede || null, codigo, origen, ahora());
      return q.porId.get(Number(r.lastInsertRowid));
    });
  }

  function crearSesion(estudianteId) {
    const token = crypto.randomBytes(32).toString('base64url');
    q.insertarSesion.run(hashToken(token), estudianteId, ahora());
    return token;
  }

  function inscribir(estudianteId, tallerId) {
    return transaccion(() => {
      const taller = q.taller.get(tallerId);
      if (!taller) throw new ErrorNegocio('TALLER_INEXISTENTE', 'El taller no existe.', 404);
      if (q.existeInscripcion.get(estudianteId, tallerId)) return { yaInscrito: true };

      const mias = q.inscripcionesDe.all(estudianteId);
      if (maxTalleres && mias.length >= maxTalleres) {
        throw new ErrorNegocio('MAXIMO_TALLERES', `Puedes inscribir como máximo ${maxTalleres} talleres.`);
      }
      const choque = mias.find((m) => m.inicio < taller.fin && taller.inicio < m.fin);
      if (choque) throw new ErrorNegocio('CHOQUE_HORARIO', `Tope de horario con «${choque.titulo}».`);

      if (q.inscritosTaller.get(tallerId).n >= taller.cupos) {
        throw new ErrorNegocio('SIN_CUPOS', 'El taller ya no tiene cupos disponibles.');
      }
      q.insertarInscripcion.run(estudianteId, tallerId, ahora());
      return { yaInscrito: false };
    });
  }

  function cupos() {
    const r = {};
    for (const fila of q.cupos.all()) r[fila.id] = { cupos: fila.cupos, inscritos: fila.inscritos };
    return r;
  }

  function buscar(texto) {
    const limpio = String(texto).trim().slice(0, 60).replace(/[\\%_]/g, (c) => '\\' + c);
    if (limpio.length < 2) return [];
    const soloRut = limpio.replace(/[.\s]/g, '');
    return q.buscar.all(`${soloRut}%`, `%${limpio}%`, `%${limpio}%`);
  }

  return {
    db,
    registrar,
    crearSesion,
    estudiantePorSesion: (token) => (token ? q.porSesion.get(hashToken(token)) : undefined),
    cerrarSesion: (token) => q.borrarSesion.run(hashToken(token)),
    porId: (id) => q.porId.get(id),
    porRut: (rut) => q.porRut.get(rut),
    porCodigo: (codigo) => q.porCodigo.get(codigo),
    inscripcionesDe: (id) => q.inscripcionesDe.all(id),
    inscribir,
    desinscribir: (estudianteId, tallerId) => q.borrarInscripcion.run(estudianteId, tallerId).changes > 0,
    cupos,
    acreditar: (id, por) => q.acreditar.run(ahora(), por || null, id).changes > 0,
    desacreditar: (id) => q.desacreditar.run(id).changes > 0,
    buscar,
    estadisticas: () => ({
      ...q.totales.get(),
      porSede: q.porSede.all(),
      ultimas: q.ultimasAcreditaciones.all(12),
    }),
    todos: () => q.todos.all(),
    todasInscripciones: () => q.todasInscripciones.all(),
    cerrar: () => db.close(),
  };
}

module.exports = { abrirDB, ErrorNegocio, hashToken };
