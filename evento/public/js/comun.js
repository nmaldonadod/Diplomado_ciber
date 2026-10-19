'use strict';

// Utilidades compartidas por la app de estudiantes y la de acreditación.

async function api(metodo, url, cuerpo) {
  const opciones = { method: metodo, credentials: 'same-origin', headers: {} };
  if (cuerpo !== undefined) {
    opciones.headers['Content-Type'] = 'application/json';
    opciones.body = JSON.stringify(cuerpo);
  }
  let res;
  try {
    res = await fetch(url, opciones);
  } catch {
    const e = new Error('Sin conexión con el servidor. Revisa tu internet.');
    e.status = 0;
    throw e;
  }
  const datos = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(datos.mensaje || `Error ${res.status}`);
    e.status = res.status;
    e.codigo = datos.error;
    e.datos = datos;
    throw e;
  }
  return datos;
}

// Constructor de nodos DOM (evita innerHTML con datos de usuario).
function el(tag, attrs, ...hijos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const h of hijos.flat(Infinity)) {
    if (h == null || h === false) continue;
    n.append(h instanceof Node ? h : document.createTextNode(String(h)));
  }
  return n;
}

// Horas de la agenda vienen como "2026-11-12T09:00" (hora local del evento).
const hora = (iso) => String(iso).slice(11, 16);
const fechaDe = (iso) => String(iso).slice(0, 10);

function nombreDia(fecha, opciones = { weekday: 'long', day: 'numeric', month: 'long' }) {
  const [a, m, d] = fecha.split('-').map(Number);
  const s = new Date(a, m - 1, d).toLocaleDateString('es-CL', opciones);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function horaReal(isoUtc) {
  return new Date(isoUtc).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
}

const RE_INACAPMAIL = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?@inacapmail\.cl$/i;
const correoValido = (v) => RE_INACAPMAIL.test(String(v).trim()) && !String(v).includes('..');
const telefonoValido = (v) => /^(?:\+?56)?\d{9}$/.test(String(v).replace(/[\s().-]/g, ''));

// Campo de formulario con etiqueta y mensaje de error.
function campo(nombre, etiqueta, attrs = {}) {
  const { opciones, multilinea, ayuda, ...resto } = attrs;
  let control;
  if (opciones) {
    control = el('select', { id: 'f-' + nombre, name: nombre, ...resto },
      el('option', { value: '' }, 'Selecciona…'), opciones.map((o) => el('option', { value: o }, o)));
  } else if (multilinea) {
    control = el('textarea', { id: 'f-' + nombre, name: nombre, rows: 4, ...resto });
  } else {
    control = el('input', { id: 'f-' + nombre, name: nombre, ...resto });
  }
  // El error se limpia apenas el usuario corrige el campo.
  control.addEventListener('input', () => {
    const c = control.closest('.campo');
    c?.classList.remove('invalido');
    const e = c?.querySelector('.err');
    if (e) e.textContent = '';
  });
  return el('div', { class: 'campo', 'data-campo': nombre },
    el('label', { for: 'f-' + nombre }, etiqueta), control,
    ayuda && el('small', { class: 'ayuda' }, ayuda),
    el('span', { class: 'err' }));
}

function mostrarErrores(form, errores = {}) {
  for (const c of form.querySelectorAll('[data-campo]')) {
    const msg = errores[c.dataset.campo];
    c.classList.toggle('invalido', Boolean(msg));
    const e = c.querySelector('.err');
    if (e) e.textContent = msg || '';
  }
  const primero = form.querySelector('.invalido input, .invalido select, .invalido textarea');
  if (primero) primero.focus();
}

let temporizadorToast;
function toast(mensaje, tipo = '') {
  let t = document.getElementById('toast');
  if (!t) {
    t = el('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(t);
  }
  t.textContent = mensaje;
  t.className = 'ver ' + tipo;
  clearTimeout(temporizadorToast);
  temporizadorToast = setTimeout(() => (t.className = tipo), 3200);
}

// Widget de cupos: barra de progreso + texto.
function widgetCupo(c, { flash = false } = {}) {
  const cupos = c?.cupos ?? 0;
  const inscritos = Math.min(c?.inscritos ?? 0, cupos);
  const pct = cupos ? Math.round((inscritos / cupos) * 100) : 100;
  const quedan = Math.max(cupos - inscritos, 0);
  const clase = quedan === 0 ? 'lleno' : pct >= 75 ? 'medio' : '';
  return el('div', { class: `cupo ${clase} ${flash ? 'flash' : ''}`, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': cupos, 'aria-valuenow': inscritos, 'aria-label': 'Cupos ocupados' },
    el('div', { class: 'barra' }, el('i', { style: { width: pct + '%' } })),
    el('div', { class: 'txt' },
      el('span', null, el('strong', null, inscritos), ` / ${cupos} inscritos`),
      el('span', null, quedan === 0 ? 'Sin cupos' : quedan === 1 ? 'Queda 1 cupo' : `Quedan ${quedan} cupos`)));
}

function chipCupo(c) {
  const quedan = (c?.cupos ?? 0) - (c?.inscritos ?? 0);
  if (quedan <= 0) return el('span', { class: 'chip rojo' }, 'Agotado');
  if (quedan <= Math.max(3, Math.ceil(c.cupos * 0.15))) return el('span', { class: 'chip ambar' }, 'Últimos cupos');
  return el('span', { class: 'chip verde' }, 'Disponible');
}

// Suscripción en tiempo real (Server-Sent Events) con reconexión automática del navegador.
//  - cupos:  cambian las inscripciones a talleres
//  - evento: el administrador modificó agenda, talleres o datos del evento
function suscribirCambios({ cupos, evento, conexion }) {
  const es = new EventSource('/api/stream');
  if (cupos) es.addEventListener('cupos', (ev) => cupos(JSON.parse(ev.data)));
  if (evento) es.addEventListener('evento', () => evento());
  es.addEventListener('open', () => conexion?.(true));
  es.addEventListener('error', () => conexion?.(false));
  return es;
}
