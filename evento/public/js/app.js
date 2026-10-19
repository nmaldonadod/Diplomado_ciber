'use strict';

/* App del estudiante: inscripción, entrada con QR, talleres con cupos en vivo y agenda. */

const estado = {
  datos: null, // respuesta de /api/evento
  cupos: {},
  yo: null,
  dia: null,
  soloMia: false,
  cambiados: new Set(),
  bienvenida: null, // resultado de la inscripción recién hecha
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
const ETIQUETA_TIPO = { estudiante: 'Estudiante', docente: 'Docente', administrativo: 'Administrativo' };
const esEstudiante = () => !estado.yo || (estado.yo.tipo || 'estudiante') === 'estudiante';
const talleresTxt = (n) => (n === 1 ? '1 taller' : `${n} talleres`);

// Motivo por el que no se puede elegir un taller dada una selección (null = se puede).
function motivoBloqueo(t, seleccion) {
  if (quedan(t) <= 0) return 'Sin cupos';
  const max = ev().maxTalleres;
  if (max === 1 && seleccion.length >= 1) return 'Ya elegiste tu taller';
  const choque = seleccion.find((m) => m.id !== t.id && seCruzan(m, t));
  if (choque) return `Tope de horario con «${choque.titulo}»`;
  if (max && seleccion.length >= max) return `Máximo ${talleresTxt(max)}`;
  return null;
}

function irA(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
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

// ---------- video de fondo de la portada ----------
// Sutil y sin sonido. Se elige el archivo según el ancho de pantalla (360p en teléfonos: ~0,8 MB) y no se carga si el
// usuario pidió menos movimiento, ahorro de datos o tiene una conexión lenta. Se pausa fuera de pantalla para cuidar
// la batería. Un único elemento se reutiliza entre vistas para no volver a descargarlo ni reiniciarlo.
let videoPortada = null; // null: aún no se crea · false: no se pudo reproducir
let observadorVideo = null;

function videoFondo() {
  const red = navigator.connection;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || red?.saveData || /(^|-)2g$/.test(red?.effectiveType || '')) return null;
  if (videoPortada === null) {
    const v = document.createElement('video');
    v.className = 'video-fondo';
    v.muted = v.defaultMuted = true; // iOS sólo permite reproducción automática sin sonido
    v.loop = v.autoplay = v.playsInline = true;
    v.disablePictureInPicture = true;
    v.disableRemotePlayback = true;
    v.preload = 'auto';
    v.setAttribute('playsinline', '');
    v.setAttribute('aria-hidden', 'true');
    v.tabIndex = -1;
    v.poster = '/video/inacapito.webp';
    // H.264 (decodificación por hardware en todos los teléfonos); VP9 sólo si el navegador no trae H.264.
    const formato = v.canPlayType('video/mp4; codecs="avc1.4D401E"') ? 'mp4' : 'webm';
    v.src = `/video/inacapito-${matchMedia('(min-width: 761px)').matches ? 720 : 360}.${formato}`;
    v.addEventListener('playing', () => v.classList.add('visible'), { once: true });
    // Si el video no se puede reproducir queda la imagen del campus de siempre.
    v.addEventListener('error', () => { v.remove(); videoPortada = false; }, { once: true });
    document.addEventListener('visibilitychange', () => (document.hidden ? v.pause() : reproducirVideo()));
    videoPortada = v;
  }
  if (!videoPortada) return null;
  observadorVideo?.disconnect();
  if ('IntersectionObserver' in window) {
    observadorVideo = new IntersectionObserver(([e]) => (e.isIntersecting ? reproducirVideo() : videoPortada.pause()));
    queueMicrotask(() => videoPortada?.isConnected && observadorVideo.observe(videoPortada));
  }
  queueMicrotask(reproducirVideo);
  return videoPortada;
}

function reproducirVideo() {
  if (videoPortada?.isConnected && !document.hidden) videoPortada.play().catch(() => {});
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
      el('div', { class: 'campus', role: 'img', 'aria-label': 'Campus INACAP de noche' }),
      videoFondo()),

    estado.yo && el('div', { class: 'aviso ok' }, `Hola ${estado.yo.nombres.split(' ')[0]}, ya estás inscrito. `,
      estado.yo.talleres.length ? `Tienes ${estado.yo.talleres.length} taller(es).` : 'Aún no eliges talleres.'),

    el('div', { class: 'grid grid-2 arriba' },
      el('section', { class: 'card' },
        el('h2', null, '¿Cómo participar?'),
        el('ol', { class: 'pasos' },
          el('li', null, el('span', null, el('strong', null, 'Inscríbete'), ' con tu RUT y correo institucional. Recibirás tu entrada digital con código QR.')),
          el('li', null, el('span', null, el('strong', null, 'Elige tus talleres'), ' al inscribirte o después', e.maxTalleres === 1 ? ' (1 por persona)' : e.maxTalleres ? ` (hasta ${e.maxTalleres})` : '', '. Los cupos son limitados y se actualizan en vivo.')),
          el('li', null, el('span', null, el('strong', null, 'Acredítate'), ' el día del evento mostrando el QR de tu entrada.')))),
      el('section', { class: 'card' },
        el('div', { class: 'cabecera-seccion' }, el('h2', null, 'Talleres'),
          talleres().length > 0 && el('a', { class: 'btn btn-contorno btn-chico', href: '#/talleres' }, 'Ver detalle')),
        talleres().length ? mosaicoTalleres() : el('p', { class: 'sub' }, 'Pronto publicaremos los talleres.'))),
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
            `${hora(t.inicio)}–${hora(t.fin)} · ${t.sala}${t.nivel ? ' · Nivel ' + t.nivel.toLowerCase() : ''}${t.docente ? ' · ' + partirDocente(t.docente)[0] : ''}`),
          motivo && el('span', { class: 'd', style: { display: 'block', color: 'var(--alerta)' } }, motivo),
          widgetCupo(cupoDe(t))));
    }));
  }
  dibujar();
  cont.__redibujar = dibujar;
  cont.__seleccion = () => seleccion.map((t) => t.id);
  return cont;
}

// Indicador de pasos de la inscripción.
function pasosInscripcion(actual) {
  const nombres = ['Tus datos', 'Revisa y confirma'];
  return el('ol', { class: 'progreso', 'aria-label': 'Pasos de la inscripción' }, nombres.map((n, i) => el('li', {
    class: i + 1 < actual ? 'hecho' : i + 1 === actual ? 'actual' : '', 'aria-current': i + 1 === actual ? 'step' : null,
  }, el('span', { class: 'num' }, i + 1 < actual ? '✓' : String(i + 1)), el('span', null, n))));
}

function vistaRegistro() {
  if (estado.yo) return irA('#/entrada');
  const e = ev();
  if (!e.inscripcionesAbiertas) {
    return el('div', { class: 'card', style: { maxWidth: '560px', margin: '0 auto' } },
      el('h1', null, 'Inscripciones cerradas'), el('p', { class: 'sub' }, 'Las inscripciones para este evento ya no están disponibles.'));
  }
  const contenedor = el('div', { class: 'registro' });
  const aviso = el('div', { class: 'aviso error oculto', role: 'alert' });
  const selector = e.talleresAbiertos && talleres().length ? selectorTalleres() : null;
  // Si cambian los cupos mientras completa el formulario, se actualiza la lista.
  if (selector) alCambiarCupos = selector.__redibujar;

  // ---------- paso 1: datos y talleres ----------
  const TIPOS = ETIQUETA_TIPO;
  const dominios = estado.datos.tiposParticipante || { estudiante: estado.datos.dominioCorreo };
  const tipoSel = el('div', { class: 'selector-tipo', role: 'radiogroup', 'aria-label': 'Tipo de participante', 'data-campo': 'tipo' },
    Object.entries(TIPOS).map(([valor, texto]) => el('label', null,
      el('input', { type: 'radio', name: 'tipo', value: valor, checked: valor === 'estudiante' }),
      el('span', null, texto))));
  const notaTalleres = el('p', { class: 'aviso info oculto' },
    'Los talleres están pensados para estudiantes. Podrás verlos más tarde en la sección Talleres.');
  const bloqueTalleres = selector && el('fieldset', null,
    el('legend', null, 'Elige tu taller (opcional)'),
    el('p', { class: 'sub', style: { fontSize: '.88rem' } }, 'Puedes elegirlo ahora o más tarde desde la sección Talleres.', e.maxTalleres ? ` Máximo ${talleresTxt(e.maxTalleres)}.` : ''),
    selector);

  const form = el('form', { class: 'card', novalidate: true },
    el('span', { class: 'eyebrow' }, 'Inscripción'),
    el('h1', null, 'Inscríbete al evento'),
    pasosInscripcion(1),
    aviso,
    el('div', { class: 'campo' }, el('span', { class: 'etiqueta' }, 'Soy'), tipoSel),
    el('div', { class: 'grid grid-2', style: { gap: '0 16px' } },
      campo('nombres', 'Nombres', { autocomplete: 'given-name', required: true, maxlength: 60 }),
      campo('apellidos', 'Apellidos', { autocomplete: 'family-name', required: true, maxlength: 60 })),
    el('div', { class: 'grid grid-2', style: { gap: '0 16px' } },
      campo('rut', 'RUT', { autocomplete: 'off', required: true, maxlength: 12, placeholder: '12.345.678-5', inputmode: 'text' }),
      campo('telefono', 'Teléfono', { type: 'tel', autocomplete: 'tel', required: true, placeholder: '9 1234 5678', maxlength: 16, inputmode: 'tel' })),
    campo('email', 'INACAPMAIL', { type: 'email', autocomplete: 'email', required: true, maxlength: 120, placeholder: `nombre.apellido@${dominios.estudiante}`, inputmode: 'email' }),
    campo('sede', 'Sede', { opciones: estado.datos.sedes, required: true }),
    bloqueTalleres,
    notaTalleres,
    el('button', { class: 'btn btn-primario btn-bloque', type: 'submit' }, 'Continuar →'),
    el('p', { class: 'sub', style: { marginTop: '14px', fontSize: '.88rem', textAlign: 'center' } },
      '¿Ya te inscribiste? ', el('a', { href: '#/acceso' }, 'Recupera tu entrada')));
  form.elements.rut.addEventListener('input', (x) => (x.target.value = formatearRutInput(x.target.value)));

  const tipoActual = () => form.elements.tipo.value || 'estudiante';
  // Docentes y administrativos usan @inacap.cl y no se les ofrecen talleres al inscribirse.
  function aplicarTipo() {
    const tipo = tipoActual();
    const email = form.querySelector('[data-campo="email"]');
    email.querySelector('label').textContent = tipo === 'estudiante' ? 'INACAPMAIL' : 'Correo INACAP';
    email.querySelector('input').placeholder = `nombre.apellido@${dominios[tipo]}`;
    bloqueTalleres?.classList.toggle('oculto', tipo !== 'estudiante');
    notaTalleres.classList.toggle('oculto', tipo === 'estudiante');
  }
  tipoSel.addEventListener('change', aplicarTipo);

  function leerDatos() {
    const f = form.elements;
    const tipo = tipoActual();
    return {
      tipo,
      nombres: f.nombres.value.trim(), apellidos: f.apellidos.value.trim(), rut: f.rut.value, email: f.email.value.trim(),
      telefono: f.telefono.value.trim(), sede: f.sede.value, talleres: selector && tipo === 'estudiante' ? selector.__seleccion() : [],
    };
  }

  // Valida el correo según el dominio que corresponde al tipo de participante.
  const correoDelTipo = (email, tipo) => correoValido(email) && email.trim().toLowerCase().endsWith('@' + dominios[tipo]);

  form.addEventListener('submit', (evt) => {
    evt.preventDefault();
    const d = leerDatos();
    const errores = {};
    if (d.nombres.length < 2) errores.nombres = 'Ingresa tus nombres.';
    if (d.apellidos.length < 2) errores.apellidos = 'Ingresa tus apellidos.';
    if (!rutValido(d.rut)) errores.rut = 'RUT inválido. Revisa el dígito verificador.';
    if (!correoDelTipo(d.email, d.tipo)) errores.email = `Usa tu correo institucional @${dominios[d.tipo]}.`;
    if (!telefonoValido(d.telefono)) errores.telefono = 'Teléfono inválido (ej: 9 1234 5678).';
    if (!d.sede) errores.sede = 'Selecciona tu sede.';
    mostrarErrores(form, errores);
    aviso.classList.add('oculto');
    if (Object.keys(errores).length) return;
    mostrarResumen(d);
  });

  // ---------- paso 2: resumen y confirmación ----------
  function mostrarResumen(d) {
    const elegidos = d.talleres.map(taller).filter(Boolean);
    const avisoResumen = el('div', { class: 'aviso error oculto', role: 'alert' });
    const consentimiento = el('input', { type: 'checkbox', name: 'consentimiento', id: 'f-consentimiento' });
    consentimiento.addEventListener('change', () => consentimiento.checked && mostrarErrores(tarjeta, {}));
    const fila = (etiqueta, valor) => el('div', { class: 'fila-resumen' }, el('dt', null, etiqueta), el('dd', null, valor));
    const confirmar = el('button', { class: 'btn btn-primario btn-bloque', type: 'button' }, 'Confirmar inscripción');
    const volver = () => {
      contenedor.replaceChildren(form);
      window.scrollTo(0, 0);
    };

    const tarjeta = el('section', { class: 'card resumen' },
      el('span', { class: 'eyebrow' }, 'Inscripción'),
      el('h1', null, 'Revisa tus datos'),
      pasosInscripcion(2),
      avisoResumen,
      el('dl', null,
        fila('Participante', TIPOS[d.tipo]),
        fila('Nombre', `${d.nombres} ${d.apellidos}`),
        fila('RUT', formatearRutInput(d.rut)),
        fila(d.tipo === 'estudiante' ? 'INACAPMAIL' : 'Correo', d.email.toLowerCase()),
        fila('Teléfono', d.telefono),
        fila('Sede', d.sede),
        d.tipo === 'estudiante' && fila(elegidos.length > 1 ? 'Talleres' : 'Taller', elegidos.length
          ? el('ul', null, elegidos.map((t) => el('li', null, el('strong', null, t.titulo), el('br'),
            el('span', { class: 'sub' }, `${hora(t.inicio)}–${hora(t.fin)} · ${t.sala}`))))
          : el('span', { class: 'sub' }, 'Lo elegirás después'))),
      el('p', { class: 'nota-resumen' }, 'Si cambias de teléfono, podrás recuperar tu entrada con tu ', el('strong', null, 'RUT, correo y sede'), '.'),
      el('label', { class: 'check', 'data-campo': 'consentimiento', for: 'f-consentimiento' },
        consentimiento,
        el('span', null, 'Autorizo el uso de mis datos sólo para gestionar mi participación en este evento, según la ',
          el('a', { href: '/privacidad', target: '_blank', rel: 'noopener' }, 'política de privacidad'), '.',
          el('span', { class: 'err', style: { display: 'block' } }))),
      el('div', { class: 'acciones-resumen' },
        el('button', { class: 'btn btn-contorno', type: 'button', onclick: volver }, '← Editar datos'),
        confirmar));

    confirmar.addEventListener('click', async () => {
      if (!consentimiento.checked) return mostrarErrores(tarjeta, { consentimiento: 'Debes aceptar para continuar.' });
      mostrarErrores(tarjeta, {});
      confirmar.disabled = true;
      confirmar.textContent = 'Inscribiendo…';
      try {
        const r = await api('POST', '/api/registro', { ...d, consentimiento: true });
        estado.yo = r.perfil;
        estado.bienvenida = { rechazados: r.rechazados };
        irA('#/bienvenida');
      } catch (e2) {
        if (e2.datos?.errores && Object.keys(e2.datos.errores).some((k) => k !== 'consentimiento')) {
          // Un dato no pasó la validación del servidor: se vuelve al formulario con el error marcado.
          volver();
          mostrarErrores(form, e2.datos.errores);
          aviso.textContent = e2.message;
          aviso.classList.remove('oculto');
          return;
        }
        avisoResumen.textContent = e2.codigo === 'YA_REGISTRADO' ? `${e2.message} Puedes recuperar tu entrada con tu RUT, correo y sede.` : e2.message;
        avisoResumen.classList.remove('oculto');
        confirmar.disabled = false;
        confirmar.textContent = 'Confirmar inscripción';
      }
    });
    contenedor.replaceChildren(tarjeta);
    window.scrollTo(0, 0);
  }

  contenedor.append(form);
  return contenedor;
}

function vistaBienvenida() {
  const n = estado.bienvenida;
  if (!n || !estado.yo) return irA('#/entrada');
  return el('div', { class: 'card bienvenida' },
    el('div', { class: 'sello', 'aria-hidden': 'true' }, '✓'),
    el('span', { class: 'eyebrow' }, '¡Inscripción lista!'),
    el('h1', null, `Te esperamos, ${estado.yo.nombres.split(' ')[0]}`),
    el('p', { class: 'sub' }, 'Tu entrada digital ya está disponible. Muéstrala en la acreditación el día del evento.'),
    n.rechazados?.length > 0 && el('div', { class: 'aviso error' },
      el('strong', null, 'No pudimos reservar algunos talleres:'),
      el('ul', { style: { margin: '6px 0 0 18px' } }, n.rechazados.map((r) => el('li', null, r.motivo))),
      'Puedes elegir otro desde la sección Talleres.'),
    el('div', { class: 'acciones' },
      el('button', { class: 'btn btn-primario', type: 'button', onclick: () => { estado.bienvenida = null; irA('#/entrada'); } }, 'Ver mi entrada')));
}

// Recuperar la entrada en otro dispositivo con RUT + INACAPMAIL + sede.
function vistaAcceso() {
  if (estado.yo) return irA('#/entrada');
  const aviso = el('div', { class: 'aviso error oculto', role: 'alert' });
  const form = el('form', { class: 'card', novalidate: true },
    el('span', { class: 'eyebrow' }, 'Ya estoy inscrito'),
    el('h1', null, 'Recupera tu entrada'),
    el('p', { class: 'sub', style: { marginBottom: '18px' } }, 'Ingresa los mismos datos que usaste al inscribirte.'),
    aviso,
    campo('rut', 'RUT', { autocomplete: 'off', required: true, maxlength: 12, placeholder: '12.345.678-5' }),
    campo('email', 'Correo institucional', { type: 'email', autocomplete: 'email', required: true, inputmode: 'email', placeholder: '@inacapmail.cl o @inacap.cl' }),
    campo('sede', 'Sede', { opciones: estado.datos.sedes, required: true }),
    el('button', { class: 'btn btn-primario btn-bloque', type: 'submit' }, 'Recuperar mi entrada'),
    el('p', { class: 'sub', style: { marginTop: '14px', fontSize: '.86rem', textAlign: 'center' } },
      '¿No te acuerdas de tus datos? Acércate al módulo de acreditación.'));
  form.elements.rut.addEventListener('input', (x) => (x.target.value = formatearRutInput(x.target.value)));
  form.addEventListener('submit', async (evt) => {
    evt.preventDefault();
    const f = form.elements;
    const errores = {};
    if (!rutValido(f.rut.value)) errores.rut = 'RUT inválido. Revisa el dígito verificador.';
    if (!correoValido(f.email.value)) errores.email = 'Ingresa tu correo institucional.';
    if (!f.sede.value) errores.sede = 'Selecciona tu sede.';
    mostrarErrores(form, errores);
    aviso.classList.add('oculto');
    if (Object.keys(errores).length) return;
    const boton = form.querySelector('button[type=submit]');
    boton.disabled = true;
    try {
      estado.yo = await api('POST', '/api/recuperar', { rut: f.rut.value, email: f.email.value.trim(), sede: f.sede.value });
      toast('¡Listo! Recuperaste tu entrada.');
      irA('#/entrada');
    } catch (e) {
      aviso.textContent = e.message;
      aviso.classList.remove('oculto');
      boton.disabled = false;
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
        el('p', { class: 'sub' }, 'Recupera tu entrada con tu RUT, correo institucional y sede.'),
        el('div', { class: 'acciones' }, el('a', { class: 'btn btn-contorno', href: '#/acceso' }, 'Recuperar entrada'))));
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
        el('span', { class: 'sub' }, (yo.tipo && yo.tipo !== 'estudiante' ? `${ETIQUETA_TIPO[yo.tipo]} · ` : '') + yo.sede),
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
        : el('p', { class: 'sub', style: { marginTop: '8px' } }, esEstudiante() ? 'Todavía no eliges talleres.' : 'Los talleres están pensados para estudiantes; puedes revisarlos cuando quieras.'),
      el('div', { class: 'acciones' },
        el('a', { class: 'btn btn-primario btn-chico', href: '#/talleres' }, mios.length ? 'Cambiar talleres' : 'Elegir talleres'),
        el('a', { class: 'btn btn-contorno btn-chico', href: '#/agenda' }, 'Ver mi agenda'))),

    el('section', { class: 'card', style: { marginTop: '16px' } },
      el('h2', null, 'Mis datos'),
      el('p', { class: 'sub', style: { fontSize: '.9rem' } }, [yo.rut, yo.email, yo.telefono].filter(Boolean).join(' · ')),
      el('p', { class: 'sub', style: { fontSize: '.82rem', marginTop: '6px' } }, 'Para corregir o eliminar tus datos, escribe a la organización del evento.'),
      el('div', { class: 'acciones' },
        el('button', {
          class: 'btn btn-contorno btn-chico', type: 'button',
          onclick: async () => {
            if (!confirm('¿Cerrar sesión en este dispositivo? Podrás recuperar tu entrada con tu RUT, correo y sede.')) return;
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

// Anillo de cupos (SVG): cuánto queda del taller de un vistazo.
function anilloCupo(c, tam = 76) {
  const NS = 'http://www.w3.org/2000/svg';
  const nodo = (tag, attrs) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  const cupos = c.cupos || 0;
  const quedan = Math.max(cupos - (c.inscritos || 0), 0);
  const fraccion = cupos ? quedan / cupos : 0;
  const r = 15.5;
  const largo = 2 * Math.PI * r;
  const clase = quedan === 0 ? 'lleno' : fraccion <= 0.25 ? 'medio' : '';
  const svg = nodo('svg', { viewBox: '0 0 36 36', width: tam, height: tam, 'aria-hidden': 'true' });
  svg.append(
    nodo('circle', { cx: 18, cy: 18, r, class: 'pista' }),
    nodo('circle', { cx: 18, cy: 18, r, class: 'valor', 'stroke-dasharray': `${(fraccion * largo).toFixed(2)} ${largo.toFixed(2)}`, transform: 'rotate(-90 18 18)' }));
  return el('div', { class: `anillo ${clase}`, role: 'img', 'aria-label': quedan === 0 ? 'Sin cupos' : `Quedan ${quedan} de ${cupos} cupos` },
    svg, el('div', { class: 'cifra' }, el('strong', null, quedan), el('span', null, quedan === 1 ? 'cupo' : 'cupos')));
}

const minutos = (t) => Math.round((Date.parse(t.fin + ':00Z') - Date.parse(t.inicio + ':00Z')) / 60000);

// "André Goujon Maucher, CEO y cofundador de Lockbits" → nombre y cargo.
function partirDocente(texto) {
  const i = String(texto || '').indexOf(',');
  return i > 0 ? [texto.slice(0, i).trim(), texto.slice(i + 1).trim()] : [texto || '', ''];
}

function tarjetaTaller(t) {
  const mio = esMio(t);
  const c = cupoDe(t);
  let boton;
  if (!estado.yo) {
    boton = el('a', { class: 'btn btn-secundario btn-bloque', href: '#/registro' }, 'Inscríbete para elegir este taller');
  } else if (!ev().talleresAbiertos) {
    boton = el('button', { class: 'btn btn-contorno btn-bloque', type: 'button', disabled: true }, mio ? '✓ Inscrito · elección cerrada' : 'Elección de talleres cerrada');
  } else if (mio) {
    boton = el('button', { class: 'btn btn-contorno btn-bloque', type: 'button' }, 'Cancelar inscripción');
  } else {
    const motivo = motivoBloqueo(t, misTalleres());
    boton = el('button', { class: 'btn btn-primario btn-bloque', type: 'button', disabled: Boolean(motivo) }, motivo || 'Quiero este taller');
  }
  if (boton.tagName === 'BUTTON' && !boton.disabled) boton.addEventListener('click', () => cambiarInscripcion(t, boton));

  const [nombreDocente, cargo] = partirDocente(t.docente);
  const iniciales = (nombreDocente || '?').split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();

  return el('article', { class: `taller-xl ${mio ? 'mio' : ''}` },
    el('header', { class: 'portada' },
      el('div', null,
        el('div', { class: 'etiquetas' },
          el('span', { class: 'sala' }, t.sala || 'Sala por confirmar'),
          t.nivel && el('span', { class: `nivel nivel-${t.nivel.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()}` }, t.nivel)),
        el('div', { class: 'horario' }, `${hora(t.inicio)} – ${hora(t.fin)}`),
        el('div', { class: 'duracion' }, `${nombreDia(fechaDe(t.inicio), { weekday: 'long', day: 'numeric', month: 'long' })} · ${minutos(t)} min`),
        mio && el('span', { class: 'chip ok', style: { marginTop: '10px' } }, '✓ Estás inscrito')),
      vivo(() => anilloCupo(cupoDe(t)))),
    el('div', { class: 'cuerpo' },
      el('h3', null, t.titulo),
      el('div', { class: 'relator' },
        t.foto
          ? el('img', { src: t.foto, alt: `Foto de ${nombreDocente || 'docente'}`, loading: 'lazy', width: 72, height: 72 })
          : el('span', { class: 'sin-foto', 'aria-hidden': 'true' }, iniciales),
        el('div', null,
          el('small', null, 'Relator'),
          el('strong', null, nombreDocente || 'Por confirmar'),
          cargo && el('span', null, cargo))),
      t.descripcion && el('div', { class: 'descripcion' }, t.descripcion.split(/\n{2,}/).map((parrafo) => el('p', null, parrafo))),
      el('div', { class: 'pie-t' }, widgetCupo(c, { flash: estado.cambiados.has(t.id) }), boton)));
}

// Mosaico de talleres para la portada: un cuadrado por taller.
function mosaicoTalleres() {
  return el('div', { class: 'mosaico' }, talleres().map((t) => el('a', { class: `cuadro ${esMio(t) ? 'mio' : ''}`, href: '#/talleres' },
    el('span', { class: 'sala' }, t.sala || 'Taller', t.nivel && ` · ${t.nivel}`),
    el('strong', null, t.titulo),
    el('span', { class: 'quien' }, partirDocente(t.docente)[0] || 'Relator por confirmar'),
    el('div', { class: 'base' },
      el('span', null, `${hora(t.inicio)}–${hora(t.fin)}`),
      vivo(() => anilloCupo(cupoDe(t), 52))))));
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
    !esEstudiante() && el('div', { class: 'aviso info' }, 'Los talleres están dirigidos a estudiantes. Si te interesa asistir y quedan cupos, igual puedes inscribirte.'),
    !talleres().length && el('p', { class: 'vacio' }, 'Aún no hay talleres publicados.'),
    [...porDia].map(([fecha, lista]) => el('section', { style: { marginBottom: '24px' } },
      el('h2', null, nombreDia(fecha)),
      el('div', { class: 'talleres-xl' }, lista.map((t) => vivo(() => tarjetaTaller(t)))))),
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
