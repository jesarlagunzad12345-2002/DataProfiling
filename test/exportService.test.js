const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const ExcelJS = require('exceljs');
const legacyXlsx = require('@e965/xlsx');
const {
  normalizeExportOptions,
  createFilename,
  applyXlsxExportOptions,
  applyLegacyExportOptions,
  createExportForUser,
  getExportFilePath,
  cleanupExpiredExports,
  EXPORT_RETENTION_HOURS
} = require('../services/exportService');

const sampleUpload = {
  file_extension: 'xlsx',
  original_name: 'Quarterly report.xlsx',
  worksheets: [
    { worksheet_index: 0, name: 'Customers', rowCount: 4, columnCount: 3 },
    { worksheet_index: 1, name: 'Archive', rowCount: 2, columnCount: 2 }
  ]
};

test('validates worksheet and column export selections', () => {
  const config = normalizeExportOptions({
    exportType: 'cleaned',
    recordFilter: 'incomplete',
    worksheetIndexes: ['0'],
    columns: ['0:0', '0:2']
  }, sampleUpload);

  assert.equal(config.recordFilter, 'incomplete');
  assert.deepEqual(config.selectedSheets, [{
    worksheetIndex: 0,
    columnCount: 3,
    columns: [0, 2],
    allColumns: false
  }]);

  assert.throws(() => normalizeExportOptions({
    exportType: 'complete',
    worksheetIndexes: ['9'],
    columns: ['9:0']
  }, sampleUpload), /invalid worksheet/);
  assert.throws(() => normalizeExportOptions({
    exportType: 'cleaned',
    worksheetIndexes: ['0'],
    columns: ['0:8']
  }, sampleUpload), /invalid column/);
  assert.throws(() => normalizeExportOptions({
    exportType: 'complete',
    worksheetIndexes: ['0'],
    columns: []
  }, sampleUpload), /at least one column/);
});

test('original export selection always includes every worksheet and column', () => {
  const config = normalizeExportOptions({ exportType: 'original' }, sampleUpload);
  assert.deepEqual(config.selectedSheets.map((sheet) => sheet.worksheetIndex), [0, 1]);
  assert.deepEqual(config.selectedSheets.map((sheet) => sheet.columns), [[0, 1, 2], [0, 1]]);
});

test('creates safe descriptive filenames with a stable timestamp', () => {
  const filename = createFilename(
    '../../Customer Data.xlsx',
    'cleaned',
    '.xlsx',
    new Date('2026-11-21T11:01:02.000Z')
  );
  assert.equal(filename, 'Customer-Data-cleaned-20261121T110102Z.xlsx');
  assert.doesNotMatch(filename, /[\\/]/);
});

test('filters xlsx rows, worksheets, and columns while preserving retained cell styles', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Customers');
  sheet.columns = [{ width: 24 }, { width: 18 }, { width: 14 }];
  sheet.addRow(['Name', 'Unused', 'Amount']);
  sheet.addRow(['Ada', 'x', 1234.5]);
  sheet.addRow(['Missing', '', 20]);
  sheet.addRow(['Footer', '', 'kept']);
  sheet.getCell('A1').font = { bold: true };
  sheet.getCell('C2').numFmt = '$#,##0.00';
  workbook.addWorksheet('Archive').addRow(['Not included']);

  const profiles = new Map([[0, {
    filterRows: true,
    profiledRows: new Set([2, 3]),
    includedRows: new Set([2])
  }]]);
  applyXlsxExportOptions(workbook, {
    selectedSheets: [{
      worksheetIndex: 0,
      columnCount: 3,
      columns: [0, 2]
    }]
  }, profiles);

  const output = workbook.worksheets[0];
  assert.equal(workbook.worksheets.length, 1);
  assert.equal(output.name, 'Customers');
  assert.deepEqual(output.getRow(1).values.slice(1), ['Name', 'Amount']);
  assert.deepEqual(output.getRow(2).values.slice(1), ['Ada', 1234.5]);
  assert.deepEqual(output.getRow(3).values.slice(1), ['Footer', 'kept']);
  assert.equal(output.getCell('A1').font.bold, true);
  assert.equal(output.getCell('B2').numFmt, '$#,##0.00');
  assert.equal(output.getColumn(1).width, 24);
  assert.equal(output.getColumn(2).width, 14);
});

test('converts filtered legacy xls sheets into a readable xlsx without changing source', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clearsheet-export-test-'));
  try {
    const sourcePath = path.join(directory, 'source.xls');
    const outputPath = path.join(directory, 'filtered.xlsx');
    const sourceSheet = legacyXlsx.utils.aoa_to_sheet([
      ['Name', 'Unused', 'Amount'],
      ['Ada', 'x', 12],
      ['Missing', '', 20]
    ]);
    const sourceWorkbook = legacyXlsx.utils.book_new();
    legacyXlsx.utils.book_append_sheet(sourceWorkbook, sourceSheet, 'Customers');
    legacyXlsx.writeFile(sourceWorkbook, sourcePath, { bookType: 'xls' });

    const legacyWorkbook = legacyXlsx.readFile(sourcePath, { cellDates: true, cellStyles: true });
    const profiles = new Map([[0, {
      filterRows: true,
      profiledRows: new Set([2, 3]),
      includedRows: new Set([2])
    }]]);
    applyLegacyExportOptions(legacyWorkbook, {
      selectedSheets: [{
        worksheetIndex: 0,
        columnCount: 3,
        columns: [0, 2]
      }]
    }, profiles);
    legacyXlsx.writeFile(legacyWorkbook, outputPath, { bookType: 'xlsx' });

    const result = new ExcelJS.Workbook();
    await result.xlsx.readFile(outputPath);
    assert.equal(result.worksheets[0].name, 'Customers');
    assert.deepEqual(result.worksheets[0].getRow(1).values.slice(1), ['Name', 'Amount']);
    assert.deepEqual(result.worksheets[0].getRow(2).values.slice(1), ['Ada', 12]);
    assert.equal(result.worksheets[0].getRow(3).getCell(1).value, null);

    const original = legacyXlsx.readFile(sourcePath);
    assert.equal(legacyXlsx.utils.sheet_to_json(original.Sheets.Customers, { header: 1 })[2][0], 'Missing');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('creates original, complete, incomplete, and approved-only exports with summaries', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clearsheet-export-flow-'));
  const uploadDirectory = path.join(directory, 'uploads');
  const workingDirectory = path.join(directory, 'working-copies');
  const exportDirectory = path.join(directory, 'exports');
  await Promise.all([
    fs.mkdir(uploadDirectory),
    fs.mkdir(workingDirectory),
    fs.mkdir(exportDirectory)
  ]);
  try {
    const storedName = '11111111-1111-4111-8111-111111111111.xlsx';
    const workingName = `${crypto.randomUUID()}.xlsx`;
    const uploadPath = path.join(uploadDirectory, storedName);
    const workingPath = path.join(workingDirectory, workingName);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Customers');
    sheet.addRow(['Name', 'Email']);
    sheet.addRow(['Complete', 'ada@example.com']);
    sheet.addRow(['Incomplete', '']);
    workbook.addWorksheet('Archive').addRow(['Not exported']);
    await workbook.xlsx.writeFile(uploadPath);

    const approvedWorkbook = new ExcelJS.Workbook();
    const approvedSheet = approvedWorkbook.addWorksheet('Customers');
    approvedSheet.addRow(['Name', 'Email']);
    approvedSheet.addRow(['Approved name', 'ada@example.com']);
    approvedSheet.addRow(['Incomplete', '']);
    approvedWorkbook.addWorksheet('Archive').addRow(['Not exported']);
    await approvedWorkbook.xlsx.writeFile(workingPath);

    const upload = {
      id: 8,
      original_name: 'Quarterly report.xlsx',
      stored_name: storedName,
      file_extension: 'xlsx',
      worksheets: [
        { worksheet_index: 0, name: 'Customers', rowCount: 3, columnCount: 2 },
        { worksheet_index: 1, name: 'Archive', rowCount: 1, columnCount: 1 }
      ]
    };
    const savedExports = new Map();
    let nextExportId = 1;
    const repositories = {
      upload: {
        async getUploadForUser() { return upload; }
      },
      manipulation: {
        async getJobForUpload() { return { working_name: workingName }; }
      },
      export: {
        async getLatestCompletedRuns(_userId, _uploadId, worksheetIndexes) {
          return worksheetIndexes.includes(0)
            ? [{
              id: 15,
              worksheet_index: 0,
              total_records: 2,
              complete_records: 1,
              incomplete_records: 1
            }]
            : [];
        },
        async listProfileRowsAfter(_runId, lastId) {
          return [
            { id: 1, excel_row_number: 2, missing_count: 0 },
            { id: 2, excel_row_number: 3, missing_count: 1 }
          ].filter((row) => row.id > lastId);
        },
        async getDecisionCounts() { return { approved: 1, rejected: 2 }; },
        async createExport(record) {
          const id = nextExportId++;
          savedExports.set(id, {
            id,
            upload_id: record.uploadId,
            export_type: record.exportType,
            record_filter: record.recordFilter,
            stored_name: record.storedName,
            filename: record.filename,
            record_count: record.recordCount,
            complete_count: record.completeCount,
            incomplete_count: record.incompleteCount,
            approved_change_count: record.approvedChangeCount,
            rejected_change_count: record.rejectedChangeCount,
            worksheet_count: record.worksheetCount,
            column_count: record.columnCount,
            expires_at: record.expiresAt,
            original_name: upload.original_name
          });
          return id;
        },
        async getExportForUser(_userId, id) { return savedExports.get(id); }
      }
    };
    const options = {
      profilingReady: true,
      reviewReady: true,
      manipulationReady: true,
      now: new Date('2026-11-21T11:01:02.000Z'),
      repositories,
      directories: {
        uploads: uploadDirectory,
        working: workingDirectory,
        exports: exportDirectory
      }
    };
    const selectCustomerColumns = {
      uploadId: '8',
      worksheetIndexes: ['0'],
      columns: ['0:0', '0:1']
    };

    const originalExport = await createExportForUser(3, {
      uploadId: '8',
      exportType: 'original'
    }, options);
    const originalBytes = await fs.readFile(uploadPath);
    const downloadedOriginal = await fs.readFile(getExportFilePath(originalExport.stored_name, exportDirectory));
    assert.deepEqual(downloadedOriginal, originalBytes);
    assert.equal(originalExport.export_type, 'original');

    const completeExport = await createExportForUser(3, {
      ...selectCustomerColumns,
      exportType: 'complete'
    }, options);
    const completeWorkbook = new ExcelJS.Workbook();
    await completeWorkbook.xlsx.readFile(getExportFilePath(completeExport.stored_name, exportDirectory));
    assert.equal(completeWorkbook.worksheets.length, 1);
    assert.deepEqual(completeWorkbook.worksheets[0].getRow(2).values.slice(1), ['Complete', 'ada@example.com']);
    assert.equal(completeWorkbook.worksheets[0].getRow(3).getCell(1).value, null);
    assert.equal(Number(completeExport.record_count), 1);
    assert.equal(Number(completeExport.complete_count), 1);
    assert.equal(Number(completeExport.incomplete_count), 1);

    const incompleteExport = await createExportForUser(3, {
      ...selectCustomerColumns,
      exportType: 'incomplete'
    }, options);
    const incompleteWorkbook = new ExcelJS.Workbook();
    await incompleteWorkbook.xlsx.readFile(getExportFilePath(incompleteExport.stored_name, exportDirectory));
    assert.deepEqual(incompleteWorkbook.worksheets[0].getRow(2).values.slice(1), ['Incomplete', '']);
    assert.equal(Number(incompleteExport.record_count), 1);

    const cleanedExport = await createExportForUser(3, {
      ...selectCustomerColumns,
      exportType: 'cleaned',
      recordFilter: 'all'
    }, options);
    const cleanedWorkbook = new ExcelJS.Workbook();
    await cleanedWorkbook.xlsx.readFile(getExportFilePath(cleanedExport.stored_name, exportDirectory));
    assert.equal(cleanedWorkbook.worksheets[0].getCell('A2').value, 'Approved name');
    assert.equal(cleanedWorkbook.worksheets[0].getCell('B2').value, 'ada@example.com');
    assert.equal(Number(cleanedExport.approved_change_count), 1);
    assert.equal(Number(cleanedExport.rejected_change_count), 2);

    const untouched = new ExcelJS.Workbook();
    await untouched.xlsx.readFile(uploadPath);
    assert.equal(untouched.worksheets[0].getCell('A2').value, 'Complete');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('expires export files while retaining summary history and active downloads', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clearsheet-export-cleanup-'));
  const now = Date.now();
  const expiredName = '11111111-1111-4111-8111-111111111111.xlsx';
  const activeName = '22222222-2222-4222-8222-222222222222.xlsx';
  const temporaryName = '.33333333-3333-4333-8333-333333333333.tmp';
  const history = new Map([[17, {
    id: 17,
    stored_name: expiredName,
    filename: 'report.xlsx',
    file_deleted_at: null
  }]]);
  const expiredIds = [];
  let expiredBatchReturned = false;
  try {
    await Promise.all([
      fs.writeFile(path.join(directory, expiredName), 'expired'),
      fs.writeFile(path.join(directory, activeName), 'active'),
      fs.writeFile(path.join(directory, temporaryName), 'temporary')
    ]);
    const oldTime = new Date(now - (EXPORT_RETENTION_HOURS + 1) * 60 * 60 * 1000);
    await fs.utimes(path.join(directory, temporaryName), oldTime, oldTime);

    const model = {
      async listExpiredExports() {
        if (expiredBatchReturned) return [];
        expiredBatchReturned = true;
        return [{ id: 17, stored_name: expiredName }];
      },
      async markExportFileDeleted(id) {
        expiredIds.push(id);
        history.get(id).file_deleted_at = new Date(now);
      },
      async listStoredExportNames() { return [activeName]; }
    };

    const removed = await cleanupExpiredExports({ model, directory, now });

    assert.equal(removed, 1);
    assert.deepEqual(expiredIds, [17]);
    assert.ok(history.get(17).file_deleted_at instanceof Date);
    await assert.rejects(fs.access(path.join(directory, expiredName)), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(directory, temporaryName)), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(directory, activeName), 'utf8'), 'active');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
