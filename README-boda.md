# 💍 Invitación de boda — Guía completa

Sitio de invitación de una sola página, elegante y optimizado para celular.
Todo vive en **`index.html`** (HTML + CSS + JS en un solo archivo), más la carpeta
**`/images`** para las fotos.

---

## 1. Personaliza el contenido

Abre `index.html` y busca los comentarios marcados con **`✎ EDITAR`**. Ahí cambias:

| Qué | Dónde buscar |
|-----|--------------|
| Nombres de la pareja | `✎ EDITAR: nombres de la pareja` |
| Frase de portada | `✎ EDITAR: frase corta` |
| Fecha visible | `✎ EDITAR: fecha` |
| **Fecha/hora del countdown** | `data-target="2026-11-14T17:00:00"` (formato `AAAA-MM-DDTHH:MM:SS`, hora local) |
| Nuestra historia | `✎ EDITAR: mensaje de bienvenida` |
| Ceremonia y celebración | `✎ EDITAR: ceremonia` / `✎ EDITAR: celebración` |
| Dress code y regalos | `✎ EDITAR: dress code` / `✎ EDITAR: regalos` |
| Título de la pestaña | `✎ EDITAR: título de la pestaña` |

### Mapa de Google Maps

1. Entra a [Google Maps](https://maps.google.com) y busca tu lugar.
2. Botón **Compartir → Insertar un mapa → Copiar HTML**. Copia solo el enlace del `src="..."`.
3. En `index.html` busca `✎ EDITAR: reemplaza el src del iframe` y pega tu enlace dentro de `src="..."`.
4. Justo debajo, en el botón **"Cómo llegar"**, pon en `href` el enlace normal de tu lugar
   (Compartir → Copiar vínculo). Así abre las indicaciones en el celular.

### Fotos de la galería

Coloca tus fotos en `/images` con los nombres `1.jpg`, `2.jpg`, … (ver `images/README.md`).

---

## 2. Publica en Netlify (enlace público)

Tienes **dos formas**. La opción A es la más rápida; la B se actualiza sola cada vez que
haces cambios en GitHub.

### Opción A — Arrastrar y soltar (la más simple)

1. Crea una cuenta gratis en **https://app.netlify.com** (puedes entrar con tu correo o GitHub).
2. En el panel, ve a **Sites** y busca el recuadro que dice
   **"Drag and drop your site output folder here"** (o **Add new site → Deploy manually**).
3. Arrastra la **carpeta completa del proyecto** (la que contiene `index.html`, `netlify.toml`
   y la carpeta `images`) a ese recuadro.
4. En segundos tendrás un enlace público tipo `https://nombre-al-azar.netlify.app`.
5. Para cambiar el nombre: **Site configuration → Change site name**
   (ej.: `isabela-y-mateo.netlify.app`).

> Cada vez que edites algo, vuelve a arrastrar la carpeta para actualizar el sitio.

### Opción B — Conectar con GitHub (se actualiza solo)

1. En Netlify: **Add new site → Import an existing project → GitHub**.
2. Autoriza y elige este repositorio (`nmaldonadod/diplomado_ciber`),
   rama `claude/wedding-invitation-site-lulhnm`.
3. Netlify leerá el archivo `netlify.toml`:
   - **Build command**: *(vacío)*
   - **Publish directory**: `.`
4. Pulsa **Deploy**. Cada `git push` a esa rama volverá a publicar el sitio automáticamente.

---

## 3. Ver las confirmaciones (RSVP)

El formulario usa **Netlify Forms**, así que las respuestas se guardan solas.

1. En tu sitio de Netlify entra a **Forms** (menú lateral).
2. Verás un formulario llamado **`rsvp`** con cada confirmación: nombre, correo,
   asistencia, número de acompañantes y mensaje.
3. Opcional — recibir un correo por cada respuesta:
   **Forms → Settings and notifications → Add notification → Email notification**.

> ⚠️ **Importante:** Netlify solo detecta el formulario cuando el sitio está **publicado en Netlify**
> (no funciona abriendo el archivo localmente ni en otro hosting). Si haces el primer deploy y no
> ves el formulario en la pestaña *Forms*, entra a
> **Site configuration → Build & deploy → Form detection** y verifica que esté activado; luego
> vuelve a desplegar (re-deploy).

---

## 4. Probar en tu computadora (opcional)

Solo para revisar el diseño antes de publicar:

```bash
# Con Python (viene en la mayoría de los equipos):
python3 -m http.server 8000
# Luego abre http://localhost:8000 en el navegador
```

El **envío del RSVP solo funcionará una vez publicado en Netlify**; en local verás
el resto del sitio pero el formulario no guardará datos.

---

¡Felicidades por tu boda! 🥂
