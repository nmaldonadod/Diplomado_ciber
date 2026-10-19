import { correoInstitucional } from './validacion.js';

const PREFIJO_TICKET = 'EVT1:';
const RE_TICKET = /^EVT1:([A-Z2-9]{16})$/;
const RE_CODIGO = /^[A-Z2-9]{16}$/;

// Interpreta lo leído por el acreditador (cámara o teclado):
//  - QR de la entrada digital del estudiante:   EVT1:XXXXXXXXXXXXXXXX
//  - Código de la entrada escrito a mano:        XXXX XXXX XXXX XXXX
//  - Correo institucional (escrito o dentro de un QR/credencial): nombre@inacapmail.cl
function extraerIdentidad(texto) {
  const t = String(texto ?? '').trim().slice(0, 2048);
  if (!t) return null;

  const ticket = t.toUpperCase().match(RE_TICKET);
  if (ticket) return { tipo: 'ticket', codigo: ticket[1] };

  const compacto = t.toUpperCase().replace(/[\s-]/g, '');
  if (RE_CODIGO.test(compacto)) return { tipo: 'ticket', codigo: compacto };

  for (const m of t.matchAll(/[A-Za-z0-9._-]+@inacapmail\.cl\b/gi)) {
    const email = correoInstitucional(m[0]);
    if (email) return { tipo: 'email', email };
  }
  return null;
}

export { extraerIdentidad, PREFIJO_TICKET };
