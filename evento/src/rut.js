'use strict';

// Utilidades para el RUT/RUN chileno (módulo 11).

function limpiar(valor) {
  return String(valor ?? '').replace(/[^0-9kK]/g, '').toUpperCase();
}

function calcularDV(cuerpo) {
  let suma = 0;
  let factor = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) {
    suma += Number(cuerpo[i]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const resto = 11 - (suma % 11);
  if (resto === 11) return '0';
  if (resto === 10) return 'K';
  return String(resto);
}

// Devuelve el RUT en forma canónica "12345678-5" o null si no es válido.
function normalizarRut(valor) {
  const limpio = limpiar(valor);
  if (limpio.length < 2 || limpio.length > 10) return null;
  const cuerpo = limpio.slice(0, -1);
  const dv = limpio.slice(-1);
  if (!/^\d+$/.test(cuerpo)) return null;
  const numero = Number(cuerpo);
  if (numero < 100000 || numero > 99999999) return null;
  if (calcularDV(cuerpo) !== dv) return null;
  return `${numero}-${dv}`;
}

// "12345678-5" -> "12.345.678-5"
function formatearRut(canonico) {
  const [cuerpo, dv] = String(canonico).split('-');
  return `${cuerpo.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}-${dv}`;
}

module.exports = { calcularDV, normalizarRut, formatearRut };
