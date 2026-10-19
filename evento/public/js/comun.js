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

// Correo institucional INACAP: @inacapmail.cl (estudiantes) o @inacap.cl (docentes y administrativos).
const RE_INACAPMAIL = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?@inacap(?:mail)?\.cl$/i;
const correoValido = (v) => RE_INACAPMAIL.test(String(v).trim()) && !String(v).includes('..');
// Formatea un RUT a medida que se escribe: 12.345.678-5
function formatearRutInput(valor) {
  const limpio = String(valor).replace(/[^0-9kK]/g, '').toUpperCase().slice(0, 9);
  if (limpio.length < 2) return limpio;
  return `${limpio.slice(0, -1).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}-${limpio.slice(-1)}`;
}

function rutValido(valor) {
  const limpio = String(valor).replace(/[^0-9kK]/g, '').toUpperCase();
  if (limpio.length < 7) return false;
  const cuerpo = limpio.slice(0, -1);
  if (!/^\d+$/.test(cuerpo)) return false;
  let suma = 0;
  let f = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) {
    suma += Number(cuerpo[i]) * f;
    f = f === 7 ? 2 : f + 1;
  }
  const r = 11 - (suma % 11);
  return (r === 11 ? '0' : r === 10 ? 'K' : String(r)) === limpio.slice(-1);
}

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
  if (quedan <= 0) return el('span', { class: 'chip peligro' }, 'Agotado');
  if (quedan <= Math.max(3, Math.ceil(c.cupos * 0.15))) return el('span', { class: 'chip alerta' }, 'Últimos cupos');
  return el('span', { class: 'chip ok' }, 'Disponible');
}

// Suscripción en tiempo real por WebSocket, con reconexión automática.
//  - cupos:  cambian las inscripciones a talleres
//  - evento: el administrador modificó agenda, talleres o datos del evento
function suscribirCambios({ cupos, evento, conexion }) {
  let intentos = 0;
  let latido;
  function conectar() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/tiempo-real`);
    ws.addEventListener('open', () => {
      intentos = 0;
      conexion?.(true);
      latido = setInterval(() => ws.readyState === 1 && ws.send('ping'), 30_000);
    });
    ws.addEventListener('message', (ev) => {
      if (ev.data === 'pong') return;
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.tipo === 'cupos') cupos?.(m.datos);
      if (m.tipo === 'evento') evento?.();
    });
    ws.addEventListener('close', () => {
      clearInterval(latido);
      conexion?.(false);
      // Espera creciente (máx. 30 s) con algo de azar para no reconectar todos a la vez.
      const espera = Math.min(30_000, 1000 * 2 ** intentos++) + Math.random() * 1000;
      setTimeout(conectar, espera);
    });
  }
  conectar();
}
