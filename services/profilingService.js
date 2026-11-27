const crypto = require('node:crypto');
const { pool } = require('../config/database');
const profilingModel = require('../models/profilingModel');
const { iterateWorksheetRows } = require('./excelStreamService');
const { validatePhone } = require('./phoneService');
const { parseAddress } = require('./addressParser');
const { standardizeCountry } = require('./countryService');
const { normalizeCellValue, WorkbookValidationError } = require('./excelService');

const BATCH_SIZE = 200;
const MAX_BATCH_BYTES = 1024 * 1024;
const missingTokens = new Set(['na', 'n/a', 'null', 'undefined', 'missing']);

function normalizeText(value) {
  return normalizeCellValue(value)
    .normalize('NFKC')
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en');
}

function normalizeCompany(value) {
  return normalizeText(value).replace(/\b(?:co|corp|corporation|inc|incorporated|llc|ltd|limited)\b/g, '').replace(/\s+/g, ' ').trim();
}

function normalizeAddress(value) {
  return normalizeText(value)
    .replace(/\b(?:street)\b/g, 'st')
    .replace(/\b(?:avenue)\b/g, 'ave')
    .replace(/\b(?:road)\b/g, 'rd')
    .replace(/\b(?:boulevard)\b/g, 'blvd');
}

function normalizedPhone(value, defaultCountry) {
  const phone = validatePhone(value, defaultCountry);
  return phone.status === 'valid' ? phone.e164.replace(/\D/g, '') : normalizeText(value).replace(/\D/g, '');
}

function levenshteinSimilarity(left, right) {
  if (!left && !right) return 1;
  if (!left || !right) return 0;
  if (left === right) return 1;
  const rows = left.length + 1;
  const cols = right.length + 1;
  const distance = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) distance[i][0] = i;
  for (let j = 0; j < cols; j += 1) distance[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      distance[i][j] = Math.min(
        distance[i - 1][j] + 1,
        distance[i][j - 1] + 1,
        distance[i - 1][j - 1] + cost
      );
    }
  }
  return 1 - (distance[left.length][right.length] / Math.max(left.length, right.length));
}

function compareDuplicateRecords(left, right, thresholds = {}) {
  const available = [];
  const matching = [];
  const different = [];
  const reasons = [];
  const weights = { email: 28, phone: 25, company: 22, name: 18, address: 7 };
  let score = 0;
  let weightTotal = 0;

  for (const field of ['email', 'phone', 'company', 'name', 'address']) {
    const a = left.normalizedValues && left.normalizedValues[field];
    const b = right.normalizedValues && right.normalizedValues[field];
    if (!a || !b) continue;
    available.push(field);
    weightTotal += weights[field];
    const similarity = field === 'phone'
      ? (a === b ? 1 : levenshteinSimilarity(a, b))
      : levenshteinSimilarity(a, b);
    if (similarity >= 0.92) {
      matching.push(field);
      score += weights[field] * similarity;
      reasons.push(`${field[0].toUpperCase()}${field.slice(1)} is ${similarity === 1 ? 'identical' : 'very similar'} after normalization`);
    } else if (similarity >= 0.72) {
      matching.push(field);
      score += weights[field] * similarity;
      reasons.push(`${field[0].toUpperCase()}${field.slice(1)} has minor spelling or formatting differences`);
    } else {
      different.push(field);
    }
  }

  const confidence = weightTotal ? Math.round((score / weightTotal) * 100) : 0;
  const high = Number.isFinite(thresholds.high) ? thresholds.high : 80;
  const medium = Number.isFinite(thresholds.medium) ? thresholds.medium : 60;
  const low = Number.isFinite(thresholds.low) ? thresholds.low : 40;
  let label = 'Low Confidence';
  if (confidence >= 100 || (matching.length >= 2 && confidence >= high)) label = 'Exact Match';
  else if (confidence >= high) label = 'High Confidence';
  else if (confidence >= medium) label = 'Medium Confidence';
  else if (confidence < low) return null;

  if (matching.length === 1 && matching[0] === 'email' && confidence >= 80) {
    reasons.push('Email match is strong');
  }
  return { confidence, label, matchingFields: matching, differentFields: different, availableFields: available, reasons };
}

function isMissingValue(value) {
  const text = normalizeCellValue(value).trim();
  return text === '' || missingTokens.has(text.toLowerCase());
}

function valueAt(values, columnIndex) {
  return columnIndex === null || columnIndex === undefined
    ? ''
    : normalizeCellValue(values[columnIndex]);
}

function createFingerprint(salt, value) {
  return crypto.createHmac('sha256', salt).update(value).digest('hex');
}

function profileRecord(values, excelRowNumber, columns, options, salt) {
  const missingColumnIndexes = [];
  for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
    if (isMissingValue(values[columnIndex])) {
      missingColumnIndexes.push(columnIndex);
      columns[columnIndex].missingCount += 1;
    }
  }

  const suggestions = {};
  const issues = { missingColumnIndexes };
  let invalidPhone = false;
  let suspiciousPhone = false;
  let addressIssue = false;
  let countryInconsistent = false;
  let phoneDuplicateHash = null;
  let emailDuplicateHash = null;
  const normalizedValues = {};
  let normalizedCompanyHash = null;
  let normalizedNameHash = null;
  let normalizedAddressHash = null;

  if (options.phoneColumn !== null) {
    const phoneValue = valueAt(values, options.phoneColumn);
    const phone = isMissingValue(phoneValue)
      ? { status: 'missing', e164: null, reason: null }
      : validatePhone(phoneValue, options.defaultCountry);
    if (phone.status === 'valid') {
      suggestions.phone = { standardized: phone.e164 };
      phoneDuplicateHash = createFingerprint(salt, phone.e164);
    } else if (phone.status === 'invalid' || phone.status === 'suspicious') {
      invalidPhone = phone.status === 'invalid';
      suspiciousPhone = phone.status === 'suspicious';
      issues.phone = { status: phone.status, reason: phone.reason };
    }
    const normalizedPhoneValue = normalizedPhone(phoneValue, options.defaultCountry);
    if (normalizedPhoneValue) normalizedValues.phone = normalizedPhoneValue;
  }

  if (options.emailColumn !== null) {
    const email = valueAt(values, options.emailColumn).trim();
    if (email && !isMissingValue(email)) {
      const normalizedEmail = normalizeText(email).replace(/\s/g, '');
      normalizedValues.email = normalizedEmail;
      emailDuplicateHash = createFingerprint(salt, normalizedEmail);
    }
  }

  if (options.companyColumn !== null && options.companyColumn !== undefined) {
    const company = normalizeCompany(valueAt(values, options.companyColumn));
    if (company) {
      normalizedValues.company = company;
      normalizedCompanyHash = createFingerprint(salt, company);
    }
  }

  if (options.nameColumn !== null && options.nameColumn !== undefined) {
    const name = normalizeText(valueAt(values, options.nameColumn));
    if (name) {
      normalizedValues.name = name;
      normalizedNameHash = createFingerprint(salt, name);
    }
  }

  let country = null;
  if (options.countryColumn !== null) {
    const countryValue = valueAt(values, options.countryColumn);
    country = isMissingValue(countryValue)
      ? null
      : standardizeCountry(countryValue);
    if (country.original) {
      countryInconsistent = country.inconsistent;
      issues.country = {
        recognized: country.recognized,
        inconsistent: country.inconsistent
      };
      if (country.recognized && country.inconsistent) {
        suggestions.country = {
          standardized: country.name,
          iso2: country.alpha2,
          iso3: country.alpha3
        };
      }
    }
  }

  if (options.addressColumn !== null) {
    const addressValue = valueAt(values, options.addressColumn);
    if (!isMissingValue(addressValue)) {
      const address = parseAddress(addressValue, country ? country.original : '');
      const normalizedAddress = normalizeAddress(addressValue);
      if (normalizedAddress) {
        normalizedValues.address = normalizedAddress;
        normalizedAddressHash = createFingerprint(salt, normalizedAddress);
      }
      addressIssue = address.issues.length > 0;
      issues.address = { status: address.status, messages: address.issues };
      if (Object.values(address.components).some(Boolean)) {
        suggestions.address = address.components;
      }
    }
  }

  let exactDuplicateHash = null;
  if (options.duplicateColumns.length) {
    const comparedValues = options.duplicateColumns.map((columnIndex) => {
      let value = valueAt(values, columnIndex);
      if (options.trimWhitespace) value = value.trim();
      if (options.ignoreCase) value = value.toLocaleLowerCase('en');
      return value;
    });
    exactDuplicateHash = createFingerprint(salt, JSON.stringify(comparedValues));
  }

  return {
    excelRowNumber,
    originalValues: values,
    suggestions,
    issues,
    missingCount: missingColumnIndexes.length,
    invalidPhone,
    suspiciousPhone,
    addressIssue,
    countryInconsistent,
    normalizedValues,
    normalizedCompanyHash,
    normalizedNameHash,
    normalizedAddressHash,
    exactDuplicateHash,
    phoneDuplicateHash,
    emailDuplicateHash
  };
}

function recordValues(rowValues, columnCount) {
  return Array.from({ length: columnCount }, (_, index) =>
    normalizeCellValue(rowValues && rowValues[index + 1])
  );
}

async function writeBatch(connection, runId, batch, processedRecords) {
  await connection.beginTransaction();
  try {
    await profilingModel.insertRecords(connection, runId, batch);
    await profilingModel.updateProcessedCount(connection, runId, processedRecords);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

async function profileWorksheet({ runId, filePath, worksheetIndex, columnCount, options }) {
  if (!Number.isInteger(worksheetIndex) || worksheetIndex < 0) {
    throw new WorkbookValidationError('The selected worksheet does not exist.');
  }
  if (!Number.isInteger(columnCount) || columnCount < 1 || columnCount > 16384) {
    throw new WorkbookValidationError('The worksheet does not have a supported number of columns.');
  }

  const labels = Array.from({ length: columnCount }, (_, index) =>
    String(options.columnNames[index] || `Column ${index + 1}`).trim().slice(0, 255)
  );
  const columns = labels.map((name) => ({ name, missingCount: 0 }));
  const salt = crypto.randomBytes(32);
  const connection = await pool.getConnection();
  let batch = [];
  let batchBytes = 0;
  let totalRecords = 0;
  let headerSkipped = !options.hasHeaderRow;

  try {
    for await (const row of iterateWorksheetRows(filePath, worksheetIndex)) {
      const values = recordValues(row.values, columnCount);
      if (!headerSkipped && values.every((value) => value.trim() === '')) continue;
      if (!headerSkipped) {
        headerSkipped = true;
        continue;
      }
      if (values.every((value) => value.trim() === '')) continue;

      totalRecords += 1;
      const record = profileRecord(values, row.rowNumber, columns, options, salt);
      const recordBytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
      if (batch.length && (batch.length >= BATCH_SIZE || batchBytes + recordBytes > MAX_BATCH_BYTES)) {
        await writeBatch(connection, runId, batch, totalRecords - 1);
        batch = [];
        batchBytes = 0;
      }
      batch.push(record);
      batchBytes += recordBytes;
      if (batch.length >= BATCH_SIZE || batchBytes >= MAX_BATCH_BYTES) {
        await writeBatch(connection, runId, batch, totalRecords);
        batch = [];
        batchBytes = 0;
      }
    }

    if (batch.length) await writeBatch(connection, runId, batch, totalRecords);
  } finally {
    connection.release();
  }

  await profilingModel.completeRun({ runId, columns, totalRecords });
}

module.exports = {
  profileWorksheet,
  profileRecord,
  isMissingValue,
  createFingerprint,
  normalizeText,
  normalizeCompany,
  normalizeAddress,
  normalizedPhone,
  levenshteinSimilarity,
  compareDuplicateRecords,
  BATCH_SIZE,
  MAX_BATCH_BYTES
};
