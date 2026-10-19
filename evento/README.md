# Plataforma de eventos INACAP

Aplicación web para gestionar eventos estudiantiles, pensada para usarse desde el teléfono.
Tiene **tres interfaces**, cada una con sus propios permisos:

| Interfaz | URL | Quién | Qué hace |
|---|---|---|---|
| **Estudiante** | `/` | Cualquier estudiante | Ve la agenda y los talleres con cupos en vivo, se inscribe, elige talleres (al inscribirse o después) y obtiene su entrada con código QR |
| **Acreditador** | `/acreditacion` | Cuentas con rol *acreditador* (o *admin*) | Escanea el QR de la entrada con la cámara del teléfono, busca estudiantes e inscribe presencialmente |
| **Administrador** | `/admin` | Cuentas con rol *admin* | Configura el evento, crea talleres (título, descripción, cupos, horario, sala, **foto del docente**), arma la agenda, gestiona estudiantes y cuentas, exporta y revisa la auditoría |

### Datos que se piden al estudiante

Nombres · Apellidos · Sede (Santiago Centro, Santiago Sur, Rancagua, Talca, Curicó, Apoquindo, Valparaíso) ·
INACAPMAIL (sólo se aceptan correos `@inacapmail.cl`) · Teléfono · aceptación de la política de privacidad.
Los talleres se pueden elegir en el mismo formulario o más tarde.

## Puesta en marcha

Requiere **Node.js 22.13 o superior**. No usa dependencias externas (base de datos SQLite incluida en Node).

```bash
cd evento
npm start            # la primera vez muestra en consola un token de configuración
```

1. Abre `http://localhost:3000/admin`, ingresa el **token de configuración** que aparece en la consola y crea tu cuenta de administrador.
2. En **Evento** completa nombre, fechas, lugar y contacto, y publícalo.
3. En **Talleres** crea los talleres con su foto del docente; en **Agenda**, las charlas y pausas.
4. En **Usuarios** crea las cuentas de los acreditadores.
5. Comparte `https://tu-dominio/` con los estudiantes y `https://tu-dominio/acreditacion` con los acreditadores.

Para cargar de una vez el **Mes de la Ciberseguridad 2026** (agenda completa y los 4 talleres en borrador) ejecuta `npm run cargar-evento` antes de `npm start`. Los datos están en `config/mes-ciberseguridad-2026.json`. Si el evento ya está cargado y cambias ese archivo, aplica los cambios con `npm run cargar-evento -- --actualizar`: actualiza datos, agenda y talleres (reconocidos por sala y día) sin perder inscripciones ni fotos.

### Variables de entorno

| Variable | Descripción |
|---|---|
| `DATA_KEY` | **Recomendada en producción.** Clave de cifrado de datos personales: 32 bytes en base64 (`openssl rand -base64 32`). Si no se define, se genera `data/clave.key`. **Respáldala aparte**: sin ella los correos y teléfonos no se pueden leer. |
| `DATA_DIR` | Carpeta de la base de datos, fotos y clave (por defecto `./data`, permisos 700) |
| `PORT` / `HOST` | Puerto e interfaz (por defecto `3000` / `0.0.0.0`) |
| `TLS_CERT` / `TLS_KEY` | Certificado y llave para servir HTTPS directamente |
| `TRUST_PROXY` | `1` si está detrás de un proxy HTTPS (Nginx, Render, Railway, Cloudflare). Sólo actívalo en ese caso. |

**La aplicación debe publicarse con HTTPS**: protege los datos en tránsito y, además, los navegadores sólo permiten usar la cámara (para acreditar) en sitios `https://`.

## Seguridad y protección de datos personales

Diseñada considerando la Ley N.° 19.628 (y su actualización por la Ley N.° 21.719) y las recomendaciones OWASP.

**Datos personales**
- Minimización: sólo se piden los datos necesarios (no RUT, no fotos de estudiantes).
- Correo y teléfono **cifrados en la base de datos** (AES-256-GCM); la búsqueda por correo usa un índice HMAC, sin guardar el correo en claro.
- Consentimiento explícito con fecha registrada y política de privacidad pública (`/privacidad`).
- Acceso según rol: el acreditador ve sólo nombre, sede, talleres y el correo parcialmente oculto; **no** ve teléfonos ni puede exportar.
- El administrador puede eliminar a un estudiante o **todos los datos** al terminar el evento (con confirmación y contraseña).
- Las exportaciones CSV quedan registradas en la auditoría.

**Autenticación y sesiones**
- Cuentas de staff con contraseñas de mínimo 12 caracteres, hash **scrypt** con sal, bloqueo progresivo tras 5 intentos fallidos y mensajes que no revelan si una cuenta existe.
- Estudiantes: entran con su INACAPMAIL + un **código de acceso** aleatorio entregado una sola vez (guardado con scrypt, con bloqueo tras 5 intentos). Si lo pierden, el administrador genera uno nuevo.
- Sesiones del lado del servidor (token aleatorio de 256 bits, guardado como hash), cookies `HttpOnly`, `Secure`, prefijo `__Host-`, `SameSite=Strict` para el staff. Expiración por inactividad (admin 60 min, acreditador 3 h) y absoluta.
- Al desactivar una cuenta, cambiar su rol o su contraseña se cierran todas sus sesiones. Siempre queda al menos un administrador activo.
- El primer administrador se crea con un token de un solo uso que sólo aparece en la consola del servidor.

**Aplicación**
- Validación estricta en el servidor de todos los datos; consultas SQL parametrizadas; transacciones para que los cupos nunca se sobrevendan.
- Protección CSRF (verificación de `Origin`/`Sec-Fetch-Site` y JSON obligatorio).
- Cabeceras: CSP estricta (`script-src 'self'`, sin scripts en línea), HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, COOP/CORP, `Permissions-Policy`.
- El frontend nunca inserta datos de usuarios como HTML.
- Fotos de docentes: el navegador las recorta y convierte a JPEG; el servidor sólo acepta JPEG válidos de hasta 2 MB, **elimina los metadatos** (EXIF/GPS) y las guarda con nombre aleatorio.
- Límites de tamaño de solicitudes y de intentos por IP; errores internos sin detalles para el cliente.
- CSV protegidos contra inyección de fórmulas.
- **Auditoría** de ingresos, intentos fallidos, accesos denegados, cambios, acreditaciones, exportaciones y eliminaciones (sin guardar datos personales en el registro).

**Recomendaciones de operación**
- Publicar sólo con HTTPS y definir `DATA_KEY` fuera del servidor.
- Respaldar `data/` (cifrado) y restringir el acceso al servidor.
- Entregar las contraseñas iniciales por un canal seguro y pedir que se cambien.
- Eliminar los datos de estudiantes cuando ya no sean necesarios.

## Pruebas

```bash
npm test
```

Cubren validaciones, cifrado, limpieza de imágenes, reglas de cupos y topes, permisos por rol, CSRF, bloqueo de cuentas, archivos protegidos y el flujo completo admin → estudiante → acreditador.

## Estructura

```
evento/
├── server.js               # arranque HTTP/HTTPS
├── config/mes-ciberseguridad-2026.json   # agenda y talleres del evento
├── scripts/cargar-evento.js
├── src/
│   ├── app.js              # API y permisos por rol
│   ├── db.js               # SQLite: evento, estudiantes, talleres, agenda, usuarios, auditoría
│   ├── seguridad.js        # scrypt, cifrado AES-GCM, tokens, limitador, limpieza JPEG
│   ├── validacion.js       # reglas de validación (sedes, INACAPMAIL, teléfono, contraseñas…)
│   ├── http.js             # cabeceras de seguridad, cookies, CSRF, lectura de cuerpos
│   └── qr.js               # interpretación de lo escaneado en la acreditación
├── public/                 # index.html (estudiante) · acreditacion.html · admin.html · privacidad.html
└── test/
```
