# Grupos-Web

Directorio público para buscar y publicar grupos. Incluye perfil del grupo, foto, categoría, descripción, enlace público para unirse y animaciones livianas de píxeles que se desvanecen, destellos al tocar y entradas progresivas al desplazarse. Las animaciones respetan la preferencia de reducir movimiento del dispositivo. Las publicaciones quedan en PostgreSQL y se comparten entre todos los visitantes. No requiere Supabase, claves de API, ni editar un archivo de configuración.

## Cómo se guardan las fotos y publicaciones

Las fotos se reducen en el navegador y quedan almacenadas como datos de imagen junto a la publicación en PostgreSQL. El código crea la tabla automáticamente al iniciar. Por eso la web necesita una base PostgreSQL persistente conectada por `DATABASE_URL`; no guardes publicaciones en el disco efímero del servicio web.

## Antes de desplegar

1. En Render, crea una base de datos PostgreSQL (New → PostgreSQL). Elegí una región que también puedas usar para el servicio web.
2. En la base, copiá la **Internal Database URL** si el servicio web va a estar en Render.
3. En el servicio web, agregá `DATABASE_URL` como variable de entorno con esa URL. No la compartas ni la subas a GitHub.
4. Al iniciar, la app crea `groups_public` automáticamente.

## Publicación en Render desde GitHub

1. Subí esta carpeta a un repositorio nuevo en GitHub.
2. En Render elegí **New → Blueprint** y seleccioná el repositorio que contiene `render.yaml` (o **New → Web Service** y usá `npm install` / `npm start`).
3. Render creará el servicio Node. En **Environment**, cargá `DATABASE_URL` con la Internal Database URL de PostgreSQL, y `NODE_ENV=production`.
4. Deployá. El sitio estará disponible en la URL pública `.onrender.com` que Render asigne.
5. Probá la URL, cargá un grupo de prueba y recargá la página para comprobar que sigue guardado.

El servicio web puede usar el plan gratuito si aparece disponible en tu cuenta. La disponibilidad, límites y precio de PostgreSQL dependen de las opciones que Render muestre al crear la base; elegí una opción persistente antes de compartir la página.

## Uso en Termux

Una vez creados los archivos en `~/Grupos-Web`:

```sh
pkg update -y
pkg install nodejs-lts git -y
cd ~/Grupos-Web
npm install
```

Para probar localmente hace falta una base PostgreSQL y configurar su URL en el entorno:

```sh
export DATABASE_URL='URL_DE_TU_POSTGRES'
export NODE_ENV=development
npm start
```

Abrí `http://127.0.0.1:3000`. Para detener, Ctrl+C. No guardes una URL real de base de datos en archivos públicos.

## Cuentas, publicaciones y calificaciones

- Para publicar, votar o administrar tus grupos, creá una cuenta con usuario y contraseña. El usuario identifica al publicador; el servidor almacena la contraseña con scrypt y guarda sesiones en cookies HttpOnly y SameSite. Cada cuenta puede borrar sus publicaciones desde cualquier dispositivo después de iniciar sesión.
- No se solicita correo, por lo que no existe recuperación automática si olvidás la contraseña. Si recordás la actual, podés cambiarla desde tu cuenta; al hacerlo se cierran las demás sesiones. Elegí una contraseña larga y única, y guardala en un lugar seguro.
- Cada cuenta puede votar de 1 a 5 estrellas por grupo; puede cambiar su voto, pero cuenta una sola vez. El promedio y la cantidad de votos se muestran públicamente.
- Las publicaciones existentes no se asignan automáticamente a una cuenta: no hay forma segura de saber qué persona las creó. Para que cada grupo nuevo sea administrable, se publica desde una cuenta.
- El contacto opcional de WhatsApp sigue siendo público. El bloqueo anterior solo oculta publicaciones localmente en ese navegador; no bloquea mensajes de WhatsApp.
- Antes de insertar, se compara el enlace normalizado y se rechazan duplicados. Las migraciones son aditivas y no borran grupos ni votos.

Los formularios validan campos y enlaces HTTP(S), procesan las imágenes para reducir su tamaño, limitan el tamaño de la solicitud, limitan la frecuencia de publicaciones e intentos de cuenta y verifican acciones por sesión. El directorio es público y cualquiera puede ver sus perfiles. Los comentarios anónimos siguen siendo públicos, pero solo una cuenta que publicó un comentario con su perfil puede editarlo o borrarlo; las respuestas requieren iniciar sesión, se limitan a un nivel y quedan asociadas al grupo y al comentario raíz. Borrar un comentario raíz también borra sus respuestas. La cola de denuncias actual revisa publicaciones/grupos, no comentarios individuales.


## Denuncias y moderación

Las denuncias públicas se validan por motivo, se limitan a 3 por hora y dirección de origen, y tienen un tope de 100 abiertas por grupo y 2.000 en total. La lista de denuncias no es pública. Para habilitar la cola privada de moderación, configurá en el entorno del servicio una variable `MODERATION_TOKEN` de al menos 32 caracteres aleatorios y mantenela fuera del repositorio, el navegador, las URLs y los mensajes. Sin esa variable, los endpoints privados devuelven 503 y no hay interfaz administrativa pública. Ver `MODERATION.md` para el uso de la API protegida.

La base gratuita de Render mencionada en la interfaz tiene vencimiento; no se configuró ni verificó una copia de seguridad o restauración. Antes de depender de estas publicaciones, confirmá el vencimiento exacto en Render y prepara una exportación/restauración en un destino persistente. No se debe cambiar el plan ni aceptar costos sin consentimiento.
