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

## Gestión, contacto y seguridad

- Las publicaciones nuevas pueden incluir un número público de WhatsApp de contacto. La ficha abre un chat de WhatsApp; el teléfono es opcional y se advierte que será público. Las publicaciones anteriores siguen intactas y no tienen contacto si no se cargó uno.
- Al publicar se genera una clave aleatoria de administración. El servidor guarda solo su hash y el navegador la conserva localmente para que quien publicó pueda borrar esa ficha desde el mismo navegador. Si se borran los datos del navegador o se usa otro dispositivo, esa clave no se recupera automáticamente. Las publicaciones anteriores no tienen clave de propietario, así que no se pueden borrar mediante esta función sin una verificación segura.
- Bloquear es local a ese navegador: oculta todas las publicaciones que comparten el mismo contacto de WhatsApp; sin contacto, permite ocultar solo esa publicación. No es un bloqueo global ni una cuenta de usuario.
- Antes de insertar, se compara el enlace normalizado y se rechazan duplicados. La migración añade columnas e índice no único, conserva las publicaciones existentes y no borra duplicados antiguos.

Los formularios validan campos y enlaces HTTP(S), procesan las imágenes para reducir su tamaño, limitan el tamaño de la solicitud y restringen la frecuencia de publicaciones por IP. Es un directorio abierto: no hay cuentas ni revisión previa, así que cualquiera puede publicar. Para un sitio con mucho tráfico, conviene añadir autenticación o moderación.
