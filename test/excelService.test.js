const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ExcelJS = require('exceljs');
const legacyXlsx = require('@e965/xlsx');
const {
  getWorkbookSummary,
  getWorksheetPreview,
  validateArchiveEntries
} = require('../services/excelService');

let tempDirectory;

test.before(async () => {
  tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'datawise-workbook-test-'));
});

test.after(async () => {
  if (tempDirectory) {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

test('reads .xlsx worksheet names, dimensions, and a bounded preview', async () => {
  const filePath = path.join(tempDirectory, 'customers.xlsx');
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Customers');
  worksheet.addRow(['Name', 'City']);
  worksheet.addRow(['Ada', 'London']);
  worksheet.addRow(['Lin', 'Taipei']);
  await workbook.xlsx.writeFile(filePath);

  assert.deepEqual(await getWorkbookSummary(filePath), [
    { name: 'Customers', rowCount: 3, columnCount: 2 }
  ]);
  assert.deepEqual(await getWorksheetPreview(filePath, 0), {
    name: 'Customers',
    rowCount: 3,
    columnCount: 2,
    headers: ['Column 1', 'Column 2'],
    rows: [
      ['Name', 'City'],
      ['Ada', 'London'],
      ['Lin', 'Taipei']
    ]
  });
});

test('reads legacy .xls worksheets and cell values', async () => {
  const filePath = path.join(tempDirectory, 'legacy.xls');
  const worksheet = legacyXlsx.utils.aoa_to_sheet([
    ['Name', 'Score'],
    ['Grace', 98]
  ]);
  const workbook = legacyXlsx.utils.book_new();
  legacyXlsx.utils.book_append_sheet(workbook, worksheet, 'Results');
  legacyXlsx.writeFile(workbook, filePath, { bookType: 'xls' });

  assert.deepEqual(await getWorkbookSummary(filePath), [
    { name: 'Results', rowCount: 2, columnCount: 2 }
  ]);
  const preview = await getWorksheetPreview(filePath, 0);
  assert.equal(preview.name, 'Results');
  assert.deepEqual(preview.rows, [
    ['Name', 'Score'],
    ['Grace', '98']
  ]);
});

test('limits worksheet previews to ten rows and twenty columns', async () => {
  const filePath = path.join(tempDirectory, 'large-preview.xlsx');
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Wide sheet');
  for (let row = 0; row < 12; row += 1) {
    worksheet.addRow(Array.from({ length: 22 }, (_, column) => `${row}:${column}`));
  }
  await workbook.xlsx.writeFile(filePath);

  const preview = await getWorksheetPreview(filePath, 0);
  assert.equal(preview.rowCount, 12);
  assert.equal(preview.columnCount, 22);
  assert.equal(preview.rows.length, 10);
  assert.equal(preview.headers.length, 20);
  assert.ok(preview.rows.every((row) => row.length === 20));
});

test('rejects unsupported workbook extensions and worksheet indexes', async () => {
  await assert.rejects(getWorkbookSummary(path.join(tempDirectory, 'notes.csv')), /\.xlsx and \.xls/);

  const filePath = path.join(tempDirectory, 'single.xlsx');
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Sheet1').addRow(['value']);
  await workbook.xlsx.writeFile(filePath);

  await assert.rejects(getWorksheetPreview(filePath, 1), /worksheet does not exist/);
});

test('rejects files that use an Excel extension without an Excel signature', async () => {
  const filePath = path.join(tempDirectory, 'renamed.xlsx');
  await fs.writeFile(filePath, 'not an Excel workbook');
  await assert.rejects(getWorkbookSummary(filePath), /contents do not match an Excel workbook/);
});

test('rejects archive traversal paths and oversized workbook expansions before parsing', () => {
  assert.throws(() => validateArchiveEntries([
    { path: '../outside.xml', uncompressedSize: 1 }
  ]), /unsupported archive entry/);
  assert.throws(() => validateArchiveEntries([
    { path: 'xl/sharedStrings.xml', uncompressedSize: 33 * 1024 * 1024 }
  ]), /shared-string data/);
  assert.throws(() => validateArchiveEntries([
    { path: 'xl/worksheet1.xml', uncompressedSize: 129 * 1024 * 1024 }
  ]), /unsupported archive entry/);
  assert.throws(() => validateArchiveEntries([
    { path: 'xl/worksheets/sheet1.xml', uncompressedSize: 128 * 1024 * 1024 },
    { path: 'xl/worksheets/sheet2.xml', uncompressedSize: 128 * 1024 * 1024 },
    { path: 'xl/worksheets/sheet3.xml', uncompressedSize: 1 }
  ]), /expands beyond/);
  assert.doesNotThrow(() => validateArchiveEntries([
    { path: 'xl/workbook.xml', uncompressedSize: 100 },
    { path: 'xl/worksheets/sheet1.xml', uncompressedSize: 1000 }
  ]));
});
