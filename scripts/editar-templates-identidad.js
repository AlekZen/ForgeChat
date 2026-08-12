// Auditoría WhatsApp 12-ago-2026 · decisión de Alek: re-someter a Meta SOLO las 3
// plantillas que lee un desconocido primero (referido y aliado), para que la
// identidad en frío coincida con la del carril caliente («Alekito, el asistente de
// Alek») y para borrar del one-liner la afirmación que el sistema no puede
// verificar («Nos presentaron hace poco»).
//
// EDITA la plantilla aprobada (mismo nombre, mismo id) en vez de crear otra: así
// no hay que tocar el catálogo de código ni migrar metaTemplateName. Meta la pone
// en PENDING mientras revisa; durante ese rato el guard G-COLD del readout ya avisa
// al owner «aún no está aprobado por Meta, elige otra secuencia o espera» — degrada
// honesto, no en silencio.
//
// Se mandan TODOS los componentes (BODY + FOOTER + BUTTONS + example): un edit
// parcial con solo el BODY le borraría los botones a la plantilla.
//
//   docker exec forgecrm-backend node /app/scripts/editar-templates-identidad.js          # dry-run
//   docker exec forgecrm-backend node /app/scripts/editar-templates-identidad.js --apply

const pool = require('/app/src/db');
const { decrypt } = require('/app/src/util/crypto');
const { listTemplates, editTemplate } = require('/app/src/integrations/metaTemplates');

const APPLY = process.argv.includes('--apply');


// nombre -> nuevo texto del BODY. Mismo copy que ya usa el borrador caliente.
// OJO: el catálogo manda `ia360_aliado_mapa_colaboracion_v2` (la que trae los
// botones del opener), no la v1 — editar la v1 no cambia nada de lo que sale.
const NUEVO_BODY = {
  ia360_referido_oneliner:
    'Hola {{1}}, soy Alekito, el asistente de Alek. Alek prefiere darte la versión corta antes que una llamada a ciegas: IA360 evita que el seguimiento se caiga entre WhatsApp, el CRM, la agenda y la gente. ¿Quieres explorar si aplica a tu caso?',
  ia360_referido_contexto:
    'Hola {{1}}, soy Alekito, el asistente de Alek. Te escribo porque nos presentó {{2}} y, antes de mandarte cualquier propuesta, Alek quiere entender tu contexto para no escribirte algo fuera de lugar. ¿Cómo prefieres empezar?',
  ia360_aliado_mapa_colaboracion_v2:
    'Hola {{1}}, soy Alekito, el asistente de Alek. Alek me pidió escribirte porque te ve como posible aliado, no como cliente: quiere explorar si IA360 les sirve a los clientes que tú ya atiendes cuando tienen fricción en WhatsApp, CRM o procesos repetidos. ¿Te hago una pregunta corta para mapear si hay fit?',
};

(async () => {
  const { rows } = await pool.query(
    `SELECT id, waba_id, access_token_encrypted FROM coexistence.whatsapp_accounts
      WHERE is_active ORDER BY is_default DESC LIMIT 1`
  );
  if (!rows.length) throw new Error('sin cuenta de WhatsApp activa');
  const token = decrypt(rows[0].access_token_encrypted);
  const tpls = await listTemplates(rows[0].waba_id, token, { fields: 'name,status,id,components', limit: 100 });

  for (const nombre of Object.keys(NUEVO_BODY)) {
    const tpl = tpls.find(t => t.name === nombre);
    if (!tpl) { console.log(`  [omitido] ${nombre}: no existe en Meta`); continue; }
    if (tpl.status !== 'APPROVED') { console.log(`  [omitido] ${nombre}: status ${tpl.status} (solo se editan APPROVED)`); continue; }

    const components = (tpl.components || []).map(c =>
      c.type === 'BODY' ? { ...c, text: NUEVO_BODY[nombre] } : c
    );
    const body = components.find(c => c.type === 'BODY');
    const vars = (NUEVO_BODY[nombre].match(/\{\{\d+\}\}/g) || []).length;
    const ejemplos = body?.example?.body_text?.[0]?.length || 0;
    if (vars !== ejemplos) throw new Error(`${nombre}: ${vars} variables pero ${ejemplos} ejemplos — Meta lo rechazaría`);

    if (!APPLY) {
      console.log(`  [editaría] ${nombre} (${tpl.id}) · ${components.length} componentes · ${vars} variables`);
      console.log(`             ${NUEVO_BODY[nombre].slice(0, 100)}…`);
      continue;
    }
    try {
      await editTemplate(tpl.id, token, { components });
      // El PENDING de Meta se guarda local como 'SUBMITTED' (es el mapeo que usa
      // /templates/sync; el check constraint de la tabla no acepta 'PENDING').
      // Con esto el guard G-COLD del readout ya no cree que está aprobada.
      await pool.query(
        `UPDATE coexistence.message_templates SET status = 'SUBMITTED', updated_at = NOW() WHERE name = $1`,
        [nombre]
      );
      console.log(`  [OK] ${nombre} enviada a revisión de Meta (local: SUBMITTED hasta que aprueben)`);
    } catch (e) {
      console.error(`  [FALLO] ${nombre}: ${e.message}`);
    }
  }
  if (!APPLY) console.log('\n  Dry-run: no se tocó Meta. Corre con --apply para enviarlas a revisión.');
  process.exit(0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
