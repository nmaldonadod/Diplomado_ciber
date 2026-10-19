// Punto de entrada del Worker: sirve el frontend, las fotos de docentes y deriva la API al Durable Object.
// Todas las respuestas salen con cabeceras de seguridad.
import { aplicarCabecerasSeguridad } from './http.js';

export { EventoDO } from './evento.js';

const PAGINAS = { '/': '/index.html', '/acreditacion': '/acreditacion.html', '/admin': '/admin.html', '/privacidad': '/privacidad.html' };
// Sólo se publican recursos de carpetas conocidas con nombres simples.
const RECURSO = /^\/(css|js|vendor|img|fuentes)\/[\w.-]+$|^\/[\w-]+\.(webmanifest|svg)$/;
const FOTO = /^\/fotos\/([a-f0-9]{32}\.jpg)$/;

function noEncontrado() {
  return new Response('No encontrado', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

async function estatico(request, env, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Método no permitido', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const ruta = PAGINAS[url.pathname] || (RECURSO.test(url.pathname) && !url.pathname.includes('..') ? url.pathname : null);
  if (!ruta) return noEncontrado();
  const res = await env.ASSETS.fetch(new Request(new URL(ruta, url), request));
  if (!res.ok && res.status !== 304) return noEncontrado();
  const salida = new Response(res.body, res);
  // HTML, CSS y JS se revalidan siempre (ETag) para que un despliegue llegue de inmediato a todos.
  const largo = /^\/(fuentes|img)\//.test(ruta) || ruta.endsWith('.svg') ? 'public, max-age=86400' : 'no-cache';
  salida.headers.set('Cache-Control', largo);
  return salida;
}

async function foto(request, env, nombre) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
  const objeto = await env.FOTOS.get(nombre);
  if (!objeto) return noEncontrado();
  return new Response(request.method === 'HEAD' ? null : objeto.body, {
    headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400', ETag: objeto.httpEtag },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let res;
    if (url.pathname.startsWith('/api/')) {
      // Ninguna ruta acepta más de 2 MB (fotos): lo demás se rechaza aquí, antes de llegar a la base de datos.
      if (Number(request.headers.get('Content-Length')) > 2.5 * 1024 * 1024) {
        const r = new Response(JSON.stringify({ error: 'MUY_GRANDE', mensaje: 'Solicitud demasiado grande.' }), { status: 413, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
        aplicarCabecerasSeguridad(r.headers, url.protocol === 'https:');
        return r;
      }
      const stub = env.EVENTO.get(env.EVENTO.idFromName('principal'));
      res = await stub.fetch(request);
      if (res.status === 101) return res; // WebSocket: la respuesta no admite cambios
    } else {
      const m = url.pathname.match(FOTO);
      res = m ? await foto(request, env, m[1]) : await estatico(request, env, url);
    }
    const salida = new Response(res.body, res);
    aplicarCabecerasSeguridad(salida.headers, url.protocol === 'https:');
    return salida;
  },
};
