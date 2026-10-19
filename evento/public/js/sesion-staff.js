'use strict';

/* Inicio de sesión compartido por las interfaces de acreditación y administración. */

function formularioLogin({ titulo, alEntrar }) {
  const aviso = el('div', { class: 'aviso error oculto', role: 'alert' });
  const form = el('form', { class: 'card', style: { maxWidth: '420px', margin: '24px auto' } },
    el('span', { class: 'eyebrow' }, 'Acceso restringido'),
    el('h1', null, titulo),
    el('p', { class: 'sub', style: { marginBottom: '16px' } }, 'Ingresa con la cuenta entregada por la organización.'),
    aviso,
    campo('email', 'Correo', { type: 'email', autocomplete: 'username', required: true, maxlength: 120 }),
    campo('clave', 'Contraseña', { type: 'password', autocomplete: 'current-password', required: true, maxlength: 128 }),
    el('button', { class: 'btn btn-oscuro btn-bloque', type: 'submit' }, 'Ingresar'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const boton = form.querySelector('button');
    boton.disabled = true;
    try {
      const r = await api('POST', '/api/staff/login', { email: form.elements.email.value.trim(), clave: form.elements.clave.value });
      form.elements.clave.value = '';
      alEntrar(r.usuario);
    } catch (e) {
      aviso.textContent = e.message;
      aviso.classList.remove('oculto');
      boton.disabled = false;
    }
  });
  return form;
}

// Creación del primer administrador con el token que el servidor muestra en consola.
function formularioConfiguracionInicial(alTerminar) {
  const aviso = el('div', { class: 'aviso error oculto', role: 'alert' });
  const form = el('form', { class: 'card', style: { maxWidth: '480px', margin: '24px auto' }, novalidate: true },
    el('span', { class: 'eyebrow' }, 'Configuración inicial'),
    el('h1', null, 'Crear administrador'),
    el('p', { class: 'sub', style: { marginBottom: '16px' } }, 'Ingresa el token que aparece en la consola del servidor al iniciarlo.'),
    aviso,
    campo('token', 'Token de configuración', { required: true, autocomplete: 'off' }),
    campo('nombre', 'Tu nombre', { required: true, maxlength: 80 }),
    campo('email', 'Correo', { type: 'email', required: true, autocomplete: 'username' }),
    campo('clave', 'Contraseña', { type: 'password', required: true, autocomplete: 'new-password', ayuda: 'Mínimo 12 caracteres, con mayúsculas, minúsculas, números o símbolos.' }),
    el('button', { class: 'btn btn-rojo btn-bloque', type: 'submit' }, 'Crear administrador'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = form.elements;
    try {
      await api('POST', '/api/staff/configuracion-inicial', { token: f.token.value.trim(), nombre: f.nombre.value, email: f.email.value.trim(), clave: f.clave.value });
      toast('Administrador creado. Ahora ingresa.');
      alTerminar();
    } catch (e) {
      mostrarErrores(form, e.datos?.errores);
      aviso.textContent = e.message;
      aviso.classList.remove('oculto');
    }
  });
  return form;
}

function formularioCambioClave(alTerminar) {
  const aviso = el('div', { class: 'aviso error oculto', role: 'alert' });
  const form = el('form', { class: 'card', style: { maxWidth: '440px', margin: '0 auto' }, novalidate: true },
    el('h2', null, 'Cambiar mi contraseña'),
    aviso,
    campo('actual', 'Contraseña actual', { type: 'password', autocomplete: 'current-password' }),
    campo('nueva', 'Nueva contraseña', { type: 'password', autocomplete: 'new-password', ayuda: 'Mínimo 12 caracteres, con al menos tres tipos de caracteres.' }),
    el('button', { class: 'btn btn-oscuro', type: 'submit' }, 'Cambiar contraseña'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('POST', '/api/staff/clave', { actual: form.elements.actual.value, nueva: form.elements.nueva.value });
      toast('Contraseña actualizada. Vuelve a ingresar.');
      alTerminar();
    } catch (e) {
      mostrarErrores(form, e.datos?.errores);
      aviso.textContent = e.message;
      aviso.classList.remove('oculto');
    }
  });
  return form;
}

// Muestra el usuario conectado y el botón para salir en la cabecera.
function cabeceraUsuario(usuario, alSalir, extra) {
  const op = document.getElementById('operador');
  if (!usuario) {
    op.classList.add('oculto');
    return;
  }
  op.replaceChildren(
    el('span', null, usuario.nombre, ' · '),
    extra || '',
    el('a', {
      href: '#', onclick: async (e) => {
        e.preventDefault();
        await api('POST', '/api/staff/logout', {}).catch(() => {});
        alSalir();
      },
    }, 'Salir'));
  op.classList.remove('oculto');
}
