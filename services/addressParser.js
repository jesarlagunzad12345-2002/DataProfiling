const { standardizeCountry } = require('./countryService');

const usStates = new Map(Object.entries({
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
  TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia'
}).flatMap(([code, name]) => [[code.toLowerCase(), code], [name.toLowerCase(), code]]));

const caProvinces = new Map(Object.entries({
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador', NS: 'Nova Scotia', NT: 'Northwest Territories',
  NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec',
  SK: 'Saskatchewan', YT: 'Yukon'
}).flatMap(([code, name]) => [[code.toLowerCase(), code], [name.toLowerCase(), code]]));

const postalPatterns = {
  US: /^\d{5}(?:-\d{4})?$/i,
  CA: /^[A-Z]\d[A-Z][ -]?\d[A-Z]\d$/i,
  GB: /^(?:GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})$/i,
  AU: /^\d{4}$/,
  NZ: /^\d{4}$/,
  DE: /^\d{5}$/,
  FR: /^\d{5}$/,
  IN: /^\d{6}$/,
  JP: /^\d{3}-?\d{4}$/,
  NL: /^\d{4}\s?[A-Z]{2}$/i,
  BR: /^\d{5}-?\d{3}$/,
  SG: /^\d{6}$/
};

function emptyComponents() {
  return { street: null, city: null, region: null, postalCode: null, country: null, countryCode: null };
}

function cleanParts(value) {
  return value.split(/[,;\n]+/).map((part) => part.trim()).filter(Boolean);
}

function parseAddress(value, countryValue = '') {
  const raw = value === null || value === undefined ? '' : String(value).trim();
  const components = emptyComponents();
  if (!raw) {
    return { status: 'incomplete', components, issues: ['Address is empty.'] };
  }

  const parts = cleanParts(raw);
  const embeddedCountry = parts.length ? standardizeCountry(parts[parts.length - 1]) : null;
  const suppliedCountry = standardizeCountry(countryValue);
  const resolvedCountry = embeddedCountry && embeddedCountry.recognized
    ? embeddedCountry
    : suppliedCountry;

  if (embeddedCountry && embeddedCountry.recognized) {
    components.country = embeddedCountry.name;
    components.countryCode = embeddedCountry.alpha2;
    parts.pop();
  } else if (suppliedCountry.recognized) {
    components.country = suppliedCountry.name;
    components.countryCode = suppliedCountry.alpha2;
  }

  const issues = [];
  if (!resolvedCountry || !resolvedCountry.recognized) issues.push('Country could not be identified reliably.');
  if (parts.length === 0) {
    return { status: 'incomplete', components, issues: [...issues, 'Street and locality are missing.'] };
  }
  if (parts.length === 1) {
    components.street = parts[0];
    return { status: 'ambiguous', components, issues: [...issues, 'A single address component is not enough to separate the locality.'] };
  }

  components.street = parts[0];
  if (parts.length >= 2) components.city = parts[1];

  const countryCode = resolvedCountry && resolvedCountry.recognized ? resolvedCountry.alpha2 : null;
  const postalPattern = countryCode ? postalPatterns[countryCode] : null;
  if (postalPattern) {
    const last = parts[parts.length - 1];
    if (postalPattern.test(last)) {
      components.postalCode = last.toUpperCase();
      if (countryCode === 'US' && parts.length >= 4) {
        const regionCode = usStates.get(parts[parts.length - 2].toLowerCase());
        if (regionCode) components.region = regionCode;
        else issues.push('State or province could not be identified reliably.');
      } else if (countryCode === 'US') {
        issues.push('State or province could not be identified reliably.');
      } else if (parts.length >= 4 && countryCode === 'CA') {
        const regionCode = caProvinces.get(parts[parts.length - 2].toLowerCase());
        if (regionCode) components.region = regionCode;
        else issues.push('State or province could not be identified reliably.');
      } else if (countryCode === 'CA') {
        issues.push('State or province could not be identified reliably.');
      } else if (parts.length >= 4) {
        issues.push('Address component order is ambiguous; region was not inferred.');
      }
    } else if (countryCode === 'US') {
      const stateAndPostal = last.match(/^([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/i);
      if (stateAndPostal && usStates.has(stateAndPostal[1].toUpperCase())) {
        components.region = stateAndPostal[1].toUpperCase();
        components.postalCode = stateAndPostal[2];
      } else {
        issues.push('Postal code could not be identified reliably.');
      }
    } else {
      issues.push('Postal code could not be identified reliably.');
    }
  } else {
    issues.push('Postal code format is not supported for confident parsing.');
  }

  if (!components.postalCode && countryCode && ['US', 'CA', 'GB', 'AU', 'NZ', 'DE', 'FR', 'IN', 'JP', 'NL', 'BR', 'SG'].includes(countryCode)) {
    issues.push('Postal code is missing.');
  }
  return {
    status: issues.length ? 'ambiguous' : 'parsed',
    components,
    issues: [...new Set(issues)]
  };
}

module.exports = { parseAddress };
