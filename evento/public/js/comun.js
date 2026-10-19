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

// Formatea un RUT a medida que se escribe: 12.345.678-5
function formatearRutInput(valor) {
  const limpio = String(valor).replace(/[^0-9kK]/g, '').toUpperCase().slice(0, 9);
  if (limpio.length < 2) return limpio;
  const cuerpo = limpio.slice(0, -1).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${cuerpo}-${limpio.slice(-1)}`;
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
  const dv = r === 11 ? '0' : r === 10 ? 'K' : String(r);
  return dv === limpio.slice(-1);
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

// Suscripción a cupos en tiempo real (Server-Sent Events) con reconexión automática del navegador.
function suscribirCupos(alRecibir, alCambiarEstado) {
  const es = new EventSource('/api/stream');
  es.addEventListener('cupos', (ev) => alRecibir(JSON.parse(ev.data)));
  es.addEventListener('open', () => alCambiarEstado?.(true));
  es.addEventListener('error', () => alCambiarEstado?.(false));
  return es;
}
