'use strict';

api('GET', '/api/evento').then((d) => {
  if (!d.evento) return;
  document.getElementById('evento-nombre').textContent = d.evento.nombre;
  if (d.evento.contacto) document.getElementById('evento-contacto').textContent = d.evento.contacto;
}).catch(() => {});
