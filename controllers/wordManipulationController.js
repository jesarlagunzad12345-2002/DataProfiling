const path = require('node:path');
const uploadModel = require('../models/uploadModel');
const manipulationModel = require('../models/manipulationModel');
const wordService = require('../services/wordManipulationService');
const persistenceService = require('../services/manipulationPersistenceService');

const uploadsDirectory = path.resolve(__dirname, '..', 'uploads');
const workingDirectory = path.resolve(__dirname, '..', 'working-copies');
const MAX_TEXT_LENGTH = 500;
const MAX_HISTORY_ITEMS = 10;
const MAX_HISTORY_CELLS = 20;
const SEPARATORS = new Set(['space', 'comma', 'hyphen']);

function parseSource(value) {
  if (typeof value !== 'string' || !/^(\d+):(\d+)$/.test(value)) return null;
  const [uploadId, worksheetIndex] = value.split(':').map(Number);
  if (!Number.isSafeInteger(uploadId) || uploadId < 1
    || !Number.isSafeInteger(worksheetIndex) || worksheetIndex < 0) return null;
  return { uploadId, worksheetIndex, key: `${uploadId}:${worksheetIndex}` };
}

function getPrivateFilePath(directory, name) {
  const filePath = path.resolve(directory, name);
  if (!filePath.startsWith(`${directory}${path.sep}`)) {
    throw new Error('Stored workbook path is invalid.');
  }
  return filePath;
}

function parseJson(value, fallback) {
  if (typeof value !== 'string') return value === null || value === undefined ? fallback : value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseRevision(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const revision = Number(value);
  return Number.isSafeInteger(revision) ? revision : null;
}

function parseSelection(value) {
  if (typeof value !== 'string' || value.length > 900000) {
    throw new wordService.WordManipulationValidationError('Select columns or cells in the worksheet grid.');
  }
  let selection;
  try {
    selection = JSON.parse(value);
  } catch {
    throw new wordService.WordManipulationValidationError('The selected cells could not be read. Select them again.');
  }
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
    throw new wordService.WordManipulationValidationError('Choose valid columns or cells.');
  }
  const columns = selection.columns;
  const cells = selection.cells;
  if (!Array.isArray(columns) || !Array.isArray(cells)) {
    throw new wordService.WordManipulationValidationError('Choose valid columns or cells.');
  }
  return {
    columns,
    cells,
    includeHeader: selection.includeHeader === true
  };
}

function buildOperationParameters(operation, body) {
  if (operation === 'addFirst' || operation === 'addCenter' || operation === 'addLast') {
    const text = typeof body.addedText === 'string' ? body.addedText.trim() : '';
    const separator = typeof body.separator === 'string' ? body.separator : '';
    if (!text || text.length > MAX_TEXT_LENGTH || !SEPARATORS.has(separator)) {
      throw new wordService.WordManipulationValidationError('Enter up to 500 characters of text and choose a valid separator.');
    }
    return { text, separator };
  }
  if (operation === 'findReplace') {
    const findText = typeof body.findText === 'string' ? body.findText : '';
    const replaceText = typeof body.replaceText === 'string' ? body.replaceText : '';
    if (!findText.trim() || findText.length > MAX_TEXT_LENGTH || replaceText.length > MAX_TEXT_LENGTH) {
      throw new wordService.WordManipulationValidationError('Enter text to find and keep both fields under 500 characters.');
    }
    return {
      findText,
      replaceText,
      matchCase: body.matchCase === 'on'
    };
  }
  if (!wordService.getOperationLabel(operation)) {
    throw new wordService.WordManipulationValidationError('Choose a supported text operation.');
  }
  return {};
}

async function getSelectedSource(userId, sourceValue) {
  const source = parseSource(sourceValue);
  if (!source) return null;
  const upload = await uploadModel.getUploadForUser(userId, source.uploadId);
  const worksheet = upload && upload.worksheets.find((item) => item.worksheet_index === source.worksheetIndex);
  if (!upload || !worksheet) return null;

  const job = await manipulationModel.getJobForUpload(userId, source.uploadId);
  const filePath = job
    ? getPrivateFilePath(workingDirectory, job.working_name)
    : getPrivateFilePath(uploadsDirectory, upload.stored_name);
  const [headers, history, canUndo] = await Promise.all([
    wordService.getWorksheetHeaders(filePath, source.worksheetIndex),
    manipulationModel.listRecentHistory(userId, source.uploadId, MAX_HISTORY_ITEMS),
    manipulationModel.hasUndoableHistory(userId, source.uploadId)
  ]);
  const columnChoices = headers.map((header, index) => {
    const letters = wordService.columnToLetters(index);
    return {
      index,
      letters,
      name: (String(header || '').trim() || `Column ${letters}`).slice(0, 255),
      label: `${letters} — ${String(header || '').trim() || `Column ${letters}`}`.slice(0, 300)
    };
  });
  return {
    upload,
    worksheet,
    key: source.key,
    revision: job ? String(job.revision) : '0',
    filePath,
    columnChoices,
    history,
    canUndo
  };
}

async function renderTool(req, res, {
  sourceValue = '',
  errorMessage = null,
  preview = null,
  submitted = null,
  selectedSource: sourceOverride = undefined,
  statusCode = 200
} = {}) {
  const sources = await manipulationModel.listSources(req.session.user.id);
  const selectedSource = sourceOverride !== undefined
    ? sourceOverride
    : sourceValue
      ? await getSelectedSource(req.session.user.id, sourceValue)
      : null;
  const history = selectedSource ? selectedSource.history : [];
  for (const item of history) {
    item.parameters_json = parseJson(item.parameters_json, {});
    item.displayOperation = item.operation === 'undo'
      ? 'Undo operation'
      : wordService.getOperationLabel(item.operation) || item.operation;
    item.cellChanges = await manipulationModel.listHistoryChanges(req.session.user.id, item.id, MAX_HISTORY_CELLS);
    item.cellChanges = item.cellChanges.map((change) => ({
      ...change,
      original_value: parseJson(change.original_value_json, ''),
      modified_value: parseJson(change.modified_value_json, '')
    }));
  }
  res.status(statusCode).render('word-manipulation', {
    title: 'Word Manipulation',
    activePage: 'word-manipulation',
    sources,
    selectedSource,
    errorMessage,
    preview,
    submitted,
    operationLabels: Object.entries({
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
    }).map(([value, label]) => ({ value, label }))
  });
}

async function getTool(req, res) {
  const sourceValue = typeof req.query.source === 'string' ? req.query.source : '';
  const selectedSource = sourceValue
    ? await getSelectedSource(req.session.user.id, sourceValue)
    : null;
  await renderTool(req, res, {
    sourceValue,
    selectedSource,
    errorMessage: sourceValue && !selectedSource
      ? 'The selected workbook or worksheet is not available in your account.'
      : null
  });
}

async function getWorksheetGrid(req, res) {
  const uploadId = Number(req.params.uploadId);
  const worksheetIndex = Number(req.params.worksheetIndex);
  if (!Number.isSafeInteger(uploadId) || uploadId < 1
    || !Number.isSafeInteger(worksheetIndex) || worksheetIndex < 0) {
    return res.status(404).json({ error: 'The selected worksheet is not available in your account.' });
  }

  const upload = await uploadModel.getUploadForUser(req.session.user.id, uploadId);
  const worksheet = upload && upload.worksheets.find((item) => item.worksheet_index === worksheetIndex);
  if (!upload || !worksheet) {
    return res.status(404).json({ error: 'The selected worksheet is not available in your account.' });
  }
  const job = await manipulationModel.getJobForUpload(req.session.user.id, uploadId);
  const filePath = job
    ? getPrivateFilePath(workingDirectory, job.working_name)
    : getPrivateFilePath(uploadsDirectory, upload.stored_name);
  const parsePage = (value) => {
    const page = /^\d+$/.test(value || '') ? Number(value) : 1;
    return Number.isSafeInteger(page) && page > 0 ? page : 1;
  };
  const grid = await wordService.getWorksheetGrid(filePath, worksheetIndex, {
    rowPage: parsePage(req.query.rowPage),
    columnPage: parsePage(req.query.columnPage)
  });
  res.json({ ...grid, revision: job ? String(job.revision) : '0' });
}

async function postPreview(req, res) {
  const source = parseSource(req.body.source);
  try {
    if (!source) {
      throw new wordService.WordManipulationValidationError('Select an uploaded worksheet first.');
    }
    const selectedSource = await getSelectedSource(req.session.user.id, source.key);
    if (!selectedSource) {
      throw new wordService.WordManipulationValidationError('The selected workbook or worksheet is not available in your account.');
    }
    const expectedRevision = parseRevision(req.body.expectedRevision);
    if (expectedRevision === null || expectedRevision !== Number(selectedSource.revision)) {
      throw new persistenceService.StaleManipulationPreviewError('This workbook changed after the grid loaded. Reload it before previewing.');
    }
    const operation = typeof req.body.operation === 'string' ? req.body.operation : '';
    const parameters = buildOperationParameters(operation, req.body);
    const selection = parseSelection(req.body.selection);
    const preview = await wordService.previewWorkbook(
      selectedSource.filePath,
      source.worksheetIndex,
      selection,
      operation,
      parameters
    );
    preview.operation = wordService.getOperationLabel(operation);
    preview.selection = selection;
    preview.parameters = parameters;
    preview.source = source.key;
    preview.revision = expectedRevision;
    return renderTool(req, res, {
      sourceValue: source.key,
      selectedSource,
      preview,
      submitted: { operation, ...parameters, selection }
    });
  } catch (error) {
    if (error instanceof wordService.WordManipulationValidationError
      || error instanceof persistenceService.StaleManipulationPreviewError) {
      return renderTool(req, res, {
        sourceValue: source ? source.key : '',
        errorMessage: error.message,
        submitted: req.body,
        statusCode: error.status || 400
      });
    }
    throw error;
  }
}

async function postApply(req, res) {
  const source = parseSource(req.body.source);
  try {
    if (!source) {
      throw new wordService.WordManipulationValidationError('Select an uploaded worksheet first.');
    }
    const selectedSource = await getSelectedSource(req.session.user.id, source.key);
    if (!selectedSource) {
      throw new wordService.WordManipulationValidationError('The selected workbook or worksheet is not available in your account.');
    }
    const expectedRevision = parseRevision(req.body.expectedRevision);
    if (expectedRevision === null) {
      throw new wordService.WordManipulationValidationError('Reload the worksheet and preview your operation again.');
    }
    const operation = typeof req.body.operation === 'string' ? req.body.operation : '';
    const parameters = buildOperationParameters(operation, req.body);
    const selection = parseSelection(req.body.selection);
    const originalFilePath = getPrivateFilePath(uploadsDirectory, selectedSource.upload.stored_name);
    const result = await persistenceService.stageOperation({
      userId: req.session.user.id,
      uploadId: source.uploadId,
      worksheetIndex: source.worksheetIndex,
      originalFilePath,
      fileExtension: selectedSource.upload.file_extension,
      workingDirectory,
      expectedRevision,
      selection,
      operation,
      parameters,
      columnNames: selectedSource.columnChoices.map((column) => column.name)
    });
    req.session.notice = `${result.affectedCount.toLocaleString()} cell${result.affectedCount === 1 ? '' : 's'} submitted for review. The working copy changes only after approval.`;
    return res.redirect(`/word-manipulation?source=${encodeURIComponent(source.key)}`);
  } catch (error) {
    if (error instanceof wordService.WordManipulationValidationError
      || error instanceof persistenceService.StaleManipulationPreviewError) {
      return renderTool(req, res, {
        sourceValue: source ? source.key : '',
        errorMessage: error.message,
        submitted: req.body,
        statusCode: error.status || 400
      });
    }
    throw error;
  }
}

async function getHistory(req, res) {
  const uploadId = Number(req.params.uploadId);
  if (!Number.isSafeInteger(uploadId) || uploadId < 1) {
    return res.status(404).render('error', {
      title: 'Workbook not found',
      message: 'This workbook is not available in your account.',
      statusCode: 404
    });
  }
  const upload = await uploadModel.getUploadForUser(req.session.user.id, uploadId);
  if (!upload) {
    return res.status(404).render('error', {
      title: 'Workbook not found',
      message: 'This workbook is not available in your account.',
      statusCode: 404
    });
  }
  const job = await manipulationModel.getJobForUpload(req.session.user.id, uploadId);
  const requestedPage = Number(req.query.page);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const historyResult = await manipulationModel.listHistoryPage(req.session.user.id, uploadId, {
    page,
    pageSize: 20
  });
  const history = historyResult.history;
  for (const item of history) {
    item.parameters_json = parseJson(item.parameters_json, {});
    item.displayOperation = item.operation === 'undo'
      ? 'Undo operation'
      : wordService.getOperationLabel(item.operation) || item.operation;
    item.cellChanges = await manipulationModel.listHistoryChanges(req.session.user.id, item.id, MAX_HISTORY_CELLS);
    item.cellChanges = item.cellChanges.map((change) => ({
      ...change,
      original_value: parseJson(change.original_value_json, ''),
      modified_value: parseJson(change.modified_value_json, '')
    }));
  }
  res.render('word-manipulation-history', {
    title: 'Word Manipulation History',
    activePage: 'word-manipulation',
    upload,
    history,
    revision: job ? String(job.revision) : '0',
    page: historyResult.page,
    pageCount: historyResult.pageCount,
    total: historyResult.total,
    canUndo: await manipulationModel.hasUndoableHistory(req.session.user.id, uploadId)
  });
}

async function getHistoryDetail(req, res) {
  const uploadId = Number(req.params.uploadId);
  const historyId = Number(req.params.historyId);
  if (!Number.isSafeInteger(uploadId) || uploadId < 1
    || !Number.isSafeInteger(historyId) || historyId < 1) {
    return res.status(404).render('error', {
      title: 'Operation not found',
      message: 'This operation is not available in your account.',
      statusCode: 404
    });
  }
  const upload = await uploadModel.getUploadForUser(req.session.user.id, uploadId);
  const history = await manipulationModel.getHistoryForUser(req.session.user.id, uploadId, historyId);
  if (!upload || !history) {
    return res.status(404).render('error', {
      title: 'Operation not found',
      message: 'This operation is not available in your account.',
      statusCode: 404
    });
  }
  const requestedPage = Number(req.query.page);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const pageSize = 50;
  const result = await manipulationModel.listHistoryChangesPage(req.session.user.id, historyId, {
    page,
    pageSize
  });
  const pageCount = Math.max(1, Math.ceil(result.total / pageSize));
  const actualPage = result.page;
  history.parameters_json = parseJson(history.parameters_json, {});
  history.displayOperation = history.operation === 'undo'
    ? 'Undo operation'
    : wordService.getOperationLabel(history.operation) || history.operation;
  res.render('word-manipulation-history-detail', {
    title: 'Operation Details',
    activePage: 'word-manipulation',
    upload,
    history,
    changes: result.changes.map((change) => ({
      ...change,
      original_value: parseJson(change.original_value_json, ''),
      modified_value: parseJson(change.modified_value_json, '')
    })),
    page: actualPage,
    pageCount,
    total: result.total
  });
}

async function postUndo(req, res) {
  const uploadId = Number(req.params.uploadId);
  if (!Number.isSafeInteger(uploadId) || uploadId < 1) {
    return res.status(404).render('error', {
      title: 'Workbook not found',
      message: 'This workbook is not available in your account.',
      statusCode: 404
    });
  }
  try {
    const upload = await uploadModel.getUploadForUser(req.session.user.id, uploadId);
    if (!upload) {
      throw new wordService.WordManipulationValidationError('This workbook is not available in your account.');
    }
    const expectedRevision = parseRevision(req.body.expectedRevision);
    if (expectedRevision === null) {
      throw new wordService.WordManipulationValidationError('Reload history before undoing an operation.');
    }
    const result = await persistenceService.undoLatestOperation({
      userId: req.session.user.id,
      uploadId,
      originalFilePath: getPrivateFilePath(uploadsDirectory, upload.stored_name),
      fileExtension: upload.file_extension,
      workingDirectory,
      expectedRevision
    });
    req.session.notice = `Undid the most recent operation affecting ${result.affectedCount.toLocaleString()} cell${result.affectedCount === 1 ? '' : 's'}.`;
    return res.redirect(`/word-manipulation?source=${uploadId}:${result.worksheetIndex}`);
  } catch (error) {
    if (error instanceof wordService.WordManipulationValidationError
      || error instanceof persistenceService.StaleManipulationPreviewError) {
      req.session.notice = error.message;
      return res.redirect(`/word-manipulation/history/${uploadId}`);
    }
    throw error;
  }
}

module.exports = {
  getTool,
  getWorksheetGrid,
  postPreview,
  postApply,
  getHistory,
  getHistoryDetail,
  postUndo
};
