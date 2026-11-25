const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ExcelJS = require('exceljs');
const legacyXlsx = require('@e965/xlsx');
const { profileRecord, isMissingValue } = require('../services/profilingService');
const { validatePhone } = require('../services/phoneService');
const { standardizeCountry, getCountryOptions } = require('../services/countryService');
const { parseAddress } = require('../services/addressParser');
const { getWorksheetHeaders, iterateWorksheetRows } = require('../services/excelStreamService');

const salt = Buffer.from('profiling-test-key');

test('counts blank and common missing markers and reports completeness without changing values', () => {
  const columns = Array.from({ length: 4 }, (_, index) => ({ name: `Column ${index + 1}`, missingCount: 0 }));
  const originalValues = ['Ada', ' N/A ', '', 'London'];
  const options = {
    phoneColumn: null,
    emailColumn: null,
    addressColumn: null,
    countryColumn: null,
    duplicateColumns: [],
    ignoreCase: true,
    trimWhitespace: true
  };
  const record = profileRecord(originalValues, 2, columns, options, salt);

  assert.equal(isMissingValue(' NULL '), true);
  assert.equal(isMissingValue('0'), false);
  assert.deepEqual(record.issues.missingColumnIndexes, [1, 2]);
  assert.equal(record.missingCount, 2);
  assert.deepEqual(originalValues, ['Ada', ' N/A ', '', 'London']);
  assert.deepEqual(columns.map((column) => column.missingCount), [0, 1, 1, 0]);
});

test('normalizes valid international phones and detects email and configured exact duplicates', () => {
  const options = {
    phoneColumn: 1,
    emailColumn: 2,
    addressColumn: null,
    countryColumn: null,
    defaultCountry: 'US',
    duplicateColumns: [0, 2],
    ignoreCase: true,
    trimWhitespace: true
  };
  const columns = Array.from({ length: 3 }, (_, index) => ({ name: `Column ${index + 1}`, missingCount: 0 }));
  const first = profileRecord([' Ada ', '(213) 373-4253', 'ADA@example.com'], 2, columns, options, salt);
  const second = profileRecord(['ada', '+1 213 373 4253', 'ada@example.com'], 3, columns, options, salt);

  assert.deepEqual(validatePhone('+1 213 373 4253'), {
    status: 'valid',
    e164: '+12133734253',
    reason: null
  });
  assert.equal(first.suggestions.phone.standardized, '+12133734253');
  assert.equal(first.phoneDuplicateHash, second.phoneDuplicateHash);
  assert.equal(first.emailDuplicateHash, second.emailDuplicateHash);
  assert.equal(first.exactDuplicateHash, second.exactDuplicateHash);
  assert.notEqual(first.emailDuplicateHash, 'ada@example.com');
  assert.equal(validatePhone('not a phone').status, 'invalid');
  assert.equal(validatePhone('+12005550100').status, 'suspicious');
});

test('standardizes country aliases and proposes conservative address components', () => {
  const country = standardizeCountry('UK');
  assert.equal(country.recognized, true);
  assert.equal(country.alpha2, 'GB');
  assert.equal(country.inconsistent, true);
  assert.ok(getCountryOptions().every((option) => option.callingCode));

  const parsed = parseAddress('1600 Pennsylvania Avenue NW, Washington, DC, 20500, United States');
  assert.equal(parsed.status, 'parsed');
  assert.equal(parsed.components.city, 'Washington');
  assert.equal(parsed.components.region, 'DC');
  assert.equal(parsed.components.postalCode, '20500');

  const canadian = parseAddress('101 Main Street, Toronto, ON, M5H 1J9', 'CA');
  assert.equal(canadian.components.region, 'ON');
  assert.equal(canadian.components.postalCode, 'M5H 1J9');
  assert.ok(canadian.issues.length === 0);

  const uncertain = parseAddress('101 Main Street, Toronto, M5H 1J9', 'CA');
  assert.equal(uncertain.components.region, null);
  assert.ok(uncertain.issues.some((issue) => issue.includes('province')));
});

test('streams worksheet headers and rows for .xlsx and bounded legacy .xls', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'profiling-stream-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const xlsxPath = path.join(directory, 'customers.xlsx');
  const workbook = new ExcelJS.Workbook();
  const customers = workbook.addWorksheet('Customers');
  customers.addRow([null, null, null]);
  customers.addRows([
    ['Name', 'Phone'],
    ['Ada', '+12133734253'],
  ]);
  const dateRow = customers.addRow([
    { richText: [{ text: 'Björ' }, { text: 'k' }] },
    null,
    new Date('2024-01-02T00:00:00Z')
  ]);
  dateRow.getCell(3).numFmt = 'yyyy-mm-dd';
  workbook.addWorksheet('Other').addRow(['ignored']);
  await workbook.xlsx.writeFile(xlsxPath);

  assert.deepEqual(await getWorksheetHeaders(xlsxPath, 0, 3), ['Name', 'Phone', '']);
  assert.deepEqual(await getWorksheetHeaders(xlsxPath, 0, 3), ['Name', 'Phone', '']);
  const xlsxRows = [];
  for await (const row of iterateWorksheetRows(xlsxPath, 0)) {
    xlsxRows.push([row.rowNumber, row.values[1], row.values[2], row.values[3]]);
  }
  assert.deepEqual(xlsxRows.slice(0, 2), [
    [1, undefined, undefined, undefined],
    [2, 'Name', 'Phone', undefined]
  ]);
  assert.deepEqual(xlsxRows[2], [
    3,
    'Ada',
    '+12133734253',
    undefined
  ]);
  assert.equal(xlsxRows[3][1], 'Björk');
  assert.equal(xlsxRows[3][2], undefined);
  assert.equal(xlsxRows[3][3], 45293);
  assert.deepEqual(await getWorksheetHeaders(xlsxPath, 1, 1), ['ignored']);

  const xlsPath = path.join(directory, 'legacy.xls');
  const legacyBook = legacyXlsx.utils.book_new();
  legacyXlsx.utils.book_append_sheet(legacyBook, legacyXlsx.utils.aoa_to_sheet([
    ['Name', 'City'],
    ['Grace', 'London']
  ]), 'Legacy');
  legacyXlsx.writeFile(legacyBook, xlsPath, { bookType: 'xls' });

  const xlsRows = [];
  for await (const row of iterateWorksheetRows(xlsPath, 0)) xlsRows.push(row.values.slice(1));
  assert.deepEqual(xlsRows, [['Name', 'City'], ['Grace', 'London']]);

  const offsetXlsPath = path.join(directory, 'offset.xls');
  const offsetSheet = {};
  offsetSheet.B2 = { t: 's', v: 'Name' };
  offsetSheet.C2 = { t: 's', v: 'City' };
  offsetSheet.B3 = { t: 's', v: 'Grace' };
  offsetSheet.C3 = { t: 's', v: 'London' };
  offsetSheet['!ref'] = 'B2:C3';
  const offsetBook = legacyXlsx.utils.book_new();
  legacyXlsx.utils.book_append_sheet(offsetBook, offsetSheet, 'Offset');
  legacyXlsx.writeFile(offsetBook, offsetXlsPath, { bookType: 'xls' });

  assert.deepEqual(await getWorksheetHeaders(offsetXlsPath, 0, 3), ['', 'Name', 'City']);
  const offsetRows = [];
  for await (const row of iterateWorksheetRows(offsetXlsPath, 0)) {
    offsetRows.push(Array.from({ length: 3 }, (_, index) => row.values[index + 1] ?? ''));
  }
  assert.deepEqual(offsetRows[0], ['', 'Name', 'City']);
  assert.deepEqual(offsetRows[1], ['', 'Grace', 'London']);
});
