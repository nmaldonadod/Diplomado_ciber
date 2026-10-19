// Punto de entrada del Worker: sirve el frontend, las fotos de docentes y deriva la API al Durable Object.
// Todas las respuestas salen con cabeceras de seguridad.
import { aplicarCabecerasSeguridad, rangoPedido } from './http.js';

export { EventoDO } from './evento.js';

const PAGINAS = { '/': '/index.html', '/acreditacion': '/acreditacion.html', '/admin': '/admin.html', '/privacidad': '/privacidad.html' };
// Sólo se publican recursos de carpetas conocidas con nombres simples.
const RECURSO = /^\/(css|js|vendor|img|fuentes|video)\/[\w.-]+$|^\/[\w-]+\.(webmanifest|svg)$/;
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
  const salida = res.status === 200 && ruta.startsWith('/video/') ? await conRango(request, res) : new Response(res.body, res);
  // HTML, CSS y JS se revalidan siempre (ETag) para que un despliegue llegue de inmediato a todos.
  const largo = /^\/(fuentes|img|video)\//.test(ruta) || ruta.endsWith('.svg') ? 'public, max-age=86400' : 'no-cache';
  salida.headers.set('Cache-Control', largo);
  return salida;
}

// Safari en iPhone pide el video por rangos de bytes y no lo reproduce sin respuestas 206. Si el servidor de archivos
// no las da (entorno local), se recorta aquí.
async function conRango(request, res) {
  const ifRange = request.headers.get('If-Range');
  const etag = res.headers.get('ETag');
  if (request.method === 'HEAD' || !request.headers.has('Range') || (ifRange && ifRange !== etag)) {
    const r = new Response(res.body, res);
    r.headers.set('Accept-Ranges', 'bytes');
    return r;
  }
  const datos = new Uint8Array(await res.arrayBuffer());
  const rango = rangoPedido(request.headers.get('Range'), datos.length);
  const headers = new Headers(res.headers);
  headers.set('Accept-Ranges', 'bytes');
  if (!rango) {
    headers.set('Content-Range', `bytes */${datos.length}`);
    headers.delete('Content-Length');
    return new Response(null, { status: 416, headers });
  }
  const [inicio, fin] = rango;
  headers.set('Content-Range', `bytes ${inicio}-${fin}/${datos.length}`);
  headers.set('Content-Length', String(fin - inicio + 1));
  return new Response(datos.subarray(inicio, fin + 1), { status: 206, headers });
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
