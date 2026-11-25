const fs = require('node:fs/promises');
const path = require('node:path');
const ExcelJS = require('exceljs');
const legacyXlsx = require('@e965/xlsx');
const unzipper = require('unzipper');

const PREVIEW_ROWS = 10;
const PREVIEW_COLUMNS = 20;
const XLSX_SIGNATURES = ['504b0304', '504b0506', '504b0708'];
const XLS_SIGNATURE = 'd0cf11e0a1b11ae1';
const MAX_XLSX_ENTRIES = 20000;
const MAX_XLSX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_XLSX_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_SHARED_STRINGS_BYTES = 32 * 1024 * 1024;
const configuredLegacyLimit = Number(process.env.PROFILE_XLS_MAX_SIZE_MB || 10);
const MAX_LEGACY_XLS_BYTES = (Number.isFinite(configuredLegacyLimit)
  ? Math.min(Math.max(configuredLegacyLimit, 1), 50)
  : 10) * 1024 * 1024;

class WorkbookValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkbookValidationError';
    this.status = 400;
  }
}

function normalizeCellValue(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((item) => item.text || '').join('');
    if (value.text !== undefined) return String(value.text);
    if (value.result !== undefined) return normalizeCellValue(value.result);
    if (value.error !== undefined) return String(value.error);
    if (value.formula !== undefined) return '[formula]';
    if (value.sharedString !== undefined) return `[shared string ${value.sharedString}]`;
    if (value.hyperlink) return String(value.text || value.hyperlink);
    return String(value);
  }
  return String(value);
}

async function validateWorkbookSignature(filePath, extension) {
  const handle = await fs.open(filePath, 'r');
  try {
    const header = Buffer.alloc(8);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const signature = header.subarray(0, bytesRead).toString('hex').toLowerCase();
    const valid = extension === '.xlsx'
      ? XLSX_SIGNATURES.some((value) => signature.startsWith(value))
      : signature.startsWith(XLS_SIGNATURE);
    if (!valid) {
      throw new WorkbookValidationError('The file contents do not match an Excel workbook. Choose a valid .xlsx or .xls file.');
    }
  } finally {
    await handle.close();
  }
}

function validateArchiveEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_XLSX_ENTRIES) {
    throw new WorkbookValidationError('The .xlsx workbook has an unsupported number of archive entries.');
  }

  let totalUncompressedBytes = 0;
  for (const entry of entries) {
    const entryPath = entry.path;
    const uncompressedSize = Number(entry.uncompressedSize);
    if (typeof entryPath !== 'string'
      || entryPath.startsWith('/')
      || /^[a-zA-Z]:/.test(entryPath)
      || entryPath.includes('\\')
      || entryPath.split('/').includes('..')
      || !Number.isSafeInteger(uncompressedSize)
      || uncompressedSize < 0
      || uncompressedSize > MAX_XLSX_ENTRY_BYTES) {
      throw new WorkbookValidationError('The .xlsx workbook contains an unsupported archive entry.');
    }
    if (entryPath === 'xl/sharedStrings.xml' && uncompressedSize > MAX_SHARED_STRINGS_BYTES) {
      throw new WorkbookValidationError('The .xlsx workbook contains too much shared-string data to process safely.');
    }
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > MAX_XLSX_UNCOMPRESSED_BYTES) {
      throw new WorkbookValidationError('The .xlsx workbook expands beyond the supported processing size.');
    }
  }
}

async function validateXlsxArchive(filePath) {
  let archive;
  try {
    archive = await unzipper.Open.file(filePath);
  } catch {
    throw new WorkbookValidationError('This .xlsx workbook has an invalid or unsupported archive structure.');
  }
  validateArchiveEntries(archive.files);
}

async function validateLegacyWorkbookSize(filePath) {
  const fileStats = await fs.stat(filePath);
  if (fileStats.size > MAX_LEGACY_XLS_BYTES) {
    throw new WorkbookValidationError(
      `Legacy .xls workbooks are limited to ${Math.floor(MAX_LEGACY_XLS_BYTES / (1024 * 1024))} MB for safe processing. Save a larger workbook as .xlsx and upload it again.`
    );
  }
}

async function readXlsxSummary(filePath) {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    if (workbook.worksheets.length === 0) {
      throw new WorkbookValidationError('The workbook does not contain any worksheets.');
    }
    return workbook.worksheets.map((worksheet) => ({
      name: worksheet.name,
      rowCount: worksheet.rowCount,
      columnCount: worksheet.columnCount
    }));
  } catch (error) {
    if (error instanceof WorkbookValidationError) throw error;
    throw new WorkbookValidationError('This .xlsx workbook could not be opened. Check that it is valid and not password-protected.');
  }
}

function getLegacySheetRows(sheet) {
  const reference = sheet['!ref'];
  const range = reference ? legacyXlsx.utils.decode_range(reference) : null;
  const rows = legacyXlsx.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: true
  });
  return {
    rows,
    rowCount: range ? range.e.r + 1 : 0,
    columnCount: range ? range.e.c + 1 : 0
  };
}

async function readXlsSummary(filePath) {
  try {
    const workbook = legacyXlsx.readFile(filePath, { cellDates: true });
    if (workbook.SheetNames.length === 0) {
      throw new WorkbookValidationError('The workbook does not contain any worksheets.');
    }
    return workbook.SheetNames.map((name) => {
      const { rowCount, columnCount } = getLegacySheetRows(workbook.Sheets[name]);
      return { name, rowCount, columnCount };
    });
  } catch (error) {
    if (error instanceof WorkbookValidationError) throw error;
    throw new WorkbookValidationError('This .xls workbook could not be opened. Check that it is valid and not password-protected.');
  }
}

async function getWorkbookSummary(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension !== '.xlsx' && extension !== '.xls') {
    throw new WorkbookValidationError('Only .xlsx and .xls workbooks are supported.');
  }
  await validateWorkbookSignature(filePath, extension);
  if (extension === '.xlsx') {
    await validateXlsxArchive(filePath);
    return readXlsxSummary(filePath);
  }
  await validateLegacyWorkbookSize(filePath);
  return readXlsSummary(filePath);
}

async function getWorksheetPreview(filePath, worksheetIndex) {
  const summaries = await getWorkbookSummary(filePath);
  if (!Number.isInteger(worksheetIndex) || worksheetIndex < 0 || worksheetIndex >= summaries.length) {
    throw new WorkbookValidationError('The selected worksheet does not exist.');
  }

  const summary = summaries[worksheetIndex];
  if (path.extname(filePath).toLowerCase() === '.xls') {
    const workbook = legacyXlsx.readFile(filePath, { cellDates: true });
    const { rows } = getLegacySheetRows(workbook.Sheets[workbook.SheetNames[worksheetIndex]]);
    return buildPreview(summary, rows);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.worksheets[worksheetIndex];
  const rows = [];
  worksheet.eachRow({ includeEmpty: true }, (row) => {
    const values = [];
    for (let column = 1; column <= Math.min(summary.columnCount, PREVIEW_COLUMNS); column += 1) {
      values.push(normalizeCellValue(row.getCell(column).value));
    }
    rows.push(values);
  });
  return buildPreview(summary, rows);
}

function buildPreview(summary, rows) {
  const columnCount = Math.min(summary.columnCount, PREVIEW_COLUMNS);
  return {
    ...summary,
    headers: Array.from({ length: columnCount }, (_, index) => `Column ${index + 1}`),
    rows: rows.slice(0, PREVIEW_ROWS).map((row) =>
      Array.from({ length: columnCount }, (_, index) => normalizeCellValue(row[index]))
    )
  };
}

module.exports = {
  getWorkbookSummary,
  getWorksheetPreview,
  WorkbookValidationError,
  normalizeCellValue,
  validateArchiveEntries,
  validateXlsxArchive,
  validateLegacyWorkbookSize
};