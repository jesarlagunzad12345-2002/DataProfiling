const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ExcelJS = require('exceljs');
const legacyXlsx = require('@e965/xlsx');
const {
  applyChanges,
  columnToLetters,
  getWorksheetGrid,
  inspectSelection,
  loadWorkbook,
  previewWorkbook,
  transformText,
  writeWorkbook
} = require('../services/wordManipulationService');

let tempDirectory;

test.before(async () => {
  tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'clearsheet-word-test-'));
});

test.after(async () => {
  if (tempDirectory) await fs.rm(tempDirectory, { recursive: true, force: true });
});

test('removes first, center, last, and all words across one, two, odd, and even word counts', () => {
  assert.equal(transformText('  Alpha   Beta Gamma Delta  ', 'removeFirst'), 'Beta Gamma Delta');
  assert.equal(transformText('Alpha Beta Gamma Delta', 'removeCenter'), 'Alpha Beta Delta');
  assert.equal(transformText('Alpha Beta Gamma', 'removeCenter'), 'Alpha Gamma');
  assert.equal(transformText('Alpha Beta', 'removeCenter'), 'Alpha');
  assert.equal(transformText('Alpha', 'removeFirst'), '');
  assert.equal(transformText('Alpha', 'removeLast'), '');
  assert.equal(transformText('Alpha Beta', 'removeLast'), 'Alpha');
  assert.equal(transformText('Alpha Beta', 'removeAll'), '');
  assert.equal(transformText('', 'removeCenter'), '');
});

test('adds multiple words in each position using the selected separator', () => {
  assert.equal(transformText('Alpha Beta', 'addFirst', {
    text: 'New Client',
    separator: 'comma'
  }), 'New, Client, Alpha, Beta');
  assert.equal(transformText('Alpha Beta Gamma Delta', 'addCenter', {
    text: 'New Client',
    separator: 'hyphen'
  }), 'Alpha - Beta - New - Client - Gamma - Delta');
  assert.equal(transformText('Alpha Beta', 'addLast', {
    text: 'New Client',
    separator: 'space'
  }), 'Alpha Beta New Client');
  assert.equal(transformText('', 'addFirst', { text: 'New', separator: 'space' }), 'New');
});

test('find and replace and text cleaning handle punctuation, Unicode, spaces, and case', () => {
  assert.equal(transformText('Hello hello', 'findReplace', {
    findText: 'hello',
    replaceText: 'Hi',
    matchCase: false
  }), 'Hi Hi');
  assert.equal(transformText('  Alpha\t  Beta  ', 'removeExtraSpaces'), 'Alpha Beta');
  assert.equal(transformText('  Alpha Beta  ', 'removeLeadingSpaces'), 'Alpha Beta  ');
  assert.equal(transformText('  Alpha Beta  ', 'removeTrailingSpaces'), '  Alpha Beta');
  assert.equal(transformText('Crème™ 東京—42!', 'removeSpecialCharacters'), 'Crème 東京42');
  assert.equal(transformText('Cafe\u0301', 'removeSpecialCharacters'), 'Cafe\u0301');
  assert.equal(transformText('mIxEd 東京', 'uppercase'), 'MIXED 東京');
  assert.equal(transformText('MIXED 東京', 'lowercase'), 'mixed 東京');
  assert.equal(transformText("o'NEIL / ÉCOLE", 'properCase'), "O'Neil / École");
});

test('supports numbers and mixed alphanumeric values without regex interpretation', () => {
  assert.equal(transformText('ACME-42 Data', 'removeFirst'), 'Data');
  assert.equal(transformText('12345', 'addLast', { text: 'units', separator: 'space' }), '12345 units');
  assert.equal(transformText('a.b.a', 'findReplace', {
    findText: '.',
    replaceText: '-',
    matchCase: true
  }), 'a-b-a');
  assert.throws(() => transformText('Alpha', 'addFirst', { text: ' ', separator: 'space' }), /Enter the word/);
  assert.throws(() => transformText('Alpha', 'findReplace', { findText: '' }), /Enter text to find/);
});

test('maps zero-based column indexes to Excel column labels', () => {
  assert.deepEqual([0, 25, 26, 51, 52, 701, 702].map(columnToLetters), [
    'A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA'
  ]);
});

test('previews and applies only selected cells and columns while leaving the original workbook unchanged', async () => {
  const originalPath = path.join(tempDirectory, 'selection.xlsx');
  const workingPath = path.join(tempDirectory, 'selection-working.xlsx');
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Customers');
  worksheet.addRows([
    ['Name', 'City'],
    ['ada lovelace', 'London'],
    ['grace hopper', 'New York']
  ]);
  await workbook.xlsx.writeFile(originalPath);

  const selection = {
    columns: [0],
    cells: [{ row: 3, column: 1 }],
    includeHeader: false
  };
  const preview = await previewWorkbook(originalPath, 0, selection, 'uppercase');
  assert.equal(preview.affectedCount, 3);
  assert.deepEqual(preview.rows.map((row) => row.cellReference), ['A2', 'A3', 'B3']);

  const result = await inspectSelection(originalPath, 0, selection, 'uppercase');
  applyChanges(result.state, 0, result.changes);
  await writeWorkbook(result.state, workingPath);

  const originalWorkbook = new ExcelJS.Workbook();
  await originalWorkbook.xlsx.readFile(originalPath);
  assert.equal(originalWorkbook.getWorksheet('Customers').getCell('A2').value, 'ada lovelace');

  const grid = await getWorksheetGrid(workingPath, 0, { rowPage: 1, columnPage: 1 });
  assert.equal(grid.rows[1].cells[0].value, 'ADA LOVELACE');
  assert.equal(grid.rows[2].cells[0].value, 'GRACE HOPPER');
  assert.equal(grid.rows[2].cells[1].value, 'NEW YORK');
});

test('previews legacy .xls files and writes changes to a separate working copy', async () => {
  const originalPath = path.join(tempDirectory, 'legacy.xls');
  const workingPath = path.join(tempDirectory, 'legacy-working.xls');
  const sheet = legacyXlsx.utils.aoa_to_sheet([
    ['Name', 'City'],
    ['grace hopper', 'Arlington']
  ]);
  const workbook = legacyXlsx.utils.book_new();
  legacyXlsx.utils.book_append_sheet(workbook, sheet, 'People');
  legacyXlsx.writeFile(workbook, originalPath, { bookType: 'xls' });

  const preview = await previewWorkbook(
    originalPath,
    0,
    { columns: [], cells: [{ row: 2, column: 0 }], includeHeader: false },
    'properCase'
  );
  assert.equal(preview.affectedCount, 1);
  assert.equal(preview.rows[0].originalDisplay, 'grace hopper');

  const result = await inspectSelection(
    originalPath,
    0,
    { columns: [], cells: [{ row: 2, column: 0 }], includeHeader: false },
    'uppercase'
  );
  applyChanges(result.state, 0, result.changes);
  await writeWorkbook(result.state, workingPath);

  const originalWorkbook = legacyXlsx.readFile(originalPath);
  const updatedWorkbook = legacyXlsx.readFile(workingPath);
  assert.equal(originalWorkbook.Sheets.People.A2.v, 'grace hopper');
  assert.equal(updatedWorkbook.Sheets.People.A2.v, 'GRACE HOPPER');
});

test('allows add-text operations on explicitly selected blank cells but not blank bulk-column cells', async () => {
  const filePath = path.join(tempDirectory, 'blank-cells.xlsx');
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Empty values');
  worksheet.addRow(['Name']);
  worksheet.addRow([null]);
  await workbook.xlsx.writeFile(filePath);

  const cellPreview = await previewWorkbook(
    filePath,
    0,
    { columns: [], cells: [{ row: 2, column: 0 }], includeHeader: false },
    'addFirst',
    { text: 'New', separator: 'space' }
  );
  assert.equal(cellPreview.affectedCount, 1);
  assert.equal(cellPreview.rows[0].modifiedDisplay, 'New');

  const columnPreview = await previewWorkbook(
    filePath,
    0,
    { columns: [0], cells: [], includeHeader: true },
    'addFirst',
    { text: 'New', separator: 'space' }
  );
  assert.equal(columnPreview.affectedCount, 1);
  assert.deepEqual(columnPreview.rows.map((row) => row.cellReference), ['A1']);
});
