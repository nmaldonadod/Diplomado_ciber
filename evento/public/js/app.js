'use strict';

/* App de estudiantes: inscripción, mi entrada (QR), talleres con cupos en vivo y agenda. */

const estado = {
  evento: null,
  cupos: {},
  yo: null,
  dia: null,
  soloMia: false,
  cambiados: new Set(),
};
const vista = document.getElementById('vista');

// ---------- nodos que se vuelven a dibujar cuando cambian los cupos ----------
let refrescables = new Set();
function vivo(render) {
  const nodo = render();
  nodo.__render = render;
  refrescables.add(nodo);
  return nodo;
}
function refrescar() {
  for (const nodo of [...refrescables]) {
    refrescables.delete(nodo);
    if (nodo.isConnected) nodo.replaceWith(vivo(nodo.__render));
  }
  estado.cambiados.clear();
}

// ---------- utilidades del dominio ----------
const talleres = () => estado.evento.talleres;
const taller = (id) => talleres().find((t) => t.id === id);
const misTalleres = () => (estado.yo ? estado.yo.talleres.map(taller).filter(Boolean) : []);
const esMio = (t) => Boolean(estado.yo && estado.yo.talleres.includes(t.id));
const seCruzan = (a, b) => a.inicio < b.fin && b.inicio < a.fin;
const choqueCon = (t) => misTalleres().find((m) => m.id !== t.id && seCruzan(m, t));
const quedan = (t) => (estado.cupos[t.id]?.cupos ?? t.cupos) - (estado.cupos[t.id]?.inscritos ?? 0);
const cupoDe = (t) => estado.cupos[t.id] || { cupos: t.cupos, inscritos: 0 };

function rangoFechas() {
  const dias = estado.evento.dias || [];
  if (!dias.length) return '';
  if (dias.length === 1) return nombreDia(dias[0].fecha);
  return `${nombreDia(dias[0].fecha, { day: 'numeric' })} al ${nombreDia(dias[dias.length - 1].fecha, { day: 'numeric', month: 'long', year: 'numeric' })}`;
}

function irA(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

// ---------- vistas ----------

function vistaInicio() {
  const ev = estado.evento;
  const acciones = estado.yo
    ? [el('a', { class: 'btn btn-rojo', href: '#/entrada' }, 'Ver mi entrada'), el('a', { class: 'btn btn-linea', href: '#/talleres' }, 'Elegir talleres')]
    : [el('a', { class: 'btn btn-rojo', href: '#/registro' }, 'Inscribirme al evento →'), el('a', { class: 'btn btn-linea', href: '#/acceso' }, 'Ya estoy inscrito')];

  return [
    el('section', { class: 'hero' },
      el('span', { class: 'eyebrow' }, ev.organiza),
      el('h1', null, ev.nombre),
      el('p', { class: 'sub' }, ev.descripcion),
      el('div', { class: 'meta' }, el('span', null, '▦ ', rangoFechas()), el('span', null, '⌖ ', ev.lugar)),
      el('div', { class: 'acciones' }, acciones)),

    estado.yo && el('div', { class: 'aviso ok' }, `Hola ${estado.yo.nombre.split(' ')[0]}, ya estás inscrito. `,
      estado.yo.talleres.length ? `Tienes ${estado.yo.talleres.length} taller(es) elegido(s).` : 'Aún no eliges talleres.'),

    el('div', { class: 'grid grid-2' },
      el('section', { class: 'card' },
        el('h2', null, '¿Cómo participar?'),
        el('ol', { class: 'pasos' },
          el('li', null, el('span', null, el('strong', null, 'Inscríbete'), ' con tu RUT y correo. Recibirás tu entrada digital con código QR.')),
          el('li', null, el('span', null, el('strong', null, 'Elige tus talleres'), ` (hasta ${ev.maxTalleresPorEstudiante}). Los cupos son limitados y se actualizan en vivo.`)),
          el('li', null, el('span', null, el('strong', null, 'Acredítate'), ' el día del evento mostrando el QR de tu entrada o el QR de tu carnet (cédula de identidad).')))),
      el('section', { class: 'card' },
        el('h2', null, 'Talleres y cupos'),
        talleres().map((t) => el('div', { style: { marginBottom: '12px' } },
          el('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px' } },
            el('a', { href: '#/talleres', style: { fontWeight: '600', fontSize: '.92rem', textDecoration: 'none' } }, t.titulo),
            el('span', { class: 'sub', style: { fontSize: '.8rem', whiteSpace: 'nowrap' } }, `${nombreDia(fechaDe(t.inicio), { weekday: 'short' })} ${hora(t.inicio)}`)),
          vivo(() => widgetCupo(cupoDe(t), { flash: estado.cambiados.has(t.id) })))),
        el('a', { class: 'btn btn-linea btn-chico', href: '#/talleres' }, 'Ver todos los talleres'))),
  ];
}

function campo(nombre, etiqueta, attrs = {}) {
  return el('div', { class: 'campo', 'data-campo': nombre },
    el('label', { for: 'f-' + nombre }, etiqueta),
    attrs.opciones
      ? el('select', { id: 'f-' + nombre, name: nombre },
        el('option', { value: '' }, 'Selecciona…'), attrs.opciones.map((o) => el('option', { value: o }, o)))
      : el('input', { id: 'f-' + nombre, name: nombre, ...attrs }),
    el('span', { class: 'err' }));
}

function mostrarErrores(form, errores = {}) {
  for (const c of form.querySelectorAll('[data-campo]')) {
    const msg = errores[c.dataset.campo];
    c.classList.toggle('invalido', Boolean(msg));
    c.querySelector('.err').textContent = msg || '';
  }
  const primero = form.querySelector('.invalido input, .invalido select');
  if (primero) primero.focus();
}

function conRut(input) {
  input.addEventListener('input', () => (input.value = formatearRutInput(input.value)));
  return input;
}

function vistaRegistro() {
  if (estado.yo) return irA('#/entrada');
  const aviso = el('div', { class: 'aviso error oculto', role: 'alert' });
  const form = el('form', { class: 'card', novalidate: true },
    el('span', { class: 'eyebrow' }, 'Inscripción'),
    el('h1', null, 'Inscríbete al evento'),
    el('p', { class: 'sub', style: { marginBottom: '18px' } }, 'Completa tus datos. Al terminar obtendrás tu entrada con código QR.'),
    aviso,
    campo('rut', 'RUT', { inputmode: 'text', autocomplete: 'off', placeholder: '12.345.678-5', required: true, maxlength: 12 }),
    campo('nombre', 'Nombre completo', { autocomplete: 'name', required: true, maxlength: 100 }),
    campo('email', 'Correo electrónico', { type: 'email', autocomplete: 'email', required: true, maxlength: 120 }),
    campo('telefono', 'Teléfono (opcional)', { type: 'tel', autocomplete: 'tel', placeholder: '+56 9 1234 5678', maxlength: 20 }),
    campo('carrera', 'Carrera', { maxlength: 100, placeholder: 'Ej: Ingeniería en Informática' }),
    estado.evento.sedes?.length ? campo('sede', 'Sede', { opciones: estado.evento.sedes }) : null,
    el('label', { class: 'check', 'data-campo': 'consentimiento' },
      el('input', { type: 'checkbox', name: 'consentimiento' }),
      el('span', null, 'Acepto que INACAP use mis datos sólo para gestionar mi participación en este evento.', el('span', { class: 'err', style: { display: 'block' } }))),
    el('button', { class: 'btn btn-rojo btn-bloque', type: 'submit' }, 'Inscribirme'),
    el('p', { class: 'sub', style: { marginTop: '14px', fontSize: '.88rem', textAlign: 'center' } },
      '¿Ya te inscribiste? ', el('a', { href: '#/acceso' }, 'Recupera tu entrada')));

  conRut(form.elements.rut);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = form.elements;
    const datos = {
      rut: f.rut.value, nombre: f.nombre.value, email: f.email.value, telefono: f.telefono.value,
      carrera: f.carrera.value, sede: f.sede?.value || '', consentimiento: f.consentimiento.checked,
    };
    const errores = {};
    if (!rutValido(datos.rut)) errores.rut = 'RUT inválido. Revisa el dígito verificador.';
    if (datos.nombre.trim().length < 3) errores.nombre = 'Ingresa tu nombre completo.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(datos.email.trim())) errores.email = 'Correo electrónico inválido.';
    if (!datos.consentimiento) errores.consentimiento = 'Debes aceptar para continuar.';
    mostrarErrores(form, errores);
    aviso.classList.add('oculto');
    if (Object.keys(errores).length) return;

    const boton = form.querySelector('button[type=submit]');
    boton.disabled = true;
    boton.textContent = 'Inscribiendo…';
    try {
      estado.yo = await api('POST', '/api/registro', datos);
      toast('¡Inscripción lista! Ahora elige tus talleres.');
      irA('#/entrada');
    } catch (e) {
      mostrarErrores(form, e.datos?.errores);
      aviso.textContent = e.codigo === 'YA_REGISTRADO' ? 'Este RUT ya está inscrito. Usa «Recupera tu entrada».' : e.message;
      aviso.classList.remove('oculto');
      boton.disabled = false;
      boton.textContent = 'Inscribirme';
    }
  });

  return el('div', { style: { maxWidth: '560px', margin: '0 auto' } }, form);
}

function vistaAcceso() {
  if (estado.yo) return irA('#/entrada');
  const aviso = el('div', { class: 'aviso error oculto', role: 'alert' });
  const form = el('form', { class: 'card', novalidate: true },
    el('span', { class: 'eyebrow' }, 'Ya estoy inscrito'),
    el('h1', null, 'Recupera tu entrada'),
    el('p', { class: 'sub', style: { marginBottom: '18px' } }, 'Ingresa el RUT y el correo con que te inscribiste.'),
    aviso,
    campo('rut', 'RUT', { autocomplete: 'off', placeholder: '12.345.678-5', required: true, maxlength: 12 }),
    campo('email', 'Correo electrónico', { type: 'email', autocomplete: 'email', required: true }),
    el('button', { class: 'btn btn-oscuro btn-bloque', type: 'submit' }, 'Ver mi entrada'),
    el('p', { class: 'sub', style: { marginTop: '14px', fontSize: '.88rem', textAlign: 'center' } },
      '¿Aún no te inscribes? ', el('a', { href: '#/registro' }, 'Inscríbete aquí')));
  conRut(form.elements.rut);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    aviso.classList.add('oculto');
    try {
      estado.yo = await api('POST', '/api/acceso', { rut: form.elements.rut.value, email: form.elements.email.value });
      irA('#/entrada');
    } catch (e) {
      aviso.textContent = e.message;
      aviso.classList.remove('oculto');
    }
  });
  return el('div', { style: { maxWidth: '480px', margin: '0 auto' } }, form);
}

function svgQR(texto) {
  const qr = qrcode(0, 'M');
  qr.addData(texto);
  qr.make();
  const cont = el('div', { class: 'qr' });
  // El SVG lo genera la librería a partir de un código alfanumérico propio (sin datos de usuario).
  cont.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true, alt: 'Código QR de tu entrada' });
  return cont;
}

function vistaEntrada() {
  if (!estado.yo) {
    return el('div', { class: 'grid grid-2', style: { maxWidth: '760px', margin: '0 auto' } },
      el('section', { class: 'card' }, el('h2', null, 'Aún no te inscribes'),
        el('p', { class: 'sub' }, 'Inscríbete para obtener tu entrada con código QR y elegir talleres.'),
        el('div', { class: 'acciones' }, el('a', { class: 'btn btn-rojo', href: '#/registro' }, 'Inscribirme'))),
      el('section', { class: 'card' }, el('h2', null, '¿Ya estás inscrito?'),
        el('p', { class: 'sub' }, 'Si te inscribiste desde otro dispositivo, recupera tu entrada con tu RUT y correo.'),
        el('div', { class: 'acciones' }, el('a', { class: 'btn btn-linea', href: '#/acceso' }, 'Recuperar entrada'))));
  }
  const yo = estado.yo;
  const mios = misTalleres().sort((a, b) => a.inicio.localeCompare(b.inicio));
  return el('div', { style: { maxWidth: '520px', margin: '0 auto' } },
    el('article', { class: 'ticket' },
      el('div', { class: 'top' }, el('div', { class: 'eyebrow' }, 'Entrada digital'), el('h2', null, estado.evento.nombre)),
      svgQR(yo.qr),
      el('div', { class: 'cod' }, yo.codigo.replace(/(.{4})/g, '$1 ').trim()),
      el('div', { class: 'quien' },
        el('strong', null, yo.nombre),
        el('span', { class: 'sub' }, yo.rut, yo.sede ? ` · ${yo.sede}` : ''),
        el('div', { class: 'estado' }, yo.acreditadoEn
          ? el('span', { class: 'chip verde' }, `✓ Acreditado ${horaReal(yo.acreditadoEn)}`)
          : el('span', { class: 'chip ambar' }, 'Pendiente de acreditación')))),
    el('p', { class: 'sub', style: { textAlign: 'center', fontSize: '.86rem', margin: '12px 0 0' } },
      'Muestra este QR (o el QR de tu carnet) en la acreditación. Te recomendamos guardar una captura de pantalla.'),

    el('section', { class: 'card mis' },
      el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' } },
        el('h2', { style: { margin: 0 } }, 'Mis talleres'),
        el('span', { class: 'chip' }, `${mios.length} / ${estado.evento.maxTalleresPorEstudiante}`)),
      mios.length
        ? el('ul', { style: { marginTop: '8px' } }, mios.map((t) => el('li', null,
          el('span', null, el('strong', null, t.titulo), el('br'), el('span', { class: 'sub', style: { fontSize: '.85rem' } },
            `${nombreDia(fechaDe(t.inicio), { weekday: 'short', day: 'numeric' })} · ${hora(t.inicio)}–${hora(t.fin)} · ${t.sala}`)))))
        : el('p', { class: 'sub', style: { marginTop: '8px' } }, 'Todavía no eliges talleres. ¡Los cupos se están llenando!'),
      el('div', { class: 'acciones' },
        el('a', { class: 'btn btn-rojo btn-chico', href: '#/talleres' }, mios.length ? 'Cambiar talleres' : 'Elegir talleres'),
        el('a', { class: 'btn btn-linea btn-chico', href: '#/agenda' }, 'Ver mi agenda'))),

    el('p', { style: { textAlign: 'center', marginTop: '18px' } },
      el('button', {
        class: 'btn btn-linea btn-chico', type: 'button',
        onclick: async () => {
          if (!confirm('¿Cerrar sesión en este dispositivo? Podrás recuperar tu entrada con tu RUT y correo.')) return;
          await api('POST', '/api/salir', {}).catch(() => {});
          estado.yo = null;
          irA('#/');
        },
      }, 'Cerrar sesión')));
}

async function cambiarInscripcion(t, boton) {
  const inscribir = !esMio(t);
  if (!inscribir && !confirm(`¿Cancelar tu inscripción en «${t.titulo}»? Liberarás tu cupo.`)) return;
  boton.disabled = true;
  boton.textContent = inscribir ? 'Reservando cupo…' : 'Cancelando…';
  try {
    const r = await api(inscribir ? 'POST' : 'DELETE', `/api/talleres/${encodeURIComponent(t.id)}/inscripcion`, {});
    estado.yo = r.perfil;
    actualizarCupos(r.cupos);
    toast(inscribir ? `¡Listo! Tienes cupo en «${t.titulo}».` : 'Inscripción cancelada.');
  } catch (e) {
    if (e.codigo === 'SIN_SESION') return irA('#/registro');
    toast(e.message, 'error');
    actualizarCupos(await api('GET', '/api/cupos').catch(() => estado.cupos));
  }
}

function tarjetaTaller(t) {
  const mio = esMio(t);
  const ev = estado.evento;
  let boton;
  if (!estado.yo) {
    boton = el('a', { class: 'btn btn-oscuro btn-bloque', href: '#/registro' }, 'Inscríbete al evento para elegir');
  } else if (mio) {
    boton = el('button', { class: 'btn btn-linea btn-bloque', type: 'button' }, 'Cancelar inscripción');
  } else {
    const choque = choqueCon(t);
    const lleno = misTalleres().length >= ev.maxTalleresPorEstudiante;
    let motivo = null;
    if (quedan(t) <= 0) motivo = 'Sin cupos';
    else if (choque) motivo = `Tope de horario con «${choque.titulo}»`;
    else if (lleno) motivo = `Ya elegiste ${ev.maxTalleresPorEstudiante} talleres`;
    boton = el('button', { class: 'btn btn-rojo btn-bloque', type: 'button', disabled: Boolean(motivo) }, motivo || 'Inscribirme');
  }
  if (boton.tagName === 'BUTTON') boton.addEventListener('click', () => cambiarInscripcion(t, boton));

  return el('article', { class: `card taller ${mio ? 'mio' : ''}` },
    el('div', { class: 'cabt' },
      el('span', { class: 'chip' }, t.nivel || 'Taller'),
      mio ? el('span', { class: 'chip verde' }, '✓ Inscrito') : chipCupo(cupoDe(t))),
    el('h3', null, t.titulo),
    el('div', { class: 'datos' },
      el('span', null, `▦ ${nombreDia(fechaDe(t.inicio), { weekday: 'long', day: 'numeric', month: 'short' })} · ${hora(t.inicio)}–${hora(t.fin)}`),
      el('span', null, `⌖ ${t.sala}`),
      t.relator && el('span', null, `◉ ${t.relator}`)),
    t.descripcion && el('p', { class: 'desc' }, t.descripcion),
    el('div', { class: 'pie-t' }, widgetCupo(cupoDe(t), { flash: estado.cambiados.has(t.id) }), boton));
}

function vistaTalleres() {
  const ev = estado.evento;
  const porDia = new Map();
  for (const t of [...talleres()].sort((a, b) => a.inicio.localeCompare(b.inicio))) {
    const f = fechaDe(t.inicio);
    if (!porDia.has(f)) porDia.set(f, []);
    porDia.get(f).push(t);
  }
  return [
    el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' } },
      el('div', null, el('span', { class: 'eyebrow' }, 'Talleres'), el('h1', null, 'Elige tus talleres'),
        el('p', { class: 'sub' }, `Puedes inscribir hasta ${ev.maxTalleresPorEstudiante} talleres sin topes de horario. Los cupos se actualizan en tiempo real.`)),
      estado.yo && vivo(() => el('span', { class: 'chip oscuro' }, `Elegidos: ${estado.yo.talleres.length} / ${ev.maxTalleresPorEstudiante}`))),
    !estado.yo && el('div', { class: 'aviso info' }, 'Para reservar un cupo primero debes ', el('a', { href: '#/registro' }, 'inscribirte en el evento'), '.'),
    [...porDia].map(([fecha, lista]) => el('section', { style: { marginBottom: '24px' } },
      el('h2', null, nombreDia(fecha), el('span', { class: 'sub', style: { fontWeight: 400, fontSize: '.95rem' } },
        ' · ', (ev.dias || []).find((d) => d.fecha === fecha)?.titulo || '')),
      el('div', { class: 'grid grid-3' }, lista.map((t) => vivo(() => tarjetaTaller(t)))))),
  ];
}

function vistaAgenda() {
  const ev = estado.evento;
  const dias = ev.dias?.length ? ev.dias : [...new Set([...ev.agenda, ...ev.talleres].map((i) => fechaDe(i.inicio)))].sort().map((fecha) => ({ fecha }));
  if (!estado.dia || !dias.some((d) => d.fecha === estado.dia)) {
    const hoy = new Date().toISOString().slice(0, 10);
    estado.dia = (dias.find((d) => d.fecha === hoy) || dias[0]).fecha;
  }

  const items = [
    ...ev.agenda.map((a) => ({ ...a, clase: a.tipo })),
    ...ev.talleres.map((t) => ({ ...t, tipo: 'taller', clase: 'taller-a', taller: t })),
  ]
    .filter((i) => fechaDe(i.inicio) === estado.dia)
    .filter((i) => !(estado.soloMia && estado.yo && i.tipo === 'taller' && !esMio(i.taller)))
    .sort((a, b) => a.inicio.localeCompare(b.inicio) || (a.tipo === 'taller') - (b.tipo === 'taller'));

  // Agrupa por hora de inicio (los talleres paralelos quedan juntos).
  const bloques = [];
  for (const i of items) {
    const ultimo = bloques[bloques.length - 1];
    if (ultimo && ultimo.inicio === i.inicio) ultimo.items.push(i);
    else bloques.push({ inicio: i.inicio, items: [i] });
  }

  const etiquetas = { charla: 'Charla', taller: 'Taller', pausa: 'Pausa', acreditacion: 'Acreditación' };
  const item = (i) => el('div', { class: `item ${i.clase} ${i.taller && esMio(i.taller) ? 'mio' : ''}` },
    el('div', { class: 'chips' },
      el('span', { class: 'chip' }, etiquetas[i.tipo] || i.tipo),
      i.taller && esMio(i.taller) && el('span', { class: 'chip verde' }, '✓ Mi taller'),
      i.taller && !esMio(i.taller) && vivo(() => chipCupo(cupoDe(i.taller)))),
    el('div', { class: 'tit' }, i.titulo),
    el('div', { class: 'det' }, `${hora(i.inicio)}–${hora(i.fin)}`, (i.lugar || i.sala) ? ` · ${i.lugar || i.sala}` : '',
      (i.expositor || i.relator) ? ` · ${i.expositor || i.relator}` : ''),
    i.taller && vivo(() => widgetCupo(cupoDe(i.taller), { flash: estado.cambiados.has(i.taller.id) })),
    i.taller && !esMio(i.taller) && estado.yo && el('a', { class: 'btn btn-linea btn-chico', href: '#/talleres', style: { marginTop: '8px' } }, 'Ver taller'));

  return [
    el('span', { class: 'eyebrow' }, 'Programa'),
    el('h1', null, 'Agenda del evento'),
    el('p', { class: 'sub', style: { marginBottom: '16px' } }, `${ev.lugar}${ev.direccion ? ' · ' + ev.direccion : ''}`),
    el('div', { class: 'dias', role: 'group', 'aria-label': 'Día' }, dias.map((d) => el('button', {
      type: 'button', 'aria-pressed': String(d.fecha === estado.dia),
      onclick: () => { estado.dia = d.fecha; render(); },
    }, el('strong', null, nombreDia(d.fecha, { weekday: 'long', day: 'numeric', month: 'short' })), d.titulo && el('span', null, d.titulo)))),
    estado.yo && el('label', { class: 'filtros check' },
      el('input', { type: 'checkbox', checked: estado.soloMia, onchange: (e) => { estado.soloMia = e.target.checked; render(); } }),
      el('span', null, 'Mostrar sólo mi agenda (charlas + mis talleres)')),
    bloques.length
      ? bloques.map((b) => el('div', { class: 'linea' },
        el('div', { class: 'hora' }, hora(b.inicio)),
        el('div', null, b.items.map(item))))
      : el('p', { class: 'vacio' }, 'No hay actividades para este día.'),
  ];
}

// ---------- enrutador ----------

const RUTAS = {
  '': ['inicio', vistaInicio],
  registro: ['entrada', vistaRegistro],
  acceso: ['entrada', vistaAcceso],
  entrada: ['entrada', vistaEntrada],
  talleres: ['talleres', vistaTalleres],
  agenda: ['agenda', vistaAgenda],
};

function render() {
  const clave = location.hash.replace(/^#\/?/, '').split('?')[0];
  const [seccion, fn] = RUTAS[clave] || RUTAS[''];
  for (const a of document.querySelectorAll('[data-ruta]')) {
    if (a.dataset.ruta === seccion) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  refrescables = new Set();
  const contenido = fn();
  if (contenido === undefined) return; // la vista redirigió
  vista.replaceChildren(...[contenido].flat(Infinity).filter(Boolean));
}

function actualizarCupos(nuevos) {
  for (const [id, c] of Object.entries(nuevos)) {
    if (estado.cupos[id] && estado.cupos[id].inscritos !== c.inscritos) estado.cambiados.add(id);
  }
  estado.cupos = nuevos;
  refrescar();
}

window.addEventListener('hashchange', () => {
  render();
  window.scrollTo(0, 0);
});

(async function iniciar() {
  try {
    estado.evento = await api('GET', '/api/evento');
  } catch (e) {
    vista.replaceChildren(el('div', { class: 'aviso error' }, 'No pudimos cargar el evento. ', e.message));
    return;
  }
  estado.cupos = estado.evento.cupos;
  document.title = `${estado.evento.nombre} | ${estado.evento.organiza}`;
  estado.yo = await api('GET', '/api/yo').catch(() => null);
  render();

  const indicador = document.getElementById('vivo');
  suscribirCupos(actualizarCupos, (ok) => indicador.classList.toggle('on', ok));

  // Al volver a la pestaña, refresca el estado de acreditación.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !estado.yo) return;
    const yo = await api('GET', '/api/yo').catch(() => null);
    if (yo && (yo.acreditadoEn !== estado.yo.acreditadoEn || yo.talleres.join() !== estado.yo.talleres.join())) {
      estado.yo = yo;
      render();
    }
  });
})();
