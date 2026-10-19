import { codigoAleatorio } from './seguridad.js';

// Capa de datos sobre el SQLite de un Durable Object (ctx.storage.sql).
// Todas las operaciones son síncronas y el Durable Object procesa una petición a la vez,
// por lo que cada transacción es atómica (los cupos nunca se sobrevenden).
// El cifrado/descifrado de datos personales ocurre fuera de esta capa: aquí sólo se guardan cifrados.

export class ErrorNegocio extends Error {
  constructor(codigo, mensaje, status = 409) {
    super(mensaje);
    this.codigo = codigo;
    this.status = status;
  }
}

const ahora = () => new Date().toISOString();

// Texto para búsquedas sin distinguir mayúsculas ni tildes ("perez" encuentra "Pérez").
const normalizar = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const ESQUEMA = `
  CREATE TABLE IF NOT EXISTS evento (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    nombre TEXT NOT NULL,
    lema TEXT NOT NULL DEFAULT '',
    descripcion TEXT NOT NULL DEFAULT '',
    lugar TEXT NOT NULL DEFAULT '',
    direccion TEXT NOT NULL DEFAULT '',
    contacto TEXT NOT NULL DEFAULT '',
    fecha_inicio TEXT NOT NULL,
    fecha_fin TEXT NOT NULL,
    max_talleres INTEGER NOT NULL DEFAULT 2,
    inscripciones_abiertas INTEGER NOT NULL DEFAULT 1,
    talleres_abiertos INTEGER NOT NULL DEFAULT 1,
    actualizado_en TEXT NOT NULL
  );

  -- Datos personales: RUT, correo y teléfono se guardan cifrados (AES-256-GCM).
  -- rut_idx y email_idx son HMAC para búsquedas exactas y unicidad, sin guardar el dato en claro.
  CREATE TABLE IF NOT EXISTS estudiantes (
    id INTEGER PRIMARY KEY,
    tipo TEXT NOT NULL DEFAULT 'estudiante',
    nombres TEXT NOT NULL,
    apellidos TEXT NOT NULL,
    busqueda TEXT NOT NULL,
    sede TEXT NOT NULL,
    email_cif TEXT NOT NULL,
    email_idx TEXT NOT NULL UNIQUE,
    rut_cif TEXT,
    rut_idx TEXT,
    telefono_cif TEXT NOT NULL,
    codigo TEXT NOT NULL UNIQUE,
    acceso_hash TEXT NOT NULL,
    acceso_fallidos INTEGER NOT NULL DEFAULT 0,
    acceso_bloqueado_hasta TEXT,
    origen TEXT NOT NULL DEFAULT 'web',
    consentimiento_en TEXT,
    creado_en TEXT NOT NULL,
    acreditado_en TEXT,
    acreditado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS ix_est_nombre ON estudiantes(apellidos, nombres);

  CREATE TABLE IF NOT EXISTS sesiones_estudiantes (
    token_hash TEXT PRIMARY KEY,
    estudiante_id INTEGER NOT NULL REFERENCES estudiantes(id) ON DELETE CASCADE,
    creado_en TEXT NOT NULL,
    expira_en TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    nombre TEXT NOT NULL,
    rol TEXT NOT NULL CHECK (rol IN ('admin', 'acreditador')),
    clave_hash TEXT NOT NULL,
    activo INTEGER NOT NULL DEFAULT 1,
    fallidos INTEGER NOT NULL DEFAULT 0,
    bloqueado_hasta TEXT,
    creado_en TEXT NOT NULL,
    ultimo_acceso TEXT
  );

  CREATE TABLE IF NOT EXISTS sesiones_usuarios (
    token_hash TEXT PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    creado_en TEXT NOT NULL,
    expira_en TEXT NOT NULL,
    ultimo_uso TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS talleres (
    id INTEGER PRIMARY KEY,
    titulo TEXT NOT NULL,
    descripcion TEXT NOT NULL DEFAULT '',
    docente TEXT NOT NULL DEFAULT '',
    nivel TEXT NOT NULL DEFAULT '',
    foto TEXT,
    sala TEXT NOT NULL DEFAULT '',
    inicio TEXT NOT NULL,
    fin TEXT NOT NULL,
    cupos INTEGER NOT NULL CHECK (cupos > 0),
    publicado INTEGER NOT NULL DEFAULT 1,
    creado_en TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS inscripciones (
    estudiante_id INTEGER NOT NULL REFERENCES estudiantes(id) ON DELETE CASCADE,
    taller_id INTEGER NOT NULL REFERENCES talleres(id) ON DELETE CASCADE,
    creado_en TEXT NOT NULL,
    PRIMARY KEY (estudiante_id, taller_id)
  );
  CREATE INDEX IF NOT EXISTS ix_insc_taller ON inscripciones(taller_id);

  CREATE TABLE IF NOT EXISTS agenda (
    id INTEGER PRIMARY KEY,
    tipo TEXT NOT NULL,
    titulo TEXT NOT NULL,
    descripcion TEXT NOT NULL DEFAULT '',
    expositor TEXT NOT NULL DEFAULT '',
    lugar TEXT NOT NULL DEFAULT '',
    inicio TEXT NOT NULL,
    fin TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auditoria (
    id INTEGER PRIMARY KEY,
    en TEXT NOT NULL,
    actor TEXT NOT NULL,
    accion TEXT NOT NULL,
    detalle TEXT,
    ip TEXT
  );
`;

export function crearDB(storage) {
  const sql = storage.sql;
  const valor = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
  // Adaptador con la misma forma que node:sqlite: prepare(sql).get/all/run.
  const db = {
    prepare: (q) => ({
      get: (...a) => sql.exec(q, ...a.map(valor)).toArray()[0],
      all: (...a) => sql.exec(q, ...a.map(valor)).toArray(),
      run: (...a) => {
        sql.exec(q, ...a.map(valor));
        const r = sql.exec('SELECT changes() AS cambios, last_insert_rowid() AS id').one();
        return { changes: r.cambios, lastInsertRowid: r.id };
      },
    }),
  };
  for (const sentencia of ESQUEMA.split(';')) if (sentencia.trim()) sql.exec(sentencia);
  // Migración: RUT agregado después de la primera versión.
  const columnas = sql.exec("SELECT name FROM pragma_table_info('estudiantes')").toArray().map((c) => c.name);
  if (!columnas.includes('rut_idx')) {
    sql.exec('ALTER TABLE estudiantes ADD COLUMN rut_cif TEXT');
    sql.exec('ALTER TABLE estudiantes ADD COLUMN rut_idx TEXT');
  }
  if (!columnas.includes('tipo')) sql.exec("ALTER TABLE estudiantes ADD COLUMN tipo TEXT NOT NULL DEFAULT 'estudiante'");
  if (!sql.exec("SELECT 1 FROM pragma_table_info('talleres') WHERE name = 'nivel'").toArray().length) {
    sql.exec("ALTER TABLE talleres ADD COLUMN nivel TEXT NOT NULL DEFAULT ''");
  }
  sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_est_rut ON estudiantes(rut_idx) WHERE rut_idx IS NOT NULL');

  // Transacción reentrante: una llamada anidada se une a la transacción en curso.
  let enTransaccion = false;
  function tx(fn) {
    if (enTransaccion) return fn();
    enTransaccion = true;
    try {
      return storage.transactionSync(fn);
    } finally {
      enTransaccion = false;
    }
  }

  const p = (sql) => db.prepare(sql);
  const enDias = (dias) => new Date(Date.now() + dias * 86400_000).toISOString();
  const enHoras = (h) => new Date(Date.now() + h * 3600_000).toISOString();

  // ---------- evento ----------
  const evento = {
    get: () => p('SELECT * FROM evento WHERE id = 1').get(),
    guardar(d) {
      p(`INSERT INTO evento (id, nombre, lema, descripcion, lugar, direccion, contacto, fecha_inicio, fecha_fin, max_talleres,
           inscripciones_abiertas, talleres_abiertos, actualizado_en)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET nombre = excluded.nombre, lema = excluded.lema, descripcion = excluded.descripcion, lugar = excluded.lugar,
           direccion = excluded.direccion, contacto = excluded.contacto, fecha_inicio = excluded.fecha_inicio,
           fecha_fin = excluded.fecha_fin, max_talleres = excluded.max_talleres,
           inscripciones_abiertas = excluded.inscripciones_abiertas, talleres_abiertos = excluded.talleres_abiertos,
           actualizado_en = excluded.actualizado_en`)
        .run(d.nombre, d.lema || '', d.descripcion, d.lugar, d.direccion, d.contacto, d.fecha_inicio, d.fecha_fin, d.max_talleres,
          d.inscripciones_abiertas, d.talleres_abiertos, ahora());
      return evento.get();
    },
  };

  // ---------- estudiantes ----------
  // `d` trae el correo y teléfono ya cifrados (email_cif, telefono_cif) y el índice ciego del correo (email_idx).
  const estudiantes = {
    crear(d, accesoHash, origen = 'web') {
      return tx(() => {
        const idx = d.email_idx;
        if (p('SELECT 1 FROM estudiantes WHERE email_idx = ?').get(idx)) {
          throw new ErrorNegocio('YA_REGISTRADO', 'Este correo ya está inscrito en el evento.');
        }
        if (d.rut_idx && p('SELECT 1 FROM estudiantes WHERE rut_idx = ?').get(d.rut_idx)) {
          throw new ErrorNegocio('YA_REGISTRADO', 'Este RUT ya está inscrito en el evento.');
        }
        let codigo;
        do codigo = codigoAleatorio(16); while (p('SELECT 1 FROM estudiantes WHERE codigo = ?').get(codigo));
        const t = ahora();
        const r = p(`INSERT INTO estudiantes (tipo, nombres, apellidos, busqueda, sede, email_cif, email_idx, rut_cif, rut_idx, telefono_cif, codigo, acceso_hash,
                       origen, consentimiento_en, creado_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(d.tipo || 'estudiante', d.nombres, d.apellidos, normalizar(`${d.nombres} ${d.apellidos}`), d.sede, d.email_cif, idx, d.rut_cif || null, d.rut_idx || null, d.telefono_cif, codigo, accesoHash,
            origen, t, t);
        return estudiantes.porId(Number(r.lastInsertRowid));
      });
    },
    porId: (id) => p('SELECT * FROM estudiantes WHERE id = ?').get(id),
    porEmailIdx: (idx) => p('SELECT * FROM estudiantes WHERE email_idx = ?').get(idx),
    porRutIdx: (idx) => p('SELECT * FROM estudiantes WHERE rut_idx = ?').get(idx),
    porCodigo: (codigo) => p('SELECT * FROM estudiantes WHERE codigo = ?').get(codigo),
    // emailIdx / rutIdx: índice ciego cuando la búsqueda es un correo o un RUT completo.
    buscar({ q = '', emailIdx = null, rutIdx = null, sede = '', tipo = '', estado = '', limite = 50, desde = 0 } = {}) {
      const condiciones = [];
      const args = [];
      const texto = String(q).trim().slice(0, 80);
      if (emailIdx) {
        condiciones.push('email_idx = ?');
        args.push(emailIdx);
      } else if (rutIdx) {
        condiciones.push('rut_idx = ?');
        args.push(rutIdx);
      } else if (texto.length >= 2) {
        for (const palabra of normalizar(texto).split(/\s+/).slice(0, 4)) {
          condiciones.push("busqueda LIKE ? ESCAPE '\\'");
          args.push('%' + palabra.replace(/[\\%_]/g, (c) => '\\' + c) + '%');
        }
      }
      if (sede) { condiciones.push('sede = ?'); args.push(sede); }
      if (tipo) { condiciones.push('tipo = ?'); args.push(tipo); }
      if (estado === 'acreditados') condiciones.push('acreditado_en IS NOT NULL');
      if (estado === 'pendientes') condiciones.push('acreditado_en IS NULL');
      const where = condiciones.length ? 'WHERE ' + condiciones.join(' AND ') : '';
      const total = p(`SELECT COUNT(*) AS n FROM estudiantes ${where}`).get(...args).n;
      const filas = p(`SELECT * FROM estudiantes ${where} ORDER BY apellidos, nombres LIMIT ? OFFSET ?`)
        .all(...args, Math.min(limite, 500), Math.max(desde, 0));
      return { total, filas };
    },
    todos: () => p('SELECT * FROM estudiantes ORDER BY apellidos, nombres').all(),
    registrarFalloAcceso(id) {
      const e = p('SELECT acceso_fallidos FROM estudiantes WHERE id = ?').get(id);
      const n = (e?.acceso_fallidos || 0) + 1;
      p('UPDATE estudiantes SET acceso_fallidos = ?, acceso_bloqueado_hasta = ? WHERE id = ?')
        .run(n, n >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null, id);
    },
    accesoCorrecto: (id) => p('UPDATE estudiantes SET acceso_fallidos = 0, acceso_bloqueado_hasta = NULL WHERE id = ?').run(id),
    acreditar: (id, usuarioId) => p('UPDATE estudiantes SET acreditado_en = ?, acreditado_por = ? WHERE id = ? AND acreditado_en IS NULL').run(ahora(), usuarioId, id).changes > 0,
    desacreditar: (id) => p('UPDATE estudiantes SET acreditado_en = NULL, acreditado_por = NULL WHERE id = ?').run(id).changes > 0,
    eliminar: (id) => p('DELETE FROM estudiantes WHERE id = ?').run(id).changes > 0,
    eliminarTodos: () => tx(() => {
      const n = p('SELECT COUNT(*) AS n FROM estudiantes').get().n;
      p('DELETE FROM estudiantes').run();
      return n;
    }),
  };

  // ---------- sesiones ----------
  // Se guarda sólo el hash SHA-256 del token; el token viaja únicamente en la cookie del navegador.
  const sesiones = {
    crearEstudiante(tokenHash, estudianteId, dias = 30) {
      p('INSERT INTO sesiones_estudiantes (token_hash, estudiante_id, creado_en, expira_en) VALUES (?, ?, ?, ?)')
        .run(tokenHash, estudianteId, ahora(), enDias(dias));
    },
    estudiante(tokenHash) {
      if (!tokenHash) return null;
      const s = p('SELECT estudiante_id FROM sesiones_estudiantes WHERE token_hash = ? AND expira_en > ?').get(tokenHash, ahora());
      return s ? estudiantes.porId(s.estudiante_id) : null;
    },
    cerrarEstudiante: (tokenHash) => p('DELETE FROM sesiones_estudiantes WHERE token_hash = ?').run(tokenHash),
    cerrarTodasEstudiante: (id) => p('DELETE FROM sesiones_estudiantes WHERE estudiante_id = ?').run(id),

    crearUsuario(tokenHash, usuarioId, horas) {
      const t = ahora();
      p('INSERT INTO sesiones_usuarios (token_hash, usuario_id, creado_en, expira_en, ultimo_uso) VALUES (?, ?, ?, ?, ?)')
        .run(tokenHash, usuarioId, t, enHoras(horas), t);
    },
    // Expira por tiempo absoluto o por inactividad (minutos según rol).
    usuario(tokenHash, inactividadPorRol) {
      if (!tokenHash) return null;
      const s = p(`SELECT s.ultimo_uso, u.id, u.email, u.nombre, u.rol FROM sesiones_usuarios s JOIN usuarios u ON u.id = s.usuario_id
                   WHERE s.token_hash = ? AND s.expira_en > ? AND u.activo = 1`).get(tokenHash, ahora());
      if (!s) return null;
      if (Date.now() - Date.parse(s.ultimo_uso) > inactividadPorRol[s.rol] * 60_000) {
        p('DELETE FROM sesiones_usuarios WHERE token_hash = ?').run(tokenHash);
        return null;
      }
      p('UPDATE sesiones_usuarios SET ultimo_uso = ? WHERE token_hash = ?').run(ahora(), tokenHash);
      return { id: s.id, email: s.email, nombre: s.nombre, rol: s.rol };
    },
    cerrarUsuario: (tokenHash) => p('DELETE FROM sesiones_usuarios WHERE token_hash = ?').run(tokenHash),
    cerrarTodasUsuario: (id) => p('DELETE FROM sesiones_usuarios WHERE usuario_id = ?').run(id),
    purgarExpiradas() {
      const t = ahora();
      p('DELETE FROM sesiones_estudiantes WHERE expira_en <= ?').run(t);
      p('DELETE FROM sesiones_usuarios WHERE expira_en <= ?').run(t);
    },
  };

  // ---------- usuarios (admin / acreditador) ----------
  const COLS_USUARIO = 'id, email, nombre, rol, activo, creado_en, ultimo_acceso, bloqueado_hasta';
  const usuarios = {
    crear(d, claveHash) {
      if (p('SELECT 1 FROM usuarios WHERE email = ?').get(d.email)) throw new ErrorNegocio('YA_EXISTE', 'Ya existe un usuario con ese correo.');
      const r = p('INSERT INTO usuarios (email, nombre, rol, clave_hash, creado_en) VALUES (?, ?, ?, ?, ?)')
        .run(d.email, d.nombre, d.rol, claveHash, ahora());
      return usuarios.porId(Number(r.lastInsertRowid));
    },
    porId: (id) => p(`SELECT ${COLS_USUARIO} FROM usuarios WHERE id = ?`).get(id),
    conClave: (email) => p('SELECT * FROM usuarios WHERE email = ?').get(String(email).toLowerCase()),
    listar: () => p(`SELECT ${COLS_USUARIO} FROM usuarios ORDER BY rol, nombre`).all(),
    hayAdmin: () => Boolean(p("SELECT 1 FROM usuarios WHERE rol = 'admin' AND activo = 1").get()),
    adminsActivos: () => p("SELECT COUNT(*) AS n FROM usuarios WHERE rol = 'admin' AND activo = 1").get().n,
    actualizar: (id, d) => p('UPDATE usuarios SET nombre = ?, rol = ?, activo = ? WHERE id = ?').run(d.nombre, d.rol, d.activo ? 1 : 0, id),
    cambiarClave: (id, hash) => p('UPDATE usuarios SET clave_hash = ?, fallidos = 0, bloqueado_hasta = NULL WHERE id = ?').run(hash, id),
    registrarFallo(id) {
      const u = p('SELECT fallidos FROM usuarios WHERE id = ?').get(id);
      const n = (u?.fallidos || 0) + 1;
      // Bloqueo progresivo: 5 fallos → 15 min; cada fallo extra duplica (máx. 24 h).
      const min = n >= 5 ? Math.min(15 * 2 ** (n - 5), 1440) : 0;
      p('UPDATE usuarios SET fallidos = ?, bloqueado_hasta = ? WHERE id = ?').run(n, min ? new Date(Date.now() + min * 60_000).toISOString() : null, id);
    },
    accesoCorrecto: (id) => p('UPDATE usuarios SET fallidos = 0, bloqueado_hasta = NULL, ultimo_acceso = ? WHERE id = ?').run(ahora(), id),
    eliminar: (id) => p('DELETE FROM usuarios WHERE id = ?').run(id).changes > 0,
  };

  // ---------- talleres ----------
  const COLS_TALLER = 'id, titulo, descripcion, docente, nivel, foto, sala, inicio, fin, cupos, publicado';
  const talleres = {
    listar: (soloPublicados) => p(`SELECT ${COLS_TALLER} FROM talleres ${soloPublicados ? 'WHERE publicado = 1' : ''} ORDER BY inicio, titulo`).all(),
    get: (id) => p(`SELECT ${COLS_TALLER} FROM talleres WHERE id = ?`).get(id),
    crear(d) {
      const r = p('INSERT INTO talleres (titulo, descripcion, docente, nivel, sala, inicio, fin, cupos, publicado, creado_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(d.titulo, d.descripcion, d.docente, d.nivel || '', d.sala, d.inicio, d.fin, d.cupos, d.publicado ? 1 : 0, ahora());
      return talleres.get(Number(r.lastInsertRowid));
    },
    actualizar(id, d) {
      return tx(() => {
        const inscritos = p('SELECT COUNT(*) AS n FROM inscripciones WHERE taller_id = ?').get(id).n;
        if (d.cupos < inscritos) {
          throw new ErrorNegocio('CUPOS_INSUFICIENTES', `Ya hay ${inscritos} inscritos: los cupos no pueden ser menos que eso.`, 422);
        }
        p('UPDATE talleres SET titulo = ?, descripcion = ?, docente = ?, nivel = ?, sala = ?, inicio = ?, fin = ?, cupos = ?, publicado = ? WHERE id = ?')
          .run(d.titulo, d.descripcion, d.docente, d.nivel || '', d.sala, d.inicio, d.fin, d.cupos, d.publicado ? 1 : 0, id);
        return talleres.get(id);
      });
    },
    ponerFoto: (id, archivo) => p('UPDATE talleres SET foto = ? WHERE id = ?').run(archivo, id),
    eliminar: (id) => p('DELETE FROM talleres WHERE id = ?').run(id).changes > 0,
    cupos() {
      const r = {};
      for (const f of p(`SELECT t.id, t.cupos, COUNT(i.estudiante_id) AS inscritos FROM talleres t
                         LEFT JOIN inscripciones i ON i.taller_id = t.id WHERE t.publicado = 1 GROUP BY t.id`).all()) {
        r[f.id] = { cupos: f.cupos, inscritos: f.inscritos };
      }
      return r;
    },
    inscritos: (id) => p(`SELECT e.* FROM inscripciones i JOIN estudiantes e ON e.id = i.estudiante_id
                          WHERE i.taller_id = ? ORDER BY e.apellidos, e.nombres`).all(id),
  };

  // ---------- inscripciones a talleres ----------
  const inscripciones = {
    de: (estudianteId) => p(`SELECT t.id, t.titulo, t.sala, t.inicio, t.fin FROM inscripciones i JOIN talleres t ON t.id = i.taller_id
                              WHERE i.estudiante_id = ? ORDER BY t.inicio`).all(estudianteId),
    inscribir(estudianteId, tallerId, { forzar = false } = {}) {
      return tx(() => {
        const ev = evento.get();
        if (!forzar && !ev?.talleres_abiertos) throw new ErrorNegocio('TALLERES_CERRADOS', 'La elección de talleres está cerrada.');
        const t = p('SELECT * FROM talleres WHERE id = ? AND publicado = 1').get(tallerId);
        if (!t) throw new ErrorNegocio('TALLER_INEXISTENTE', 'El taller no existe.', 404);
        if (p('SELECT 1 FROM inscripciones WHERE estudiante_id = ? AND taller_id = ?').get(estudianteId, tallerId)) return false;
        const mios = inscripciones.de(estudianteId);
        if (ev?.max_talleres && mios.length >= ev.max_talleres) {
          throw new ErrorNegocio('MAXIMO_TALLERES', ev.max_talleres === 1
            ? 'Ya tienes un taller: puedes inscribirte en 1 solo. Cancela el actual si quieres cambiarte.'
            : `Puedes inscribir como máximo ${ev.max_talleres} talleres.`);
        }
        const choque = mios.find((m) => m.inicio < t.fin && t.inicio < m.fin);
        if (choque) throw new ErrorNegocio('CHOQUE_HORARIO', `Tope de horario con «${choque.titulo}».`);
        const n = p('SELECT COUNT(*) AS n FROM inscripciones WHERE taller_id = ?').get(tallerId).n;
        if (n >= t.cupos) throw new ErrorNegocio('SIN_CUPOS', `«${t.titulo}» ya no tiene cupos disponibles.`);
        p('INSERT INTO inscripciones (estudiante_id, taller_id, creado_en) VALUES (?, ?, ?)').run(estudianteId, tallerId, ahora());
        return true;
      });
    },
    cancelar(estudianteId, tallerId, { forzar = false } = {}) {
      if (!forzar && !evento.get()?.talleres_abiertos) throw new ErrorNegocio('TALLERES_CERRADOS', 'La elección de talleres está cerrada.');
      return p('DELETE FROM inscripciones WHERE estudiante_id = ? AND taller_id = ?').run(estudianteId, tallerId).changes > 0;
    },
    todas: () => p(`SELECT t.id AS taller_id, t.titulo, t.inicio, t.sala, e.* FROM inscripciones i
                    JOIN talleres t ON t.id = i.taller_id JOIN estudiantes e ON e.id = i.estudiante_id
                    ORDER BY t.inicio, t.titulo, e.apellidos, e.nombres`).all(),
  };

  // ---------- agenda ----------
  const agenda = {
    listar: () => p('SELECT * FROM agenda ORDER BY inicio, titulo').all(),
    get: (id) => p('SELECT * FROM agenda WHERE id = ?').get(id),
    crear(d) {
      const r = p('INSERT INTO agenda (tipo, titulo, descripcion, expositor, lugar, inicio, fin) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(d.tipo, d.titulo, d.descripcion, d.expositor, d.lugar, d.inicio, d.fin);
      return agenda.get(Number(r.lastInsertRowid));
    },
    actualizar(id, d) {
      p('UPDATE agenda SET tipo = ?, titulo = ?, descripcion = ?, expositor = ?, lugar = ?, inicio = ?, fin = ? WHERE id = ?')
        .run(d.tipo, d.titulo, d.descripcion, d.expositor, d.lugar, d.inicio, d.fin, id);
      return agenda.get(id);
    },
    eliminar: (id) => p('DELETE FROM agenda WHERE id = ?').run(id).changes > 0,
  };

  // ---------- auditoría ----------
  const auditoria = {
    registrar: (actor, accion, detalle, ip) => p('INSERT INTO auditoria (en, actor, accion, detalle, ip) VALUES (?, ?, ?, ?, ?)')
      .run(ahora(), actor, accion, detalle == null ? null : String(detalle).slice(0, 500), ip || null),
    listar: (limite = 200) => p('SELECT * FROM auditoria ORDER BY id DESC LIMIT ?').all(Math.min(limite, 1000)),
  };

  const estadisticas = () => ({
    ...p(`SELECT COUNT(*) AS registrados, COUNT(acreditado_en) AS acreditados,
                 COALESCE(SUM(origen = 'presencial'), 0) AS presenciales FROM estudiantes`).get(),
    porTipo: p(`SELECT tipo, COUNT(*) AS registrados, COUNT(acreditado_en) AS acreditados FROM estudiantes GROUP BY tipo ORDER BY 2 DESC`).all(),
    porSede: p(`SELECT sede, COUNT(*) AS registrados, COUNT(acreditado_en) AS acreditados FROM estudiantes GROUP BY sede ORDER BY 2 DESC`).all(),
    ultimas: p(`SELECT e.id, e.nombres, e.apellidos, e.sede, e.acreditado_en, u.nombre AS acreditador FROM estudiantes e
                LEFT JOIN usuarios u ON u.id = e.acreditado_por WHERE e.acreditado_en IS NOT NULL
                ORDER BY e.acreditado_en DESC LIMIT 12`).all(),
  });

  return {
    db, tx, evento, estudiantes, sesiones, usuarios, talleres, inscripciones, agenda, auditoria, estadisticas,

  };
}


