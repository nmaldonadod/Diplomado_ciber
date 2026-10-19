'use strict';

/* App del estudiante: inscripción, entrada con QR, talleres con cupos en vivo y agenda. */

const estado = {
  datos: null, // respuesta de /api/evento
  cupos: {},
  yo: null,
  dia: null,
  soloMia: false,
  cambiados: new Set(),
  codigoNuevo: null, // código de acceso recién creado (se muestra una sola vez)
};
const vista = document.getElementById('vista');

// ---------- nodos que se redibujan cuando cambian los cupos ----------
let refrescables = new Set();
let alCambiarCupos = null; // callback de la vista actual (p. ej. selector de talleres del formulario)
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

// ---------- dominio ----------
const ev = () => estado.datos.evento;
const talleres = () => estado.datos.talleres;
const taller = (id) => talleres().find((t) => t.id === id);
const misTalleres = () => (estado.yo ? estado.yo.talleres.map(taller).filter(Boolean) : []);
const esMio = (t) => Boolean(estado.yo && estado.yo.talleres.includes(t.id));
const seCruzan = (a, b) => a.inicio < b.fin && b.inicio < a.fin;
const cupoDe = (t) => estado.cupos[t.id] || { cupos: t.cupos, inscritos: 0 };
const quedan = (t) => cupoDe(t).cupos - cupoDe(t).inscritos;
const nombreCompleto = (p) => `${p.nombres} ${p.apellidos}`;
const talleresTxt = (n) => (n === 1 ? '1 taller' : `${n} talleres`);

// Motivo por el que no se puede elegir un taller dada una selección (null = se puede).
function motivoBloqueo(t, seleccion) {
  if (quedan(t) <= 0) return 'Sin cupos';
  const choque = seleccion.find((m) => m.id !== t.id && seCruzan(m, t));
  if (choque) return `Tope de horario con «${choque.titulo}»`;
  const max = ev().maxTalleres;
  if (max && seleccion.length >= max) return `Máximo ${talleresTxt(max)}`;
  return null;
}

function irA(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function fotoDocente(t, tam) {
  const iniciales = (t.docente || '?').split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
  return el('div', { class: 'docente' },
    t.foto
      ? el('img', { src: t.foto, alt: `Foto de ${t.docente || 'docente'}`, loading: 'lazy', width: tam, height: tam })
      : el('span', { class: 'sin-foto', 'aria-hidden': 'true' }, iniciales),
    el('span', null, el('small', null, 'Docente'), t.docente || 'Por confirmar'));
}

// Horario general del programa (sin contar la acreditación), p. ej. "14:30 a 17:40 h".
function horarioEvento() {
  const items = [...estado.datos.agenda.filter((a) => a.tipo !== 'acreditacion'), ...talleres()];
  if (!items.length) return '';
  const inicio = items.map((i) => i.inicio).sort()[0];
  const fin = items.map((i) => i.fin).sort().pop();
  return `${hora(inicio)} a ${hora(fin)} h`;
}

// "Mes de la Ciberseguridad" → ["Mes de la", "Ciberseguridad"], como en la gráfica del evento.
function partirNombre(nombre) {
  const m = nombre.match(/^(.*\s(?:de la|del|de los|de las|de))\s+(.+)$/i);
  return m ? [m[1], m[2]] : ['', nombre];
}

function cuentaRegresiva() {
  const e = ev();
  const hoy = new Date().toLocaleDateString('sv-SE');
  if (hoy > e.fechaFin) return 'Evento finalizado';
  if (hoy >= e.fechaInicio) return 'Hoy · en curso';
  const dias = Math.round((Date.parse(e.fechaInicio) - Date.parse(hoy)) / 86400_000);
  return dias === 1 ? 'Mañana' : `Faltan ${dias} días`;
}

// ---------- vistas ----------

function vistaNoConfigurado() {
  return el('section', { class: 'card', style: { maxWidth: '560px', margin: '24px auto', textAlign: 'center' } },
    el('h1', null, 'Próximamente'),
    el('p', { class: 'sub' }, 'El evento aún no ha sido publicado. Vuelve pronto.'));
}

function vistaInicio() {
  const e = ev();
  const acciones = estado.yo
    ? [el('a', { class: 'btn btn-primario', href: '#/entrada' }, 'Ver mi entrada'), el('a', { class: 'btn btn-contorno', href: '#/talleres' }, 'Mis talleres')]
    : [
      e.inscripcionesAbiertas
        ? el('a', { class: 'btn btn-primario', href: '#/registro' }, 'Inscribirme →')
        : el('span', { class: 'chip alerta' }, 'Inscripciones cerradas'),
      el('a', { class: 'btn btn-contorno', href: '#/acceso' }, 'Ya estoy inscrito'),
    ];

  const [antes, principal] = partirNombre(e.nombre);
  const unDia = e.fechaInicio === e.fechaFin;
  const [anio, mes, dia] = e.fechaInicio.split('-').map(Number);
  const fecha = new Date(anio, mes - 1, dia);

  return [
    el('section', { class: 'hero' },
      el('div', { class: 'contenido' },
        el('span', { class: 'cuenta' }, cuentaRegresiva()),
        antes && el('div', { class: 'mes' }, antes),
        el('h1', null, principal),
        e.lema && el('div', { class: 'lema' }, el('span', { class: 'modo on', 'aria-hidden': 'true' }, el('i')), e.lema),
        e.descripcion && el('p', { class: 'desc' }, e.descripcion),
        el('div', { class: 'fecha-evento' },
          el('div', { class: 'dia' }, unDia ? String(dia) : `${dia}–${Number(e.fechaFin.slice(8))}`),
          el('div', { class: 'mesano' }, fecha.toLocaleDateString('es-CL', { month: 'long' }), el('span', null, anio)),
          el('div', { class: 'donde' },
            unDia && fecha.toLocaleDateString('es-CL', { weekday: 'long' }), unDia && horarioEvento() && ' · ', horarioEvento(),
            e.lugar && el('div', null, el('strong', null, e.lugar)))),
        el('div', { class: 'acciones' }, acciones)),
      el('div', { class: 'campus', role: 'img', 'aria-label': 'Campus INACAP de noche' })),

    estado.yo && el('div', { class: 'aviso ok' }, `Hola ${estado.yo.nombres.split(' ')[0]}, ya estás inscrito. `,
      estado.yo.talleres.length ? `Tienes ${estado.yo.talleres.length} taller(es).` : 'Aún no eliges talleres.'),

    el('div', { class: 'grid grid-2 arriba' },
      el('section', { class: 'card' },
        el('h2', null, '¿Cómo participar?'),
        el('ol', { class: 'pasos' },
          el('li', null, el('span', null, el('strong', null, 'Inscríbete'), ' con tu correo INACAPMAIL. Recibirás tu entrada digital con código QR.')),
          el('li', null, el('span', null, el('strong', null, 'Elige tus talleres'), ' al inscribirte o después', e.maxTalleres === 1 ? ' (1 por persona)' : e.maxTalleres ? ` (hasta ${e.maxTalleres})` : '', '. Los cupos son limitados y se actualizan en vivo.')),
          el('li', null, el('span', null, el('strong', null, 'Acredítate'), ' el día del evento mostrando el QR de tu entrada.')))),
      el('section', { class: 'card' },
        el('h2', null, 'Talleres'),
        talleres().length
          ? talleres().map((t) => el('div', { style: { marginBottom: '12px' } },
            el('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px' } },
              el('a', { href: '#/talleres', style: { fontWeight: '600', fontSize: '.92rem', textDecoration: 'none' } }, t.titulo),
              el('span', { class: 'sub', style: { fontSize: '.8rem', whiteSpace: 'nowrap' } }, `${nombreDia(fechaDe(t.inicio), { weekday: 'short' })} ${hora(t.inicio)}`)),
            vivo(() => widgetCupo(cupoDe(t), { flash: estado.cambiados.has(t.id) }))))
          : el('p', { class: 'sub' }, 'Pronto publicaremos los talleres.'),
        talleres().length > 0 && el('a', { class: 'btn btn-contorno btn-chico', href: '#/talleres' }, 'Ver talleres'))),
  ];
}

// Lista de talleres con casillas, usada en el formulario de inscripción.
function selectorTalleres() {
  const seleccion = [];
  const cont = el('div', { class: 'elegir' });
  function dibujar() {
    cont.replaceChildren(...talleres().map((t) => {
      const marcado = seleccion.some((s) => s.id === t.id);
      const motivo = marcado ? null : motivoBloqueo(t, seleccion);
      const caja = el('input', { type: 'checkbox', value: t.id, checked: marcado, disabled: Boolean(motivo) });
      caja.addEventListener('change', () => {
        if (caja.checked) seleccion.push(t);
        else seleccion.splice(seleccion.findIndex((s) => s.id === t.id), 1);
        dibujar();
      });
      return el('label', { class: marcado ? 'sel' : motivo ? 'no' : '' }, caja,
        el('span', { style: { flex: 1 } },
          el('span', { class: 't' }, t.titulo),
          el('span', { class: 'd', style: { display: 'block' } },
            `${nombreDia(fechaDe(t.inicio), { weekday: 'short', day: 'numeric', month: 'short' })} · ${hora(t.inicio)}–${hora(t.fin)}${t.docente ? ' · ' + t.docente : ''}`),
          motivo && el('span', { class: 'd', style: { display: 'block', color: 'var(--alerta)' } }, motivo),
          widgetCupo(cupoDe(t))));
    }));
  }
  dibujar();
  cont.__redibujar = dibujar;
  cont.__seleccion = () => seleccion.map((t) => t.id);
  return cont;
}

function vistaRegistro() {
  if (estado.yo) return irA('#/entrada');
  const e = ev();
  if (!e.inscripcionesAbiertas) {
    return el('div', { class: 'card', style: { maxWidth: '560px', margin: '0 auto' } },
      el('h1', null, 'Inscripciones cerradas'), el('p', { class: 'sub' }, 'Las inscripciones para este evento ya no están disponibles.'));
  }
  const aviso = el('div', { class: 'aviso error oculto', role: 'alert' });
  const selector = e.talleresAbiertos && talleres().length ? selectorTalleres() : null;
  // Si cambian los cupos mientras completa el formulario, se actualiza la lista.
  if (selector) alCambiarCupos = selector.__redibujar;

  const form = el('form', { class: 'card', novalidate: true },
    el('span', { class: 'eyebrow' }, 'Inscripción'),
    el('h1', null, 'Inscríbete al evento'),
    el('p', { class: 'sub', style: { marginBottom: '18px' } }, e.nombre),
    aviso,
    el('div', { class: 'grid grid-2', style: { gap: '0 16px' } },
      campo('nombres', 'Nombres', { autocomplete: 'given-name', required: true, maxlength: 60 }),
      campo('apellidos', 'Apellidos', { autocomplete: 'family-name', required: true, maxlength: 60 })),
    campo('sede', 'Sede', { opciones: estado.datos.sedes, required: true }),
    campo('email', 'INACAPMAIL', { type: 'email', autocomplete: 'email', required: true, maxlength: 120, placeholder: `nombre.apellido@${estado.datos.dominioCorreo}`, inputmode: 'email' }),
    campo('telefono', 'Teléfono', { type: 'tel', autocomplete: 'tel', required: true, placeholder: '9 1234 5678', maxlength: 16, inputmode: 'tel' }),
    selector && el('fieldset', null,
      el('legend', null, 'Talleres (opcional)'),
      el('p', { class: 'sub', style: { fontSize: '.86rem' } }, 'Puedes elegirlos ahora o más tarde desde la sección Talleres.', e.maxTalleres ? ` Máximo ${talleresTxt(e.maxTalleres)}.` : ''),
      selector),
    el('label', { class: 'check', 'data-campo': 'consentimiento' },
      el('input', { type: 'checkbox', name: 'consentimiento' }),
      el('span', null, 'Autorizo el uso de mis datos sólo para gestionar mi participación en este evento, según la ',
        el('a', { href: '/privacidad', target: '_blank', rel: 'noopener' }, 'política de privacidad'), '.',
        el('span', { class: 'err', style: { display: 'block' } }))),
    el('button', { class: 'btn btn-primario btn-bloque', type: 'submit' }, 'Inscribirme'),
    el('p', { class: 'sub', style: { marginTop: '14px', fontSize: '.88rem', textAlign: 'center' } },
      '¿Ya te inscribiste? ', el('a', { href: '#/acceso' }, 'Entra con tu código de acceso')));

  form.addEventListener('submit', async (evt) => {
    evt.preventDefault();
    const f = form.elements;
    const datos = {
      nombres: f.nombres.value, apellidos: f.apellidos.value, sede: f.sede.value, email: f.email.value.trim(),
      telefono: f.telefono.value, consentimiento: f.consentimiento.checked, talleres: selector ? selector.__seleccion() : [],
    };
    const errores = {};
    if (datos.nombres.trim().length < 2) errores.nombres = 'Ingresa tus nombres.';
    if (datos.apellidos.trim().length < 2) errores.apellidos = 'Ingresa tus apellidos.';
    if (!datos.sede) errores.sede = 'Selecciona tu sede.';
    if (!correoValido(datos.email)) errores.email = `Usa tu correo institucional @${estado.datos.dominioCorreo}.`;
    if (!telefonoValido(datos.telefono)) errores.telefono = 'Teléfono inválido (ej: 9 1234 5678).';
    if (!datos.consentimiento) errores.consentimiento = 'Debes aceptar para continuar.';
    mostrarErrores(form, errores);
    aviso.classList.add('oculto');
    if (Object.keys(errores).length) return;

    const boton = form.querySelector('button[type=submit]');
    boton.disabled = true;
    boton.textContent = 'Inscribiendo…';
    try {
      const r = await api('POST', '/api/registro', datos);
      estado.yo = r.perfil;
      estado.codigoNuevo = { codigo: r.codigoAcceso, rechazados: r.rechazados };
      irA('#/bienvenida');
    } catch (e2) {
      mostrarErrores(form, e2.datos?.errores);
      aviso.textContent = e2.codigo === 'YA_REGISTRADO' ? 'Este correo ya está inscrito. Entra con tu código de acceso.' : e2.message;
      aviso.classList.remove('oculto');
      boton.disabled = false;
      boton.textContent = 'Inscribirme';
    }
  });

  return el('div', { style: { maxWidth: '620px', margin: '0 auto' } }, form);
}

// Se muestra una única vez tras inscribirse: el código de acceso no se puede volver a consultar.
function vistaBienvenida() {
  const n = estado.codigoNuevo;
  if (!n || !estado.yo) return irA('#/entrada');
  return el('div', { class: 'card', style: { maxWidth: '520px', margin: '0 auto' } },
    el('span', { class: 'eyebrow' }, '¡Inscripción lista!'),
    el('h1', null, `Bienvenido/a, ${estado.yo.nombres.split(' ')[0]}`),
    el('p', null, 'Este es tu ', el('strong', null, 'código de acceso'), '. Lo necesitarás para entrar desde otro teléfono o computador. ',
      el('strong', null, 'Guárdalo (anótalo o toma una captura): no lo volveremos a mostrar.')),
    el('div', { class: 'codigo-acceso', 'aria-label': 'Código de acceso' }, n.codigo),
    n.rechazados?.length > 0 && el('div', { class: 'aviso error' },
      el('strong', null, 'Algunos talleres no se pudieron reservar:'),
      el('ul', { style: { margin: '6px 0 0 18px' } }, n.rechazados.map((r) => el('li', null, r.motivo)))),
    el('div', { class: 'acciones' },
      el('button', { class: 'btn btn-primario', type: 'button', onclick: () => { estado.codigoNuevo = null; irA('#/entrada'); } }, 'Ya lo guardé, ver mi entrada')));
}

function vistaAcceso() {
  if (estado.yo) return irA('#/entrada');
  const aviso = el('div', { class: 'aviso error oculto', role: 'alert' });
  const form = el('form', { class: 'card', novalidate: true },
    el('span', { class: 'eyebrow' }, 'Ya estoy inscrito'),
    el('h1', null, 'Entra a tu cuenta'),
    el('p', { class: 'sub', style: { marginBottom: '18px' } }, 'Usa tu INACAPMAIL y el código de acceso que recibiste al inscribirte.'),
    aviso,
    campo('email', 'INACAPMAIL', { type: 'email', autocomplete: 'email', required: true, inputmode: 'email' }),
    campo('codigo', 'Código de acceso', { autocomplete: 'off', required: true, maxlength: 12, style: { textTransform: 'uppercase', letterSpacing: '.15em' } }),
    el('button', { class: 'btn btn-secundario btn-bloque', type: 'submit' }, 'Entrar'),
    el('p', { class: 'sub', style: { marginTop: '14px', fontSize: '.86rem', textAlign: 'center' } },
      '¿Perdiste tu código? Pide uno nuevo a la organización o en el módulo de acreditación.'));
  form.addEventListener('submit', async (evt) => {
    evt.preventDefault();
    aviso.classList.add('oculto');
    try {
      estado.yo = await api('POST', '/api/acceso', { email: form.elements.email.value.trim(), codigo: form.elements.codigo.value });
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
  // El SVG se genera a partir de un código alfanumérico propio (sin datos ingresados por usuarios).
  cont.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true, alt: 'Código QR de tu entrada' });
  return cont;
}

function vistaEntrada() {
  if (!estado.yo) {
    return el('div', { class: 'grid grid-2', style: { maxWidth: '760px', margin: '0 auto' } },
      el('section', { class: 'card' }, el('h2', null, 'Aún no te inscribes'),
        el('p', { class: 'sub' }, 'Inscríbete para obtener tu entrada con código QR y elegir talleres.'),
        el('div', { class: 'acciones' }, el('a', { class: 'btn btn-primario', href: '#/registro' }, 'Inscribirme'))),
      el('section', { class: 'card' }, el('h2', null, '¿Ya estás inscrito?'),
        el('p', { class: 'sub' }, 'Entra con tu INACAPMAIL y tu código de acceso.'),
        el('div', { class: 'acciones' }, el('a', { class: 'btn btn-contorno', href: '#/acceso' }, 'Entrar'))));
  }
  const yo = estado.yo;
  const mios = misTalleres().sort((a, b) => a.inicio.localeCompare(b.inicio));
  const max = ev().maxTalleres;
  return el('div', { style: { maxWidth: '520px', margin: '0 auto' } },
    el('article', { class: 'ticket' },
      el('div', { class: 'top' },
        el('img', { src: '/img/logo-inacap-60.png', alt: 'INACAP 60 años', width: 124, height: 20 }),
        el('div', { class: 'eyebrow' }, 'Entrada digital'), el('h2', null, ev().nombre)),
      svgQR(yo.qr),
      el('div', { class: 'cod' }, yo.codigo.replace(/(.{4})/g, '$1 ').trim()),
      el('div', { class: 'quien' },
        el('strong', null, nombreCompleto(yo)),
        el('span', { class: 'sub' }, yo.sede),
        el('div', { class: 'estado' }, yo.acreditadoEn
          ? el('span', { class: 'chip ok' }, `✓ Acreditado ${horaReal(yo.acreditadoEn)}`)
          : el('span', { class: 'chip alerta' }, 'Pendiente de acreditación')))),
    el('p', { class: 'sub', style: { textAlign: 'center', fontSize: '.86rem', margin: '12px 0 0' } },
      'Muestra este QR en la acreditación. Te recomendamos guardar una captura de pantalla.'),

    el('section', { class: 'card mis' },
      el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' } },
        el('h2', { style: { margin: 0 } }, 'Mis talleres'),
        el('span', { class: 'chip' }, max ? `${mios.length} / ${max}` : String(mios.length))),
      mios.length
        ? el('ul', { style: { marginTop: '8px' } }, mios.map((t) => el('li', null,
          el('span', null, el('strong', null, t.titulo), el('br'), el('span', { class: 'sub', style: { fontSize: '.85rem' } },
            `${nombreDia(fechaDe(t.inicio), { weekday: 'short', day: 'numeric' })} · ${hora(t.inicio)}–${hora(t.fin)}${t.sala ? ' · ' + t.sala : ''}`)))))
        : el('p', { class: 'sub', style: { marginTop: '8px' } }, 'Todavía no eliges talleres.'),
      el('div', { class: 'acciones' },
        el('a', { class: 'btn btn-primario btn-chico', href: '#/talleres' }, mios.length ? 'Cambiar talleres' : 'Elegir talleres'),
        el('a', { class: 'btn btn-contorno btn-chico', href: '#/agenda' }, 'Ver mi agenda'))),

    el('section', { class: 'card', style: { marginTop: '16px' } },
      el('h2', null, 'Mis datos'),
      el('p', { class: 'sub', style: { fontSize: '.9rem' } }, `${yo.email} · ${yo.telefono}`),
      el('p', { class: 'sub', style: { fontSize: '.82rem', marginTop: '6px' } }, 'Para corregir o eliminar tus datos, escribe a la organización del evento.'),
      el('div', { class: 'acciones' },
        el('button', {
          class: 'btn btn-contorno btn-chico', type: 'button',
          onclick: async () => {
            if (!confirm('¿Cerrar sesión en este dispositivo? Para volver a entrar necesitarás tu código de acceso.')) return;
            await api('POST', '/api/salir', {}).catch(() => {});
            estado.yo = null;
            irA('#/');
          },
        }, 'Cerrar sesión'))));
}

async function cambiarInscripcion(t, boton) {
  const inscribir = !esMio(t);
  if (!inscribir && !confirm(`¿Cancelar tu inscripción en «${t.titulo}»? Liberarás tu cupo.`)) return;
  boton.disabled = true;
  boton.textContent = inscribir ? 'Reservando cupo…' : 'Cancelando…';
  try {
    const r = await api(inscribir ? 'POST' : 'DELETE', `/api/talleres/${t.id}/inscripcion`, {});
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
  let boton;
  if (!estado.yo) {
    boton = el('a', { class: 'btn btn-secundario btn-bloque', href: '#/registro' }, 'Inscríbete al evento para elegir');
  } else if (!ev().talleresAbiertos) {
    boton = el('button', { class: 'btn btn-contorno btn-bloque', type: 'button', disabled: true }, mio ? '✓ Inscrito · elección cerrada' : 'Elección de talleres cerrada');
  } else if (mio) {
    boton = el('button', { class: 'btn btn-contorno btn-bloque', type: 'button' }, 'Cancelar inscripción');
  } else {
    const motivo = motivoBloqueo(t, misTalleres());
    boton = el('button', { class: 'btn btn-primario btn-bloque', type: 'button', disabled: Boolean(motivo) }, motivo || 'Inscribirme');
  }
  if (boton.tagName === 'BUTTON' && !boton.disabled) boton.addEventListener('click', () => cambiarInscripcion(t, boton));

  return el('article', { class: `card taller ${mio ? 'mio' : ''}` },
    el('div', { class: 'cabt' },
      el('span', { class: 'chip' }, 'Taller'),
      mio ? el('span', { class: 'chip ok' }, '✓ Inscrito') : chipCupo(cupoDe(t))),
    el('h3', null, t.titulo),
    fotoDocente(t, 44),
    el('div', { class: 'datos', style: { marginTop: '6px' } },
      el('span', null, `▦ ${nombreDia(fechaDe(t.inicio), { weekday: 'long', day: 'numeric', month: 'short' })} · ${hora(t.inicio)}–${hora(t.fin)}`),
      t.sala && el('span', null, `⌖ ${t.sala}`)),
    t.descripcion && el('p', { class: 'desc', style: { whiteSpace: 'pre-line' } }, t.descripcion),
    el('div', { class: 'pie-t' }, widgetCupo(cupoDe(t), { flash: estado.cambiados.has(t.id) }), boton));
}

function vistaTalleres() {
  const e = ev();
  const porDia = new Map();
  for (const t of talleres()) {
    const f = fechaDe(t.inicio);
    if (!porDia.has(f)) porDia.set(f, []);
    porDia.get(f).push(t);
  }
  return [
    el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' } },
      el('div', null, el('span', { class: 'eyebrow' }, 'Talleres'), el('h1', null, 'Elige tus talleres'),
        el('p', { class: 'sub' }, e.maxTalleres === 1 ? 'Puedes inscribirte en 1 taller. '
          : e.maxTalleres ? `Puedes inscribir hasta ${talleresTxt(e.maxTalleres)} sin topes de horario. ` : 'Puedes inscribir talleres sin topes de horario. ',
          'Los cupos se actualizan en tiempo real.')),
      estado.yo && vivo(() => el('span', { class: 'chip fuerte' }, `Elegidos: ${estado.yo.talleres.length}${e.maxTalleres ? ' / ' + e.maxTalleres : ''}`))),
    !estado.yo && el('div', { class: 'aviso info' }, 'Para reservar un cupo primero debes ', el('a', { href: '#/registro' }, 'inscribirte en el evento'), '.'),
    !talleres().length && el('p', { class: 'vacio' }, 'Aún no hay talleres publicados.'),
    [...porDia].map(([fecha, lista]) => el('section', { style: { marginBottom: '24px' } },
      el('h2', null, nombreDia(fecha)),
      el('div', { class: 'grid grid-3' }, lista.map((t) => vivo(() => tarjetaTaller(t)))))),
  ];
}

function diasDelEvento() {
  const e = ev();
  const dias = [];
  const [a, m, d] = e.fechaInicio.split('-').map(Number);
  for (let f = new Date(Date.UTC(a, m - 1, d)); f.toISOString().slice(0, 10) <= e.fechaFin && dias.length < 31; f.setUTCDate(f.getUTCDate() + 1)) {
    dias.push(f.toISOString().slice(0, 10));
  }
  const conActividad = new Set([...estado.datos.agenda, ...talleres()].map((i) => fechaDe(i.inicio)));
  return [...new Set([...dias, ...conActividad])].sort();
}

function vistaAgenda() {
  const e = ev();
  const dias = diasDelEvento();
  if (!estado.dia || !dias.includes(estado.dia)) {
    const hoy = new Date().toLocaleDateString('sv-SE');
    estado.dia = dias.includes(hoy) ? hoy : dias[0];
  }

  const items = [
    ...estado.datos.agenda.map((a) => ({ ...a, clase: a.tipo })),
    ...talleres().map((t) => ({ ...t, tipo: 'taller', clase: 'taller-a', taller: t, lugar: t.sala, expositor: t.docente })),
  ]
    .filter((i) => fechaDe(i.inicio) === estado.dia)
    .filter((i) => !(estado.soloMia && estado.yo && i.tipo === 'taller' && !esMio(i.taller)))
    .sort((a, b) => a.inicio.localeCompare(b.inicio) || (a.tipo === 'taller') - (b.tipo === 'taller'));

  // Bloques por hora de inicio: los talleres simultáneos quedan juntos, como en el afiche.
  const bloques = [];
  for (const i of items) {
    const ultimo = bloques[bloques.length - 1];
    if (ultimo && ultimo.inicio === i.inicio) {
      ultimo.items.push(i);
      if (i.fin > ultimo.fin) ultimo.fin = i.fin;
    } else bloques.push({ inicio: i.inicio, fin: i.fin, items: [i] });
  }

  const item = (i) => el('div', { class: `item ${i.taller && esMio(i.taller) ? 'mio' : ''}` },
    i.taller && el('div', { class: 'chips' },
      el('span', { class: 'chip' }, 'Taller'),
      esMio(i.taller) ? el('span', { class: 'chip ok' }, 'Mi taller') : vivo(() => chipCupo(cupoDe(i.taller)))),
    el('div', { class: 'tit' }, i.titulo),
    i.expositor && el('div', { class: 'quien' }, i.expositor),
    i.descripcion && !i.taller && el('div', { class: 'det', style: { whiteSpace: 'pre-line' } }, i.descripcion),
    i.taller && el('div', { class: 'det' }, `${hora(i.inicio)}–${hora(i.fin)}${i.lugar ? ' · ' + i.lugar : ''}`),
    i.taller && vivo(() => widgetCupo(cupoDe(i.taller), { flash: estado.cambiados.has(i.taller.id) })));

  return [
    el('span', { class: 'eyebrow' }, 'Programa'),
    el('h1', null, nombreDia(estado.dia, { weekday: 'long', day: 'numeric', month: 'long' })),
    el('p', { class: 'sub', style: { marginBottom: '16px' } }, [e.lugar, e.direccion].filter(Boolean).join(' · ')),
    dias.length > 1 && el('div', { class: 'dias', role: 'group', 'aria-label': 'Día' }, dias.map((d) => el('button', {
      type: 'button', 'aria-pressed': String(d === estado.dia),
      onclick: () => { estado.dia = d; render(); },
    }, el('strong', null, nombreDia(d, { weekday: 'long', day: 'numeric', month: 'short' }))))),
    estado.yo && el('label', { class: 'filtros check' },
      el('input', { type: 'checkbox', checked: estado.soloMia, onchange: (x) => { estado.soloMia = x.target.checked; render(); } }),
      el('span', null, 'Mostrar sólo mi agenda (actividades generales + mis talleres)')),
    el('section', { class: 'card agenda' },
      el('div', { class: 'agenda-titulo' }, 'AGENDA'),
      bloques.length
        ? bloques.map((b) => el('div', { class: `linea ${b.items.every((i) => i.tipo === 'pausa') ? 'pausa' : ''}` },
          el('div', { class: 'hora' }, `${hora(b.inicio)} – ${hora(b.fin)}`),
          el('div', { class: 'items' }, b.items.map(item))))
        : el('p', { class: 'vacio' }, 'No hay actividades publicadas para este día.')),
  ];
}

// ---------- enrutador ----------

const RUTAS = {
  '': ['inicio', vistaInicio],
  registro: ['entrada', vistaRegistro],
  bienvenida: ['entrada', vistaBienvenida],
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
  alCambiarCupos = null;
  const contenido = estado.datos.configurado ? fn() : vistaNoConfigurado();
  if (contenido === undefined) return; // la vista redirigió
  vista.replaceChildren(...[contenido].flat(Infinity).filter(Boolean));
}

function actualizarCupos(nuevos) {
  for (const [id, c] of Object.entries(nuevos)) {
    if (estado.cupos[id] && estado.cupos[id].inscritos !== c.inscritos) estado.cambiados.add(Number(id));
  }
  estado.cupos = nuevos;
  alCambiarCupos?.();
  refrescar();
}

async function cargarEvento() {
  estado.datos = await api('GET', '/api/evento');
  estado.cupos = estado.datos.cupos;
  if (estado.datos.evento) document.title = `${estado.datos.evento.nombre} | INACAP`;
}

// Actualiza el estado del estudiante (p. ej. si lo acaban de acreditar) sin interrumpir formularios.
async function refrescarYo() {
  if (!estado.yo) return;
  const yo = await api('GET', '/api/yo').catch(() => undefined);
  if (yo === undefined) return;
  if (!yo || yo.acreditadoEn !== estado.yo.acreditadoEn || yo.talleres.join() !== estado.yo.talleres.join()) {
    estado.yo = yo;
    if (!vista.querySelector('form')) render();
  }
}

window.addEventListener('hashchange', () => {
  render();
  window.scrollTo(0, 0);
  if (location.hash === '#/entrada') refrescarYo();
});

(async function iniciar() {
  try {
    await cargarEvento();
  } catch (e) {
    vista.replaceChildren(el('div', { class: 'aviso error' }, 'No pudimos cargar el evento. ', e.message));
    return;
  }
  estado.yo = await api('GET', '/api/yo').catch(() => null);
  render();

  const indicador = document.getElementById('vivo');
  let recarga;
  suscribirCambios({
    cupos: actualizarCupos,
    // El administrador cambió el programa: se recarga sin perder lo que el estudiante está escribiendo.
    evento: () => {
      clearTimeout(recarga);
      recarga = setTimeout(async () => {
        await cargarEvento().catch(() => {});
        if (!vista.querySelector('form')) render();
      }, 400);
    },
    conexion: (ok) => indicador.classList.toggle('on', ok),
  });

  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refrescarYo());
})();
