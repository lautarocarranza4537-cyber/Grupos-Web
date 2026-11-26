# Grupos-Web

Directorio público para buscar y publicar grupos. Incluye perfil del grupo, foto, categoría, descripción, enlace público para unirse y animaciones livianas de píxeles que se desvanecen, destellos al tocar y entradas progresivas al desplazarse. Las animaciones respetan la preferencia de reducir movimiento del dispositivo. Las publicaciones quedan en PostgreSQL y se comparten entre todos los visitantes. Cada publicación puede marcarse como abierta o cerrada a nuevos miembros; las fichas cerradas siguen visibles y buscables, pero no muestran la acción para unirse ni copiar la invitación. Las publicaciones antiguas se conservan abiertas por defecto. No requiere Supabase, claves de API, ni editar un archivo de configuración.

## Cómo se guardan las fotos y publicaciones

Las fotos se reducen en el navegador y quedan almacenadas como datos de imagen junto a la publicación en PostgreSQL. Cada publicación también puede incluir reglas o detalles públicos opcionales (hasta 1.200 caracteres), editables por quien la publicó. El código crea la tabla y aplica migraciones aditivas automáticamente al iniciar. Por eso la web necesita una base PostgreSQL persistente conectada por `DATABASE_URL`; no guardes publicaciones en el disco efímero del servicio web.

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

En la ficha de cada grupo se sugieren hasta cuatro publicaciones públicas de la misma categoría, sin incluir el grupo actual ni publicaciones ocultas. La lista se consulta de forma acotada y solo expone identificador, nombre y categoría.

Los formularios validan campos y enlaces HTTP(S), procesan las imágenes para reducir su tamaño, limitan el tamaño de la solicitud, limitan la frecuencia de publicaciones e intentos de cuenta y verifican acciones por sesión. El directorio es público y cualquiera puede ver sus perfiles. Los comentarios anónimos siguen siendo públicos, pero solo una cuenta que publicó un comentario con su perfil puede editarlo o borrarlo; las respuestas requieren iniciar sesión, se limitan a un nivel y quedan asociadas al grupo y al comentario raíz. Borrar un comentario raíz también borra sus respuestas. Se pueden denunciar publicaciones/grupos y comentarios individuales; las denuncias no son públicas y no incluyen información del denunciante en la cola privada. La cola de moderación permanece deshabilitada hasta que el responsable configure un secreto seguro.


## Ayuda pública

La página `/ayuda.html` reúne instrucciones sobre búsqueda, estados de membresía, publicación, cuentas y precauciones al abrir invitaciones. También aclara que el contenido es aportado por usuarios, que las denuncias no garantizan respuesta y que la cola privada de revisión sigue deshabilitada hasta configurar el secreto requerido. Es información de uso; no se presenta como canal de soporte ni como política legal.

## Denuncias y moderación

Las denuncias de publicaciones y comentarios se validan por motivo, se limitan conjuntamente a 3 por hora y dirección de origen, y tienen un tope de 100 abiertas por grupo y 2.000 en total. Se asocian al objeto denunciado y, si existe, al usuario autenticado; la lista privada no revela la identidad del denunciante. Para habilitar la cola privada de moderación, configurá en el entorno del servicio una variable `MODERATION_TOKEN` de al menos 32 caracteres aleatorios y mantenela fuera del repositorio, el navegador, las URLs y los mensajes. Sin esa variable, los endpoints privados devuelven 503 y no hay interfaz administrativa pública. Ver `MODERATION.md` para el uso de la API protegida.

La base gratuita de Render mencionada en la interfaz tiene vencimiento; no se configuró ni verificó una copia de seguridad o restauración. Antes de depender de estas publicaciones, confirmá el vencimiento exacto en Render y prepara una exportación/restauración en un destino persistente. No se debe cambiar el plan ni aceptar costos sin consentimiento.
