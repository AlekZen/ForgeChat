# ForgeChat POC — wa.geekstudio.dev

Fecha: 2026-06-01

## URL pública

- https://wa.geekstudio.dev

## Ruta de despliegue

- Repo/compose: `/home/alek/stack/forgechat-poc`
- Caddy global: `/home/alek/stack/caddy/Caddyfile`
- Cloudflare Tunnel config: `/etc/cloudflared/config.yml`

## Servicios

Docker Compose en `/home/alek/stack/forgechat-poc`:

- `forgecrm-db` — PostgreSQL 15
- `redis` / container `forgecrm-redis` — Redis
- `forgecrm-backend` — Node backend en puerto interno `3011`
- `forgecrm-frontend` — Nginx frontend, publicado localmente en `127.0.0.1:4017`

Ingress:

- Cloudflare DNS/tunnel: `wa.geekstudio.dev`
- cloudflared ingress: `wa.geekstudio.dev` → `http://localhost:8094`
- Caddy local listener `:8094` → `127.0.0.1:4017`
- ForgeChat frontend `/api/*` proxy interno → backend `forgecrm-backend:3011`

## Configuración ajustada

- `backend/.env`: `CORS_ORIGIN=https://wa.geekstudio.dev`
- `backend/.env`: `NODE_ENV=production`

Credenciales admin locales guardadas en:

- `/home/alek/stack/forgechat-poc/.forgechat-credentials`

No exponer ese archivo en chats ni commits.

## Verificación ejecutada

- `https://wa.geekstudio.dev/` respondió `HTTP/2 200` vía Cloudflare/Caddy.
- HTML público contiene: `ForgeChat — Inbox & CRM for WhatsApp Business`.
- Login admin por API respondió `HTTP 200`.
- `/api/auth/me` con cookie respondió `HTTP 200`.
- Sesión admin expone páginas visibles:
  - `home`
  - `chats`
  - `contacts`
  - `pipelines`
  - `bulk-message`
  - `template-builder`
  - `chatbot-builder`
  - `media-library`
  - `admin-settings:whatsapp-accounts`
  - `admin-settings:users`

## Pendiente para Meta WhatsApp Cloud API real

1. Crear/configurar Meta App y WhatsApp Business Account.
2. Configurar callback público:
   - `https://wa.geekstudio.dev/api/webhook/whatsapp`
3. Usar el verify token configurado en `META_WEBHOOK_VERIFY_TOKEN`.
4. Cargar/guardar `META_ACCESS_TOKEN` y datos de cuenta/número desde la UI o env según flujo de ForgeChat.
5. Probar handshake webhook de Meta.
6. Probar envío/recepción real con número de prueba antes de producción.
7. Evaluar licencia Sustainable Use License antes de adopción productiva/comercial amplia.

## Despliegue G1 — cierre automático de envíos (2026-08-08)

- Migración aplicada: `db/migrations/050_outbound_correlation.sql`. Resultado: `ALTER TABLE`, backfill de 1590 filas salientes y creación del índice único parcial `idx_chat_outbound_correlation`.
- Backend reconstruido y recreado con `docker compose up -d --build forgecrm-backend`. Imagen resultante: manifest list `sha256:3b0e1314fb6d6b59382307079f7fae4038a169821af001746d2f32f871ca5883`.
- PostgreSQL y Redis permanecieron saludables durante el recreado; no se reiniciaron manualmente procesos Node.
- Comprobación directa dentro del contenedor: `GET http://127.0.0.1:3011/health` devolvió `{"ok":true}`.
- El canario de WhatsApp se ejecuta sólo después de confirmar con Alek el contacto, la cuenta y el contenido exacto.

- Correcciones de security review redesplegadas: sondeo por POST sin PII en URL, error público redactado, autorización de contacto en template test-send y harness Postgres/Redis efímero. Imagen final: manifest list `sha256:66768db1ae68a3a8c3a24dbd53a36e79bb05425f95586df12b7337afa94556cd`; health final `{"ok":true}`.

- Hallazgo de code review cerrado: migración `051_outbound_status_receipts.sql` aplicada (`CREATE TABLE`, `CREATE INDEX`) y conciliación desplegada para recibos Meta que llegan antes del enlace `local-* -> wamid`. Imagen final: manifest list `sha256:a87685976816021d8bb532753d0f860bd2fa2418c7fc212a7e1784df408a88e4`; health final `{"ok":true}`.

- Corrección definitiva del review: advisory lock transaccional por wamid, transiciones monotónicas, IDs acotados, TTL oportunista de 24 h y webhook HMAC fail-closed. Producción confirmó `META_APP_SECRET: configured` sin exponer su valor. Imagen final: manifest list `sha256:4c86fa1f5aacb77003e9fdde6937ac6e9ed645786d5ac8dcee617772d3d9579a`; health final `{"ok":true}`.
