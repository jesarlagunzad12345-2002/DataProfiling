const fs = require('node:fs/promises');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const legacyXlsx = require('@e965/xlsx');
const unzipper = require('unzipper');
const { SaxesParser } = require('saxes');
const {
  normalizeCellValue,
  WorkbookValidationError,
  validateArchiveEntries
} = require('./excelService');

const configuredLegacyLimit = Number(process.env.PROFILE_XLS_MAX_SIZE_MB || 10);
const LEGACY_XLS_MAX_BYTES = (Number.isFinite(configuredLegacyLimit)
  ? Math.min(Math.max(configuredLegacyLimit, 1), 50)
  : 10) * 1024 * 1024;

async function readSharedStrings(entry) {
  if (!entry) return [];
  const strings = [];
  let currentParts = null;
  let inText = false;
  let inPhoneticRun = false;
  let parseError = null;
  const decoder = new StringDecoder('utf8');
  const parser = new SaxesParser();
  parser.on('opentag', (tag) => {
    if (tag.name === 'si') currentParts = [];
    if (tag.name === 't') inText = true;
    if (tag.name === 'rPh') inPhoneticRun = true;
  });
  parser.on('text', (text) => {
    if (inText && !inPhoneticRun && currentParts) currentParts.push(text);
  });
  parser.on('cdata', (text) => {
    if (inText && !inPhoneticRun && currentParts) currentParts.push(text);
  });
  parser.on('closetag', (tag) => {
    if (tag.name === 't') inText = false;
    if (tag.name === 'rPh') inPhoneticRun = false;
    if (tag.name === 'si' && currentParts) {
      strings.push(currentParts.join(''));
      currentParts = null;
    }
  });
  parser.on('error', (error) => {
    parseError = error;
  });
  try {
    for await (const chunk of entry.stream()) parser.write(decoder.write(chunk));
    parser.write(decoder.end());
    parser.close();
  } catch {
    throw new WorkbookValidationError('This .xlsx workbook contains invalid shared-string data.');
  }
  if (parseError) throw new WorkbookValidationError('This .xlsx workbook contains invalid shared-string data.');
  return strings;
}

async function getWorksheetModels(filePath) {
  const archive = await unzipper.Open.file(filePath);
  validateArchiveEntries(archive.files);
  const workbookEntry = archive.files.find((entry) => entry.path === 'xl/workbook.xml');
  const relationshipsEntry = archive.files.find((entry) => entry.path === 'xl/_rels/workbook.xml.rels');
  if (!workbookEntry || !relationshipsEntry) {
    throw new WorkbookValidationError('This .xlsx workbook is missing worksheet metadata.');
  }
  const sharedStringsEntry = archive.files.find((entry) => entry.path === 'xl/sharedStrings.xml');
  if (workbookEntry.uncompressedSize > 1024 * 1024 || relationshipsEntry.uncompressedSize > 1024 * 1024) {
    throw new WorkbookValidationError('This .xlsx workbook contains unsupported worksheet metadata.');
  }
  const [workbookBuffer, relationshipsBuffer, sharedStrings] = await Promise.all([
    workbookEntry.buffer(),
    relationshipsEntry.buffer(),
    readSharedStrings(sharedStringsEntry)
  ]);
  if (workbookBuffer.length > 1024 * 1024 || relationshipsBuffer.length > 1024 * 1024) {
    throw new WorkbookValidationError('This .xlsx workbook contains unsupported worksheet metadata.');
  }
  const relationshipTargets = new Map();
  const relationshipsParser = new SaxesParser();
  let metadataError = null;
  relationshipsParser.on('opentag', (tag) => {
    if (tag.name === 'Relationship' && tag.attributes.Id && tag.attributes.Target) {
      relationshipTargets.set(tag.attributes.Id, tag.attributes.Target);
    }
  });
  const sheets = [];
  const workbookParser = new SaxesParser();
  workbookParser.on('opentag', (tag) => {
    if (tag.name !== 'sheet') return;
    const target = relationshipTargets.get(tag.attributes['r:id']);
    const sheetMatch = target && target.match(/(?:^|\/)sheet(\d+)\.xml$/i);
    const id = Number(tag.attributes.sheetId);
    if (!sheetMatch || !Number.isSafeInteger(id) || id < 1) {
      metadataError = new Error('Unsupported worksheet reference.');
      return;
    }
    const worksheetPath = target.startsWith('/')
      ? path.posix.normalize(target.slice(1))
      : path.posix.normalize(path.posix.join('xl', target));
    const worksheetEntry = archive.files.find((entry) => entry.path === worksheetPath);
    if (!worksheetEntry) {
      metadataError = new Error('Missing worksheet data.');
      return;
    }
    sheets.push({ id, name: tag.attributes.name || `Sheet ${id}`, worksheetEntry });
  });
  for (const parser of [relationshipsParser, workbookParser]) {
    parser.on('error', (error) => {
      metadataError = error;
    });
  }
  try {
    relationshipsParser.write(relationshipsBuffer.toString('utf8')).close();
    workbookParser.write(workbookBuffer.toString('utf8')).close();
  } catch {
    throw new WorkbookValidationError('This .xlsx workbook contains invalid worksheet metadata.');
  }
  if (metadataError) throw new WorkbookValidationError('This .xlsx workbook contains invalid worksheet metadata.');
  if (!sheets.length) throw new WorkbookValidationError('The selected workbook has no worksheets.');
  return { sheets, sharedStrings };
}

function columnIndexFromCellReference(reference) {
  const letters = String(reference || '').match(/^[A-Z]+/i);
  if (!letters) return 0;
  let column = 0;
  for (const letter of letters[0].toUpperCase()) {
    column = column * 26 + letter.charCodeAt(0) - 64;
  }
  return column;
}

function decodeWorksheetCell(cell, sharedStrings) {
  if (cell.hasFormula && !cell.valuePresent) return { formula: '[formula]' };
  const value = cell.value;
  let result;
  if (cell.type === 's') {
    const stringIndex = Number(value);
    result = Number.isSafeInteger(stringIndex) && stringIndex >= 0
      ? sharedStrings[stringIndex]
      : undefined;
    if (result === undefined) throw new WorkbookValidationError('This .xlsx workbook references an invalid shared string.');
  } else if (cell.type === 'inlineStr') {
    result = cell.inlineText.join('');
  } else if (cell.type === 'str') {
    result = value;
  } else if (cell.type === 'e') {
    result = { error: value };
  } else if (cell.type === 'b') {
    result = value === '1';
  } else if (cell.type === 'd') {
    result = new Date(value);
  } else if (value === '') {
    result = '';
  } else {
    const number = Number(value);
    result = Number.isFinite(number) ? number : value;
  }
  return cell.hasFormula
    ? { formula: '[formula]', result }
    : result;
}

async function* iterateWorksheetXmlRows(entry, sharedStrings) {
  const decoder = new StringDecoder('utf8');
  const parser = new SaxesParser();
  const readyRows = [];
  let parseError = null;
  let currentRow = null;
  let currentCell = null;
  let textField = null;
  let inPhoneticRun = false;
  let lastRowNumber = 0;

  parser.on('opentag', (tag) => {
    if (tag.name === 'row') {
      const number = Number(tag.attributes.r);
      lastRowNumber = Number.isSafeInteger(number) && number > 0 ? number : lastRowNumber + 1;
      currentRow = { rowNumber: lastRowNumber, values: [] };
    } else if (tag.name === 'c' && currentRow) {
      currentCell = {
        columnIndex: columnIndexFromCellReference(tag.attributes.r),
        type: tag.attributes.t || '',
        value: '',
        valuePresent: false,
        inlineText: [],
        hasFormula: false
      };
    } else if (tag.name === 'v' && currentCell) {
      textField = 'value';
      currentCell.valuePresent = true;
    } else if (tag.name === 'f' && currentCell) {
      currentCell.hasFormula = true;
    } else if (tag.name === 't' && currentCell) {
      textField = 'inlineText';
    } else if (tag.name === 'rPh') {
      inPhoneticRun = true;
    }
  });
  parser.on('text', (text) => {
    if (!currentCell || inPhoneticRun) return;
    if (textField === 'value') currentCell.value += text;
    if (textField === 'inlineText') currentCell.inlineText.push(text);
  });
  parser.on('cdata', (text) => {
    if (!currentCell || inPhoneticRun) return;
    if (textField === 'value') currentCell.value += text;
    if (textField === 'inlineText') currentCell.inlineText.push(text);
  });
  parser.on('closetag', (tag) => {
    if (tag.name === 'v' || tag.name === 't') textField = null;
    if (tag.name === 'rPh') inPhoneticRun = false;
    if (tag.name === 'c' && currentCell) {
      if (currentCell.columnIndex > 0) {
        currentRow.values[currentCell.columnIndex] = decodeWorksheetCell(currentCell, sharedStrings);
      }
      currentCell = null;
    } else if (tag.name === 'row' && currentRow) {
      readyRows.push(currentRow);
      currentRow = null;
    }
  });
  parser.on('error', (error) => {
    parseError = error;
  });

  try {
    for await (const chunk of entry.stream()) {
      parser.write(decoder.write(chunk));
      while (readyRows.length) yield readyRows.shift();
      if (parseError) throw parseError;
    }
    parser.write(decoder.end());
    parser.close();
  } catch (error) {
    if (error instanceof WorkbookValidationError) throw error;
    throw new WorkbookValidationError('This .xlsx worksheet could not be parsed.');
  }
  while (readyRows.length) yield readyRows.shift();
  if (parseError) throw new WorkbookValidationError('This .xlsx worksheet contains invalid XML.');
}

async function* iterateXlsxWorksheetRows(filePath, worksheetIndex) {
  const { sheets, sharedStrings } = await getWorksheetModels(filePath);
  if (!Number.isInteger(worksheetIndex) || worksheetIndex < 0 || worksheetIndex >= sheets.length) {
    throw new WorkbookValidationError('The selected worksheet does not exist.');
  }
  yield* iterateWorksheetXmlRows(sheets[worksheetIndex].worksheetEntry, sharedStrings);
}

async function readLegacyWorksheet(filePath, worksheetIndex) {
  const fileStats = await fs.stat(filePath);
  if (fileStats.size > LEGACY_XLS_MAX_BYTES) {
    throw new WorkbookValidationError(
      `Legacy .xls profiling is limited to ${Math.floor(LEGACY_XLS_MAX_BYTES / (1024 * 1024))} MB to control memory use. Save a larger workbook as .xlsx and upload it again.`
    );
  }

  let workbook;
  try {
    workbook = legacyXlsx.readFile(filePath, { cellDates: true });
  } catch {
    throw new WorkbookValidationError('This .xls workbook could not be opened for profiling.');
  }
  const sheetName = workbook.SheetNames[worksheetIndex];
  if (!sheetName) throw new WorkbookValidationError('The selected worksheet does not exist.');
  const sheet = workbook.Sheets[sheetName];
  const range = sheet['!ref'] ? legacyXlsx.utils.decode_range(sheet['!ref']) : null;
  return { sheet, range };
}

async function* iterateLegacyWorksheetRows(filePath, worksheetIndex) {
  const { sheet, range } = await readLegacyWorksheet(filePath, worksheetIndex);
  if (!range) return;
  for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
    const values = new Array(range.e.c + 2);
    for (let columnIndex = range.s.c; columnIndex <= range.e.c; columnIndex += 1) {
      const cellAddress = legacyXlsx.utils.encode_cell({ r: rowIndex, c: columnIndex });
      const cell = sheet[cellAddress];
      values[columnIndex + 1] = cell ? legacyXlsx.utils.format_cell(cell) : '';
    }
    yield { rowNumber: rowIndex + 1, values };
  }
}

async function* iterateWorksheetRows(filePath, worksheetIndex) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.xlsx') {
    yield* iterateXlsxWorksheetRows(filePath, worksheetIndex);
    return;
  }
  if (extension === '.xls') {
    yield* iterateLegacyWorksheetRows(filePath, worksheetIndex);
    return;
  }
  throw new WorkbookValidationError('Only .xlsx and .xls workbooks can be profiled.');
}

async function getWorksheetHeaders(filePath, worksheetIndex, columnCount) {
  let firstRow = null;
  for await (const row of iterateWorksheetRows(filePath, worksheetIndex)) {
    if (!firstRow && row.values.some((value, index) => index > 0 && normalizeCellValue(value).trim() !== '')) {
      firstRow = row;
    }
  }
  if (!firstRow) return Array.from({ length: columnCount }, (_, index) => '');
  return Array.from({ length: columnCount }, (_, index) =>
    normalizeCellValue(firstRow.values[index + 1])
  );
}

module.exports = {
  iterateWorksheetRows,
  getWorksheetHeaders,
  LEGACY_XLS_MAX_BYTES
};
