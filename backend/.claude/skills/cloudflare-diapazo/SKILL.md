---
name: cloudflare-diapazo
description: Gestiona Cloudflare como control plane de DIAPAZO/Hermes (zona diapazo.com y demas zonas de la cuenta) — DNS, Email Routing, Workers, KV, SSL, Page Rules. Invocala cuando se pida configurar/revisar correo de diapazo, agregar alias o registros DNS, crear Workers/KV, o construir infra edge desde este proyecto.
---

# Cloudflare control plane — DIAPAZO (proyecto Hermes)

Runbook canonico: `docs/cloudflare-runbook.md`. Helper: `scripts/cf.sh`. Token en `backend/.env` (gitignored).

## IDs
- CLOUDFLARE_ACCOUNT_ID = 65be1221d0776b7b9dd75d2b209a6edc
- CF_ZONE_DIAPAZO = 1bf1cf8988603a9302a121b58d866b64

## Operar (desde la raiz backend)
```
bash scripts/cf.sh verify
bash scripts/cf.sh email status diapazo.com
bash scripts/cf.sh email rules  diapazo.com
bash scripts/cf.sh dns list     diapazo.com
bash scripts/cf.sh api <METHOD> <path> [json]
```

## Reglas
- El token es secreto: jamas commitearlo ni imprimirlo. Esta en backend/.env (CLOUDFLARE_API_TOKEN).
- Email Routing solo recibe/reenvia; enviar como @diapazo.com requiere Workspace/SMTP.
- Tras cambios verifica con cf.sh, no asumas.
- Fallback sin token: fetch mismo-origen sobre dash.cloudflare.com logueado (ver runbook).
