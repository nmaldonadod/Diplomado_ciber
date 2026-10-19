const SEDES = ['Santiago Centro', 'Santiago Sur', 'Rancagua', 'Talca', 'Curicó', 'Apoquindo', 'Valparaíso'];
const DOMINIO_CORREO = 'inacapmail.cl';
const TIPOS_AGENDA = ['charla', 'pausa', 'acreditacion', 'actividad'];
const ROLES = ['admin', 'acreditador'];

// Texto de una línea: normaliza Unicode, quita caracteres de control y espacios repetidos.
function linea(valor, max) {
  if (typeof valor !== 'string') return '';
  return valor.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

// Texto multilínea (descripciones).
function parrafo(valor, max) {
  if (typeof valor !== 'string') return '';
  return valor.normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e]/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

const RE_NOMBRE = /^[\p{L}][\p{L}\p{M}' .-]*$/u;
const RE_FECHA_HORA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

function fechaHoraValida(v) {
  if (!RE_FECHA_HORA.test(v)) return false;
  const d = new Date(v + ':00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 16) === v;
}

function fechaValida(v) {
  return RE_FECHA.test(v) && fechaHoraValida(v + 'T00:00');
}

function correoInstitucional(valor) {
  const email = linea(valor, 120).toLowerCase();
  const re = new RegExp(`^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?@${DOMINIO_CORREO.replace('.', '\\.')}$`);
  return re.test(email) && !email.includes('..') ? email : null;
}

// Acepta 9 1234 5678, +56 9 1234 5678, 912345678, 221234567 (fijo) → +56XXXXXXXXX
function telefonoChile(valor) {
  const digitos = String(valor ?? '').replace(/[\s().-]/g, '');
  const m = digitos.match(/^(?:\+?56)?(\d{9})$/);
  return m ? '+56' + m[1] : null;
}

function validarRegistro(b) {
  const errores = {};
  const nombres = linea(b.nombres, 60);
  const apellidos = linea(b.apellidos, 60);
  if (nombres.length < 2 || !RE_NOMBRE.test(nombres)) errores.nombres = 'Ingresa tus nombres (sólo letras).';
  if (apellidos.length < 2 || !RE_NOMBRE.test(apellidos)) errores.apellidos = 'Ingresa tus apellidos (sólo letras).';
  const sede = SEDES.includes(b.sede) ? b.sede : null;
  if (!sede) errores.sede = 'Selecciona tu sede.';
  const email = correoInstitucional(b.email);
  if (!email) errores.email = `Usa tu correo institucional @${DOMINIO_CORREO}.`;
  const telefono = telefonoChile(b.telefono);
  if (!telefono) errores.telefono = 'Ingresa un teléfono válido (ej: 9 1234 5678).';
  return { errores, datos: { nombres, apellidos, sede, email, telefono } };
}

function validarTaller(b) {
  const errores = {};
  const d = {
    titulo: linea(b.titulo, 120),
    descripcion: parrafo(b.descripcion, 1500),
    docente: linea(b.docente, 100),
    sala: linea(b.sala, 80),
    inicio: String(b.inicio || ''),
    fin: String(b.fin || ''),
    cupos: Number(b.cupos),
    publicado: b.publicado === true,
  };
  if (d.titulo.length < 3) errores.titulo = 'El título es obligatorio.';
  if (!fechaHoraValida(d.inicio)) errores.inicio = 'Fecha y hora de inicio inválida.';
  if (!fechaHoraValida(d.fin)) errores.fin = 'Fecha y hora de término inválida.';
  else if (!errores.inicio && d.fin <= d.inicio) errores.fin = 'El término debe ser posterior al inicio.';
  if (!Number.isInteger(d.cupos) || d.cupos < 1 || d.cupos > 5000) errores.cupos = 'Cupos debe ser un número entre 1 y 5000.';
  return { errores, datos: d };
}

function validarAgenda(b) {
  const errores = {};
  const d = {
    tipo: TIPOS_AGENDA.includes(b.tipo) ? b.tipo : 'charla',
    titulo: linea(b.titulo, 120),
    descripcion: parrafo(b.descripcion, 800),
    expositor: linea(b.expositor, 100),
    lugar: linea(b.lugar, 80),
    inicio: String(b.inicio || ''),
    fin: String(b.fin || ''),
  };
  if (d.titulo.length < 2) errores.titulo = 'El título es obligatorio.';
  if (!fechaHoraValida(d.inicio)) errores.inicio = 'Inicio inválido.';
  if (!fechaHoraValida(d.fin)) errores.fin = 'Término inválido.';
  else if (!errores.inicio && d.fin <= d.inicio) errores.fin = 'El término debe ser posterior al inicio.';
  return { errores, datos: d };
}

function validarEvento(b) {
  const errores = {};
  const d = {
    nombre: linea(b.nombre, 120),
    lema: linea(b.lema, 60),
    descripcion: parrafo(b.descripcion, 2000),
    lugar: linea(b.lugar, 120),
    direccion: linea(b.direccion, 160),
    contacto: linea(b.contacto, 120),
    fecha_inicio: String(b.fecha_inicio || ''),
    fecha_fin: String(b.fecha_fin || ''),
    max_talleres: Number(b.max_talleres),
    inscripciones_abiertas: b.inscripciones_abiertas === true ? 1 : 0,
    talleres_abiertos: b.talleres_abiertos === true ? 1 : 0,
  };
  if (d.nombre.length < 3) errores.nombre = 'El nombre del evento es obligatorio.';
  if (!fechaValida(d.fecha_inicio)) errores.fecha_inicio = 'Fecha inválida.';
  if (!fechaValida(d.fecha_fin)) errores.fecha_fin = 'Fecha inválida.';
  else if (!errores.fecha_inicio && d.fecha_fin < d.fecha_inicio) errores.fecha_fin = 'Debe ser igual o posterior al inicio.';
  if (!Number.isInteger(d.max_talleres) || d.max_talleres < 0 || d.max_talleres > 20) errores.max_talleres = 'Entre 0 (sin límite) y 20.';
  return { errores, datos: d };
}

// Política de contraseñas para cuentas de administración y acreditación.
function validarClave(clave) {
  if (typeof clave !== 'string' || clave.length < 12) return 'La contraseña debe tener al menos 12 caracteres.';
  if (clave.length > 128) return 'La contraseña es demasiado larga.';
  const clases = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(clave)).length;
  if (clases < 3) return 'Usa al menos tres de: minúsculas, mayúsculas, números y símbolos.';
  return null;
}

function validarUsuario(b, { exigirClave }) {
  const errores = {};
  const email = linea(b.email, 120).toLowerCase();
  if (!/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(email)) errores.email = 'Correo inválido.';
  const nombre = linea(b.nombre, 80);
  if (nombre.length < 2) errores.nombre = 'Nombre obligatorio.';
  const rol = ROLES.includes(b.rol) ? b.rol : null;
  if (!rol) errores.rol = 'Rol inválido.';
  if (exigirClave || b.clave) {
    const e = validarClave(b.clave);
    if (e) errores.clave = e;
  }
  return { errores, datos: { email, nombre, rol, clave: b.clave } };
}

const hayErrores = (e) => Object.keys(e).length > 0;

export {
  SEDES, DOMINIO_CORREO, TIPOS_AGENDA, ROLES,
  linea, parrafo, fechaHoraValida, correoInstitucional, telefonoChile,
  validarRegistro, validarTaller, validarAgenda, validarEvento, validarClave, validarUsuario, hayErrores,
};
