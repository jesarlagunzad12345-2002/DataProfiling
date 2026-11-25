const dashboardModel = require('../models/dashboardModel');
const { dateKey } = require('./dashboardController');

const PAGE_SIZE = 25;
const MAX_UPLOAD_FILTERS = 100;

function parseDate(value, label) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const error = new Error(`Enter a valid ${label} date.`);
    error.status = 400;
    throw error;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    const error = new Error(`Enter a valid ${label} date.`);
    error.status = 400;
    throw error;
  }
  return value;
}

function parseReportFilters(source, userId) {
  const fromDate = parseDate(source.from, 'start');
  const toDate = parseDate(source.to, 'end');
  if (fromDate && toDate && fromDate > toDate) {
    const error = new Error('The start date must be on or before the end date.');
    error.status = 400;
    throw error;
  }
  const values = source.uploadIds === undefined ? [] : Array.isArray(source.uploadIds)
    ? source.uploadIds
    : [source.uploadIds];
  if (values.length > MAX_UPLOAD_FILTERS) {
    const error = new Error(`Select no more than ${MAX_UPLOAD_FILTERS} workbooks.`);
    error.status = 400;
    throw error;
  }
  const uploadIds = [];
  for (const value of values) {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
      const error = new Error('The selected workbook filter is invalid.');
      error.status = 400;
      throw error;
    }
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id < 1) {
      const error = new Error('The selected workbook filter is invalid.');
      error.status = 400;
      throw error;
    }
    if (!uploadIds.includes(id)) uploadIds.push(id);
  }
  return { userId, fromDate, toDate, uploadIds };
}

function escapeCsv(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(rows) {
  const headers = [
    'Filename',
    'Uploaded at',
    'Uploaded by',
    'Processed records',
    'Complete records',
    'Incomplete records',
    'Completeness percent',
    'Missing values',
    'Duplicate records',
    'Invalid phone numbers',
    'Address issues',
    'Country inconsistencies',
    'Approved changes',
    'Word manipulation operations',
    'Processing status'
  ];
  const lines = [headers, ...rows.map((row) => [
    row.original_name,
    row.uploaded_at instanceof Date ? row.uploaded_at.toISOString() : row.uploaded_at,
    row.uploaded_by,
    row.total_records,
    row.complete_records,
    row.incomplete_records,
    row.overall_completeness,
    row.missing_values,
    row.duplicate_record_count,
    row.invalid_phone_count,
    row.address_issue_count,
    row.country_inconsistency_count,
    row.approved_changes,
    row.manipulation_operations,
    row.processing_status
  ])];
  return lines.map((line) => line.map(escapeCsv).join(',')).join('\r\n');
}

function getReadiness(req) {
  return {
    profilingReady: req.app.locals.profilingSchemaReady !== false,
    reviewReady: req.app.locals.reviewSchemaReady !== false,
    manipulationReady: req.app.locals.manipulationSchemaReady !== false
  };
}

async function loadReportData(req, requestedPage = null) {
  const filters = parseReportFilters(req.query, req.session.user.id);
  const uploads = await dashboardModel.listReportUploadOptions(req.session.user.id);
  const availableIds = new Set(uploads.map((upload) => Number(upload.id)));
  if (filters.uploadIds.some((id) => !availableIds.has(id))) {
    const error = new Error('One or more selected workbooks are not available in your account.');
    error.status = 404;
    throw error;
  }
  let page = null;
  let pageCount = null;
  let total = null;
  let pagination = null;
  if (requestedPage !== null) {
    total = await dashboardModel.countReportUploads(filters);
    pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    page = Math.min(requestedPage, pageCount);
    pagination = { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE };
  }
  const [rows, activity] = await Promise.all([
    dashboardModel.getReportRows(filters, getReadiness(req), pagination),
    dashboardModel.getReportManipulationActivity(filters, getReadiness(req))
  ]);
  return {
    filters,
    uploads,
    rows,
    activity,
    total: total === null ? rows.length : total,
    page,
    pageCount
  };
}

async function getReports(req, res, next) {
  try {
    const requestedPage = typeof req.query.page === 'string' && /^\d+$/.test(req.query.page)
      ? Number(req.query.page)
      : 1;
    const page = Number.isSafeInteger(requestedPage) && requestedPage > 0
      ? requestedPage
      : 1;
    const data = await loadReportData(req, page);
    const chartRows = data.rows
      .filter((row) => row.overall_completeness !== null)
      .slice(0, 12)
      .reverse();
    return res.render('reports', {
      title: 'Reports',
      activePage: 'reports',
      uploads: data.uploads,
      selectedUploadIds: data.filters.uploadIds,
      fromDate: data.filters.fromDate,
      toDate: data.filters.toDate,
      rows: data.rows,
      total: data.total,
      page: data.page,
      pageCount: data.pageCount,
      charts: {
        labels: chartRows.map((row) => row.original_name),
        completeness: chartRows.map((row) => row.overall_completeness),
        missing: chartRows.map((row) => row.missing_values),
        duplicates: chartRows.map((row) => row.duplicate_record_count),
        invalidPhones: chartRows.map((row) => row.invalid_phone_count),
        addressIssues: chartRows.map((row) => row.address_issue_count),
        countryIssues: chartRows.map((row) => row.country_inconsistency_count),
        manipulationLabels: data.activity.map((item) => dateKey(item.activity_date)),
        manipulationValues: data.activity.map((item) => Number(item.total))
      },
      chartRowCount: chartRows.length
    });
  } catch (error) {
    return next(error);
  }
}

async function getReportCsv(req, res, next) {
  try {
    const data = await loadReportData(req);
    const filename = `clearsheet-report-${new Date().toISOString().slice(0, 10)}.csv`;
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store'
    });
    return res.send(`\uFEFF${toCsv(data.rows)}`);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getReports,
  getReportCsv,
  parseReportFilters,
  escapeCsv,
  toCsv
};
