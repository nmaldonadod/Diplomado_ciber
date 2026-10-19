'use strict';

/* Interfaz del administrador: evento, talleres (con foto del docente), agenda, estudiantes, usuarios y auditoría. */

const vista = document.getElementById('vista');
const adm = { usuario: null, sedes: [], pestana: 'resumen', timer: null };

const PESTANAS = [
  ['resumen', 'Resumen'], ['evento', 'Evento'], ['talleres', 'Talleres'], ['agenda', 'Agenda'],
  ['estudiantes', 'Estudiantes'], ['usuarios', 'Usuarios'], ['auditoria', 'Auditoría'], ['cuenta', 'Mi cuenta'],
];

const nombreDe = (e) => `${e.nombres} ${e.apellidos}`;
const rango = (i) => `${nombreDia(fechaDe(i.inicio), { weekday: 'short', day: 'numeric', month: 'short' })} · ${hora(i.inicio)}–${hora(i.fin)}`;

// Manejo uniforme de errores: sesión expirada → volver al login.
async function llamar(metodo, url, cuerpo) {
  try {
    return await api(metodo, url, cuerpo);
  } catch (e) {
    if (e.status === 401 && e.codigo === 'SIN_SESION_STAFF') {
      toast('Tu sesión expiró. Ingresa nuevamente.', 'error');
      iniciar();
    }
    throw e;
  }
}

function modal(titulo, contenido) {
  const fondo = el('div', { class: 'modal-fondo', role: 'dialog', 'aria-modal': 'true', 'aria-label': titulo });
  const cerrar = () => { fondo.remove(); document.removeEventListener('keydown', esc); };
  const esc = (e) => e.key === 'Escape' && cerrar();
  document.addEventListener('keydown', esc);
  fondo.addEventListener('click', (e) => e.target === fondo && cerrar());
  fondo.append(el('div', { class: 'modal' },
    el('button', { class: 'cerrar', type: 'button', 'aria-label': 'Cerrar', onclick: cerrar }, '×'),
    el('h2', null, titulo), contenido));
  document.body.append(fondo);
  setTimeout(() => fondo.querySelector('input, select, textarea, button:not(.cerrar)')?.focus());
  return cerrar;
}

// Envía un formulario mostrando errores de validación del servidor en cada campo.
function alEnviar(form, fn) {
  const aviso = el('div', { class: 'aviso error oculto', role: 'alert' });
  form.prepend(aviso);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    aviso.classList.add('oculto');
    const boton = form.querySelector('button[type=submit]');
    if (boton) boton.disabled = true;
    try {
      await fn(form.elements);
      mostrarErrores(form, {});
    } catch (e) {
      mostrarErrores(form, e.datos?.errores);
      aviso.textContent = e.message;
      aviso.classList.remove('oculto');
    } finally {
      if (boton) boton.disabled = false;
    }
  });
  return form;
}

// =====================================================================
// Resumen
// =====================================================================

async function vistaResumen() {
  const s = await llamar('GET', '/api/admin/resumen');
  const pct = s.registrados ? Math.round((s.acreditados / s.registrados) * 100) : 0;
  return [
    !s.evento && el('div', { class: 'aviso info' }, 'Aún no configuras el evento. ',
      el('a', { href: '#', onclick: (e) => { e.preventDefault(); cambiarPestana('evento'); } }, 'Configúralo aquí'), ' para publicarlo a los estudiantes.'),
    el('div', { class: 'kpis' },
      el('div', { class: 'kpi' }, el('div', { class: 'n' }, s.registrados), el('div', { class: 'l' }, 'Inscritos')),
      el('div', { class: 'kpi' }, el('div', { class: 'n' }, s.acreditados), el('div', { class: 'l' }, 'Acreditados')),
      el('div', { class: 'kpi' }, el('div', { class: 'n' }, pct + '%'), el('div', { class: 'l' }, 'Asistencia')),
      el('div', { class: 'kpi' }, el('div', { class: 'n' }, s.talleres.length), el('div', { class: 'l' }, 'Talleres'))),
    el('section', { class: 'card', style: { marginBottom: '16px' } },
      el('h2', null, 'Cupos por taller'),
      s.talleres.length
        ? s.talleres.map((t) => el('div', { style: { marginBottom: '12px' } },
          el('strong', { style: { fontSize: '.92rem' } }, t.titulo, !t.publicado && el('span', { class: 'chip', style: { marginLeft: '6px' } }, 'Borrador')),
          el('div', { class: 'sub', style: { fontSize: '.8rem' } }, rango(t), t.sala ? ` · ${t.sala}` : ''),
          widgetCupo({ cupos: t.cupos, inscritos: t.inscritos })))
        : el('p', { class: 'sub' }, 'No hay talleres.')),
    el('div', { class: 'grid grid-2' },
      el('section', { class: 'card' }, el('h2', null, 'Últimas acreditaciones'),
        s.ultimas.length
          ? s.ultimas.map((u) => el('div', { class: 'fila' },
            el('div', { class: 'q' }, el('strong', null, nombreDe(u)), el('span', null, `${u.sede}${u.acreditador ? ' · por ' + u.acreditador : ''}`)),
            el('span', { class: 'chip ok' }, horaReal(u.acreditado_en))))
          : el('p', { class: 'sub' }, 'Aún no hay acreditaciones.')),
      el('section', { class: 'card' }, el('h2', null, 'Por sede'),
        el('table', { class: 'tabla' },
          el('thead', null, el('tr', null, el('th', null, 'Sede'), el('th', null, 'Inscritos'), el('th', null, 'Acreditados'))),
          el('tbody', null, s.porSede.map((r) => el('tr', null, el('td', null, r.sede), el('td', null, r.registrados), el('td', null, r.acreditados))))),
        el('h2', { style: { marginTop: '18px' } }, 'Exportar (CSV)'),
        el('p', { class: 'sub', style: { fontSize: '.82rem' } }, 'Contiene datos personales: guárdalo en un lugar seguro y elimínalo cuando ya no lo necesites. Cada descarga queda registrada.'),
        el('div', { class: 'acciones' },
          el('a', { class: 'btn btn-contorno btn-chico', href: '/api/admin/exportar/estudiantes.csv' }, 'Estudiantes'),
          el('a', { class: 'btn btn-contorno btn-chico', href: '/api/admin/exportar/talleres.csv' }, 'Listas por taller')))),
  ];
}

// =====================================================================
// Evento
// =====================================================================

async function vistaEvento() {
  const { evento: e } = await llamar('GET', '/api/admin/resumen');
  const ev = e || { nombre: '', lema: '', descripcion: '', lugar: '', direccion: '', contacto: '', fecha_inicio: '', fecha_fin: '', max_talleres: 2, inscripciones_abiertas: 1, talleres_abiertos: 1 };
  const form = el('form', { class: 'card', novalidate: true },
    campo('nombre', 'Nombre del evento', { value: ev.nombre, maxlength: 120, ayuda: 'Ej: Mes de la Ciberseguridad. En la portada se destaca la última palabra.' }),
    campo('lema', 'Lema (opcional)', { value: ev.lema || '', maxlength: 60, placeholder: 'Ej: Modo Seguro' }),
    campo('descripcion', 'Descripción', { multilinea: true, maxlength: 2000 }),
    el('div', { class: 'grid grid-2', style: { gap: '0 16px' } },
      campo('fecha_inicio', 'Fecha de inicio', { type: 'date', value: ev.fecha_inicio }),
      campo('fecha_fin', 'Fecha de término', { type: 'date', value: ev.fecha_fin }),
      campo('lugar', 'Lugar', { value: ev.lugar, maxlength: 120, placeholder: 'Ej: INACAP Sede Santiago Centro' }),
      campo('direccion', 'Dirección', { value: ev.direccion, maxlength: 160 }),
      campo('contacto', 'Correo de contacto (privacidad y consultas)', { type: 'email', value: ev.contacto, maxlength: 120 }),
      campo('max_talleres', 'Máximo de talleres por estudiante', { type: 'number', min: 0, max: 20, value: ev.max_talleres, ayuda: '0 = sin límite' })),
    el('label', { class: 'interruptor' }, el('input', { type: 'checkbox', name: 'inscripciones_abiertas', checked: Boolean(ev.inscripciones_abiertas) }), 'Inscripciones al evento abiertas'),
    el('label', { class: 'interruptor' }, el('input', { type: 'checkbox', name: 'talleres_abiertos', checked: Boolean(ev.talleres_abiertos) }), 'Estudiantes pueden elegir/cambiar talleres'),
    el('button', { class: 'btn btn-primario', type: 'submit' }, e ? 'Guardar cambios' : 'Publicar evento'));
  form.elements.descripcion.value = ev.descripcion;
  alEnviar(form, async (f) => {
    await llamar('PUT', '/api/admin/evento', {
      nombre: f.nombre.value, lema: f.lema.value, descripcion: f.descripcion.value, fecha_inicio: f.fecha_inicio.value, fecha_fin: f.fecha_fin.value,
      lugar: f.lugar.value, direccion: f.direccion.value, contacto: f.contacto.value, max_talleres: Number(f.max_talleres.value),
      inscripciones_abiertas: f.inscripciones_abiertas.checked, talleres_abiertos: f.talleres_abiertos.checked,
    });
    toast('Evento guardado');
  });
  return [el('div', { class: 'barra-acciones' }, el('h1', null, 'Datos del evento')), form];
}

// =====================================================================
// Talleres
// =====================================================================

// Redimensiona y convierte la foto a JPEG en el navegador (también elimina metadatos como GPS).
async function prepararFoto(archivo) {
  if (!/^image\/(jpeg|png|webp)$/.test(archivo.type)) throw new Error('Usa una imagen JPG, PNG o WebP.');
  if (archivo.size > 15 * 1024 * 1024) throw new Error('La imagen es demasiado grande (máx. 15 MB).');
  const bmp = await createImageBitmap(archivo);
  const lado = Math.min(bmp.width, bmp.height);
  const tam = Math.min(480, lado);
  const c = document.createElement('canvas');
  c.width = tam;
  c.height = tam;
  // Recorte cuadrado centrado.
  c.getContext('2d').drawImage(bmp, (bmp.width - lado) / 2, (bmp.height - lado) / 2, lado, lado, 0, 0, tam, tam);
  bmp.close?.();
  return new Promise((ok, falla) => c.toBlob((b) => (b ? ok(b) : falla(new Error('No se pudo procesar la imagen.'))), 'image/jpeg', 0.86));
}

async function subirFoto(tallerId, blob) {
  const res = await fetch(`/api/admin/talleres/${tallerId}/foto`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
  const datos = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(datos.mensaje || 'No se pudo subir la foto.'), { status: res.status });
  return datos;
}

function formularioTaller(t, alGuardar) {
  const nuevo = !t;
  t = t || { titulo: '', descripcion: '', docente: '', sala: '', inicio: '', fin: '', cupos: 30, publicado: true, foto: null };
  let fotoPendiente = null;
  const vistaFoto = el('div', { class: 'foto-taller' });
  function pintarFoto(src) {
    vistaFoto.replaceChildren(
      src ? el('img', { src, alt: 'Foto del docente' }) : el('span', { class: 'vacia' }, 'Sin foto'),
      el('div', null,
        el('label', { class: 'btn btn-contorno btn-chico', for: 'f-foto' }, src ? 'Cambiar foto' : 'Subir foto del docente'),
        el('input', { id: 'f-foto', type: 'file', accept: 'image/jpeg,image/png,image/webp', class: 'sr', onchange: elegirFoto }),
        src && !nuevo && t.foto && el('button', {
          class: 'btn btn-contorno btn-chico', type: 'button', style: { marginLeft: '6px' },
          onclick: async () => {
            if (!confirm('¿Quitar la foto del docente?')) return;
            t = await llamar('DELETE', `/api/admin/talleres/${t.id}/foto`);
            pintarFoto(null);
            alGuardar(t, false);
          },
        }, 'Quitar'),
        el('div', { class: 'sub', style: { fontSize: '.78rem', marginTop: '4px' } }, 'Se recorta cuadrada y se reduce automáticamente.')));
  }
  async function elegirFoto(ev) {
    const archivo = ev.target.files[0];
    if (!archivo) return;
    try {
      fotoPendiente = await prepararFoto(archivo);
      pintarFoto(URL.createObjectURL(fotoPendiente));
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  pintarFoto(t.foto);

  const form = el('form', { novalidate: true },
    vistaFoto,
    campo('titulo', 'Título', { value: t.titulo, maxlength: 120 }),
    campo('docente', 'Docente / relator', { value: t.docente, maxlength: 100 }),
    campo('descripcion', 'Descripción', { multilinea: true, maxlength: 1500 }),
    el('div', { class: 'grid grid-2', style: { gap: '0 16px' } },
      campo('inicio', 'Inicio', { type: 'datetime-local', value: t.inicio }),
      campo('fin', 'Término', { type: 'datetime-local', value: t.fin }),
      campo('sala', 'Sala', { value: t.sala, maxlength: 80 }),
      campo('cupos', 'Cupos', { type: 'number', min: 1, max: 5000, value: t.cupos, ayuda: t.inscritos ? `Inscritos actualmente: ${t.inscritos}` : null })),
    el('label', { class: 'interruptor' }, el('input', { type: 'checkbox', name: 'publicado', checked: t.publicado }), 'Publicado (visible para estudiantes)'),
    el('button', { class: 'btn btn-primario', type: 'submit' }, nuevo ? 'Crear taller' : 'Guardar cambios'));
  form.elements.descripcion.value = t.descripcion;

  alEnviar(form, async (f) => {
    const datos = {
      titulo: f.titulo.value, docente: f.docente.value, descripcion: f.descripcion.value, inicio: f.inicio.value,
      fin: f.fin.value, sala: f.sala.value, cupos: Number(f.cupos.value), publicado: f.publicado.checked,
    };
    let guardado = await llamar(nuevo ? 'POST' : 'PUT', nuevo ? '/api/admin/talleres' : `/api/admin/talleres/${t.id}`, datos);
    if (fotoPendiente) {
      try {
        guardado = await subirFoto(guardado.id, fotoPendiente);
      } catch (e) {
        toast(`Taller guardado, pero la foto falló: ${e.message}`, 'error');
      }
    }
    alGuardar(guardado, true);
  });
  return form;
}

async function verInscritosTaller(t) {
  const lista = await llamar('GET', `/api/admin/talleres/${t.id}/inscritos`);
  modal(`Inscritos · ${t.titulo}`, el('div', null,
    el('p', { class: 'sub' }, `${lista.length} de ${t.cupos} cupos`),
    lista.length
      ? el('div', { class: 'tabla-scroll' }, el('table', { class: 'tabla' },
        el('thead', null, el('tr', null, el('th', null, 'Nombre'), el('th', null, 'Sede'), el('th', null, 'INACAPMAIL'), el('th', null, 'Acreditado'))),
        el('tbody', null, lista.map((e) => el('tr', null, el('td', null, nombreDe(e)), el('td', null, e.sede), el('td', null, e.email),
          el('td', null, e.acreditadoEn ? '✓ ' + horaReal(e.acreditadoEn) : '—'))))))
      : el('p', { class: 'sub' }, 'Aún no hay inscritos.')));
}

async function vistaTalleres() {
  const lista = await llamar('GET', '/api/admin/talleres');
  const editar = (t) => {
    const cerrar = modal(t ? 'Editar taller' : 'Nuevo taller', formularioTaller(t, (_, terminar) => {
      if (terminar) {
        cerrar();
        toast('Taller guardado');
      }
      cambiarPestana('talleres');
    }));
  };
  return [
    el('div', { class: 'barra-acciones' },
      el('h1', null, 'Talleres'),
      el('button', { class: 'btn btn-primario btn-chico', type: 'button', onclick: () => editar(null) }, '+ Nuevo taller')),
    el('section', { class: 'card lista-admin' },
      lista.length
        ? lista.map((t) => el('div', { class: 'fila' },
          el('div', { style: { display: 'flex', gap: '12px', alignItems: 'center', flex: 1, minWidth: 0 } },
            t.foto ? el('img', { class: 'miniatura', src: t.foto, alt: '' }) : el('span', { class: 'miniatura' }),
            el('div', { class: 'q', style: { minWidth: 0 } },
              el('strong', null, t.titulo, !t.publicado && el('span', { class: 'chip', style: { marginLeft: '6px' } }, 'Borrador')),
              el('span', null, `${rango(t)}${t.sala ? ' · ' + t.sala : ''}${t.docente ? ' · ' + t.docente : ''}`),
              widgetCupo({ cupos: t.cupos, inscritos: t.inscritos }))),
          el('div', { class: 'btns' },
            el('button', { class: 'btn btn-contorno btn-chico', type: 'button', onclick: () => verInscritosTaller(t) }, 'Inscritos'),
            el('button', { class: 'btn btn-secundario btn-chico', type: 'button', onclick: () => editar(t) }, 'Editar'),
            el('button', {
              class: 'btn btn-contorno btn-chico', type: 'button',
              onclick: async () => {
                const aviso = t.inscritos ? ` Se anularán ${t.inscritos} inscripciones.` : '';
                if (!confirm(`¿Eliminar el taller «${t.titulo}»?${aviso}`)) return;
                await llamar('DELETE', `/api/admin/talleres/${t.id}`).then(() => toast('Taller eliminado'), (e) => toast(e.message, 'error'));
                cambiarPestana('talleres');
              },
            }, 'Eliminar'))))
        : el('p', { class: 'sub' }, 'Aún no hay talleres. Crea el primero.')),
  ];
}

// =====================================================================
// Agenda
// =====================================================================

const TIPOS = { charla: 'Charla', actividad: 'Actividad', pausa: 'Pausa', acreditacion: 'Acreditación' };

function formularioAgenda(a, alGuardar) {
  const nuevo = !a;
  a = a || { tipo: 'charla', titulo: '', descripcion: '', expositor: '', lugar: '', inicio: '', fin: '' };
  const tipo = el('select', { id: 'f-tipo', name: 'tipo' }, Object.entries(TIPOS).map(([k, txt]) => el('option', { value: k }, txt)));
  tipo.value = a.tipo;
  const form = el('form', { novalidate: true },
    el('div', { class: 'campo', 'data-campo': 'tipo' }, el('label', { for: 'f-tipo' }, 'Tipo'), tipo, el('span', { class: 'err' })),
    campo('titulo', 'Título', { value: a.titulo, maxlength: 120 }),
    campo('expositor', 'Expositor (opcional)', { value: a.expositor, maxlength: 100 }),
    campo('descripcion', 'Descripción (opcional)', { multilinea: true, maxlength: 800 }),
    el('div', { class: 'grid grid-2', style: { gap: '0 16px' } },
      campo('inicio', 'Inicio', { type: 'datetime-local', value: a.inicio }),
      campo('fin', 'Término', { type: 'datetime-local', value: a.fin })),
    campo('lugar', 'Lugar', { value: a.lugar, maxlength: 80 }),
    el('button', { class: 'btn btn-primario', type: 'submit' }, nuevo ? 'Agregar a la agenda' : 'Guardar'));
  form.elements.descripcion.value = a.descripcion;
  alEnviar(form, async (f) => {
    await llamar(nuevo ? 'POST' : 'PUT', nuevo ? '/api/admin/agenda' : `/api/admin/agenda/${a.id}`, {
      tipo: f.tipo.value, titulo: f.titulo.value, expositor: f.expositor.value, descripcion: f.descripcion.value,
      inicio: f.inicio.value, fin: f.fin.value, lugar: f.lugar.value,
    });
    alGuardar();
  });
  return form;
}

async function vistaAgenda() {
  const lista = await llamar('GET', '/api/admin/agenda');
  const editar = (a) => {
    const cerrar = modal(a ? 'Editar actividad' : 'Nueva actividad', formularioAgenda(a, () => {
      cerrar();
      toast('Agenda actualizada');
      cambiarPestana('agenda');
    }));
  };
  return [
    el('div', { class: 'barra-acciones' },
      el('h1', null, 'Agenda'),
      el('button', { class: 'btn btn-primario btn-chico', type: 'button', onclick: () => editar(null) }, '+ Nueva actividad')),
    el('p', { class: 'sub', style: { marginBottom: '12px' } }, 'Charlas, pausas y actividades generales. Los talleres aparecen automáticamente en la agenda de los estudiantes.'),
    el('section', { class: 'card lista-admin' },
      lista.length
        ? lista.map((a) => el('div', { class: 'fila' },
          el('div', { class: 'q' }, el('strong', null, a.titulo), el('span', null, `${TIPOS[a.tipo] || a.tipo} · ${rango(a)}${a.lugar ? ' · ' + a.lugar : ''}`)),
          el('div', { class: 'btns' },
            el('button', { class: 'btn btn-secundario btn-chico', type: 'button', onclick: () => editar(a) }, 'Editar'),
            el('button', {
              class: 'btn btn-contorno btn-chico', type: 'button',
              onclick: async () => {
                if (!confirm(`¿Eliminar «${a.titulo}» de la agenda?`)) return;
                await llamar('DELETE', `/api/admin/agenda/${a.id}`).catch((e) => toast(e.message, 'error'));
                cambiarPestana('agenda');
              },
            }, 'Eliminar'))))
        : el('p', { class: 'sub' }, 'La agenda está vacía.')),
  ];
}

// =====================================================================
// Estudiantes
// =====================================================================

async function detalleEstudiante(id, alCambiar) {
  const [e, talleres] = await Promise.all([llamar('GET', `/api/admin/estudiantes/${id}`), llamar('GET', '/api/admin/talleres')]);
  let cerrar;
  const recargar = async () => { cerrar(); alCambiar(); await detalleEstudiante(id, alCambiar); };
  const accion = (fn) => async () => {
    try {
      await fn();
    } catch (x) {
      toast(x.message, 'error');
    }
  };
  const disponibles = talleres.filter((t) => !e.talleres.some((m) => m.id === t.id));
  const selector = el('select', { 'aria-label': 'Agregar taller' }, el('option', { value: '' }, 'Agregar a taller…'),
    disponibles.map((t) => el('option', { value: t.id }, `${t.titulo} (${t.inscritos}/${t.cupos})`)));

  // el() descarta los valores false de los elementos condicionales.
  const cont = el('div', null,
    el('p', null, el('strong', null, e.email), el('br'), el('span', { class: 'sub' }, `${e.telefono} · ${e.sede}`)),
    el('p', { class: 'sub', style: { fontSize: '.84rem' } },
      `Inscrito: ${new Date(e.creadoEn).toLocaleString('es-CL')} (${e.origen}) · Consentimiento: ${e.consentimientoEn ? new Date(e.consentimientoEn).toLocaleString('es-CL') : '—'}`),
    el('p', null, e.acreditadoEn ? el('span', { class: 'chip ok' }, `✓ Acreditado ${new Date(e.acreditadoEn).toLocaleString('es-CL')}`) : el('span', { class: 'chip alerta' }, 'No acreditado')),
    el('h3', { style: { marginTop: '14px' } }, 'Talleres'),
    e.talleres.length
      ? el('div', null, e.talleres.map((t) => el('div', { class: 'fila' }, el('div', { class: 'q' }, el('strong', null, t.titulo), el('span', null, rango(t))),
        el('button', {
          class: 'btn btn-contorno btn-chico', type: 'button',
          onclick: accion(async () => { await llamar('DELETE', `/api/admin/estudiantes/${id}/talleres/${t.id}`); recargar(); }),
        }, 'Quitar'))))
      : el('p', { class: 'sub' }, 'Sin talleres.'),
    disponibles.length > 0 && el('div', { class: 'manual' }, selector, el('button', {
      class: 'btn btn-secundario', type: 'button',
      onclick: accion(async () => {
        if (!selector.value) return;
        await llamar('POST', `/api/admin/estudiantes/${id}/talleres/${selector.value}`);
        recargar();
      }),
    }, 'Agregar')),
    el('p', { class: 'sub', style: { fontSize: '.78rem', marginTop: '4px' } }, 'Como administrador puedes inscribir aunque la elección esté cerrada (se respetan cupos y topes).'),
    el('div', { class: 'acciones', style: { marginTop: '18px' } },
      e.acreditadoEn
        ? el('button', { class: 'btn btn-contorno btn-chico', type: 'button', onclick: accion(async () => { await llamar('DELETE', `/api/acreditacion/${id}`); recargar(); }) }, 'Deshacer acreditación')
        : el('button', { class: 'btn btn-exito btn-chico', type: 'button', onclick: accion(async () => { await llamar('POST', '/api/acreditacion/acreditar', { id }); recargar(); }) }, 'Acreditar'),
      el('button', {
        class: 'btn btn-contorno btn-chico', type: 'button',
        onclick: accion(async () => {
          if (!confirm('¿Generar un nuevo código de acceso? El anterior dejará de funcionar y se cerrarán sus sesiones.')) return;
          const r = await llamar('POST', `/api/admin/estudiantes/${id}/codigo-acceso`);
          modal('Nuevo código de acceso', el('div', null,
            el('p', null, `Entrégalo personalmente a ${nombreDe(e)} (verifica su identidad). No se volverá a mostrar.`),
            el('div', { class: 'codigo-acceso' }, r.codigoAcceso)));
        }),
      }, 'Nuevo código de acceso'),
      el('button', {
        class: 'btn btn-contorno btn-chico', type: 'button', style: { color: 'var(--peligro)' },
        onclick: accion(async () => {
          if (!confirm(`¿Eliminar definitivamente a ${nombreDe(e)} y todos sus datos? Esta acción no se puede deshacer.`)) return;
          await llamar('DELETE', `/api/admin/estudiantes/${id}`);
          cerrar();
          toast('Estudiante eliminado');
          alCambiar();
        }),
      }, 'Eliminar datos')));
  cerrar = modal(nombreDe(e), cont);
}

async function vistaEstudiantes() {
  const q = el('input', { type: 'search', placeholder: 'Nombre, apellido o INACAPMAIL completo', 'aria-label': 'Buscar', maxlength: 80 });
  const sede = el('select', { 'aria-label': 'Sede' }, el('option', { value: '' }, 'Todas las sedes'), adm.sedes.map((s) => el('option', { value: s }, s)));
  const estado = el('select', { 'aria-label': 'Estado' },
    el('option', { value: '' }, 'Todos'), el('option', { value: 'acreditados' }, 'Acreditados'), el('option', { value: 'pendientes' }, 'No acreditados'));
  const lista = el('section', { class: 'card lista-admin' }, el('p', { class: 'sub' }, 'Cargando…'));
  let desde = 0;

  async function cargar() {
    const params = new URLSearchParams({ q: q.value.trim(), sede: sede.value, estado: estado.value, desde: String(desde) });
    try {
      const r = await llamar('GET', '/api/admin/estudiantes?' + params);
      lista.replaceChildren(
        el('p', { class: 'sub', style: { marginBottom: '6px' } }, `${r.total} estudiante(s)`),
        ...r.filas.map((e) => el('div', { class: 'fila' },
          el('div', { class: 'q' }, el('strong', null, nombreDe(e)), el('span', null, `${e.sede} · ${e.email}`),
            el('span', { style: { display: 'block' } }, e.talleres.length ? e.talleres.map((t) => t.titulo).join(', ') : 'Sin talleres')),
          el('div', { class: 'btns' },
            e.acreditadoEn ? el('span', { class: 'chip ok' }, '✓ Acreditado') : el('span', { class: 'chip' }, 'Pendiente'),
            el('button', { class: 'btn btn-secundario btn-chico', type: 'button', onclick: () => detalleEstudiante(e.id, cargar) }, 'Ver')))),
        el('div', { class: 'acciones' },
          desde > 0 && el('button', { class: 'btn btn-contorno btn-chico', type: 'button', onclick: () => { desde = Math.max(0, desde - 50); cargar(); } }, '← Anteriores'),
          desde + 50 < r.total && el('button', { class: 'btn btn-contorno btn-chico', type: 'button', onclick: () => { desde += 50; cargar(); } }, 'Siguientes →')));
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  let t;
  q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { desde = 0; cargar(); }, 300); });
  sede.addEventListener('change', () => { desde = 0; cargar(); });
  estado.addEventListener('change', () => { desde = 0; cargar(); });
  cargar();

  const purga = el('form', { class: 'card zona-peligro', style: { marginTop: '20px' }, novalidate: true },
    el('h2', null, 'Eliminar todos los datos de estudiantes'),
    el('p', { class: 'sub', style: { marginBottom: '12px' } },
      'Al terminar el evento, elimina los datos personales que ya no necesites (principio de retención mínima). Borra inscritos, inscripciones a talleres y sesiones. No se puede deshacer: exporta antes si necesitas un respaldo.'),
    campo('confirmacion', 'Escribe ELIMINAR TODO', { autocomplete: 'off' }),
    campo('clave', 'Tu contraseña', { type: 'password', autocomplete: 'current-password' }),
    el('button', { class: 'btn btn-primario', type: 'submit' }, 'Eliminar todos los datos'));
  alEnviar(purga, async (f) => {
    const r = await llamar('POST', '/api/admin/estudiantes/eliminar-todos', { confirmacion: f.confirmacion.value, clave: f.clave.value });
    f.clave.value = '';
    toast(`Se eliminaron ${r.eliminados} registros`);
    cargar();
  });

  return [
    el('div', { class: 'barra-acciones' }, el('h1', null, 'Estudiantes'),
      el('div', { class: 'acciones', style: { margin: 0 } },
        el('a', { class: 'btn btn-contorno btn-chico', href: '/api/admin/exportar/estudiantes.csv' }, 'Exportar CSV'))),
    el('div', { class: 'filtros-admin' }, q, sede, estado),
    lista,
    purga,
  ];
}

// =====================================================================
// Usuarios
// =====================================================================

function formularioUsuario(alGuardar) {
  const rol = el('select', { id: 'f-rol', name: 'rol' }, el('option', { value: 'acreditador' }, 'Acreditador'), el('option', { value: 'admin' }, 'Administrador'));
  const form = el('form', { novalidate: true },
    campo('nombre', 'Nombre', { maxlength: 80 }),
    campo('email', 'Correo', { type: 'email', maxlength: 120, autocomplete: 'off' }),
    el('div', { class: 'campo', 'data-campo': 'rol' }, el('label', { for: 'f-rol' }, 'Rol'), rol, el('span', { class: 'err' })),
    campo('clave', 'Contraseña inicial', { type: 'password', autocomplete: 'new-password', ayuda: 'Mínimo 12 caracteres. Entrégala por un canal seguro y pide que la cambie al ingresar.' }),
    el('button', { class: 'btn btn-primario', type: 'submit' }, 'Crear usuario'));
  alEnviar(form, async (f) => {
    await llamar('POST', '/api/admin/usuarios', { nombre: f.nombre.value, email: f.email.value.trim(), rol: f.rol.value, clave: f.clave.value });
    alGuardar();
  });
  return form;
}

async function vistaUsuarios() {
  const lista = await llamar('GET', '/api/admin/usuarios');
  const rec = () => cambiarPestana('usuarios');
  const accion = (fn) => async () => {
    try {
      await fn();
      rec();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  return [
    el('div', { class: 'barra-acciones' }, el('h1', null, 'Usuarios'),
      el('button', {
        class: 'btn btn-primario btn-chico', type: 'button',
        onclick: () => { const cerrar = modal('Nuevo usuario', formularioUsuario(() => { cerrar(); toast('Usuario creado'); rec(); })); },
      }, '+ Nuevo usuario')),
    el('p', { class: 'sub', style: { marginBottom: '12px' } },
      'Acreditadores: sólo escanean, buscan e inscriben presencialmente (ven el correo enmascarado y no ven teléfonos). Administradores: acceso total.'),
    el('section', { class: 'card lista-admin' }, lista.map((u) => el('div', { class: 'fila' },
      el('div', { class: 'q' },
        el('strong', null, u.nombre, u.id === adm.usuario.id && ' (tú)'),
        el('span', null, `${u.email} · ${u.rol === 'admin' ? 'Administrador' : 'Acreditador'}`),
        el('span', { style: { display: 'block' } }, u.ultimo_acceso ? `Último acceso: ${new Date(u.ultimo_acceso).toLocaleString('es-CL')}` : 'Nunca ha ingresado',
          u.bloqueado_hasta && Date.parse(u.bloqueado_hasta) > Date.now() ? ' · Bloqueado temporalmente' : '')),
      el('div', { class: 'btns' },
        u.activo ? el('span', { class: 'chip ok' }, 'Activo') : el('span', { class: 'chip peligro' }, 'Desactivado'),
        u.id !== adm.usuario.id && el('button', {
          class: 'btn btn-contorno btn-chico', type: 'button',
          onclick: accion(() => llamar('PUT', `/api/admin/usuarios/${u.id}`, { activo: !u.activo })),
        }, u.activo ? 'Desactivar' : 'Activar'),
        u.id !== adm.usuario.id && el('button', {
          class: 'btn btn-contorno btn-chico', type: 'button',
          onclick: accion(() => llamar('PUT', `/api/admin/usuarios/${u.id}`, { rol: u.rol === 'admin' ? 'acreditador' : 'admin' })),
        }, u.rol === 'admin' ? 'Hacer acreditador' : 'Hacer admin'),
        el('button', {
          class: 'btn btn-contorno btn-chico', type: 'button',
          onclick: () => {
            const form = el('form', { novalidate: true },
              campo('clave', 'Nueva contraseña', { type: 'password', autocomplete: 'new-password', ayuda: 'Se cerrarán todas sus sesiones.' }),
              el('button', { class: 'btn btn-secundario', type: 'submit' }, 'Restablecer'));
            const cerrar = modal(`Restablecer contraseña · ${u.nombre}`, form);
            alEnviar(form, async (f) => {
              await llamar('POST', `/api/admin/usuarios/${u.id}/clave`, { clave: f.clave.value });
              cerrar();
              toast('Contraseña restablecida');
            });
          },
        }, 'Contraseña'),
        u.id !== adm.usuario.id && el('button', {
          class: 'btn btn-contorno btn-chico', type: 'button',
          onclick: accion(async () => {
            if (!confirm(`¿Eliminar la cuenta de ${u.nombre}?`)) return;
            await llamar('DELETE', `/api/admin/usuarios/${u.id}`);
          }),
        }, 'Eliminar'))))),
  ];
}

// =====================================================================
// Auditoría y cuenta
// =====================================================================

async function vistaAuditoria() {
  const lista = await llamar('GET', '/api/admin/auditoria');
  return [
    el('div', { class: 'barra-acciones' }, el('h1', null, 'Registro de auditoría')),
    el('p', { class: 'sub', style: { marginBottom: '12px' } }, 'Últimas 300 acciones relevantes: ingresos, cambios, acreditaciones, exportaciones y eliminaciones.'),
    el('section', { class: 'card tabla-scroll' }, el('table', { class: 'tabla' },
      el('thead', null, el('tr', null, el('th', null, 'Fecha'), el('th', null, 'Usuario'), el('th', null, 'Acción'), el('th', null, 'Detalle'), el('th', null, 'IP'))),
      el('tbody', null, lista.map((a) => el('tr', null,
        el('td', null, new Date(a.en).toLocaleString('es-CL')), el('td', null, a.actor), el('td', null, a.accion),
        el('td', null, a.detalle || ''), el('td', null, el('small', null, a.ip || ''))))))),
  ];
}

function vistaCuenta() {
  return formularioCambioClave(() => iniciar());
}

// =====================================================================
// Navegación
// =====================================================================

function pestanas() {
  return el('div', { class: 'pestanas', role: 'tablist' }, PESTANAS.map(([id, txt]) => el('button', {
    type: 'button', role: 'tab', 'aria-pressed': String(adm.pestana === id), onclick: () => cambiarPestana(id),
  }, txt)));
}

async function cambiarPestana(id) {
  adm.pestana = id;
  clearTimeout(adm.timer);
  const vistas = {
    resumen: vistaResumen, evento: vistaEvento, talleres: vistaTalleres, agenda: vistaAgenda,
    estudiantes: vistaEstudiantes, usuarios: vistaUsuarios, auditoria: vistaAuditoria, cuenta: vistaCuenta,
  };
  try {
    const contenido = await vistas[id]();
    if (adm.pestana !== id) return;
    vista.replaceChildren(...[pestanas(), contenido].flat(Infinity).filter(Boolean));
    if (id === 'resumen') adm.timer = setTimeout(() => adm.pestana === 'resumen' && !document.querySelector('.modal-fondo') && cambiarPestana('resumen'), 15_000);
  } catch (e) {
    if (e.status !== 401) vista.replaceChildren(pestanas(), el('div', { class: 'aviso error' }, e.message));
  }
}

async function iniciar() {
  clearTimeout(adm.timer);
  document.querySelectorAll('.modal-fondo').forEach((m) => m.remove());
  let r;
  try {
    r = await api('GET', '/api/staff/yo');
  } catch (e) {
    return vista.replaceChildren(el('div', { class: 'aviso error' }, e.message));
  }
  adm.usuario = r.usuario;
  if (!adm.usuario) {
    cabeceraUsuario(null);
    vista.replaceChildren(r.requiereConfiguracion
      ? formularioConfiguracionInicial(iniciar)
      : formularioLogin({ titulo: 'Administración', alEntrar: iniciar }));
    return;
  }
  if (adm.usuario.rol !== 'admin') {
    cabeceraUsuario(adm.usuario, iniciar);
    vista.replaceChildren(el('div', { class: 'card', style: { maxWidth: '480px', margin: '24px auto' } },
      el('h1', null, 'Sin permisos'),
      el('p', { class: 'sub' }, 'Tu cuenta es de acreditador.'),
      el('div', { class: 'acciones' }, el('a', { class: 'btn btn-primario', href: '/acreditacion' }, 'Ir a acreditación'))));
    return;
  }
  adm.sedes = (await api('GET', '/api/evento').catch(() => ({}))).sedes || [];
  cabeceraUsuario(adm.usuario, iniciar, el('span', null, el('a', { href: '/acreditacion' }, 'Acreditación'), ' · '));
  cambiarPestana(adm.pestana);
}

iniciar();
