// Utilidades de prueba.
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

// Imita ctx.storage de un Durable Object (sql.exec + transactionSync) sobre node:sqlite.
export function almacenamientoFalso() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  return {
    db,
    sql: {
      exec(q, ...args) {
        const st = db.prepare(q);
        const filas = st.columns().length ? st.all(...args) : (st.run(...args), []);
        return { toArray: () => filas, one: () => filas[0] };
      },
    },
    transactionSync(fn) {
      db.exec('BEGIN');
      try {
        const r = fn();
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

function puertoLibre() {
  return new Promise((ok) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

// Levanta el Worker real con `wrangler dev` (runtime workerd) y una base de datos nueva.
export async function levantarWorker(vars = {}) {
  const puerto = await puertoLibre();
  const dir = mkdtempSync(path.join(tmpdir(), 'evento-wrangler-'));
  const todas = { EVENTO_INICIAL: 'no', ITERACIONES_CLAVE: '20000', ...vars };
  const args = ['wrangler', 'dev', '--port', String(puerto), '--ip', '127.0.0.1', '--persist-to', dir,
    '--inspector-port', String(await puertoLibre()), ...Object.entries(todas).flatMap(([k, v]) => ['--var', `${k}:${v}`])];
  const raiz = path.resolve(import.meta.dirname, '..');
  // Grupo de procesos propio para poder detener wrangler y workerd juntos.
  const proc = spawn(process.execPath, [path.join(raiz, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), ...args.slice(1)], {
    cwd: raiz, detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${puerto}`;
  for (let i = 0; i < 120; i++) {
    if (/Ready on/.test(log)) break;
    if (proc.exitCode !== null) throw new Error('wrangler dev terminó:\n' + log);
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!/Ready on/.test(log)) throw new Error('wrangler dev no inició:\n' + log);
  return {
    base,
    async cerrar() {
      const fin = new Promise((r) => (proc.exitCode !== null ? r() : proc.once('exit', r)));
      try {
        process.kill(-proc.pid, 'SIGTERM');
      } catch { /* ya terminó */ }
      await Promise.race([fin, new Promise((r) => setTimeout(r, 5000))]);
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch { /* ya terminó */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Cliente HTTP con cookies propias (simula un navegador).
export function cliente(base) {
  const cookies = {};
  return async function pedir(metodo, ruta, cuerpo, extra = {}) {
    const headers = { Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '), ...extra };
    let body;
    if (cuerpo instanceof Uint8Array) body = cuerpo;
    else if (cuerpo !== undefined) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      body = JSON.stringify(cuerpo);
    }
    const res = await fetch(base + ruta, { method: metodo, headers, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [par] = c.split(';');
      const i = par.indexOf('=');
      cookies[par.slice(0, i)] = par.slice(i + 1);
    }
    const tipo = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: tipo.includes('json') ? await res.json() : await res.text() };
  };
}
