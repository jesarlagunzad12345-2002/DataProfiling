const path = require('node:path');
const profilingModel = require('../models/profilingModel');
const uploadModel = require('../models/uploadModel');
const { getWorksheetHeaders } = require('../services/excelStreamService');
const { getCountryOptions } = require('../services/countryService');
const { enqueueProfilingRun } = require('../services/profilingQueue');
const storagePaths = require('../config/storagePaths');

const uploadsDirectory = storagePaths.uploads;
const RECORD_PAGE_SIZE = 20;
const COLUMN_PAGE_SIZE = 25;
const issueFilters = new Set(['all', 'incomplete', 'phone', 'duplicates', 'address', 'country']);
const countryOptions = getCountryOptions();
const countryCodes = new Set(countryOptions.map((country) => country.alpha2));

function getSourceKey(value) {
  if (typeof value !== 'string' || !/^(\d+):(\d+)$/.test(value)) return null;
  const [uploadId, worksheetIndex] = value.split(':').map(Number);
  if (!Number.isSafeInteger(uploadId) || uploadId < 1
    || !Number.isSafeInteger(worksheetIndex) || worksheetIndex < 0) return null;
  return { uploadId, worksheetIndex, key: `${uploadId}:${worksheetIndex}` };
}

function makeColumnName(header, index, hasHeaderRow = true) {
  const value = hasHeaderRow ? String(header || '').trim() : '';
  return (value || `Column ${index + 1}`).slice(0, 255);
}

function detectColumn(headers, expression) {
  const index = headers.findIndex((header) => expression.test(String(header || '').trim()));
  return index < 0 ? '' : String(index);
}

function parseColumnIndex(value, columnCount) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;
  const index = Number(value);
  return Number.isSafeInteger(index) && index >= 0 && index < columnCount ? index : undefined;
}

function parseDuplicateColumns(value, columnCount, compareAll) {
  if (compareAll) return Array.from({ length: columnCount }, (_, index) => index);
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const indexes = [];
  for (const item of values) {
    const index = parseColumnIndex(item, columnCount);
    if (index === undefined) return null;
    if (!indexes.includes(index)) indexes.push(index);
  }
  return indexes;
}

function safeJson(value, fallback) {
  if (typeof value !== 'string') return value || fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function loadSetupData(userId, sourceValue) {
  const sources = await profilingModel.listSources(userId);
  const source = getSourceKey(sourceValue);
  if (!source) return { sources, selectedSource: null, headers: [], sourceError: null };

  const upload = await uploadModel.getUploadForUser(userId, source.uploadId);
  const worksheet = upload && upload.worksheets.find((item) => item.worksheet_index === source.worksheetIndex);
  if (!upload || !worksheet) {
    return {
      sources,
      selectedSource: null,
      headers: [],
      sourceError: 'The selected workbook or worksheet is not available in your account.'
    };
  }

  const filePath = path.resolve(uploadsDirectory, upload.stored_name);
  if (!filePath.startsWith(`${uploadsDirectory}${path.sep}`)) {
    throw new Error('Stored upload path is invalid.');
  }
  const headers = await getWorksheetHeaders(filePath, source.worksheetIndex, worksheet.columnCount);
  return {
    sources,
    selectedSource: { upload, worksheet, key: source.key, filePath },
    headers,
    sourceError: null
  };
}

async function renderSetup(req, res, { sourceValue = '', errorMessage = null } = {}) {
  const [setup, recentRuns] = await Promise.all([
    loadSetupData(req.session.user.id, sourceValue),
    profilingModel.listRecentRuns(req.session.user.id, 10)
  ]);
  const selectedSource = setup.selectedSource;
  res.render('profiling-setup', {
    title: 'Data Profiling',
    activePage: 'profiling',
    sources: setup.sources,
    selectedSource,
    headers: setup.headers,
    columnNames: selectedSource
      ? setup.headers.map((header, index) => makeColumnName(header, index, true))
      : [],
    suggestedColumns: selectedSource
      ? {
        phone: detectColumn(setup.headers, /phone|mobile|telephone|tel/i),
        email: detectColumn(setup.headers, /e[\s_-]?mail/i),
        address: detectColumn(setup.headers, /address|street|location/i),
        country: detectColumn(setup.headers, /country|nation/i)
      }
      : {},
    countryOptions,
    recentRuns,
    errorMessage: errorMessage || setup.sourceError
  });
}

async function getProfilingPage(req, res) {
  await renderSetup(req, res, { sourceValue: req.query.source || '' });
}

async function postProfiling(req, res, next) {
  const sourceValue = req.body.source;
  try {
    const setup = await loadSetupData(req.session.user.id, sourceValue);
    if (!setup.selectedSource) {
      return renderSetup(req, res, {
        sourceValue,
        errorMessage: setup.sourceError || 'Select an uploaded worksheet to profile.'
      });
    }

    const columnCount = setup.selectedSource.worksheet.columnCount;
    const phoneColumn = parseColumnIndex(req.body.phoneColumn, columnCount);
    const emailColumn = parseColumnIndex(req.body.emailColumn, columnCount);
    const addressColumn = parseColumnIndex(req.body.addressColumn, columnCount);
    const countryColumn = parseColumnIndex(req.body.countryColumn, columnCount);
    if ([phoneColumn, emailColumn, addressColumn, countryColumn].includes(undefined)) {
      return renderSetup(req, res, { sourceValue, errorMessage: 'Choose valid column mappings.' });
    }

    const compareAllColumns = req.body.compareAllColumns === 'on';
    const duplicateColumns = parseDuplicateColumns(req.body.duplicateColumns, columnCount, compareAllColumns);
    if (!duplicateColumns) {
      return renderSetup(req, res, { sourceValue, errorMessage: 'Choose valid columns for exact duplicate comparison.' });
    }
    if (!duplicateColumns.length && phoneColumn === null && emailColumn === null) {
      return renderSetup(req, res, {
        sourceValue,
        errorMessage: 'Select at least one exact-duplicate column, phone column, or email column.'
      });
    }

    const defaultCountry = typeof req.body.defaultCountry === 'string' ? req.body.defaultCountry : '';
    if (defaultCountry && !countryCodes.has(defaultCountry)) {
      return renderSetup(req, res, { sourceValue, errorMessage: 'Choose a valid default country.' });
    }

    const hasHeaderRow = req.body.hasHeaderRow === 'on';
    const options = {
      hasHeaderRow,
      phoneColumn,
      emailColumn,
      addressColumn,
      countryColumn,
      defaultCountry: defaultCountry || null,
      duplicateColumns,
      ignoreCase: req.body.ignoreCase === 'on',
      trimWhitespace: req.body.trimWhitespace === 'on',
      columnNames: setup.headers.map((header, index) => makeColumnName(header, index, hasHeaderRow))
    };
    const runId = await profilingModel.createRun({
      userId: req.session.user.id,
      uploadId: setup.selectedSource.upload.id,
      worksheetIndex: setup.selectedSource.worksheet.worksheet_index,
      options
    });

    const queued = enqueueProfilingRun({
      runId,
      filePath: setup.selectedSource.filePath,
      worksheetIndex: setup.selectedSource.worksheet.worksheet_index,
      columnCount,
      options
    });
    if (!queued) {
      await profilingModel.failRun(runId, 'The profiling queue is full. Wait for a current job to finish, then try again.');
      return renderSetup(req, res, {
        sourceValue,
        errorMessage: 'The profiling queue is currently full. Wait for a current job to finish, then try again.'
      });
    }
    res.redirect(`/profiling/${runId}`);
  } catch (error) {
    next(error);
  }
}

async function getProfileResults(req, res) {
  const runId = Number(req.params.runId);
  if (!Number.isSafeInteger(runId) || runId < 1) {
    return res.status(404).render('error', {
      title: 'Profiling run not found',
      message: 'This profiling run is not available in your account.',
      statusCode: 404
    });
  }
  const run = await profilingModel.getRunForUser(req.session.user.id, runId);
  if (!run) {
    return res.status(404).render('error', {
      title: 'Profiling run not found',
      message: 'This profiling run is not available in your account.',
      statusCode: 404
    });
  }

  const options = safeJson(run.options_json, {});
  const recordPageNumber = Number(req.query.page);
  const recordPage = Number.isSafeInteger(recordPageNumber) && recordPageNumber > 0 ? recordPageNumber : 1;
  const columnPageNumber = Number(req.query.columnPage);
  const columnPage = Number.isSafeInteger(columnPageNumber) && columnPageNumber > 0 ? columnPageNumber : 1;
  const issue = issueFilters.has(req.query.issue) ? req.query.issue : 'all';
  let columns = [];
  let columnTotal = 0;
  let records = [];
  let recordTotal = 0;
  let actualRecordPage = recordPage;
  let actualColumnPage = columnPage;
  let duplicateDetails = {};

  if (run.status === 'completed') {
    let [columnResult, recordResult] = await Promise.all([
      profilingModel.listColumnSummaries(run.id, { page: columnPage, pageSize: COLUMN_PAGE_SIZE }),
      profilingModel.listRecordsPage(run.id, { page: recordPage, pageSize: RECORD_PAGE_SIZE, issue })
    ]);
    columnTotal = Number(columnResult.total);
    recordTotal = Number(recordResult.total);
    const columnPageCount = Math.max(1, Math.ceil(columnTotal / COLUMN_PAGE_SIZE));
    const recordPageCount = Math.max(1, Math.ceil(recordTotal / RECORD_PAGE_SIZE));
    actualColumnPage = Math.min(columnPage, columnPageCount);
    actualRecordPage = Math.min(recordPage, recordPageCount);
    if (actualColumnPage !== columnPage || actualRecordPage !== recordPage) {
      [columnResult, recordResult] = await Promise.all([
        profilingModel.listColumnSummaries(run.id, { page: actualColumnPage, pageSize: COLUMN_PAGE_SIZE }),
        profilingModel.listRecordsPage(run.id, { page: actualRecordPage, pageSize: RECORD_PAGE_SIZE, issue })
      ]);
    }
    columns = columnResult.columns;
    columnTotal = Number(columnResult.total);
    records = recordResult.records;
    recordTotal = Number(recordResult.total);
    for (const record of records) {
      record.original_values = safeJson(record.original_values, []);
      record.suggestions = safeJson(record.suggestions, {});
      record.issues = safeJson(record.issues, {});
    }
    duplicateDetails = await profilingModel.getDuplicateDetails(records.map((record) => record.id));
  }

  const recordPageCount = Math.max(1, Math.ceil(recordTotal / RECORD_PAGE_SIZE));
  const columnPageCount = Math.max(1, Math.ceil(columnTotal / COLUMN_PAGE_SIZE));
  const columnNames = Array.isArray(options.columnNames) ? options.columnNames : [];
  const firstVisibleColumn = (actualColumnPage - 1) * COLUMN_PAGE_SIZE;
  res.render('profiling-results', {
    title: 'Profiling Results',
    activePage: 'profiling',
    profilePolling: run.status === 'queued' || run.status === 'processing',
    run,
    options,
    recordColumns: columnNames
      .slice(firstVisibleColumn, firstVisibleColumn + COLUMN_PAGE_SIZE)
      .map((name, offset) => ({ name, index: firstVisibleColumn + offset })),
    columns,
    columnPage: actualColumnPage,
    columnPageCount,
    records,
    duplicateDetails,
    issue,
    recordPage: actualRecordPage,
    recordPageCount,
    recordTotal,
    columnTotal
  });
}

module.exports = { getProfilingPage, postProfiling, getProfileResults };
