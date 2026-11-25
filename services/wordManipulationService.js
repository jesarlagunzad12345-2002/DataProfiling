const path = require('node:path');
const ExcelJS = require('exceljs');
const legacyXlsx = require('@e965/xlsx');
const {
  normalizeCellValue,
  validateXlsxArchive,
  validateLegacyWorkbookSize
} = require('./excelService');

const PREVIEW_LIMIT = 200;
const MAX_OPERATION_CELLS = 250000;
const MAX_INDIVIDUAL_CELLS = 5000;
const OPERATION_LABELS = {
  removeFirst: 'Remove first word',
  removeCenter: 'Remove center word',
  removeLast: 'Remove last word',
  removeAll: 'Remove all words',
  addFirst: 'Add first word',
  addCenter: 'Add center word',
  addLast: 'Add last word',
  findReplace: 'Find and replace',
  removeExtraSpaces: 'Remove extra spaces',
  removeLeadingSpaces: 'Remove leading spaces',
  removeTrailingSpaces: 'Remove trailing spaces',
  removeSpecialCharacters: 'Remove special characters',
  uppercase: 'Convert to uppercase',
  lowercase: 'Convert to lowercase',
  properCase: 'Convert to proper case'
};

class WordManipulationValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'WordManipulationValidationError';
    this.status = status;
  }
}

function getOperationLabel(operation) {
  return OPERATION_LABELS[operation] || null;
}

function normalizeSeparator(separator) {
  if (separator === 'comma') return ', ';
  if (separator === 'hyphen') return ' - ';
  return ' ';
}

function splitAddedWords(value, separator) {
  const text = String(value || '').trim();
  if (!text) return [];
  const pattern = separator === 'comma'
    ? /[,\s]+/u
    : separator === 'hyphen'
      ? /[-\s]+/u
      : /\s+/u;
  return text.split(pattern).filter(Boolean);
}

function splitWords(value) {
  const text = String(value).trim();
  return text ? text.split(/\s+/u) : [];
}

function transformText(value, operation, parameters = {}) {
  if (!getOperationLabel(operation)) {
    throw new WordManipulationValidationError('Choose a supported text operation.');
  }
  const text = String(value);
  const words = splitWords(text);

  switch (operation) {
    case 'removeFirst':
      return words.slice(1).join(' ');
    case 'removeCenter':
      if (!words.length) return '';
      words.splice(Math.floor(words.length / 2), 1);
      return words.join(' ');
    case 'removeLast':
      return words.slice(0, -1).join(' ');
    case 'removeAll':
      return '';
    case 'addFirst':
    case 'addCenter':
    case 'addLast': {
      const addedWords = splitAddedWords(parameters.text, parameters.separator);
      if (!addedWords.length) {
        throw new WordManipulationValidationError('Enter the word or words to add.');
      }
      const insertionIndex = operation === 'addFirst'
        ? 0
        : operation === 'addLast'
          ? words.length
          : Math.floor(words.length / 2);
      words.splice(insertionIndex, 0, ...addedWords);
      return words.join(normalizeSeparator(parameters.separator));
    }
    case 'findReplace': {
      const search = String(parameters.findText || '');
      if (!search) {
        throw new WordManipulationValidationError('Enter text to find.');
      }
      const replacement = String(parameters.replaceText || '');
      const flags = parameters.matchCase === false ? 'giu' : 'gu';
      return text.replace(new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags), () => replacement);
    }
    case 'removeExtraSpaces':
      return text.trim().replace(/\s+/gu, ' ');
    case 'removeLeadingSpaces':
      return text.replace(/^\s+/u, '');
    case 'removeTrailingSpaces':
      return text.replace(/\s+$/u, '');
    case 'removeSpecialCharacters':
      return text.replace(/[^\p{L}\p{M}\p{N}\s]/gu, '');
    case 'uppercase':
      return text.toUpperCase();
    case 'lowercase':
      return text.toLowerCase();
    case 'properCase':
      return text.toLowerCase().replace(/(^|[\s\p{P}])(\p{L})/gu, (match, prefix, letter) =>
        `${prefix}${letter.toUpperCase()}`
      );
    default:
      throw new WordManipulationValidationError('Choose a supported text operation.');
  }
}

function columnToLetters(columnIndex) {
  let value = columnIndex + 1;
  let letters = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

function loadWorkbook(filePath) {
  return path.extname(filePath).toLowerCase() === '.xls'
    ? loadLegacyWorkbook(filePath)
    : loadXlsxWorkbook(filePath);
}

async function loadXlsxWorkbook(filePath) {
  const workbook = new ExcelJS.Workbook();
  try {
    await validateXlsxArchive(filePath);
    await workbook.xlsx.readFile(filePath);
  } catch {
    throw new WordManipulationValidationError('The selected .xlsx workbook could not be opened.');
  }
  if (!workbook.worksheets.length) {
    throw new WordManipulationValidationError('The selected workbook has no worksheets.');
  }
  return { type: 'xlsx', workbook };
}

async function loadLegacyWorkbook(filePath) {
  let workbook;
  try {
    await validateLegacyWorkbookSize(filePath);
    workbook = legacyXlsx.readFile(filePath, { cellDates: true });
  } catch {
    throw new WordManipulationValidationError('The selected .xls workbook could not be opened.');
  }
  if (!workbook.SheetNames.length) {
    throw new WordManipulationValidationError('The selected workbook has no worksheets.');
  }
  return { type: 'xls', workbook };
}

function getWorksheet(state, worksheetIndex) {
  if (!Number.isInteger(worksheetIndex) || worksheetIndex < 0) {
    throw new WordManipulationValidationError('Choose a valid worksheet.');
  }
  const worksheet = state.type === 'xlsx'
    ? state.workbook.worksheets[worksheetIndex]
    : state.workbook.Sheets[state.workbook.SheetNames[worksheetIndex]];
  if (!worksheet) {
    throw new WordManipulationValidationError('The selected worksheet does not exist.');
  }
  if (state.type === 'xlsx') {
    return {
      worksheet,
      rowCount: worksheet.rowCount,
      columnCount: worksheet.columnCount
    };
  }
  const range = worksheet['!ref'] ? legacyXlsx.utils.decode_range(worksheet['!ref']) : null;
  return {
    worksheet,
    rowCount: range ? range.e.r + 1 : 0,
    columnCount: range ? range.e.c + 1 : 0
  };
}

function getRawCell(state, worksheet, rowNumber, columnIndex) {
  if (state.type === 'xlsx') {
    return worksheet.getCell(rowNumber, columnIndex + 1).value;
  }
  const cell = worksheet[legacyXlsx.utils.encode_cell({ r: rowNumber - 1, c: columnIndex })];
  if (!cell) return null;
  if (cell.f !== undefined) return { formula: cell.f };
  return cell.v === undefined ? null : cell.v;
}

function isEditableValue(value) {
  return typeof value === 'string' || typeof value === 'number';
}

function parseSelection(selection, rowCount, columnCount) {
  const columns = Array.isArray(selection.columns) ? selection.columns : [];
  const cells = Array.isArray(selection.cells) ? selection.cells : [];
  if (columns.length === 0 && cells.length === 0) {
    throw new WordManipulationValidationError('Select at least one whole column or individual cell.');
  }
  if (cells.length > MAX_INDIVIDUAL_CELLS) {
    throw new WordManipulationValidationError(`Select no more than ${MAX_INDIVIDUAL_CELLS.toLocaleString()} individual cells at a time.`);
  }

  const normalizedColumns = [];
  for (const column of columns) {
    if (!Number.isInteger(column) || column < 0 || column >= columnCount) {
      throw new WordManipulationValidationError('The column selection contains an invalid column.');
    }
    if (!normalizedColumns.includes(column)) normalizedColumns.push(column);
  }

  const normalizedCells = [];
  const cellKeys = new Set();
  for (const cell of cells) {
    if (!cell || !Number.isInteger(cell.row) || !Number.isInteger(cell.column)
      || cell.row < 1 || cell.row > rowCount || cell.column < 0 || cell.column >= columnCount) {
      throw new WordManipulationValidationError('The cell selection contains an invalid cell reference.');
    }
    const key = `${cell.row}:${cell.column}`;
    if (!cellKeys.has(key)) {
      cellKeys.add(key);
      normalizedCells.push({ row: cell.row, column: cell.column });
    }
  }

  const firstColumnRow = selection.includeHeader ? 1 : 2;
  const columnCellCount = normalizedColumns.length * Math.max(0, rowCount - firstColumnRow + 1);
  if (columnCellCount + normalizedCells.length > MAX_OPERATION_CELLS) {
    throw new WordManipulationValidationError(
      `An operation is limited to ${MAX_OPERATION_CELLS.toLocaleString()} selected cells. Select fewer columns or split the work into multiple operations.`
    );
  }
  return { columns: normalizedColumns, cells: normalizedCells, firstColumnRow };
}

function getCellReference(row, column) {
  return `${columnToLetters(column)}${row}`;
}

function getSelectedCellMap(selection, rowCount, columnCount) {
  const parsed = parseSelection(selection, rowCount, columnCount);
  const selected = new Map();
  for (const column of parsed.columns) {
    for (let row = parsed.firstColumnRow; row <= rowCount; row += 1) {
      selected.set(`${row}:${column}`, { row, column });
    }
  }
  for (const cell of parsed.cells) {
    selected.set(`${cell.row}:${cell.column}`, cell);
  }
  return selected;
}

async function inspectSelection(filePath, worksheetIndex, selection, operation, parameters = {}) {
  if (!getOperationLabel(operation)) {
    throw new WordManipulationValidationError('Choose a supported text operation.');
  }
  const state = await loadWorkbook(filePath);
  const { worksheet, rowCount, columnCount } = getWorksheet(state, worksheetIndex);
  if (rowCount === 0 || columnCount === 0) {
    throw new WordManipulationValidationError('The selected worksheet is empty.');
  }
  const selectedCells = getSelectedCellMap(selection, rowCount, columnCount);
  const explicitCells = new Set(selection.cells.map((cell) => `${cell.row}:${cell.column}`));
  const changes = [];
  for (const cell of selectedCells.values()) {
    const originalValue = getRawCell(state, worksheet, cell.row, cell.column);
    const explicitlySelected = explicitCells.has(`${cell.row}:${cell.column}`);
    const addsText = operation === 'addFirst' || operation === 'addCenter' || operation === 'addLast';
    if (originalValue === null || originalValue === undefined || originalValue === '') {
      if (!explicitlySelected || !addsText) continue;
    } else if (!isEditableValue(originalValue)) {
      continue;
    }
    const originalText = originalValue === null || originalValue === undefined
      ? ''
      : String(originalValue);
    const modifiedValue = transformText(originalText, operation, parameters);
    if (modifiedValue === originalText) continue;
    changes.push({
      row: cell.row,
      column: cell.column,
      cellReference: getCellReference(cell.row, cell.column),
      originalValue,
      modifiedValue,
      operation: getOperationLabel(operation)
    });
    if (changes.length > MAX_OPERATION_CELLS) {
      throw new WordManipulationValidationError(
        `An operation is limited to ${MAX_OPERATION_CELLS.toLocaleString()} changed cells.`
      );
    }
  }
  return { state, worksheet, rowCount, columnCount, changes };
}

async function previewWorkbook(filePath, worksheetIndex, selection, operation, parameters = {}) {
  const result = await inspectSelection(filePath, worksheetIndex, selection, operation, parameters);
  return {
    affectedCount: result.changes.length,
    rows: result.changes.slice(0, PREVIEW_LIMIT).map((change) => ({
      ...change,
      originalDisplay: normalizeCellValue(change.originalValue),
      modifiedDisplay: change.modifiedValue,
      status: 'Ready to submit for review'
    })),
    previewLimit: PREVIEW_LIMIT,
    truncated: result.changes.length > PREVIEW_LIMIT
  };
}

function getLegacyDisplayValue(worksheet, rowNumber, columnIndex) {
  const cell = worksheet[legacyXlsx.utils.encode_cell({ r: rowNumber - 1, c: columnIndex })];
  if (!cell) return '';
  if (cell.w !== undefined) return String(cell.w);
  return normalizeCellValue(cell.f !== undefined ? { formula: cell.f } : cell.v);
}

async function getWorksheetGrid(filePath, worksheetIndex, {
  rowPage = 1,
  columnPage = 1,
  rowPageSize = 40,
  columnPageSize = 20
} = {}) {
  const state = await loadWorkbook(filePath);
  const details = getWorksheet(state, worksheetIndex);
  const rowCount = details.rowCount;
  const columnCount = details.columnCount;
  const rowPageCount = Math.max(1, Math.ceil(rowCount / rowPageSize));
  const columnPageCount = Math.max(1, Math.ceil(columnCount / columnPageSize));
  const actualRowPage = Math.min(rowPage, rowPageCount);
  const actualColumnPage = Math.min(columnPage, columnPageCount);
  const firstRow = (actualRowPage - 1) * rowPageSize + 1;
  const firstColumn = (actualColumnPage - 1) * columnPageSize;
  const columns = Array.from({ length: Math.min(columnPageSize, Math.max(0, columnCount - firstColumn)) }, (_, offset) => {
    const column = firstColumn + offset;
    const value = rowCount
      ? (state.type === 'xlsx'
        ? details.worksheet.getCell(1, column + 1).value
        : getRawCell(state, details.worksheet, 1, column))
      : null;
    return {
      index: column,
      letters: columnToLetters(column),
      header: normalizeCellValue(value) || `Column ${columnToLetters(column)}`
    };
  });
  const rows = [];
  for (let row = firstRow; row < firstRow + rowPageSize && row <= rowCount; row += 1) {
    const cells = columns.map((column) => {
      const rawValue = getRawCell(state, details.worksheet, row, column.index);
      return {
        row,
        column: column.index,
        value: state.type === 'xls'
          ? getLegacyDisplayValue(details.worksheet, row, column.index)
          : normalizeCellValue(rawValue),
        selectable: rawValue === null || rawValue === undefined || isEditableValue(rawValue)
      };
    });
    rows.push({ row, cells });
  }
  return {
    rowCount,
    columnCount,
    rows,
    columns,
    rowPage: actualRowPage,
    rowPageCount,
    columnPage: actualColumnPage,
    columnPageCount
  };
}

async function getWorksheetHeaders(filePath, worksheetIndex) {
  const state = await loadWorkbook(filePath);
  const { worksheet, columnCount } = getWorksheet(state, worksheetIndex);
  return Array.from({ length: columnCount }, (_, column) => {
    const value = getRawCell(state, worksheet, 1, column);
    return normalizeCellValue(value).slice(0, 255);
  });
}

function applyChanges(state, worksheetIndex, changes) {
  const { worksheet } = getWorksheet(state, worksheetIndex);
  for (const change of changes) {
    if (state.type === 'xlsx') {
      worksheet.getCell(change.row, change.column + 1).value = change.modifiedValue;
    } else {
      const address = legacyXlsx.utils.encode_cell({ r: change.row - 1, c: change.column });
      worksheet[address] = { t: 's', v: change.modifiedValue };
    }
  }
}

function getCellValue(state, worksheetIndex, row, column) {
  const { worksheet } = getWorksheet(state, worksheetIndex);
  return getRawCell(state, worksheet, row, column);
}

function setCellValues(state, worksheetIndex, changes) {
  const { worksheet } = getWorksheet(state, worksheetIndex);
  for (const change of changes) {
    if (state.type === 'xlsx') {
      worksheet.getCell(change.row, change.column + 1).value = change.modifiedValue;
      continue;
    }
    const address = legacyXlsx.utils.encode_cell({ r: change.row - 1, c: change.column });
    if (change.modifiedValue === null || change.modifiedValue === undefined) {
      delete worksheet[address];
    } else if (typeof change.modifiedValue === 'number') {
      worksheet[address] = { t: 'n', v: change.modifiedValue };
    } else {
      worksheet[address] = { t: 's', v: String(change.modifiedValue) };
    }
  }
}

async function writeWorkbook(state, filePath) {
  if (state.type === 'xlsx') {
    await state.workbook.xlsx.writeFile(filePath);
    return;
  }
  legacyXlsx.writeFile(state.workbook, filePath, { bookType: 'xls' });
}

module.exports = {
  WordManipulationValidationError,
  getOperationLabel,
  columnToLetters,
  transformText,
  previewWorkbook,
  inspectSelection,
  getWorksheetGrid,
  getWorksheetHeaders,
  getCellValue,
  setCellValues,
  applyChanges,
  writeWorkbook,
  loadWorkbook,
  MAX_OPERATION_CELLS,
  MAX_INDIVIDUAL_CELLS
};
