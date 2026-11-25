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
  }

  if (options.emailColumn !== null) {
    const email = valueAt(values, options.emailColumn).trim();
    if (email && !isMissingValue(email)) emailDuplicateHash = createFingerprint(salt, email.toLowerCase());
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
  BATCH_SIZE,
  MAX_BATCH_BYTES
};
