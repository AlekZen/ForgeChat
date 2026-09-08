function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function parseTechnicalContacts(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map(normalizePhone)
      .filter((number) => number.length >= 10 && number.length <= 15)
  );
}

function isTechnicalContact(value, contacts = parseTechnicalContacts(process.env.IA360_TECHNICAL_CONTACTS)) {
  const normalized = normalizePhone(value);
  return normalized.length > 0 && contacts.has(normalized);
}

module.exports = { normalizePhone, parseTechnicalContacts, isTechnicalContact };
