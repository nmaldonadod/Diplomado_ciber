import { correoInstitucional } from './validacion.js';
import { normalizarRut } from './rut.js';

const PREFIJO_TICKET = 'EVT1:';
const RE_TICKET = /^EVT1:([A-Z2-9]{16})$/;
const RE_CODIGO = /^[A-Z2-9]{16}$/;

// Interpreta lo leído por el acreditador (cámara o teclado):
//  - QR de la entrada digital del estudiante:   EVT1:XXXXXXXXXXXXXXXX
//  - Código de la entrada escrito a mano:        XXXX XXXX XXXX XXXX
//  - Cédula de identidad chilena (QR del reverso): https://portal.sidiv.registrocivil.cl/docstatus?RUN=12345678-5&...
//  - RUT escrito a mano: 12.345.678-5
//  - Correo institucional (escrito o dentro de un QR/credencial): nombre@inacapmail.cl
function extraerIdentidad(texto) {
  const t = String(texto ?? '').trim().slice(0, 2048);
  if (!t) return null;

  const ticket = t.toUpperCase().match(RE_TICKET);
  if (ticket) return { tipo: 'ticket', codigo: ticket[1] };

  const compacto = t.toUpperCase().replace(/[\s-]/g, '');
  if (RE_CODIGO.test(compacto)) return { tipo: 'ticket', codigo: compacto };

  if (/^https?:\/\//i.test(t)) {
    try {
      for (const [clave, valor] of new URL(t).searchParams) {
        if (/^(run|rut)$/i.test(clave)) {
          const rut = normalizarRut(valor);
          if (rut) return { tipo: 'rut', rut, fuente: 'cedula' };
        }
      }
    } catch { /* URL mal formada: se sigue con los demás formatos */ }
  }

  if (/^[\d.\s]{6,12}-?\s*[\dkK]$/.test(t)) {
    const rut = normalizarRut(t);
    if (rut) return { tipo: 'rut', rut, fuente: 'texto' };
  }

  for (const m of t.matchAll(/[A-Za-z0-9._-]+@inacapmail\.cl\b/gi)) {
    const email = correoInstitucional(m[0]);
    if (email) return { tipo: 'email', email };
  }
  return null;
}

export { extraerIdentidad, PREFIJO_TICKET };
