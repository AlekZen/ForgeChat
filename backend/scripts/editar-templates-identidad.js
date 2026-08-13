// Auditoría WhatsApp 12-ago-2026 · decisión de Alek: alinear la identidad de las
// plantillas frías con la del carril caliente («Alekito, el asistente de Alek»).
// En Meta hay 23 APPROVED que todavía dicen «soy la IA de Alek»; aquí se corrigen
// SÓLO las 10 con envíos en los últimos 60 días. Las 13 dormidas se quedan como
// están: cada edición cuesta una revisión de Meta y una ventana sin poder salir en
// frío, y no se paga esa ventana por una plantilla que nadie usa.
//
// CÓMO SE CORRIGE (y por qué así): el cuerpo nuevo NO se escribe a mano. Es el
// cuerpo actual de Meta con UNA sustitución literal de la frase. Copy escrito a
// mano es como se cuelan cambios no pedidos; esto es mecánico y verificable. Si la
// frase no aparece exactamente una vez, el script REVIENTA con el nombre: quiere
// decir que el copy cambió y lo revisa una persona, no lo adivina el script.
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

// Las 10 con envíos en los últimos 60 días, de más usada a menos. Las otras 13
// APPROVED con la identidad vieja siguen dormidas a propósito.
const EN_USO = [
  'ia360_beta_architectura', 'ia360_cliente_readout', 'ia360_cfo_control',
  'ia360_comercial_pipeline', 'ia360_sponsor_diagnostico', 'ia360_tecnico_arquitectura',
  'ia360_cliente_expansion', 'ia360_aliado_criterios_fit', 'ia360_beta_feedback',
  'ia360_cliente_soporte',
];
const VIEJA = 'soy la IA de Alek';
const NUEVA = 'soy Alekito, el asistente de Alek';

(async () => {
  const { rows } = await pool.query(
    `SELECT id, waba_id, access_token_encrypted FROM coexistence.whatsapp_accounts
      WHERE is_active ORDER BY is_default DESC LIMIT 1`
  );
  if (!rows.length) throw new Error('sin cuenta de WhatsApp activa');
  const token = decrypt(rows[0].access_token_encrypted);
  const tpls = await listTemplates(rows[0].waba_id, token, { fields: 'name,status,id,components', limit: 200 });

  for (const nombre of EN_USO) {
    const tpl = tpls.find(t => t.name === nombre);
    if (!tpl) { console.log(`  [omitido] ${nombre}: no existe en Meta`); continue; }
    if (tpl.status !== 'APPROVED') { console.log(`  [omitido] ${nombre}: status ${tpl.status} (solo se editan APPROVED)`); continue; }

    const actual = (tpl.components || []).find(c => c.type === 'BODY');
    const texto = actual?.text || '';
    const ocurrencias = texto.split(VIEJA).length - 1;
    if (ocurrencias !== 1) {
      throw new Error(`${nombre}: la frase «${VIEJA}» aparece ${ocurrencias} veces (se esperaba 1) — el copy cambió, revísalo a mano`);
    }
    const nuevoTexto = texto.replace(VIEJA, NUEVA);

    const components = (tpl.components || []).map(c =>
      c.type === 'BODY' ? { ...c, text: nuevoTexto } : c
    );
    const body = components.find(c => c.type === 'BODY');
    const vars = (nuevoTexto.match(/\{\{\d+\}\}/g) || []).length;
    const ejemplos = body?.example?.body_text?.[0]?.length || 0;
    if (vars !== ejemplos) throw new Error(`${nombre}: ${vars} variables pero ${ejemplos} ejemplos — Meta lo rechazaría`);

    if (!APPLY) {
      console.log(`  [editaría] ${nombre} (${tpl.id}) · ${components.length} componentes · ${vars} variables · ${nuevoTexto.length} caracteres`);
      console.log(`             ${nuevoTexto.slice(0, 90)}…`);
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
