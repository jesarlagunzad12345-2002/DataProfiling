const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const ExcelJS = require('exceljs');
const legacyXlsx = require('@e965/xlsx');
const uploadModel = require('../models/uploadModel');
const exportModel = require('../models/exportModel');
const manipulationModel = require('../models/manipulationModel');
const { getWorksheetHeaders } = require('./excelStreamService');
const {
  validateXlsxArchive,
  validateLegacyWorkbookSize
} = require('./excelService');

const uploadsDirectory = path.resolve(__dirname, '..', 'uploads');
const workingDirectory = path.resolve(__dirname, '..', 'working-copies');
const exportsDirectory = path.resolve(__dirname, '..', 'exports');
const EXPORT_RETENTION_HOURS = 24;
const PROFILE_PAGE_SIZE = 500;
const MAX_SELECTED_COLUMNS = 50000;
const EXPORT_TYPES = new Set(['complete', 'incomplete', 'cleaned', 'original']);

class ExportValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ExportValidationError';
    this.status = status;
  }
}

function toValues(value) {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function parseIndex(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const index = Number(value);
  return Number.isSafeInteger(index) ? index : null;
}

function getSelectionBody(body) {
  if (body.selection === undefined) return body;
  if (typeof body.selection !== 'string' || body.selection.length > 900000) {
    throw new ExportValidationError('The worksheet and column selection is too large. Select fewer columns.');
  }
  let selection;
  try {
    selection = JSON.parse(body.selection);
  } catch {
    throw new ExportValidationError('The worksheet and column selection is invalid. Reload the page and select again.');
  }
  if (!selection || typeof selection !== 'object'
    || !Array.isArray(selection.worksheetIndexes) || !Array.isArray(selection.columns)) {
    throw new ExportValidationError('The worksheet and column selection is invalid. Reload the page and select again.');
  }
  return { ...body, ...selection };
}

function normalizeExportOptions(body, upload) {
  body = getSelectionBody(body);
  const exportType = body.exportType;
  if (!EXPORT_TYPES.has(exportType)) {
    throw new ExportValidationError('Choose a supported export type.');
  }
  const worksheets = upload.worksheets.map((worksheet) => ({
    worksheetIndex: Number(worksheet.worksheet_index),
    columnCount: Number(worksheet.columnCount)
  }));
  if (!worksheets.length) {
    throw new ExportValidationError('This workbook does not have any available worksheets.');
  }

  if (exportType === 'original') {
    return {
      exportType,
      recordFilter: 'all',
      selectedSheets: worksheets.map((worksheet) => ({
        ...worksheet,
        columns: Array.from({ length: worksheet.columnCount }, (_, index) => index),
        allColumns: true
      }))
    };
  }

  const sheetIndexes = [];
  const submittedSheetIndexes = toValues(body.worksheetIndexes);
  const submittedColumns = toValues(body.columns);
  if (submittedColumns.length > MAX_SELECTED_COLUMNS) {
    throw new ExportValidationError(`Select no more than ${MAX_SELECTED_COLUMNS.toLocaleString()} columns at a time.`);
  }
  for (const value of submittedSheetIndexes) {
    const index = parseIndex(value);
    if (index === null || !worksheets.some((worksheet) => worksheet.worksheetIndex === index)) {
      throw new ExportValidationError('The worksheet selection contains an invalid worksheet.');
    }
    if (!sheetIndexes.includes(index)) sheetIndexes.push(index);
  }
  if (!sheetIndexes.length) {
    throw new ExportValidationError('Select at least one worksheet to export.');
  }

  const columnsBySheet = new Map(sheetIndexes.map((index) => [index, []]));
  for (const value of submittedColumns) {
    if (typeof value !== 'string' || !/^\d+:\d+$/.test(value)) {
      throw new ExportValidationError('The column selection is invalid.');
    }
    const [sheetIndex, columnIndex] = value.split(':').map(Number);
    if (!columnsBySheet.has(sheetIndex)) continue;
    const sheet = worksheets.find((worksheet) => worksheet.worksheetIndex === sheetIndex);
    if (!Number.isSafeInteger(columnIndex) || columnIndex < 0 || columnIndex >= sheet.columnCount) {
      throw new ExportValidationError('The column selection contains an invalid column.');
    }
    const selected = columnsBySheet.get(sheetIndex);
    if (!selected.includes(columnIndex)) selected.push(columnIndex);
  }

  const selectedSheets = sheetIndexes.map((worksheetIndex) => {
    const worksheet = worksheets.find((item) => item.worksheetIndex === worksheetIndex);
    const columns = columnsBySheet.get(worksheetIndex).sort((left, right) => left - right);
    if (!columns.length) {
      throw new ExportValidationError(`Select at least one column from worksheet ${worksheetIndex + 1}.`);
    }
    return {
      ...worksheet,
      columns,
      allColumns: columns.length === worksheet.columnCount
    };
  });

  let recordFilter = 'all';
  if (exportType === 'complete') recordFilter = 'complete';
  if (exportType === 'incomplete') recordFilter = 'incomplete';
  if (exportType === 'cleaned') {
    recordFilter = body.recordFilter || 'all';
    if (!['all', 'complete', 'incomplete'].includes(recordFilter)) {
      throw new ExportValidationError('Choose a supported record filter.');
    }
  }

  return { exportType, recordFilter, selectedSheets };
}

function getPrivateFilePath(directory, name) {
  if (typeof name !== 'string' || !/^[0-9a-f-]{36}\.(xlsx|xls)$/i.test(name)) {
    throw new Error('The saved workbook path is invalid.');
  }
  const root = path.resolve(directory);
  const filePath = path.resolve(root, name);
  if (!filePath.startsWith(`${root}${path.sep}`)) {
    throw new Error('The saved workbook path is invalid.');
  }
  return filePath;
}

function getExportFilePath(name, directory = exportsDirectory) {
  return getPrivateFilePath(directory, name);
}

function sanitizeBaseName(originalName) {
  const base = path.parse(String(originalName || 'workbook')).name;
  const safe = base
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 150);
  return safe || 'workbook';
}

function createFilename(originalName, exportType, extension, timestamp = new Date()) {
  const compactTimestamp = timestamp.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const typeLabel = {
    complete: 'complete-records',
    incomplete: 'incomplete-records',
    cleaned: 'cleaned',
    original: 'original'
  }[exportType];
  return `${sanitizeBaseName(originalName)}-${typeLabel}-${compactTimestamp}${extension}`;
}

function contiguousRanges(indexes) {
  const sorted = [...new Set(indexes)].sort((left, right) => left - right);
  const ranges = [];
  for (const index of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && last.start + last.count === index) {
      last.count += 1;
    } else {
      ranges.push({ start: index, count: 1 });
    }
  }
  return ranges;
}

function getRowsToRemove(profile, worksheetRowCount) {
  if (!profile || !profile.filterRows) return [];
  return [...profile.profiledRows]
    .filter((rowNumber) => rowNumber <= worksheetRowCount && !profile.includedRows.has(rowNumber))
    .map((rowNumber) => rowNumber - 1);
}

function applyXlsxExportOptions(workbook, config, profiles) {
  const selectedByIndex = new Map(config.selectedSheets.map((sheet) => [sheet.worksheetIndex, sheet]));
  const originalWorksheets = [...workbook.worksheets];
  for (let index = 0; index < originalWorksheets.length; index += 1) {
    const worksheet = originalWorksheets[index];
    const selected = selectedByIndex.get(index);
    if (!selected) {
      workbook.removeWorksheet(worksheet.id);
      continue;
    }
    const profile = profiles.get(index);
    const removeRows = getRowsToRemove(profile, worksheet.rowCount);
    for (const range of contiguousRanges(removeRows).reverse()) {
      worksheet.spliceRows(range.start + 1, range.count);
    }

    const originalColumnCount = Math.max(worksheet.columnCount, selected.columnCount);
    const selectedColumns = new Set(selected.columns);
    const removeColumns = Array.from({ length: originalColumnCount }, (_, columnIndex) => columnIndex)
      .filter((columnIndex) => !selectedColumns.has(columnIndex));
    for (const range of contiguousRanges(removeColumns).reverse()) {
      worksheet.spliceColumns(range.start + 1, range.count);
    }
  }
}

function decodeCellAddress(legacy, address) {
  try {
    return legacy.utils.decode_cell(address);
  } catch {
    return null;
  }
}

function applyLegacyExportOptions(workbook, config, profiles) {
  const selectedByIndex = new Map(config.selectedSheets.map((sheet) => [sheet.worksheetIndex, sheet]));
  const selectedNames = [];
  const selectedSheets = {};

  for (let index = 0; index < workbook.SheetNames.length; index += 1) {
    if (!selectedByIndex.has(index)) continue;
    const name = workbook.SheetNames[index];
    const source = workbook.Sheets[name];
    const configSheet = selectedByIndex.get(index);
    const profile = profiles.get(index);
    const range = source['!ref']
      ? legacyXlsx.utils.decode_range(source['!ref'])
      : { s: { r: 0, c: 0 }, e: { r: -1, c: -1 } };
    const rowMap = new Map();
    let nextRow = range.s.r;
    for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
      const excelRow = rowIndex + 1;
      if (profile && profile.filterRows
        && profile.profiledRows.has(excelRow)
        && !profile.includedRows.has(excelRow)) continue;
      rowMap.set(rowIndex, nextRow);
      nextRow += 1;
    }
    const columnMap = new Map(configSheet.columns.map((columnIndex, index) => [columnIndex, index]));
    const output = {};

    for (const key of Object.keys(source)) {
      if (key.startsWith('!') && !['!ref', '!cols', '!rows', '!merges', '!autofilter'].includes(key)) {
        output[key] = source[key];
      }
    }
    for (const key of Object.keys(source)) {
      if (key.startsWith('!')) continue;
      const cell = decodeCellAddress(legacyXlsx, key);
      if (!cell || !rowMap.has(cell.r) || !columnMap.has(cell.c)) continue;
      const address = legacyXlsx.utils.encode_cell({
        r: rowMap.get(cell.r),
        c: columnMap.get(cell.c)
      });
      output[address] = { ...source[key] };
    }

    if (Array.isArray(source['!rows'])) {
      output['!rows'] = [];
      for (const [oldRow, newRow] of rowMap) {
        if (source['!rows'][oldRow]) output['!rows'][newRow] = { ...source['!rows'][oldRow] };
      }
    }
    if (Array.isArray(source['!cols'])) {
      output['!cols'] = configSheet.columns.map((columnIndex) =>
        source['!cols'][columnIndex] ? { ...source['!cols'][columnIndex] } : {}
      );
    }
    if (Array.isArray(source['!merges'])) {
      const merges = [];
      for (const merge of source['!merges']) {
        const rowIndexes = [];
        for (let row = merge.s.r; row <= merge.e.r; row += 1) rowIndexes.push(row);
        const columnIndexes = [];
        for (let column = merge.s.c; column <= merge.e.c; column += 1) columnIndexes.push(column);
        const mappedRows = rowIndexes.map((row) => rowMap.get(row));
        const mappedColumns = columnIndexes.map((column) => columnMap.get(column));
        if (mappedRows.some((row) => row === undefined) || mappedColumns.some((column) => column === undefined)) continue;
        const rowsContiguous = mappedRows.every((row, i) => i === 0 || row === mappedRows[i - 1] + 1);
        const columnsContiguous = mappedColumns.every((column, i) => i === 0 || column === mappedColumns[i - 1] + 1);
        if (rowsContiguous && columnsContiguous) {
          merges.push({
            s: { r: mappedRows[0], c: mappedColumns[0] },
            e: { r: mappedRows[mappedRows.length - 1], c: mappedColumns[mappedColumns.length - 1] }
          });
        }
      }
      output['!merges'] = merges;
    }
    if (rowMap.size && columnMap.size) {
      output['!ref'] = legacyXlsx.utils.encode_range({
        s: { r: range.s.r, c: 0 },
        e: { r: nextRow - 1, c: configSheet.columns.length - 1 }
      });
    }
    selectedNames.push(name);
    selectedSheets[name] = output;
  }

  workbook.SheetNames = selectedNames;
  workbook.Sheets = selectedSheets;
}

async function getProfiles(userId, upload, config, profilingReady, repository = exportModel) {
  const profileRequired = config.exportType === 'complete'
    || config.exportType === 'incomplete'
    || (config.exportType === 'cleaned' && config.recordFilter !== 'all');
  if (profileRequired && !profilingReady) {
    throw new ExportValidationError('Data Profiling must be enabled before exporting complete or incomplete records.', 503);
  }
  if (!profilingReady) return { profiles: new Map(), runs: [] };

  const worksheetIndexes = config.selectedSheets.map((sheet) => sheet.worksheetIndex);
  const runs = await repository.getLatestCompletedRuns(userId, upload.id, worksheetIndexes);
  if (profileRequired && runs.length !== worksheetIndexes.length) {
    throw new ExportValidationError('Run Data Profiling on each selected worksheet before exporting complete or incomplete records.', 409);
  }
  if (!profileRequired) return { profiles: new Map(), runs };

  const profiles = new Map();
  for (const run of runs) {
    const profile = {
      filterRows: profileRequired,
      profiledRows: new Set(),
      includedRows: new Set()
    };
    let lastId = 0;
    while (true) {
      const rows = await repository.listProfileRowsAfter(run.id, lastId, PROFILE_PAGE_SIZE);
      if (!rows.length) break;
      for (const row of rows) {
        const rowNumber = Number(row.excel_row_number);
        profile.profiledRows.add(rowNumber);
        const isIncluded = config.recordFilter === 'complete'
          ? Number(row.missing_count) === 0
          : config.recordFilter === 'incomplete'
            ? Number(row.missing_count) > 0
            : true;
        if (isIncluded) profile.includedRows.add(rowNumber);
      }
      lastId = Number(rows[rows.length - 1].id);
      if (rows.length < PROFILE_PAGE_SIZE) break;
    }
    profiles.set(Number(run.worksheet_index), profile);
  }

  return { profiles, runs };
}

function getSummaryCounts(runs) {
  return runs.reduce((summary, run) => {
    summary.totalRecords += Number(run.total_records);
    summary.completeCount += Number(run.complete_records);
    summary.incompleteCount += Number(run.incomplete_records);
    return summary;
  }, { totalRecords: 0, completeCount: 0, incompleteCount: 0 });
}

function countFilteredRecords(config, profiles) {
  if (config.recordFilter === 'all') return null;
  return config.selectedSheets.reduce((total, sheet) => {
    const profile = profiles.get(sheet.worksheetIndex);
    return total + (profile ? profile.includedRows.size : 0);
  }, 0);
}

function estimateRecordsFromMetadata(config, upload) {
  return config.selectedSheets.reduce((total, sheet) => {
    const metadata = upload.worksheets.find((item) =>
      Number(item.worksheet_index) === sheet.worksheetIndex
    );
    return total + Number(metadata ? metadata.rowCount : 0);
  }, 0);
}

async function writeXlsxExport(sourcePath, temporaryPath, config, profiles) {
  const workbook = new ExcelJS.Workbook();
  try {
    await validateXlsxArchive(sourcePath);
    await workbook.xlsx.readFile(sourcePath);
  } catch {
    throw new ExportValidationError('The selected .xlsx workbook could not be opened for export.');
  }
  if (!workbook.worksheets.length) {
    throw new ExportValidationError('The selected workbook does not contain any worksheets.');
  }
  applyXlsxExportOptions(workbook, config, profiles);
  if (!workbook.worksheets.length) {
    throw new ExportValidationError('Select at least one worksheet to export.');
  }
  await workbook.xlsx.writeFile(temporaryPath);
}

async function writeLegacyExport(sourcePath, temporaryPath, config, profiles) {
  let workbook;
  try {
    await validateLegacyWorkbookSize(sourcePath);
    workbook = legacyXlsx.readFile(sourcePath, { cellDates: true, cellStyles: true });
  } catch {
    throw new ExportValidationError('The selected .xls workbook could not be opened for export.');
  }
  applyLegacyExportOptions(workbook, config, profiles);
  if (!workbook.SheetNames.length) {
    throw new ExportValidationError('Select at least one worksheet to export.');
  }
  legacyXlsx.writeFile(workbook, temporaryPath, { bookType: 'xlsx' });
}

async function createExportForUser(userId, body, {
  profilingReady = true,
  reviewReady = true,
  manipulationReady = true,
  now = new Date(),
  repositories = {},
  directories = {}
} = {}) {
  const uploadsRoot = directories.uploads || uploadsDirectory;
  const workingRoot = directories.working || workingDirectory;
  const exportsRoot = directories.exports || exportsDirectory;
  const uploadRepository = repositories.upload || uploadModel;
  const exportRepository = repositories.export || exportModel;
  const manipulationRepository = repositories.manipulation || manipulationModel;
  const uploadId = parseIndex(String(body.uploadId));
  if (!uploadId || uploadId < 1) {
    throw new ExportValidationError('Choose a valid uploaded workbook.');
  }
  const upload = await uploadRepository.getUploadForUser(userId, uploadId);
  if (!upload) {
    throw new ExportValidationError('This workbook is not available in your account.', 404);
  }
  const config = normalizeExportOptions(body, upload);
  if (!reviewReady) {
    throw new ExportValidationError('Apply the Phase 4 review schema before exporting review summaries or cleaned workbooks.', 503);
  }
  if (config.exportType === 'cleaned' && !manipulationReady) {
    throw new ExportValidationError('Apply the Phase 3 Word Manipulation schema before exporting a cleaned workbook.', 503);
  }
  const { profiles, runs } = await getProfiles(userId, upload, config, profilingReady, exportRepository);
  const profileSummary = getSummaryCounts(runs);
  const decisionCounts = await exportRepository.getDecisionCounts(
    userId,
    uploadId,
    config.selectedSheets
  );
  const filteredRecordCount = countFilteredRecords(config, profiles);
  const hasCompleteProfile = runs.length === config.selectedSheets.length;
  const recordCount = filteredRecordCount === null
    ? hasCompleteProfile
      ? profileSummary.totalRecords
      : estimateRecordsFromMetadata(config, upload)
    : filteredRecordCount;

  let sourcePath = getPrivateFilePath(uploadsRoot, upload.stored_name);
  if (config.exportType === 'cleaned') {
    const job = await manipulationRepository.getJobForUpload(userId, uploadId);
    if (job) {
      sourcePath = getPrivateFilePath(workingRoot, job.working_name);
    }
  }

  const extension = upload.file_extension === 'xls' && config.exportType === 'original'
    ? '.xls'
    : '.xlsx';
  const filename = createFilename(upload.original_name, config.exportType, extension, now);
  const storedName = `${crypto.randomUUID()}${extension}`;
  const finalPath = getExportFilePath(storedName, exportsRoot);
  const temporaryPath = path.join(exportsRoot, `.${crypto.randomUUID()}.tmp`);
  let installed = false;
  let registered = false;
  try {
    await fs.mkdir(exportsRoot, { recursive: true });
    try {
      await fs.access(sourcePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new ExportValidationError('The source workbook is missing. Re-upload it before exporting.', 409);
      }
      throw error;
    }
    if (config.exportType === 'original') {
      await fs.copyFile(sourcePath, temporaryPath);
    } else if (path.extname(sourcePath).toLowerCase() === '.xls') {
      await writeLegacyExport(sourcePath, temporaryPath, config, profiles);
    } else {
      await writeXlsxExport(sourcePath, temporaryPath, config, profiles);
    }
    await fs.rename(temporaryPath, finalPath);
    installed = true;
    const exportId = await exportRepository.createExport({
      userId,
      uploadId,
      exportType: config.exportType,
      recordFilter: config.recordFilter,
      storedName,
      filename,
      recordCount,
      completeCount: hasCompleteProfile ? profileSummary.completeCount : null,
      incompleteCount: hasCompleteProfile ? profileSummary.incompleteCount : null,
      approvedChangeCount: decisionCounts.approved,
      rejectedChangeCount: decisionCounts.rejected,
      worksheetCount: config.selectedSheets.length,
      columnCount: config.selectedSheets.reduce((total, sheet) => total + sheet.columns.length, 0),
      expiresAt: new Date(now.getTime() + EXPORT_RETENTION_HOURS * 60 * 60 * 1000)
    });
    registered = true;
    return exportRepository.getExportForUser(userId, exportId);
  } finally {
    await fs.unlink(temporaryPath).catch((error) => {
      if (error.code !== 'ENOENT') console.error('Unable to remove a temporary export file:', error.message);
    });
    if (installed && !registered) {
      await fs.unlink(finalPath).catch((error) => {
        if (error.code !== 'ENOENT') console.error('Unable to remove an unregistered export file:', error.message);
      });
    }
  }
}

async function buildWorksheetOptions(upload) {
  const filePath = getPrivateFilePath(uploadsDirectory, upload.stored_name);
  const options = [];
  for (const worksheet of upload.worksheets) {
    const columnCount = Number(worksheet.columnCount);
    const headers = await getWorksheetHeaders(filePath, Number(worksheet.worksheet_index), columnCount);
    options.push({
      worksheetIndex: Number(worksheet.worksheet_index),
      name: worksheet.name,
      columns: headers.map((header, index) => ({
        index,
        name: String(header || '').trim() || `Column ${index + 1}`
      }))
    });
  }
  return options;
}

async function cleanupExpiredExports(options = {}) {
  const model = options.model || exportModel;
  const cleanupDirectory = options.directory || exportsDirectory;
  const now = options.now === undefined ? Date.now() : options.now;
  let deletedCount = 0;
  while (true) {
    const expired = await model.listExpiredExports(500);
    if (!expired.length) break;
    for (const item of expired) {
      const filePath = getExportFilePath(item.stored_name, cleanupDirectory);
      try {
        await fs.unlink(filePath);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.error('Unable to remove an expired export file:', error.message);
          continue;
        }
      }
      await model.markExportFileDeleted(item.id);
      deletedCount += 1;
    }
    if (expired.length < 500) break;
  }
  const cutoff = now - EXPORT_RETENTION_HOURS * 60 * 60 * 1000;
  const activeNames = new Set(await model.listStoredExportNames());
  const entries = await fs.readdir(cleanupDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const isTemporary = /^\.[0-9a-f-]{36}\.tmp$/i.test(entry.name);
    const isStoredExport = /^[0-9a-f-]{36}\.(xlsx|xls)$/i.test(entry.name);
    if (!isTemporary && (!isStoredExport || activeNames.has(entry.name))) continue;
    const filePath = path.join(cleanupDirectory, entry.name);
    let stats;
    try {
      stats = await fs.stat(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (stats.mtimeMs > cutoff) continue;
    try {
      await fs.unlink(filePath);
      if (isStoredExport) deletedCount += 1;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return deletedCount;
}

module.exports = {
  ExportValidationError,
  normalizeExportOptions,
  createFilename,
  applyXlsxExportOptions,
  applyLegacyExportOptions,
  createExportForUser,
  buildWorksheetOptions,
  getExportFilePath,
  cleanupExpiredExports,
  EXPORT_RETENTION_HOURS,
  exportsDirectory
};
