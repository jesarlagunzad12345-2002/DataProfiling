const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pool } = require('../config/database');
const manipulationModel = require('../models/manipulationModel');
const profilingModel = require('../models/profilingModel');
const reviewModel = require('../models/reviewModel');
const wordService = require('./wordManipulationService');

const uploadsDirectory = path.resolve(__dirname, '..', 'uploads');
const DEFAULT_WORKING_DIRECTORY = path.resolve(__dirname, '..', 'working-copies');
const MAX_EDIT_LENGTH = 32767;
const IMPORT_PAGE_SIZE = 200;

class ReviewValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ReviewValidationError';
    this.status = status;
  }
}

function parseJson(value, fallback = null) {
  if (typeof value !== 'string') return value === undefined ? fallback : value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseColumnIndex(value) {
  if (Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const index = Number(value);
    return Number.isSafeInteger(index) ? index : null;
  }
  return null;
}

function getTarget(row, options, optionName, originalValues) {
  const columnIndex = parseColumnIndex(options[optionName]);
  if (columnIndex === null) {
    return { cellReference: null, columnIndex: null, columnName: null, originalValue: null };
  }
  const columnNames = Array.isArray(options.columnNames) ? options.columnNames : [];
  return {
    cellReference: `${wordService.columnToLetters(columnIndex)}${row.excel_row_number}`,
    columnIndex,
    columnName: String(columnNames[columnIndex] || `Column ${columnIndex + 1}`).slice(0, 255),
    originalValue: originalValues[columnIndex] === undefined ? null : originalValues[columnIndex]
  };
}

function makeProfileItem({
  userId,
  uploadId,
  run,
  record,
  sourceKey,
  reason,
  target = {},
  proposedValue = null,
  details = null,
  status = 'requires_review',
  isActionable = false
}) {
  return {
    userId,
    uploadId,
    worksheetIndex: Number(run.worksheet_index),
    cellReference: target.cellReference || null,
    row: Number(record.excel_row_number),
    columnIndex: target.columnIndex === undefined ? null : target.columnIndex,
    columnName: target.columnName || null,
    originalValue: target.originalValue === undefined ? null : target.originalValue,
    proposedValue,
    details,
    reason: reason.slice(0, 500),
    sourceType: 'profiling',
    sourceKey,
    sourceRunId: Number(run.id),
    sourceRecordId: Number(record.id),
    sourceHistoryId: null,
    isActionable,
    status
  };
}

function buildProfilingReviewItems({
  userId,
  uploadId,
  run,
  options,
  records,
  duplicateDetails = {}
}) {
  const items = [];
  for (const record of records) {
    const originalValues = Array.isArray(record.original_values)
      ? record.original_values
      : parseJson(record.original_values_json, []);
    const suggestions = record.suggestions && typeof record.suggestions === 'object'
      ? record.suggestions
      : parseJson(record.suggestions_json, {});
    const issues = record.issues && typeof record.issues === 'object'
      ? record.issues
      : parseJson(record.issues_json, {});
    const source = `${run.id}:${record.id}`;

    if (suggestions.phone && suggestions.phone.standardized) {
      const target = getTarget(record, options, 'phoneColumn', originalValues);
      const proposedValue = String(suggestions.phone.standardized);
      if (!target.cellReference || String(target.originalValue) !== proposedValue) items.push(makeProfileItem({
        userId,
        uploadId,
        run,
        record,
        sourceKey: `profile:${source}:phone`,
        target,
        proposedValue,
        details: suggestions.phone,
        reason: 'Suggested international phone-number standardization.',
        status: target.cellReference ? 'pending' : 'requires_review',
        isActionable: Boolean(target.cellReference)
      }));
    }

    if (suggestions.country && suggestions.country.standardized) {
      const target = getTarget(record, options, 'countryColumn', originalValues);
      const proposedValue = String(suggestions.country.standardized);
      if (!target.cellReference || String(target.originalValue) !== proposedValue) items.push(makeProfileItem({
        userId,
        uploadId,
        run,
        record,
        sourceKey: `profile:${source}:country`,
        target,
        proposedValue,
        details: suggestions.country,
        reason: 'Suggested country-name standardization using local ISO country data.',
        status: target.cellReference ? 'pending' : 'requires_review',
        isActionable: Boolean(target.cellReference)
      }));
    }

    if (suggestions.address) {
      const target = getTarget(record, options, 'addressColumn', originalValues);
      items.push(makeProfileItem({
        userId,
        uploadId,
        run,
        record,
        sourceKey: `profile:${source}:address`,
        target,
        details: suggestions.address,
        reason: 'Address components were parsed conservatively. Confirm or edit a complete cell value before approval.',
        status: 'requires_review',
        isActionable: false
      }));
    }

    const missingIndexes = Array.isArray(issues.missingColumnIndexes)
      ? issues.missingColumnIndexes.map(parseColumnIndex).filter((index) => index !== null)
      : [];
    if (missingIndexes.length) {
      const names = missingIndexes.map((index) =>
        String((options.columnNames || [])[index] || `Column ${index + 1}`)
      );
      items.push(makeProfileItem({
        userId,
        uploadId,
        run,
        record,
        sourceKey: `profile:${source}:missing`,
        details: { columns: names },
        reason: `Missing values detected in ${names.length} column${names.length === 1 ? '' : 's'}; no values have been invented.`,
        status: 'requires_review',
        isActionable: false
      }));
    }

    if ((record.invalid_phone || record.suspicious_phone) && !suggestions.phone) {
      const target = getTarget(record, options, 'phoneColumn', originalValues);
      items.push(makeProfileItem({
        userId,
        uploadId,
        run,
        record,
        sourceKey: `profile:${source}:phone-issue`,
        target,
        details: issues.phone || {},
        reason: record.invalid_phone ? 'Invalid phone number needs manual review.' : 'Suspicious phone number needs manual review.',
        status: 'requires_review',
        isActionable: false
      }));
    }

    if (record.address_issue && !suggestions.address) {
      const target = getTarget(record, options, 'addressColumn', originalValues);
      items.push(makeProfileItem({
        userId,
        uploadId,
        run,
        record,
        sourceKey: `profile:${source}:address-issue`,
        target,
        details: issues.address || {},
        reason: 'Address is ambiguous or incomplete and requires manual review.',
        status: 'requires_review',
        isActionable: false
      }));
    }

    if (record.country_inconsistent && !suggestions.country) {
      const target = getTarget(record, options, 'countryColumn', originalValues);
      items.push(makeProfileItem({
        userId,
        uploadId,
        run,
        record,
        sourceKey: `profile:${source}:country-issue`,
        target,
        details: issues.country || {},
        reason: 'Country value is inconsistent and needs manual review.',
        status: 'requires_review',
        isActionable: false
      }));
    }

    const duplicates = duplicateDetails[record.id] || [];
    const duplicateTypes = [
      record.duplicate_exact && 'exact',
      record.duplicate_phone && 'phone',
      record.duplicate_email && 'email'
    ].filter(Boolean);
    if (duplicates.length || duplicateTypes.length) {
      const details = duplicates.length ? duplicates : duplicateTypes.map((type) => ({ type }));
      items.push(makeProfileItem({
        userId,
        uploadId,
        run,
        record,
        sourceKey: `profile:${source}:duplicates`,
        target: { originalValue: originalValues },
        details,
        reason: `Duplicate ${duplicateTypes.join(', ') || 'record'} match${duplicateTypes.length === 1 ? '' : 'es'} detected; compare the listed rows.`,
        status: 'requires_review',
        isActionable: false
      }));
    }
  }
  return items;
}

function getPrivatePath(directory, name) {
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

function getWorkingPath(workingDirectory, workingName) {
  return getPrivatePath(workingDirectory, workingName);
}

async function restoreFileReplacement(fileState) {
  if (fileState.installed) {
    await fs.unlink(fileState.finalPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  if (fileState.originalMoved) await fs.rename(fileState.backupPath, fileState.finalPath);
}

async function installWorkingCopy(tempPath, finalPath, backupPath, fileState) {
  try {
    await fs.rename(finalPath, backupPath);
    fileState.originalMoved = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fileState.finalPath = finalPath;
  fileState.backupPath = backupPath;
  await fs.rename(tempPath, finalPath);
  fileState.installed = true;
}

async function syncUpload(userId, upload, workingDirectory = DEFAULT_WORKING_DIRECTORY) {
  let insertedCandidates = 0;
  const runs = await reviewModel.listLatestCompletedRuns(userId, upload.id);
  for (const run of runs) {
    const options = parseJson(run.options_json, {});
    let lastId = 0;
    while (true) {
      const records = await reviewModel.listProfilingRecordsAfter(run.id, lastId, IMPORT_PAGE_SIZE);
      if (!records.length) break;
      const duplicateDetails = await profilingModel.getDuplicateDetails(records.map((record) => record.id));
      const items = buildProfilingReviewItems({
        userId,
        uploadId: Number(upload.id),
        run,
        options,
        records: records.map((record) => ({
          ...record,
          original_values: parseJson(record.original_values_json, []),
          suggestions: parseJson(record.suggestions_json, {}),
          issues: parseJson(record.issues_json, {})
        })),
        duplicateDetails
      });
      await reviewModel.insertChanges(pool, items);
      insertedCandidates += items.length;
      lastId = Number(records[records.length - 1].id);
      if (records.length < IMPORT_PAGE_SIZE) break;
    }
  }

  const job = await manipulationModel.getJobForUpload(userId, upload.id);
  const workbookPath = job
    ? getWorkingPath(workingDirectory, job.working_name)
    : getPrivatePath(uploadsDirectory, upload.stored_name);
  const headersBySheet = new Map();
  let cursor = { historyId: 0, row: 0, columnIndex: -1 };
  while (true) {
    const changes = await reviewModel.listLegacyWordChangesAfter(userId, upload.id, cursor, IMPORT_PAGE_SIZE);
    if (!changes.length) break;
    const items = [];
    for (const change of changes) {
      if (!headersBySheet.has(change.worksheet_index)) {
        headersBySheet.set(
          change.worksheet_index,
          await wordService.getWorksheetHeaders(workbookPath, Number(change.worksheet_index))
        );
      }
      const headers = headersBySheet.get(change.worksheet_index);
      const operation = wordService.getOperationLabel(change.operation) || change.operation;
      items.push({
        userId,
        uploadId: Number(upload.id),
        worksheetIndex: Number(change.worksheet_index),
        cellReference: change.cell_reference,
        row: Number(change.excel_row_number),
        columnIndex: Number(change.column_index),
        columnName: headers[Number(change.column_index)] || `Column ${Number(change.column_index) + 1}`,
        originalValue: parseJson(change.original_value_json),
        proposedValue: parseJson(change.modified_value_json),
        reason: `Previously confirmed Word Manipulation operation: ${operation}.`,
        sourceType: 'word-manipulation',
        sourceKey: `word:${change.history_id}:${change.cell_reference}`,
        sourceHistoryId: Number(change.history_id),
        isActionable: true,
        status: 'approved'
      });
    }
    await reviewModel.insertChanges(pool, items);
    insertedCandidates += items.length;
    const last = changes[changes.length - 1];
    cursor = {
      historyId: Number(last.history_id),
      row: Number(last.excel_row_number),
      columnIndex: Number(last.column_index)
    };
    if (changes.length < IMPORT_PAGE_SIZE) break;
  }
  return { importedCandidates: insertedCandidates };
}

function parseIdList(ids) {
  const values = Array.isArray(ids) ? ids : [ids];
  if (values.length < 1 || values.length > 100) {
    throw new ReviewValidationError('Select between 1 and 100 changes at a time.');
  }
  const parsed = values.map((value) => {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  });
  if (parsed.some((id) => id === null) || new Set(parsed).size !== parsed.length) {
    throw new ReviewValidationError('The selected review items are invalid. Select them again.');
  }
  return parsed;
}

async function editProposedValue(userId, changeId, proposedValue) {
  if (typeof proposedValue !== 'string' || proposedValue.length > MAX_EDIT_LENGTH) {
    throw new ReviewValidationError(`Enter a value no longer than ${MAX_EDIT_LENGTH.toLocaleString()} characters.`);
  }
  const connection = await pool.getConnection();
  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;
    const change = await reviewModel.getChangeForUpdate(connection, userId, changeId);
    if (!change) throw new ReviewValidationError('This review item is not available in your account.', 404);
    if (!['pending', 'requires_review'].includes(change.status)) {
      throw new ReviewValidationError('Only pending review items can be edited.', 409);
    }
    if (!change.cell_reference || change.column_index === null) {
      throw new ReviewValidationError('This finding is informational and has no target cell to edit.', 400);
    }
    const previousValue = parseJson(change.proposed_value_json);
    const previousStatus = change.status;
    await reviewModel.updateChange(connection, change, {
      proposedValue,
      status: 'pending',
      isActionable: true,
      reviewedBy: null,
      reviewed: false
    });
    await reviewModel.insertAudit(connection, [{
      changeId: change.id,
      userId,
      uploadId: change.upload_id,
      worksheetIndex: change.worksheet_index,
      cellReference: change.cell_reference,
      originalValue: parseJson(change.original_value_json),
      previousProposedValue: previousValue,
      proposedValue,
      previousStatus,
      newStatus: 'pending',
      action: 'edited'
    }]);
    await connection.commit();
    return { uploadId: Number(change.upload_id) };
  } catch (error) {
    if (transactionStarted) await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function getApprovalValue(change) {
  const value = parseJson(change.proposed_value_json);
  if (value !== null && typeof value !== 'string' && typeof value !== 'number') {
    throw new ReviewValidationError('Edit this suggestion to a single cell value before approving it.');
  }
  if (!change.cell_reference || change.column_index === null) {
    throw new ReviewValidationError('This finding is informational and cannot be applied to a cell.');
  }
  return value;
}

async function decideChanges(userId, ids, action, workingDirectory = DEFAULT_WORKING_DIRECTORY) {
  if (action !== 'approve' && action !== 'reject') {
    throw new ReviewValidationError('Choose approve or reject.');
  }
  const changeIds = parseIdList(ids);
  const connection = await pool.getConnection();
  let transactionStarted = false;
  let tempPath = null;
  const fileState = { installed: false, originalMoved: false };
  let committed = false;

  try {
    await connection.beginTransaction();
    transactionStarted = true;
    const changes = await reviewModel.getChangesForUpdate(connection, userId, changeIds);
    if (changes.length !== changeIds.length) {
      throw new ReviewValidationError('One or more selected review items are not available in your account.', 404);
    }
    const uploadId = Number(changes[0].upload_id);
    if (changes.some((change) => Number(change.upload_id) !== uploadId)) {
      throw new ReviewValidationError('Bulk actions can only include changes from one workbook.');
    }
    const lockedUpload = await reviewModel.lockUpload(connection, userId, uploadId);
    if (!lockedUpload) {
      throw new ReviewValidationError('This workbook is not available in your account.', 404);
    }
    if (changes.some((change) => !['pending', 'requires_review'].includes(change.status))) {
      throw new ReviewValidationError('One or more changes were already reviewed. Reload the page before continuing.', 409);
    }
    if (action === 'approve' && changes.some((change) =>
      change.status !== 'pending' || !change.is_actionable
    )) {
      throw new ReviewValidationError('Edit cell suggestions first. Informational findings can be rejected but not applied.');
    }

    const nowStatus = action === 'approve' ? 'approved' : 'rejected';
    const auditRows = changes.map((change) => ({
      changeId: change.id,
      userId,
      uploadId,
      worksheetIndex: change.worksheet_index,
      cellReference: change.cell_reference,
      originalValue: parseJson(change.original_value_json),
      previousProposedValue: parseJson(change.proposed_value_json),
      proposedValue: parseJson(change.proposed_value_json),
      previousStatus: change.status,
      newStatus: nowStatus,
      action: action === 'approve' ? 'approved' : 'rejected'
    }));

    if (action === 'approve') {
      const extension = lockedUpload.file_extension === 'xls' ? '.xls' : '.xlsx';
      let job = await manipulationModel.getJobForUpdate(connection, userId, uploadId);
      const workingName = job ? job.working_name : `${crypto.randomUUID()}${extension}`;
      const finalPath = getWorkingPath(workingDirectory, workingName);
      const sourcePath = job
        ? finalPath
        : getPrivatePath(uploadsDirectory, lockedUpload.stored_name);
      if (job) await fs.access(sourcePath);
      const state = await wordService.loadWorkbook(sourcePath);
      const changesByWorksheet = new Map();
      for (const change of changes) {
        const worksheetIndex = Number(change.worksheet_index);
        const worksheetChanges = changesByWorksheet.get(worksheetIndex) || [];
        worksheetChanges.push({
          row: Number(change.excel_row_number),
          column: Number(change.column_index),
          cellReference: change.cell_reference,
          modifiedValue: getApprovalValue(change)
        });
        changesByWorksheet.set(worksheetIndex, worksheetChanges);
      }
      for (const [worksheetIndex, worksheetChanges] of changesByWorksheet) {
        wordService.setCellValues(state, worksheetIndex, worksheetChanges);
      }
      tempPath = path.join(workingDirectory, `.${crypto.randomUUID()}${extension}`);
      await wordService.writeWorkbook(state, tempPath);

      if (!job) {
        const jobId = await manipulationModel.createJob(connection, {
          userId,
          uploadId,
          workingName
        });
        job = { id: jobId, revision: 0 };
      }
      const currentRevision = Number(job.revision);
      if (!Number.isSafeInteger(currentRevision) || currentRevision < 0
        || currentRevision >= Number.MAX_SAFE_INTEGER) {
        throw new Error('The working-copy revision is outside the supported range.');
      }
      await manipulationModel.updateJobRevision(connection, job.id, currentRevision + 1);
      await installWorkingCopy(
        tempPath,
        finalPath,
        path.join(workingDirectory, `.${crypto.randomUUID()}.bak`),
        fileState
      );
      tempPath = null;
    }

    for (const change of changes) {
      await reviewModel.updateChange(connection, change, {
        proposedValue: parseJson(change.proposed_value_json),
        status: nowStatus,
        isActionable: change.is_actionable,
        reviewedBy: userId,
        reviewed: true
      });
    }
    await reviewModel.insertAudit(connection, auditRows);

    const historyIds = [...new Set(changes
      .map((change) => Number(change.source_history_id))
      .filter((id) => Number.isSafeInteger(id) && id > 0))];
    for (const historyId of historyIds) {
      const counts = await reviewModel.countHistoryReviewStates(connection, historyId);
      let status = 'pending';
      if (Number(counts.open_count) > 0) {
        if (Number(counts.approved_count) || Number(counts.rejected_count)) status = 'partial';
      } else if (Number(counts.approved_count) && Number(counts.rejected_count)) {
        status = 'partial';
      } else {
        status = Number(counts.approved_count) ? 'applied' : 'undone';
      }
      await reviewModel.updateHistoryStatus(connection, historyId, status);
    }

    await connection.commit();
    committed = true;
    if (fileState.originalMoved) {
      await fs.unlink(fileState.backupPath).catch((error) => {
        console.error('Unable to remove the previous reviewed workbook backup:', error.message);
      });
    }
    return { action, affectedCount: changes.length, uploadId };
  } catch (error) {
    if (transactionStarted && !committed) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Review transaction rollback failed:', rollbackError.code || rollbackError.message);
      }
    }
    if (!committed && (fileState.installed || fileState.originalMoved)) {
      try {
        await restoreFileReplacement(fileState);
      } catch (restoreError) {
        console.error('Unable to restore the prior workbook after a review failure:', restoreError.message);
      }
    }
    throw error;
  } finally {
    if (tempPath) {
      await fs.unlink(tempPath).catch((error) => {
        if (error.code !== 'ENOENT') console.error('Unable to remove a temporary reviewed workbook:', error.message);
      });
    }
    connection.release();
  }
}

module.exports = {
  ReviewValidationError,
  buildProfilingReviewItems,
  syncUpload,
  editProposedValue,
  decideChanges,
  parseIdList,
  parseJson
};
