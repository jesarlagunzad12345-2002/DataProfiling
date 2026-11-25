const countries = require('i18n-iso-countries');
const { getCountries, getCountryCallingCode } = require('libphonenumber-js/max');
countries.registerLocale(require('i18n-iso-countries/langs/en.json'));
const supportedPhoneCountries = new Set(getCountries());

const aliases = new Map([
  ['us', 'US'],
  ['usa', 'US'],
  ['unitedstatesofamerica', 'US'],
  ['uk', 'GB'],
  ['greatbritain', 'GB'],
  ['britain', 'GB'],
  ['unitedkingdomofgreatbritainandnorthernireland', 'GB'],
  ['england', 'GB'],
  ['uae', 'AE'],
  ['unitedarabemirates', 'AE'],
  ['southkorea', 'KR'],
  ['republicofkorea', 'KR'],
  ['northkorea', 'KP'],
  ['dprk', 'KP'],
  ['russia', 'RU'],
  ['russianfederation', 'RU'],
  ['czechrepublic', 'CZ'],
  ['ivorycoast', 'CI'],
  ['cotedivoire', 'CI'],
  ['vietnam', 'VN'],
  ['laos', 'LA'],
  ['iran', 'IR'],
  ['syria', 'SY'],
  ['taiwan', 'TW'],
  ['tanzania', 'TZ'],
  ['moldova', 'MD']
]);

function normalizeCountryText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '');
}

function standardizeCountry(value) {
  const original = value === null || value === undefined ? '' : String(value).trim();
  if (!original) {
    return { original, recognized: false, inconsistent: false, alpha2: null, alpha3: null, name: null };
  }

  const normalized = normalizeCountryText(original);
  let alpha2 = aliases.get(normalized);
  if (!alpha2 && /^[a-z]{2}$/i.test(original) && countries.isValid(original.toUpperCase())) {
    alpha2 = original.toUpperCase();
  }
  if (!alpha2 && /^[a-z]{3}$/i.test(original)) {
    alpha2 = countries.alpha3ToAlpha2(original.toUpperCase());
  }
  if (!alpha2) alpha2 = countries.getAlpha2Code(original, 'en');

  if (!alpha2 || !countries.isValid(alpha2)) {
    return { original, recognized: false, inconsistent: true, alpha2: null, alpha3: null, name: null };
  }

  const name = countries.getName(alpha2, 'en');
  const alpha3 = countries.alpha2ToAlpha3(alpha2);
  const normalizedCanonical = normalizeCountryText(name);
  const isCode = original.toUpperCase() === alpha2 || original.toUpperCase() === alpha3;
  return {
    original,
    recognized: true,
    inconsistent: !isCode && normalized !== normalizedCanonical,
    alpha2,
    alpha3,
    name
  };
}

function getCountryOptions() {
  return Object.entries(countries.getNames('en'))
    .filter(([alpha2]) => supportedPhoneCountries.has(alpha2))
    .map(([alpha2, name]) => ({ alpha2, name, callingCode: getCountryCallingCode(alpha2) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

module.exports = { standardizeCountry, getCountryOptions, normalizeCountryText };
