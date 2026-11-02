# Centro de Operaciones · Carga para vehículos eléctricos

Herramienta de trabajo para dos socios: 12 etapas, 69 tareas y 508 subtareas para validar, lanzar y escalar un negocio de instalación de cargadores en Argentina. Es un **sitio estático de un solo archivo** (`index.html`): sin build, sin frameworks, sin dependencias, funciona offline.

## Usarlo

- **Local:** abrir `index.html` con doble clic. También sirve `npm start` (http://localhost:5173), que aplica los mismos headers de seguridad que Vercel.
- **Datos:** se guardan en el `localStorage` del navegador (clave `ev-ops-v1`), automáticamente en cada cambio.
- **Compartir entre los dos socios:** `localStorage` no se comparte entre navegadores ni computadoras. Usen **Datos → Exportar JSON** y, del otro lado, **Datos → Importar JSON…** (valida el archivo y pide confirmación antes de reemplazar). Conviene exportar al terminar cada sesión de trabajo y acordar quién tiene la «versión vigente» para no pisarse.
- **Restablecer plan original:** menú Datos, con doble confirmación. Borra todo lo cargado.

## Publicar en Vercel

El proyecto ya trae `vercel.json` (headers de seguridad y `noindex`). Dos caminos:

1. **Con Git (recomendado):** subir esta carpeta a un repositorio de GitHub, entrar a vercel.com → *Add New… → Project* → elegir el repo. Framework Preset: **Other**. Sin comando de build ni carpeta de salida. Cada `git push` redespliega.
2. **Con la CLI:** `npx vercel` dentro de esta carpeta (la primera vez pide login y crea el proyecto) y `npx vercel --prod` para producción.

Cosas a tener en cuenta:

- **La URL es pública.** Cualquiera que la tenga puede abrirla y ver el plan precargado. Los datos que ustedes cargan *no* se suben a ningún servidor (viven en cada navegador), pero si el plan inicial es sensible conviene activar la protección de acceso de Vercel (Settings → Deployment Protection; las opciones disponibles dependen del plan).
- `noindex` evita que Google lo indexe, pero no es una medida de seguridad.
- Si cambian el contenido del plan, cambia solo lo que está en el bloque `SEED_DATA` de `index.html`. Ojo: los usuarios que ya tienen datos guardados **no** ven los cambios del plan; solo los ve quien restablece el plan o abre la app por primera vez.
- Si algún día cambia la estructura de los datos, hay que subir `SCHEMA_VERSION` y agregar una función en `MIGRATIONS` (están comentadas en el código) para que los datos viejos se migren solos.

## Estructura del código (`index.html`)

`0 Constantes · 1 Utilidades · 2 Plan precargado (SEED_DATA) · 3 Estado y validación · 4 Cálculo de progreso · 5 Persistencia (guardado, migración, export/import) · 6 Acciones · 7 Vistas · 8 Interfaz y eventos · 9 Arranque`.

El progreso **no se guarda**: siempre se calcula a partir del estado de las subtareas.

## Pruebas

```bash
npm test
```

Cubre la lógica pura (plan precargado, dependencias, progreso, próximas acciones, vencimientos, bitácora, persistencia, exportar/importar). Requiere Node 20 o superior; no instala nada.

## Compatibilidad

Navegadores actuales: Chrome/Edge, Firefox y Safari 16.4 o superior (usa `<dialog>`, `color-mix()` y `100dvh`).
