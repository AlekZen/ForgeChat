'use strict';
async function recordContactEngagement(db, row) {
  if (!row || row.direction !== 'incoming' || !row.wa_number || !row.contact_number) return null;
  try {
    const { rows: cRows } = await db.query(
      "SELECT id, tags, custom_fields FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = $2 LIMIT 1",
      [row.wa_number, row.contact_number]
    );
    if (!cRows[0]) return null;
    const contact = cRows[0];
    const fields = (contact.custom_fields && typeof contact.custom_fields === 'object') ? { ...contact.custom_fields } : {};
    const ep = (fields.engagement_profile && typeof fields.engagement_profile === 'object') ? { ...fields.engagement_profile } : {};
    const counts = (ep.by_modality && typeof ep.by_modality === 'object') ? { ...ep.by_modality } : { button_or_list: 0, voice_note: 0, image_or_doc: 0, free_text: 0 };

    const mtype = String(row.message_type || 'text').toLowerCase();
    let modality = 'free_text';
    if (['button', 'interactive'].includes(mtype)) modality = 'button_or_list';
    else if (['audio', 'voice'].includes(mtype)) modality = 'voice_note';
    else if (['image', 'video', 'document', 'contacts', 'location'].includes(mtype)) modality = 'image_or_doc';

    counts[modality] = (Number(counts[modality]) || 0) + 1;

    // Measure response latency from previous outgoing message (engagement rhythm)
    const { rows: prevOut } = await db.query(
      "SELECT timestamp, message_type FROM coexistence.chat_history WHERE wa_number = $1 AND contact_number = $2 AND direction = 'outgoing' AND timestamp <= $3 ORDER BY timestamp DESC LIMIT 1",
      [row.wa_number, row.contact_number, row.timestamp || new Date().toISOString()]
    );
    let latencySec = null;
    if (prevOut[0]?.timestamp && row.timestamp) {
      const diff = (new Date(row.timestamp).getTime() - new Date(prevOut[0].timestamp).getTime()) / 1000;
      if (Number.isFinite(diff) && diff >= 0 && diff <= 86400) {
        latencySec = Math.round(diff);
      }
    }
    const prevSamples = Number(ep.latency_samples) || 0;
    const prevAvg = Number(ep.avg_response_latency_sec) || 0;
    const newAvg = latencySec !== null ? Math.round(((prevAvg * prevSamples) + latencySec) / (prevSamples + 1)) : prevAvg;

    // Determine top preferred modality
    const sortedModalities = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const preferredModality = sortedModalities[0]?.[0] || 'button_or_list';

    ep.by_modality = counts;
    ep.preferred_modality = preferredModality;
    ep.total_interactions = Object.values(counts).reduce((a, b) => a + Number(b || 0), 0);
    if (latencySec !== null) {
      ep.last_response_latency_sec = latencySec;
      ep.avg_response_latency_sec = newAvg;
      ep.latency_samples = prevSamples + 1;
    }
    ep.principles = ['micro-pasos-1-toque', 'ritmo-al-momento', 'cero-hostigamiento'];
    ep.updated_at = new Date().toISOString();
    fields.engagement_profile = ep;

    // Auto-calibrate tags based on observed behavior
    const tags = new Set(Array.isArray(contact.tags) ? contact.tags : []);
    if (counts.button_or_list >= 2) tags.add('prefiere-botones');
    if (counts.voice_note >= 1) tags.add('usa-voz');
    if (counts.image_or_doc >= 1) tags.add('multimodal');
    if (newAvg > 0 && newAvg <= 120) tags.add('alto-engagement');

    await db.query(
      "UPDATE coexistence.contacts SET tags = $2::jsonb, custom_fields = $3::jsonb, updated_at = NOW() WHERE id = $1",
      [contact.id, JSON.stringify([...tags]), JSON.stringify(fields)]
    );
    return { tags: [...tags], engagement_profile: ep };
  } catch (err) {
    console.error('[engagement-telemetry] error:', err.message);
    return null;
  }
}
module.exports = { recordContactEngagement };
