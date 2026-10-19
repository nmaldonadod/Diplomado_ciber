# Mes de la Ciberseguridad · plataforma de eventos INACAP

Aplicación web para el evento, pensada para usarse desde el teléfono. El mismo código corre **en Docker**
(servidor Node.js con SQLite) o en **Cloudflare Workers** (Durable Object + R2).
Tiene **tres interfaces**, cada una con sus propios permisos:

| Interfaz | URL | Quién | Qué hace |
|---|---|---|---|
| **Estudiante** | `/` | Cualquier estudiante | Ve la agenda y los talleres con cupos en vivo, se inscribe, elige talleres (al inscribirse o después) y obtiene su entrada con código QR |
| **Acreditador** | `/acreditacion` | Cuentas con rol *acreditador* (o *admin*) | Escanea el QR de la entrada con la cámara del teléfono, busca estudiantes e inscribe presencialmente |
| **Administrador** | `/admin` | Cuentas con rol *admin* | Configura el evento, crea talleres (título, descripción, cupos, horario, sala, **foto del docente**), arma la agenda, importa cambios desde un archivo, gestiona estudiantes y cuentas, exporta y revisa la auditoría |

Primero se indica si es **estudiante, docente o administrativo** (a docentes y administrativos no se les ofrecen talleres
al inscribirse, pero pueden verlos después). Luego: nombres · apellidos · RUT (con dígito verificador) · teléfono ·
correo institucional (`@inacapmail.cl` estudiantes, `@inacap.cl` docentes y administrativos) · sede (Santiago Centro, Santiago Sur, Rancagua, Talca, Curicó, Apoquindo, Valparaíso).
Luego un **resumen para revisar y confirmar**, con la aceptación de la política de privacidad. Si cambia de teléfono,
el estudiante **recupera su entrada con RUT + INACAPMAIL + sede**. En la acreditación se lee el QR de la entrada o el
**QR de la cédula de identidad**.

## Ejecutar con Docker (en tu computador)

Requisito: [Docker Desktop](https://www.docker.com/products/docker-desktop/).

```bash
cd evento
docker compose up -d --build
docker compose logs app        # muestra el token para crear el primer administrador
```

- Estudiantes: <http://localhost:8080> · Acreditación: <http://localhost:8080/acreditacion> · Administración: <http://localhost:8080/admin>
- La primera vez se carga solo el **Mes de la Ciberseguridad** (agenda y talleres).
- Los datos (base SQLite, fotos y claves) quedan en el volumen `eventos-inacap_datos` y sobreviven a reinicios.
  Para empezar de cero: `docker compose down -v` (**borra todo**).

**Probar desde teléfonos** (la cámara del acreditador exige HTTPS):

```bash
TRUST_PROXY=1 docker compose --profile tunel up -d --build
docker compose logs tunel | grep trycloudflare   # URL https://….trycloudflare.com para abrir en el teléfono
```

El túnel rápido de Cloudflare sirve para pruebas (dirección aleatoria, sin garantía de disponibilidad).

**Endurecimiento del contenedor:** usuario sin privilegios, sistema de archivos de sólo lectura (salvo el volumen de datos),
sin capacidades de Linux, `no-new-privileges`, límites de memoria y procesos, puerto publicado sólo en `127.0.0.1`,
dependencias de producción instaladas sin scripts y chequeo de salud.

Variables opcionales (archivo `.env` junto a `compose.yaml`): `DATA_KEY` y `TOKEN_CONFIGURACION`. Si no se definen,
se generan una vez y se guardan en el volumen (`/datos/secretos.json`, permisos 600).

Sin Docker: `npm ci && npm start` (Node.js 22.13 o superior).

## Publicar en Cloudflare (opcional)

### Arquitectura

```
Navegador ──HTTPS──▶ Worker (src/worker.js)
                      ├─ archivos del frontend (public/) con cabeceras de seguridad
                      ├─ /fotos/*  ──▶ R2 (fotos de docentes, sin metadatos)
                      └─ /api/*    ──▶ Durable Object «EventoDO» (src/evento.js)
                                        ├─ SQLite: estudiantes, talleres, agenda, cuentas, auditoría
                                        ├─ reglas de cupos y topes (una petición a la vez → nunca se sobrevenden)
                                        └─ WebSockets con hibernación: cupos en vivo
```

Al crearse por primera vez, el Durable Object carga el evento de `config/mes-ciberseguridad-2026.json`
(agenda completa y talleres). Después, todo se administra desde `/admin`.

### Despliegue

Requisitos de la cuenta de Cloudflare: plan **Workers Paid** (US$5/mes: la protección de contraseñas PBKDF2 necesita
más de los 10 ms de CPU del plan gratuito) y **R2** activado.

Desde tu computador (Node.js 22.13+; en Windows, con Git Bash):

```bash
cd evento
npm ci
npx wrangler login  # abre el navegador para autorizar tu cuenta (o define CLOUDFLARE_API_TOKEN y CLOUDFLARE_ACCOUNT_ID)
npm run desplegar   # pruebas, bucket R2, despliegue y secretos que falten; muestra el token del primer administrador
```

O paso a paso:

```bash
cd evento
npm install
npx wrangler r2 bucket create mes-ciberseguridad-fotos
openssl rand -base64 32 | npx wrangler secret put DATA_KEY           # clave de cifrado de datos personales
openssl rand -hex 12    | npx wrangler secret put TOKEN_CONFIGURACION # token para crear el primer administrador
npm run deploy
```

Luego abre `https://<tu-worker>.workers.dev/admin`, ingresa el **token de configuración** y crea tu cuenta de
administrador (el token deja de servir apenas existe uno). En **Usuarios** crea las cuentas de los acreditadores.

> **DATA_KEY** cifra correos y teléfonos. Es un secreto de Cloudflare (no se puede volver a leer); si se cambia, los
> datos ya guardados quedan ilegibles. No la cambies con inscripciones en curso.

#### Variables y secretos

| Nombre | Tipo | Descripción |
|---|---|---|
| `DATA_KEY` | secreto | 32 bytes en base64. Sin ella la API responde «falta configurar» (falla cerrada). |
| `TOKEN_CONFIGURACION` | secreto | Token de un solo uso para crear el primer administrador. |
| `ITERACIONES_CLAVE` | variable | Iteraciones PBKDF2 para contraseñas del staff (por defecto 600.000, recomendación OWASP). |
| `EVENTO_INICIAL` | variable | `no` desactiva la carga automática del evento de `config/`. |

### Actualizar agenda o talleres

- Desde **Administración → Evento → Importar desde archivo**, con un JSON del mismo formato que
  `config/mes-ciberseguridad-2026.json`. Reemplaza la agenda y actualiza los talleres (reconocidos por sala y día)
  sin perder inscripciones ni fotos.
- O editando cada taller en **Administración → Talleres**.

## Desarrollo local

```bash
cp .dev.vars.example .dev.vars   # completa DATA_KEY y TOKEN_CONFIGURACION
npm run dev                      # http://localhost:8787
npm test                         # pruebas unitarias + API contra ambos entornos (Cloudflare y Node/Docker)
```

## Seguridad y protección de datos personales

Diseñada considerando la Ley N.° 19.628 (y su actualización por la Ley N.° 21.719) y las recomendaciones OWASP.

**Datos personales**
- Minimización: sólo los datos necesarios (sin fotos ni datos sensibles de estudiantes).
- RUT, correo y teléfono **cifrados** (AES-256-GCM, claves derivadas con HKDF); búsqueda por RUT o correo mediante índices ciegos HMAC.
- Consentimiento explícito con fecha registrada y política de privacidad pública (`/privacidad`).
- Acceso según rol: el acreditador ve nombre, sede, talleres, y RUT y correo parcialmente ocultos; **no** ve teléfonos ni exporta.
- El administrador puede eliminar a un estudiante o **todos los datos** al terminar el evento (con confirmación y contraseña).
- Exportaciones CSV auditadas y protegidas contra inyección de fórmulas.

**Autenticación y sesiones**
- Staff: contraseñas de 12+ caracteres con **PBKDF2-SHA256 (600.000 iteraciones)**, bloqueo progresivo tras 5 intentos,
  mensajes que no revelan si una cuenta existe.
- Estudiantes: recuperan su entrada con RUT + INACAPMAIL + sede (deben coincidir los tres), con límite por IP y bloqueo
  de 15 minutos tras 5 intentos fallidos; cada recuperación queda auditada.
- Sesiones en el servidor (token de 256 bits guardado como hash), cookies `HttpOnly`, `Secure`, prefijo `__Host-`,
  `SameSite=Strict` para el staff; expiración por inactividad (admin 60 min, acreditador 3 h) y absoluta.

**Aplicación e infraestructura**
- HTTPS obligatorio con HSTS; protección DDoS de la red de Cloudflare.
- Validación estricta en el servidor; consultas SQL parametrizadas; transacciones atómicas.
- CSRF (verificación de `Origin`/`Sec-Fetch-Site` + JSON obligatorio); WebSocket sólo desde el mismo origen.
- Cabeceras: CSP estricta (`script-src 'self'`), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, COOP/CORP.
- Fuentes, imágenes y el video de portada alojados en la propia app (ninguna petición a terceros). El video no tiene
  sonido, pesa ~0,8 MB en teléfonos, se pausa fuera de pantalla y no se carga con «reducir movimiento» ni «ahorro de datos».
- Fotos: el navegador las recorta y convierte a JPEG; el servidor acepta sólo JPEG válidos ≤ 2 MB, **elimina metadatos** (EXIF/GPS) y usa nombres aleatorios.
- Límites de tamaño e intentos por IP real del cliente (`CF-Connecting-IP`); errores sin detalles internos.
- **Auditoría** de ingresos, intentos fallidos, accesos denegados, cambios, acreditaciones, exportaciones y eliminaciones.

## Estructura

```
evento/
├── wrangler.jsonc                    # configuración de Cloudflare (Worker, Durable Object, R2)
├── config/mes-ciberseguridad-2026.json
├── Dockerfile · compose.yaml          # ejecución local en Docker
├── src/
│   ├── node/         # servidor Node (Docker): SQLite en disco, fotos en volumen, WebSockets
│   ├── worker.js     # entrada: frontend, fotos (R2) y derivación de la API
│   ├── evento.js     # Durable Object: API, permisos por rol, tiempo real
│   ├── db.js         # esquema y consultas SQLite
│   ├── seguridad.js  # PBKDF2, AES-GCM, HMAC, tokens, limpieza JPEG (WebCrypto)
│   ├── validacion.js # reglas de validación
│   ├── http.js       # cabeceras de seguridad, cookies, CSRF, lectura de cuerpos
│   └── qr.js         # interpretación de lo escaneado en la acreditación
├── public/           # index.html (estudiante) · acreditacion.html · admin.html · privacidad.html
└── test/
```
