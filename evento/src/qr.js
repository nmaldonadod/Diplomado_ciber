'use strict';

const { normalizarRut } = require('./rut');

const PREFIJO_TICKET = 'EVT1:';
const RE_TICKET = /^EVT1:([A-Z2-9]{16})$/;

// Interpreta el texto leído desde un código QR/barras en la acreditación.
// Formatos soportados:
//  - Entrada del evento generada por la app:      EVT1:XXXXXXXXXXXXXXXX
//  - Cédula de identidad chilena (QR del reverso): https://portal.sidiv.registrocivil.cl/docstatus?RUN=12345678-5&type=CEDULA&...
//  - Credencial/carnet con un RUT con guion en su contenido (p. ej. carnet estudiantil).
//  - Un RUT escrito directamente (ingreso manual).
function extraerIdentidad(texto) {
  const t = String(texto ?? '').trim().slice(0, 2048);
  if (!t) return null;

  const ticket = t.toUpperCase().match(RE_TICKET);
  if (ticket) return { tipo: 'ticket', codigo: ticket[1] };

  if (/^https?:\/\//i.test(t)) {
    try {
      const url = new URL(t);
      for (const [clave, valor] of url.searchParams) {
        if (/^(run|rut)$/i.test(clave)) {
          const rut = normalizarRut(valor);
          if (rut) return { tipo: 'rut', rut, fuente: /registrocivil/i.test(url.hostname) ? 'cedula' : 'url' };
        }
      }
    } catch {
      // URL mal formada: se sigue intentando con los patrones genéricos.
    }
  }

  // Texto que es sólo un RUT (con o sin puntos/guion).
  if (/^[\d.\s]{6,12}-?\s*[\dkK]$/.test(t)) {
    const rut = normalizarRut(t);
    if (rut) return { tipo: 'rut', rut, fuente: 'texto' };
  }

  // RUT con guion embebido en un texto más largo (credenciales).
  for (const m of t.matchAll(/(?<![\d.])(\d{1,2}\.?\d{3}\.?\d{3}-[\dkK])(?![\dkK])/g)) {
    const rut = normalizarRut(m[1]);
    if (rut) return { tipo: 'rut', rut, fuente: 'credencial' };
  }

  return null;
}

module.exports = { extraerIdentidad, PREFIJO_TICKET };
