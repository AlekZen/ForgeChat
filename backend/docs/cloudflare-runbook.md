# Runbook — Cloudflare control plane (DIAPAZO) — proyecto Hermes

Para humanos y agentes (Claude/Codex) que corren EN el VPS dentro de este repo.
El token vive en `backend/.env` (gitignored) como `CLOUDFLARE_API_TOKEN`. NUNCA commitear el valor.

## IDs
- CLOUDFLARE_ACCOUNT_ID = 65be1221d0776b7b9dd75d2b209a6edc
- CF_ZONE_DIAPAZO (diapazo.com) = 1bf1cf8988603a9302a121b58d866b64

## Helper
`backend/scripts/cf.sh` (project-aware: lee backend/.env, fallback ~/.secrets/cloudflare.env).
```
bash scripts/cf.sh verify
bash scripts/cf.sh zones
bash scripts/cf.sh email status diapazo.com
bash scripts/cf.sh email rules  diapazo.com
bash scripts/cf.sh dns list     diapazo.com
bash scripts/cf.sh dns add      diapazo.com TXT _foo "valor"
bash scripts/cf.sh api GET /zones/$CF_ZONE_DIAPAZO/email/routing
```
Token scoped: DNS Write, Zone Read, Email Routing Rules/Addresses Write, Zone Settings Write,
Page Rules Write, SSL Write, Workers Scripts Write, Workers KV Write. (id aed18fe75cc9ca8b91238bf8f56bb81c)

## Email Routing diapazo.com (estado 2026-06-23)
enabled/ready. MX route1/2/3.mx.cloudflare.net, DKIM cf2024-1._domainkey, SPF + DMARC (_dmarc p=none).
Destinos: ocompudoc@gmail.com (Verified); alek@geekstudio.dev (PENDING verificar).
11 reglas forward -> ocompudoc@gmail.com: alek, hola, contacto, diagnostico, leads, ventas,
soporte, aliados, facturacion, alertas, no-reply. Catch-all=Drop/Disabled.
Pendiente: al verificar alek@geekstudio.dev, agregar 2o destino a regla alek (err 2054 si no).

## Crear correo/DNS/Worker por API (ejemplos)
```
ZONE=$CF_ZONE_DIAPAZO
bash scripts/cf.sh api POST /zones/$ZONE/email/routing/rules \
  "{\"name\":\"prensa\",\"enabled\":true,\"priority\":20,\"matchers\":[{\"type\":\"literal\",\"field\":\"to\",\"value\":\"prensa@diapazo.com\"}],\"actions\":[{\"type\":\"forward\",\"value\":[\"ocompudoc@gmail.com\"]}]}"
```

## Fallback sin token: API mismo-origen sobre el dashboard logueado
La UI nueva de Email Routing NO es automatizable con clicks (overlay + base-ui select).
Desde una pestana dash.cloudflare.com logueada: fetch("/api/v4/zones/<ZONE>/...", {credentials:"include"}).
api.cloudflare.com directo da CORS desde el browser.

## Gotchas
- Email Routing solo recibe/reenvia. Enviar como @diapazo.com -> Google Workspace/SMTP.
- 5g-billing-mongo: al reiniciar, ligar a 127.0.0.1:27017 (no 0.0.0.0).
- Copia espejo (vault de marketing): MKT/01-Proyectos/CloudFlare/Runbook - Control plane diapazo...
