const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pool } = require('../config/database');
const manipulationModel = require('../models/manipulationModel');
const reviewModel = require('../models/reviewModel');
const wordService = require('./wordManipulationService');
const { WordManipulationValidationError } = wordService;

class StaleManipulationPreviewError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StaleManipulationPreviewError';
    this.status = 409;
  }
}

function buildWordReviewItems({
  userId,
  uploadId,
  worksheetIndex,
  historyId,
  operation,
  changes,
  columnNames
}) {
  const operationLabel = wordService.getOperationLabel(operation) || operation;
  return changes.map((change) => ({
    userId,
    uploadId,
    worksheetIndex,
    cellReference: change.cellReference,
    row: change.row,
    columnIndex: change.column,
    columnName: String(columnNames[change.column] || `Column ${change.column + 1}`).slice(0, 255),
    originalValue: change.originalValue,
    proposedValue: change.modifiedValue,
    reason: `Suggested by Word Manipulation: ${operationLabel}.`,
    sourceType: 'word-manipulation',
    sourceKey: `word:${historyId}:${change.cellReference}`,
    sourceHistoryId: historyId,
    isActionable: true,
    status: 'pending'
  }));
}

function parseJson(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function getWorkingPath(workingDirectory, workingName) {
  if (typeof workingName !== 'string' || !/^[0-9a-f-]{36}\.(xlsx|xls)$/i.test(workingName)) {
    throw new Error('The saved working-copy path is invalid.');
  }
  const directory = path.resolve(workingDirectory);
  const filePath = path.resolve(directory, workingName);
  if (!filePath.startsWith(`${directory}${path.sep}`)) {
    throw new Error('The saved working-copy path is invalid.');
  }
  return filePath;
}

async function restoreFileReplacement(fileState) {
  if (fileState.installed) {
    await fs.unlink(fileState.finalPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  if (fileState.originalMoved) {
    await fs.rename(fileState.backupPath, fileState.finalPath);
  }
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

function getCurrentRevision(job) {
  const revision = Number(job ? job.revision : 0);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('The working-copy revision is outside the supported range.');
  }
  return revision;
}

async function stageOperation({
  userId,
  uploadId,
  worksheetIndex,
  originalFilePath,
  fileExtension,
  workingDirectory,
  expectedRevision,
  selection,
  operation,
  parameters,
  columnNames = []
}) {
  const connection = await pool.getConnection();
  let transactionStarted = false;
  let tempPath = null;
  const fileState = { installed: false, originalMoved: false };
  let committed = false;

  try {
    await connection.beginTransaction();
    transactionStarted = true;
    const lockedUpload = await manipulationModel.lockUpload(connection, userId, uploadId);
    if (!lockedUpload) {
      throw new WordManipulationValidationError('The selected workbook is not available in your account.');
    }

    let job = await manipulationModel.getJobForUpdate(connection, userId, uploadId);
    const hadJob = Boolean(job);
    const currentRevision = getCurrentRevision(job);
    if (currentRevision !== expectedRevision) {
      throw new StaleManipulationPreviewError('This workbook changed after the preview. Reload it and preview your operation again.');
    }

    const extension = fileExtension === 'xls' ? '.xls' : '.xlsx';
    const workingName = job ? job.working_name : `${crypto.randomUUID()}${extension}`;
    const finalPath = getWorkingPath(workingDirectory, workingName);
    const sourcePath = job ? finalPath : originalFilePath;
    if (job) await fs.access(sourcePath);

    const result = await wordService.inspectSelection(
      sourcePath,
      worksheetIndex,
      selection,
      operation,
      parameters
    );
    if (!result.changes.length) {
      throw new WordManipulationValidationError('The selected cells have no changes to submit for review.');
    }

    if (!job) {
      const jobId = await manipulationModel.createJob(connection, {
        userId,
        uploadId,
        workingName
      });
      job = { id: jobId, revision: 0 };
    }

    const nextRevision = currentRevision + 1;
    const historyId = await manipulationModel.createHistory(connection, {
      jobId: job.id,
      userId,
      worksheetIndex,
      operation,
      parameters: { ...parameters, selection },
      changeCount: result.changes.length,
      revisionBefore: currentRevision,
      revisionAfter: nextRevision,
      status: 'pending'
    });
    await manipulationModel.insertCellChanges(connection, historyId, result.changes);
    await reviewModel.insertChanges(connection, buildWordReviewItems({
      userId,
      uploadId,
      worksheetIndex,
      historyId,
      operation,
      changes: result.changes,
      columnNames
    }));
    await manipulationModel.updateJobRevision(connection, job.id, nextRevision);

    if (!hadJob) {
      tempPath = path.join(workingDirectory, `.${crypto.randomUUID()}${extension}`);
      await fs.copyFile(originalFilePath, tempPath);
      const backupPath = path.join(workingDirectory, `.${crypto.randomUUID()}.bak`);
      await installWorkingCopy(tempPath, finalPath, backupPath, fileState);
      tempPath = null;
    }

    await connection.commit();
    committed = true;
    if (fileState.originalMoved) {
      await fs.unlink(fileState.backupPath).catch((error) => {
        console.error('Unable to remove the previous staged workbook backup:', error.message);
      });
    }
    return {
      jobId: job.id,
      historyId,
      revision: nextRevision,
      affectedCount: result.changes.length
    };
  } catch (error) {
    if (transactionStarted && !committed) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Word manipulation review transaction rollback failed:', rollbackError.code || rollbackError.message);
      }
    }
    if (!committed && (fileState.installed || fileState.originalMoved)) {
      try {
        await restoreFileReplacement(fileState);
      } catch (restoreError) {
        console.error('Unable to restore the previous working copy after staging a review:', restoreError.message);
      }
    }
    throw error;
  } finally {
    if (tempPath) {
      await fs.unlink(tempPath).catch((error) => {
        if (error.code !== 'ENOENT') console.error('Unable to remove a temporary staged workbook:', error.message);
      });
    }
    connection.release();
  }
}

async function undoLatestOperation({
  userId,
  uploadId,
  originalFilePath,
  fileExtension,
  workingDirectory,
  expectedRevision
}) {
  const connection = await pool.getConnection();
  let transactionStarted = false;
  let tempPath = null;
  let fileState = { installed: false, originalMoved: false };
  let committed = false;

  try {
    await connection.beginTransaction();
    transactionStarted = true;
    const lockedUpload = await manipulationModel.lockUpload(connection, userId, uploadId);
    if (!lockedUpload) {
      throw new WordManipulationValidationError('The selected workbook is not available in your account.');
    }

    const job = await manipulationModel.getJobForUpdate(connection, userId, uploadId);
    if (!job) {
      throw new WordManipulationValidationError('There are no applied operations to undo.');
    }
    const currentRevision = getCurrentRevision(job);
    if (currentRevision !== expectedRevision) {
      throw new StaleManipulationPreviewError('This workbook changed after the page was loaded. Reload history before undoing.');
    }
    const history = await manipulationModel.getLatestAppliedHistory(connection, userId, job.id);
    if (!history) {
      throw new WordManipulationValidationError('There are no applied operations to undo.');
    }
    const changes = await manipulationModel.getHistoryChangesForUpdate(connection, history.id);
    const filePath = getWorkingPath(workingDirectory, job.working_name);
    await fs.access(filePath);
    const state = await wordService.loadWorkbook(filePath);
    const restoredChanges = changes.map((change) => {
      const originalValue = parseJson(change.original_value_json);
      const modifiedValue = parseJson(change.modified_value_json);
      const currentValue = wordService.getCellValue(
        state,
        history.worksheet_index,
        Number(change.row_number),
        Number(change.column_index)
      );
      if (JSON.stringify(currentValue) !== JSON.stringify(modifiedValue)) {
        throw new StaleManipulationPreviewError(
          `Cannot undo because cell ${change.cell_reference} no longer contains the value saved by that operation.`
        );
      }
      return {
        row: Number(change.row_number),
        column: Number(change.column_index),
        cellReference: change.cell_reference,
        originalValue: currentValue,
        modifiedValue: originalValue
      };
    });

    wordService.setCellValues(state, history.worksheet_index, restoredChanges);
    const extension = fileExtension === 'xls' ? '.xls' : '.xlsx';
    tempPath = path.join(workingDirectory, `.${crypto.randomUUID()}${extension}`);
    await wordService.writeWorkbook(state, tempPath);

    const nextRevision = currentRevision + 1;
    await manipulationModel.markHistoryUndone(connection, history.id);
    const historyId = await manipulationModel.createHistory(connection, {
      jobId: job.id,
      userId,
      worksheetIndex: history.worksheet_index,
      operation: 'undo',
      parameters: {
        undoOfHistoryId: history.id,
        undoneOperation: history.operation
      },
      changeCount: restoredChanges.length,
      revisionBefore: currentRevision,
      revisionAfter: nextRevision,
      status: 'undone',
      undoOfHistoryId: history.id
    });
    await manipulationModel.insertCellChanges(connection, historyId, restoredChanges);
    await manipulationModel.updateJobRevision(connection, job.id, nextRevision);

    const backupPath = path.join(workingDirectory, `.${crypto.randomUUID()}.bak`);
    await installWorkingCopy(tempPath, filePath, backupPath, fileState);
    tempPath = null;
    await connection.commit();
    committed = true;
    if (fileState.originalMoved) {
      await fs.unlink(fileState.backupPath).catch((error) => {
        console.error('Unable to remove the previous working-copy backup:', error.message);
      });
    }
    return {
      historyId,
      revision: nextRevision,
      affectedCount: restoredChanges.length,
      undoneOperation: history.operation,
      worksheetIndex: history.worksheet_index
    };
  } catch (error) {
    if (transactionStarted && !committed) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Word manipulation undo transaction rollback failed:', rollbackError.code || rollbackError.message);
      }
    }
    if (!committed && (fileState.installed || fileState.originalMoved)) {
      try {
        await restoreFileReplacement(fileState);
      } catch (restoreError) {
        console.error('Unable to restore the previous working copy after undo:', restoreError.message);
      }
    }
    throw error;
  } finally {
    if (tempPath) {
      await fs.unlink(tempPath).catch((error) => {
        if (error.code !== 'ENOENT') console.error('Unable to remove temporary undo workbook:', error.message);
      });
    }
    connection.release();
  }
}

module.exports = {
  stageOperation,
  undoLatestOperation,
  StaleManipulationPreviewError,
  buildWordReviewItems
};
