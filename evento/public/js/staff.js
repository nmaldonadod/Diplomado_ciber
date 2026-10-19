'use strict';

/* App de acreditación para el staff: escaneo QR con la cámara del teléfono, búsqueda manual y panel. */

const vista = document.getElementById('vista');
const st = { staff: null, pestana: 'escanear', ultimaLectura: { texto: '', t: 0 } };

// ---------- retroalimentación (sonido + vibración) ----------
let audio;
function pitido(tipo) {
  try {
    audio = audio || new AudioContext();
    const tonos = tipo === 'ok' ? [880, 1320] : tipo === 'ya' ? [660, 660] : [300, 220];
    tonos.forEach((f, i) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.frequency.value = f;
      o.type = 'sine';
      g.gain.setValueAtTime(0.15, audio.currentTime + i * 0.14);
      g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + i * 0.14 + 0.12);
      o.connect(g).connect(audio.destination);
      o.start(audio.currentTime + i * 0.14);
      o.stop(audio.currentTime + i * 0.14 + 0.13);
    });
  } catch { /* sin audio */ }
  navigator.vibrate?.(tipo === 'ok' ? 120 : [80, 60, 80, 60, 80]);
}

// ---------- cámara y lectura de códigos ----------
const camara = { stream: null, video: null, detector: null, canvas: null, activo: false, pausado: false, timer: null };

function cargarScript(src) {
  return new Promise((ok, fallo) => {
    if (document.querySelector(`script[src="${src}"]`)) return ok();
    const s = el('script', { src });
    s.onload = ok;
    s.onerror = fallo;
    document.head.append(s);
  });
}

async function prepararDetector() {
  if ('BarcodeDetector' in window) {
    try {
      const soportados = await BarcodeDetector.getSupportedFormats();
      const formatos = ['qr_code', 'pdf417', 'code_128', 'code_39'].filter((f) => soportados.includes(f));
      if (formatos.includes('qr_code')) return new BarcodeDetector({ formats: formatos });
    } catch { /* se usa jsQR */ }
  }
  await cargarScript('/vendor/jsQR.js');
  return null;
}

async function iniciarCamara(video, estadoCam) {
  if (!window.isSecureContext) throw new Error('La cámara requiere HTTPS. Abre esta página con https:// (ver README).');
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Este navegador no permite usar la cámara.');
  camara.stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  camara.video = video;
  video.srcObject = camara.stream;
  await video.play();
  camara.detector = await prepararDetector();
  camara.canvas = camara.canvas || document.createElement('canvas');
  camara.activo = true;
  camara.pausado = false;
  estadoCam.textContent = camara.detector ? 'Lector nativo activo' : 'Lector activo';
  bucle();
}

function detenerCamara() {
  camara.activo = false;
  clearTimeout(camara.timer);
  camara.stream?.getTracks().forEach((t) => t.stop());
  camara.stream = null;
}

async function leerFotograma() {
  const v = camara.video;
  if (!v || v.readyState < 2) return null;
  if (camara.detector) {
    const r = await camara.detector.detect(v).catch(() => []);
    return r[0]?.rawValue || null;
  }
  const escala = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight));
  const w = Math.round(v.videoWidth * escala);
  const h = Math.round(v.videoHeight * escala);
  const c = camara.canvas;
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(v, 0, 0, w, h);
  const r = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
  return r?.data || null;
}

async function bucle() {
  if (!camara.activo) return;
  if (!camara.pausado) {
    const texto = await leerFotograma();
    const t = Date.now();
    // Evita procesar el mismo código repetidamente mientras sigue frente a la cámara.
    if (texto && !(texto === st.ultimaLectura.texto && t - st.ultimaLectura.t < 5000)) {
      st.ultimaLectura = { texto, t };
      await acreditar({ texto });
    }
  }
  camara.timer = setTimeout(bucle, camara.detector ? 120 : 220);
}

// ---------- acreditación ----------
let panelResultado = null;
let reanudar = null;

function cerrarResultado() {
  clearTimeout(reanudar);
  panelResultado?.remove();
  panelResultado = null;
  camara.pausado = false;
}

function mostrarResultado(r, contenedor) {
  cerrarResultado();
  camara.pausado = true;
  const e = r.estudiante;
  let clase;
  let titulo;
  if (r.resultado === 'ACREDITADO') { clase = 'ok'; titulo = '✓ Acreditado'; }
  else if (r.resultado === 'YA_ACREDITADO') { clase = 'ya'; titulo = `Ya acreditado a las ${horaReal(e.acreditadoEn)}`; }
  else if (r.resultado === 'NO_REGISTRADO') { clase = 'no'; titulo = 'No inscrito en el evento'; }
  else { clase = 'no'; titulo = 'Código no reconocido'; }
  pitido(clase);

  const acciones = [el('button', { class: 'btn btn-chico', type: 'button', onclick: cerrarResultado }, 'Siguiente')];
  if (r.resultado === 'NO_REGISTRADO') {
    acciones.unshift(el('button', { class: 'btn btn-chico', type: 'button', onclick: () => { cerrarResultado(); formularioPresencial(r.rut); } }, 'Inscribir ahora'));
  }
  if (r.resultado === 'ACREDITADO' && e) {
    acciones.push(el('button', {
      class: 'btn btn-chico sec', type: 'button',
      onclick: async () => {
        await api('DELETE', `/api/staff/acreditacion/${e.id}`).catch((x) => toast(x.message, 'error'));
        toast('Acreditación deshecha');
        cerrarResultado();
      },
    }, 'Deshacer'));
  }

  panelResultado = el('div', { class: `resultado ${clase}`, role: 'alert' },
    el('div', { class: 'grande' }, titulo),
    e && el('div', { class: 'nombre' }, e.nombre),
    e && el('div', { class: 'mini' }, [e.rut, e.carrera, e.sede].filter(Boolean).join(' · ')),
    r.resultado === 'NO_REGISTRADO' && el('div', { class: 'mini' }, r.rut ? `RUT ${r.rut}` : 'El código no corresponde a ninguna entrada.'),
    r.resultado === 'NO_RECONOCIDO' && el('div', { class: 'mini' }, 'Usa el QR de la entrada, el QR de la cédula o ingresa el RUT.'),
    e && (e.talleres.length
      ? el('ul', null, e.talleres.map((t) => el('li', null, `${hora(t.inicio)} ${t.titulo}${t.sala ? ' · ' + t.sala : ''}`)))
      : el('div', { class: 'mini' }, 'Sin talleres inscritos')),
    el('div', { class: 'acciones', style: { marginTop: '12px' } }, acciones));
  contenedor.append(panelResultado);
  if (r.resultado === 'ACREDITADO') reanudar = setTimeout(cerrarResultado, 3500);
}

let contenedorEscaner = null;
async function acreditar(cuerpo) {
  try {
    const r = await api('POST', '/api/staff/acreditar', cuerpo);
    if (st.pestana === 'escanear' && contenedorEscaner) mostrarResultado(r, contenedorEscaner);
    return r;
  } catch (e) {
    if (e.status === 401) return iniciar();
    toast(e.message, 'error');
  }
}

// ---------- vistas ----------

function vistaLogin() {
  const aviso = el('div', { class: 'aviso error oculto', role: 'alert' });
  const form = el('form', { class: 'card', style: { maxWidth: '420px', margin: '24px auto' } },
    el('span', { class: 'eyebrow' }, 'Staff'),
    el('h1', null, 'Ingreso de acreditadores'),
    el('p', { class: 'sub', style: { marginBottom: '16px' } }, 'Ingresa el PIN entregado por la organización.'),
    aviso,
    el('div', { class: 'campo' }, el('label', { for: 'op' }, 'Tu nombre'), el('input', { id: 'op', name: 'operador', maxlength: 40, autocomplete: 'name', placeholder: 'Ej: Camila – Puerta 1' })),
    el('div', { class: 'campo' }, el('label', { for: 'pin' }, 'PIN'), el('input', { id: 'pin', name: 'pin', type: 'password', inputmode: 'numeric', autocomplete: 'current-password', required: true })),
    el('button', { class: 'btn btn-oscuro btn-bloque', type: 'submit' }, 'Ingresar'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('POST', '/api/staff/login', { pin: form.elements.pin.value, operador: form.elements.operador.value });
      iniciar();
    } catch (e) {
      aviso.textContent = e.message;
      aviso.classList.remove('oculto');
    }
  });
  return form;
}

function vistaEscanear() {
  const video = el('video', { playsinline: true, muted: true, autoplay: true });
  video.muted = true;
  const estadoCam = el('span', { class: 'estado-cam oculto' });
  const inicio = el('div', { class: 'inicio' },
    el('strong', { style: { fontSize: '1.1rem' } }, 'Escanear QR'),
    el('p', null, 'Entrada digital del estudiante o QR de la cédula de identidad (carnet).'),
    el('button', {
      class: 'btn btn-rojo', type: 'button',
      onclick: async (ev) => {
        ev.target.disabled = true;
        try {
          await iniciarCamara(video, estadoCam);
          inicio.remove();
          estadoCam.classList.remove('oculto');
        } catch (e) {
          ev.target.disabled = false;
          toast(e.name === 'NotAllowedError' ? 'Debes permitir el acceso a la cámara.' : e.message, 'error');
        }
      },
    }, 'Activar cámara'));
  contenedorEscaner = el('div', { class: 'escaner' }, video, el('div', { class: 'mira' }, el('i')), estadoCam, inicio);

  const input = el('input', { placeholder: 'RUT o código (12.345.678-5)', autocomplete: 'off', 'aria-label': 'RUT o código' });
  input.addEventListener('input', () => {
    if (/^[\d.kK-]*$/.test(input.value)) input.value = formatearRutInput(input.value);
  });
  const manual = el('form', { class: 'manual' }, input, el('button', { class: 'btn btn-oscuro', type: 'submit' }, 'Acreditar'));
  manual.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!input.value.trim()) return;
    const r = await acreditar({ texto: input.value });
    if (r) input.value = '';
  });

  return [contenedorEscaner, manual,
    el('p', { class: 'sub', style: { fontSize: '.82rem', marginTop: '10px' } },
      'Verde: acreditado · Ámbar: ya estaba acreditado · Rojo: no inscrito (puedes inscribirlo en el momento).')];
}

function formularioPresencial(rut) {
  st.pestana = 'buscar';
  detenerCamara();
  const aviso = el('div', { class: 'aviso error oculto', role: 'alert' });
  const campo = (n, l, a = {}) => el('div', { class: 'campo' }, el('label', { for: 'p-' + n }, l), el('input', { id: 'p-' + n, name: n, ...a }));
  const form = el('form', { class: 'card' },
    el('h2', null, 'Inscripción presencial'),
    el('p', { class: 'sub', style: { marginBottom: '12px' } }, 'El estudiante quedará inscrito y acreditado de inmediato.'),
    aviso,
    campo('rut', 'RUT', { value: rut || '', required: true }),
    campo('nombre', 'Nombre completo', { required: true }),
    campo('email', 'Correo', { type: 'email', required: true }),
    campo('carrera', 'Carrera'),
    el('div', { class: 'campo' }, el('label', { for: 'p-sede' }, 'Sede'),
      el('select', { id: 'p-sede', name: 'sede' }, el('option', { value: '' }, '—'), (st.sedes || []).map((s) => el('option', { value: s }, s)))),
    el('div', { class: 'acciones' },
      el('button', { class: 'btn btn-verde', type: 'submit' }, 'Inscribir y acreditar'),
      el('button', { class: 'btn btn-linea', type: 'button', onclick: () => cambiarPestana('escanear') }, 'Volver')));
  form.elements.rut.addEventListener('input', (e) => (e.target.value = formatearRutInput(e.target.value)));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = form.elements;
    try {
      const r = await api('POST', '/api/staff/registro-presencial', {
        rut: f.rut.value, nombre: f.nombre.value, email: f.email.value, carrera: f.carrera.value, sede: f.sede.value,
      });
      pitido('ok');
      toast(`✓ ${r.estudiante.nombre} inscrito y acreditado`);
      cambiarPestana('escanear');
    } catch (e) {
      aviso.textContent = e.datos?.errores ? Object.values(e.datos.errores).join(' ') : e.message;
      aviso.classList.remove('oculto');
    }
  });
  pintar([segmentos(), form]);
}

function filaEstudiante(e, alCambiar) {
  return el('div', { class: 'fila' },
    el('div', { class: 'q' },
      el('strong', null, e.nombre),
      el('span', null, [e.rut, e.carrera, e.sede].filter(Boolean).join(' · ')),
      el('span', { style: { display: 'block' } }, e.talleres.length ? `Talleres: ${e.talleres.map((t) => t.titulo).join(', ')}` : 'Sin talleres')),
    e.acreditadoEn
      ? el('div', { style: { textAlign: 'right' } },
        el('span', { class: 'chip verde' }, `✓ ${horaReal(e.acreditadoEn)}`),
        el('button', {
          class: 'btn btn-linea btn-chico', type: 'button', style: { marginTop: '6px' },
          onclick: async () => {
            if (!confirm(`¿Deshacer la acreditación de ${e.nombre}?`)) return;
            await api('DELETE', `/api/staff/acreditacion/${e.id}`).then(alCambiar, (x) => toast(x.message, 'error'));
          },
        }, 'Deshacer'))
      : el('button', {
        class: 'btn btn-verde btn-chico', type: 'button',
        onclick: async () => {
          const r = await acreditar({ id: e.id });
          if (r) { pitido(r.resultado === 'ACREDITADO' ? 'ok' : 'ya'); toast(`✓ ${e.nombre} acreditado`); alCambiar(); }
        },
      }, 'Acreditar'));
}

function vistaBuscar() {
  const resultados = el('div', { class: 'card', 'aria-live': 'polite' }, el('p', { class: 'sub' }, 'Busca por RUT, nombre o correo.'));
  const input = el('input', { type: 'search', placeholder: 'Buscar estudiante…', autocomplete: 'off', 'aria-label': 'Buscar' });
  let t;
  async function buscar() {
    const q = input.value.trim();
    if (q.length < 2) return;
    try {
      const lista = await api('GET', '/api/staff/buscar?q=' + encodeURIComponent(q));
      resultados.replaceChildren(...(lista.length
        ? lista.map((e) => filaEstudiante(e, buscar))
        : [el('p', { class: 'sub' }, 'Sin resultados. '), el('button', { class: 'btn btn-oscuro btn-chico', type: 'button', onclick: () => formularioPresencial(rutValido(q) ? formatearRutInput(q) : '') }, 'Inscripción presencial')]));
    } catch (e) {
      if (e.status === 401) return iniciar();
      toast(e.message, 'error');
    }
  }
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(buscar, 250); });
  return [el('div', { class: 'manual', style: { marginTop: 0, marginBottom: '12px' } }, input,
    el('button', { class: 'btn btn-linea', type: 'button', onclick: () => formularioPresencial('') }, '+ Presencial')), resultados];
}

function vistaPanel() {
  const cont = el('div', null, el('p', { class: 'vacio' }, 'Cargando…'));
  async function cargar() {
    if (st.pestana !== 'panel' || !cont.isConnected) return;
    try {
      const s = await api('GET', '/api/staff/estadisticas');
      const pct = s.registrados ? Math.round((s.acreditados / s.registrados) * 100) : 0;
      cont.replaceChildren(
        el('div', { class: 'kpis' },
          el('div', { class: 'kpi' }, el('div', { class: 'n' }, s.registrados), el('div', { class: 'l' }, 'Inscritos')),
          el('div', { class: 'kpi' }, el('div', { class: 'n' }, s.acreditados), el('div', { class: 'l' }, 'Acreditados')),
          el('div', { class: 'kpi' }, el('div', { class: 'n' }, pct + '%'), el('div', { class: 'l' }, 'Asistencia')),
          el('div', { class: 'kpi' }, el('div', { class: 'n' }, s.presenciales), el('div', { class: 'l' }, 'Inscripciones presenciales'))),
        el('section', { class: 'card', style: { marginBottom: '16px' } },
          el('h2', null, 'Cupos por taller'),
          s.talleres.map((t) => el('div', { style: { marginBottom: '12px' } },
            el('strong', { style: { fontSize: '.92rem' } }, t.titulo),
            el('div', { class: 'sub', style: { fontSize: '.8rem' } }, `${nombreDia(fechaDe(t.inicio), { weekday: 'short', day: 'numeric' })} ${hora(t.inicio)} · ${t.sala || ''}`),
            widgetCupo(t)))),
        el('div', { class: 'grid grid-2' },
          el('section', { class: 'card' }, el('h2', null, 'Últimas acreditaciones'),
            s.ultimas.length
              ? s.ultimas.map((u) => el('div', { class: 'fila' }, el('div', { class: 'q' }, el('strong', null, u.nombre), el('span', null, `${u.rut} · ${u.acreditado_por || ''}`)), el('span', { class: 'chip verde' }, horaReal(u.acreditado_en))))
              : el('p', { class: 'sub' }, 'Aún no hay acreditaciones.')),
          el('section', { class: 'card' }, el('h2', null, 'Por sede'),
            el('table', { class: 'tabla' },
              el('thead', null, el('tr', null, el('th', null, 'Sede'), el('th', null, 'Inscritos'), el('th', null, 'Acreditados'))),
              el('tbody', null, s.porSede.map((r) => el('tr', null, el('td', null, r.sede), el('td', null, r.registrados), el('td', null, r.acreditados))))),
            el('h2', { style: { marginTop: '18px' } }, 'Exportar (CSV)'),
            el('div', { class: 'acciones' },
              el('a', { class: 'btn btn-linea btn-chico', href: '/api/staff/exportar/registrados.csv' }, 'Inscritos y acreditación'),
              el('a', { class: 'btn btn-linea btn-chico', href: '/api/staff/exportar/inscripciones.csv' }, 'Listas por taller')))));
    } catch (e) {
      if (e.status === 401) return iniciar();
    }
    setTimeout(cargar, 10_000);
  }
  setTimeout(cargar);
  return cont;
}

// ---------- navegación ----------

function segmentos() {
  const b = (id, txt) => el('button', { type: 'button', 'aria-pressed': String(st.pestana === id), onclick: () => cambiarPestana(id) }, txt);
  return el('div', { class: 'segmentos', role: 'group' }, b('escanear', 'Escanear'), b('buscar', 'Buscar'), b('panel', 'Panel'));
}

function pintar(nodos) {
  vista.replaceChildren(...[nodos].flat(Infinity).filter(Boolean));
}

function cambiarPestana(id) {
  st.pestana = id;
  detenerCamara();
  cerrarResultado();
  contenedorEscaner = null;
  const contenido = { escanear: vistaEscanear, buscar: vistaBuscar, panel: vistaPanel }[id]();
  pintar([segmentos(), contenido]);
}

async function iniciar() {
  detenerCamara();
  const op = document.getElementById('operador');
  try {
    st.staff = await api('GET', '/api/staff/yo');
  } catch {
    op.classList.add('oculto');
    return pintar(vistaLogin());
  }
  if (!st.sedes) st.sedes = (await api('GET', '/api/evento').catch(() => ({}))).sedes || [];
  op.replaceChildren(st.staff.operador, ' · ', el('a', {
    href: '#', onclick: async (e) => { e.preventDefault(); await api('POST', '/api/staff/logout', {}).catch(() => {}); iniciar(); },
  }, 'Salir'));
  op.classList.remove('oculto');
  cambiarPestana('escanear');
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && camara.activo) {
    detenerCamara();
    if (st.pestana === 'escanear') cambiarPestana('escanear');
  }
});

iniciar();
