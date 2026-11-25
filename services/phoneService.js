const { parsePhoneNumberFromString } = require('libphonenumber-js/max');

function validatePhone(value, defaultCountry = undefined) {
  const original = value === null || value === undefined ? '' : String(value).trim();
  if (!original) return { status: 'missing', e164: null, reason: null };

  let parsed;
  try {
    parsed = parsePhoneNumberFromString(original, defaultCountry || undefined);
  } catch {
    parsed = undefined;
  }

  if (!parsed) {
    return { status: 'invalid', e164: null, reason: 'Number could not be parsed.' };
  }
  if (parsed.isValid()) {
    return { status: 'valid', e164: parsed.number, reason: null };
  }
  if (parsed.isPossible()) {
    return { status: 'suspicious', e164: null, reason: 'Number length is possible, but its numbering pattern is not valid.' };
  }
  return { status: 'invalid', e164: null, reason: 'Number length or calling code is invalid.' };
}

module.exports = { validatePhone };
