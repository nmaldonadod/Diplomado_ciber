# App de gestión del evento · Jornada de Ciberseguridad INACAP – ESET

Aplicación web para estudiantes y staff, pensada para usarse desde el teléfono.

| Para estudiantes (`/`) | Para staff (`/staff`) |
|---|---|
| Inscripción al evento con RUT validado | Acreditación leyendo el QR con la cámara del teléfono |
| Entrada digital con código QR | Lee el QR de la **entrada** o el QR de la **cédula de identidad (carnet)** |
| Elección de talleres (máximo configurable, sin topes de horario) | Búsqueda manual por RUT, nombre o correo |
| Cupos que se van completando **en tiempo real** | Inscripción presencial (inscribe + acredita en un paso) |
| Agenda completa por día y filtro “mi agenda” | Panel: inscritos, acreditados, cupos por taller, por sede |
| Recuperar la entrada en otro dispositivo (RUT + correo) | Exportar CSV (inscritos y listas por taller) |

## Requisitos

- **Node.js 22.13 o superior.** No hay dependencias npm: usa `node:sqlite` incorporado.
  Las librerías de QR (`qrcode-generator` MIT, `jsQR` Apache-2.0) están incluidas en `public/vendor/`,
  así la app funciona aunque el wifi del evento no tenga salida a internet.

## Uso

```bash
cd evento
STAFF_PIN=274913 npm start      # http://localhost:3000  y  http://localhost:3000/staff
npm test                        # pruebas unitarias y de API
```

### Variables de entorno

| Variable | Descripción | Por defecto |
|---|---|---|
| `STAFF_PIN` | PIN para el staff de acreditación (mín. 4 caracteres) | se genera uno aleatorio y se muestra en consola |
| `PORT` / `HOST` | Puerto / interfaz | `3000` / `0.0.0.0` |
| `DATA_DIR` | Carpeta de la base de datos SQLite | `./data` |
| `EVENTO_CONFIG` | Archivo de configuración del evento | `./config/evento.json` |
| `SESSION_SECRET` | Secreto para firmar sesiones del staff (si no se define, el staff debe volver a ingresar tras reiniciar) | aleatorio |
| `TLS_CERT` / `TLS_KEY` | Certificado y llave para servir por HTTPS directamente | — |
| `TRUST_PROXY` | `1` si corre detrás de un proxy HTTPS (Render, Railway, Nginx, Cloudflare Tunnel…) | — |

### ⚠️ La cámara necesita HTTPS

Los navegadores sólo permiten usar la cámara en `https://` (o `localhost`). Opciones:

- Publicar en un servicio con HTTPS (Render, Railway, Fly.io, una VM con Nginx + Let's Encrypt) con `TRUST_PROXY=1`.
- En la red local del evento: `TLS_CERT=cert.pem TLS_KEY=key.pem npm start`.
- Para probar rápido: `cloudflared tunnel --url http://localhost:3000`.

Si la cámara no está disponible, el staff igual puede acreditar escribiendo el RUT.

## Configurar el evento

Todo el contenido está en [`config/evento.json`](config/evento.json): nombre, lugar, días, agenda,
sedes, máximo de talleres por estudiante y talleres (con `cupos`). Al reiniciar, los talleres se
sincronizan con la base de datos **sin perder las inscripciones**. Para quitar un taller, elimínalo
del archivo (sus inscripciones quedan ocultas). Las horas se escriben en hora local del evento
(`"2026-11-12T14:30"`).

## Acreditación: qué códigos se leen

| Código | Contenido | Cómo se identifica |
|---|---|---|
| Entrada de la app | `EVT1:XXXXXXXXXXXXXXXX` | código único aleatorio del estudiante |
| Cédula de identidad chilena (QR del reverso) | `https://portal.sidiv.registrocivil.cl/docstatus?RUN=…` | se extrae y valida el RUN |
| Credencial / carnet estudiantil con QR | cualquier texto que contenga un RUT con guion | se extrae y valida el RUT |
| Ingreso manual | `12.345.678-5` | RUT |

En Android/Chrome se usa el lector nativo `BarcodeDetector`; en iPhone y otros navegadores se usa `jsQR`.
Resultado en pantalla, con sonido y vibración: **verde** acreditado · **ámbar** ya estaba acreditado
(muestra la hora) · **rojo** no inscrito (botón para inscribirlo en el momento). Toda acreditación
queda registrada con hora y nombre del acreditador, y se puede deshacer.

## Seguridad

- Sesiones con cookies `HttpOnly` + `SameSite=Lax` (`Secure` bajo HTTPS); token del estudiante guardado como hash SHA-256.
- Sesión del staff firmada con HMAC; PIN comparado en tiempo constante y con límite de intentos.
- Límite de intentos en inscripción y recuperación de acceso; verificación de `Origin` en peticiones que modifican datos.
- Consultas SQL parametrizadas; inscripción a talleres en transacción (no se sobrevenden cupos).
- Cabeceras CSP estrictas (`script-src 'self'`), `X-Frame-Options`, `nosniff`; el frontend no inserta datos de usuario con `innerHTML`.
- Exportación CSV protegida contra inyección de fórmulas.
- Consentimiento explícito para el tratamiento de datos personales al inscribirse.

## Estructura

```
evento/
├── server.js            # arranque HTTP/HTTPS
├── config/evento.json   # agenda, talleres y cupos
├── src/
│   ├── app.js           # API, sesiones, tiempo real (SSE), archivos estáticos
│   ├── db.js            # SQLite: estudiantes, talleres, inscripciones, acreditación
│   ├── qr.js            # interpretación de QR (entrada, cédula, credencial)
│   └── rut.js           # validación de RUT
├── public/              # frontend (estudiantes: index.html · staff: staff.html)
└── test/                # node --test
```
