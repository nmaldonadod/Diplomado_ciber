'use strict';

/* Interfaz del acreditador: escaneo QR con la cámara del teléfono, búsqueda manual e inscripción presencial. */

const vista = document.getElementById('vista');
const st = { usuario: null, sedes: [], pestana: 'escanear', ultimaLectura: { texto: '', t: 0 } };

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
  return new Promise((ok, falla) => {
    if (window.jsQR) return ok();
    const s = el('script', { src });
    s.onload = ok;
    s.onerror = falla;
    document.head.append(s);
  });
}

async function prepararDetector() {
  if ('BarcodeDetector' in window) {
    try {
      const soportados = await BarcodeDetector.getSupportedFormats();
      if (soportados.includes('qr_code')) return new BarcodeDetector({ formats: ['qr_code'] });
    } catch { /* se usa jsQR */ }
  }
  await cargarScript('/vendor/jsQR.js');
  return null;
}

async function iniciarCamara(video, estadoCam) {
  if (!window.isSecureContext) throw new Error('La cámara requiere HTTPS.');
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
  estadoCam.textContent = 'Lector activo';
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
let contenedorEscaner = null;

function cerrarResultado() {
  clearTimeout(reanudar);
  panelResultado?.remove();
  panelResultado = null;
  camara.pausado = false;
}

const nombreDe = (e) => `${e.nombres} ${e.apellidos}`;

function mostrarResultado(r) {
  cerrarResultado();
  camara.pausado = true;
  const e = r.estudiante;
  const tipos = {
    ACREDITADO: ['ok', '✓ Acreditado'],
    YA_ACREDITADO: ['ya', e ? `Ya acreditado a las ${horaReal(e.acreditadoEn)}` : ''],
    NO_REGISTRADO: ['no', 'No inscrito en el evento'],
    NO_RECONOCIDO: ['no', 'Código no reconocido'],
  };
  const [clase, titulo] = tipos[r.resultado];
  pitido(clase);

  const acciones = [el('button', { class: 'btn btn-chico', type: 'button', onclick: cerrarResultado }, 'Siguiente')];
  if (r.resultado === 'NO_REGISTRADO') {
    acciones.unshift(el('button', { class: 'btn btn-chico', type: 'button', onclick: () => cambiarPestana('inscribir', { email: r.email }) }, 'Inscribir ahora'));
  }
  if (r.resultado === 'ACREDITADO') {
    acciones.push(el('button', {
      class: 'btn btn-chico sec', type: 'button',
      onclick: async () => {
        await api('DELETE', `/api/acreditacion/${e.id}`).then(() => toast('Acreditación deshecha'), (x) => toast(x.message, 'error'));
        cerrarResultado();
      },
    }, 'Deshacer'));
  }

  panelResultado = el('div', { class: `resultado ${clase}`, role: 'alert' },
    el('div', { class: 'grande' }, titulo),
    e && el('div', { class: 'nombre' }, nombreDe(e)),
    e && el('div', { class: 'mini' }, `${e.sede} · ${e.email}`),
    r.resultado === 'NO_REGISTRADO' && el('div', { class: 'mini' }, r.email ? `Correo ${r.email}` : 'La entrada no corresponde a ningún inscrito.'),
    r.resultado === 'NO_RECONOCIDO' && el('div', { class: 'mini' }, 'Escanea el QR de la entrada digital o busca al estudiante por nombre.'),
    e && (e.talleres.length
      ? el('ul', null, e.talleres.map((t) => el('li', null, `${nombreDia(fechaDe(t.inicio), { weekday: 'short' })} ${hora(t.inicio)} · ${t.titulo}${t.sala ? ' · ' + t.sala : ''}`)))
      : el('div', { class: 'mini' }, 'Sin talleres inscritos')),
    el('div', { class: 'acciones', style: { marginTop: '12px' } }, acciones));
  contenedorEscaner.append(panelResultado);
  if (r.resultado === 'ACREDITADO') reanudar = setTimeout(cerrarResultado, 3500);
}

async function acreditar(cuerpo) {
  try {
    const r = await api('POST', '/api/acreditacion/acreditar', cuerpo);
    if (st.pestana === 'escanear' && contenedorEscaner) mostrarResultado(r);
    return r;
  } catch (e) {
    if (e.status === 401) return iniciar();
    toast(e.message, 'error');
  }
}

// ---------- vistas ----------

function vistaEscanear() {
  const video = el('video', { playsinline: true, muted: true, autoplay: true });
  video.muted = true;
  const estadoCam = el('span', { class: 'estado-cam oculto' });
  const inicio = el('div', { class: 'inicio' },
    el('strong', { style: { fontSize: '1.1rem' } }, 'Escanear entrada'),
    el('p', null, 'Apunta la cámara al código QR de la entrada digital del estudiante.'),
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

  const input = el('input', { placeholder: 'Código de entrada o INACAPMAIL', autocomplete: 'off', 'aria-label': 'Código de entrada o correo', maxlength: 120 });
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

function filaEstudiante(e, alCambiar) {
  return el('div', { class: 'fila' },
    el('div', { class: 'q' },
      el('strong', null, nombreDe(e)),
      el('span', null, `${e.sede} · ${e.email}`),
      el('span', { style: { display: 'block' } }, e.talleres.length ? `Talleres: ${e.talleres.map((t) => t.titulo).join(', ')}` : 'Sin talleres')),
    e.acreditadoEn
      ? el('div', { style: { textAlign: 'right' } },
        el('span', { class: 'chip verde' }, `✓ ${horaReal(e.acreditadoEn)}`),
        el('button', {
          class: 'btn btn-linea btn-chico', type: 'button', style: { marginTop: '6px' },
          onclick: async () => {
            if (!confirm(`¿Deshacer la acreditación de ${nombreDe(e)}?`)) return;
            await api('DELETE', `/api/acreditacion/${e.id}`).then(alCambiar, (x) => toast(x.message, 'error'));
          },
        }, 'Deshacer'))
      : el('button', {
        class: 'btn btn-verde btn-chico', type: 'button',
        onclick: async () => {
          const r = await acreditar({ id: e.id });
          if (r) {
            pitido(r.resultado === 'ACREDITADO' ? 'ok' : 'ya');
            toast(`✓ ${nombreDe(e)} acreditado/a`);
            alCambiar();
          }
        },
      }, 'Acreditar'));
}

function vistaBuscar() {
  const resultados = el('div', { class: 'card', 'aria-live': 'polite' }, el('p', { class: 'sub' }, 'Busca por nombre, apellido o INACAPMAIL completo.'));
  const input = el('input', { type: 'search', placeholder: 'Buscar estudiante…', autocomplete: 'off', 'aria-label': 'Buscar', maxlength: 80 });
  let t;
  async function buscar() {
    const q = input.value.trim();
    if (q.length < 2) return;
    try {
      const lista = await api('GET', '/api/acreditacion/buscar?q=' + encodeURIComponent(q));
      resultados.replaceChildren(...(lista.length
        ? lista.map((e) => filaEstudiante(e, buscar))
        : [el('p', { class: 'sub' }, 'Sin resultados. '),
          el('button', { class: 'btn btn-oscuro btn-chico', type: 'button', onclick: () => cambiarPestana('inscribir', { email: correoValido(q) ? q : '' }) }, 'Inscripción presencial')]));
    } catch (e) {
      if (e.status === 401) return iniciar();
      toast(e.message, 'error');
    }
  }
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(buscar, 300); });
  setTimeout(() => input.focus());
  return [el('div', { class: 'manual', style: { marginTop: 0, marginBottom: '12px' } }, input), resultados];
}

function vistaInscribir({ email = '' } = {}) {
  const aviso = el('div', { class: 'aviso error oculto', role: 'alert' });
  const form = el('form', { class: 'card', novalidate: true },
    el('h2', null, 'Inscripción presencial'),
    el('p', { class: 'sub', style: { marginBottom: '12px' } }, 'El estudiante quedará inscrito y acreditado de inmediato.'),
    aviso,
    campo('nombres', 'Nombres', { maxlength: 60 }),
    campo('apellidos', 'Apellidos', { maxlength: 60 }),
    campo('sede', 'Sede', { opciones: st.sedes }),
    campo('email', 'INACAPMAIL', { type: 'email', value: email, maxlength: 120 }),
    campo('telefono', 'Teléfono', { type: 'tel', maxlength: 16 }),
    el('label', { class: 'check', 'data-campo': 'consentimiento' },
      el('input', { type: 'checkbox', name: 'consentimiento' }),
      el('span', null, 'El estudiante leyó y aceptó la política de privacidad del evento.', el('span', { class: 'err', style: { display: 'block' } }))),
    el('button', { class: 'btn btn-verde btn-bloque', type: 'submit' }, 'Inscribir y acreditar'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = form.elements;
    try {
      const r = await api('POST', '/api/acreditacion/registro-presencial', {
        nombres: f.nombres.value, apellidos: f.apellidos.value, sede: f.sede.value, email: f.email.value.trim(),
        telefono: f.telefono.value, consentimiento: f.consentimiento.checked,
      });
      pitido('ok');
      pintar([segmentos(), el('div', { class: 'card', style: { textAlign: 'center' } },
        el('h2', null, `✓ ${nombreDe(r.estudiante)} inscrito/a y acreditado/a`),
        el('p', null, 'Entrégale su código de acceso para que vea su entrada y elija talleres en la app:'),
        el('div', { class: 'codigo-acceso' }, r.codigoAcceso),
        el('button', { class: 'btn btn-oscuro', type: 'button', onclick: () => cambiarPestana('escanear') }, 'Continuar'))]);
    } catch (e) {
      mostrarErrores(form, e.datos?.errores);
      aviso.textContent = e.message;
      aviso.classList.remove('oculto');
    }
  });
  return form;
}

function vistaCuenta() {
  return formularioCambioClave(() => iniciar());
}

// ---------- navegación ----------

function segmentos() {
  const b = (id, txt) => el('button', { type: 'button', 'aria-pressed': String(st.pestana === id), onclick: () => cambiarPestana(id) }, txt);
  return el('div', { class: 'segmentos', role: 'group' }, b('escanear', 'Escanear'), b('buscar', 'Buscar'), b('inscribir', 'Inscribir'));
}

function pintar(nodos) {
  vista.replaceChildren(...[nodos].flat(Infinity).filter(Boolean));
}

function cambiarPestana(id, opciones) {
  st.pestana = id;
  detenerCamara();
  cerrarResultado();
  contenedorEscaner = null;
  const vistas = { escanear: vistaEscanear, buscar: vistaBuscar, inscribir: vistaInscribir, cuenta: vistaCuenta };
  pintar([segmentos(), vistas[id](opciones)]);
}

async function iniciar() {
  detenerCamara();
  let r;
  try {
    r = await api('GET', '/api/staff/yo');
  } catch (e) {
    return pintar(el('div', { class: 'aviso error' }, e.message));
  }
  st.usuario = r.usuario;
  if (!st.usuario) {
    cabeceraUsuario(null);
    return pintar(formularioLogin({ titulo: 'Acreditación', alEntrar: iniciar }));
  }
  st.sedes = (await api('GET', '/api/evento').catch(() => ({}))).sedes || [];
  cabeceraUsuario(st.usuario, iniciar, el('span', null,
    st.usuario.rol === 'admin' && el('a', { href: '/admin' }, 'Admin'), st.usuario.rol === 'admin' && ' · ',
    el('a', { href: '#', onclick: (e) => { e.preventDefault(); cambiarPestana('cuenta'); } }, 'Contraseña'), ' · '));
  cambiarPestana('escanear');
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && camara.activo) {
    detenerCamara();
    if (st.pestana === 'escanear') cambiarPestana('escanear');
  }
});

iniciar();
