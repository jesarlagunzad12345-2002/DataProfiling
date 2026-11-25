const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const test = require('node:test');

const viewsDirectory = path.join(__dirname, '..', 'views');

test('login view escapes submitted values and provides the CSRF form field', async () => {
  const html = await ejs.renderFile(path.join(viewsDirectory, 'login.ejs'), {
    title: 'Sign in',
    csrfToken: 'secure-token',
    errorMessage: '<script>bad()</script>',
    loginValue: '<img src=x>'
  });

  assert.match(html, /name="_csrf" value="secure-token"/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img src=x>/);
});

test('dashboard renders real-data KPI and chart placeholders with upload actions', async () => {
  const html = await ejs.renderFile(path.join(viewsDirectory, 'dashboard.ejs'), {
    title: 'Dashboard',
    activePage: 'dashboard',
    csrfToken: 'token',
    currentUser: { username: 'analyst', email: 'analyst@example.com' },
    notice: null,
    summary: {
      upload_count: 0,
      processed_records: 0,
      complete_records: 0,
      incomplete_records: 0,
      missing_values: 0,
      duplicate_record_count: 0,
      invalid_phone_count: 0,
      overall_completeness: null,
      approved_changes: 0,
      manipulation_operations: 0
    },
    recentUploads: [],
    charts: {
      completeness: { labels: [], values: [] },
      records: { labels: ['Complete', 'Incomplete'], values: [0, 0] },
      duplicates: { labels: [], values: [] },
      profiling: { labels: [], values: [] },
      uploads: { labels: [], values: [] },
      manipulation: { labels: [], values: [] }
    },
    profilingReady: true
  });

  assert.match(html, /href="\/uploads"/);
  assert.match(html, /Data Profiling/);
  assert.match(html, /href="\/profiling"/);
  assert.match(html, /href="\/review"/);
  assert.match(html, /href="\/exports"/);
  assert.match(html, /Total Excel files uploaded/);
  assert.match(html, /Overall completeness/);
  assert.match(html, /data-chart="completeness"/);
  assert.match(html, /data-chart="manipulation"/);
  assert.match(html, /data-dashboard-charts=/);
  assert.match(html, /Reports/);
  assert.doesNotMatch(html, /Data Profiling<\/span><small>Later/);
  assert.match(html, /Your workspace is ready/);
});

test('reports renders authenticated filters, actual summaries, and CSV export controls', async () => {
  const html = await ejs.renderFile(path.join(viewsDirectory, 'reports.ejs'), {
    title: 'Reports',
    activePage: 'reports',
    csrfToken: 'report-token',
    currentUser: { username: 'analyst', email: 'analyst@example.com' },
    notice: null,
    uploads: [{ id: 8, original_name: 'customers.xlsx', uploaded_at: new Date('2026-01-01T00:00:00Z') }],
    selectedUploadIds: [8],
    fromDate: '2026-01-01',
    toDate: '',
    rows: [{
      upload_id: 8,
      original_name: 'customers.xlsx',
      uploaded_at: new Date('2026-01-01T00:00:00Z'),
      uploaded_by: 'analyst',
      total_records: 5,
      complete_records: 4,
      incomplete_records: 1,
      overall_completeness: 96.5,
      missing_values: 2,
      duplicate_record_count: 0,
      invalid_phone_count: 1,
      approved_changes: 2,
      manipulation_operations: 1,
      processing_status: 'completed'
    }],
    total: 1,
    page: 1,
    pageCount: 1,
    charts: {
      labels: ['customers.xlsx'],
      completeness: [96.5],
      missing: [2],
      duplicates: [0],
      manipulationLabels: ['2026-01-01'],
      manipulationValues: [1]
    }
  });

  assert.match(html, /name="from" value="2026-01-01"/);
  assert.match(html, /customers\.xlsx/);
  assert.match(html, /data-chart="quality"/);
  assert.match(html, /data-chart="manipulation"/);
  assert.match(html, /\/reports\/export\.csv/);
  assert.match(html, /96\.5%/);
  assert.match(html, /href="\/reports"/);
});

test('upload and worksheet preview screens render with empty and populated state', async () => {
  const shell = {
    title: 'Excel Upload',
    activePage: 'uploads',
    csrfToken: 'token',
    currentUser: { username: 'analyst', email: 'analyst@example.com' },
    notice: null
  };
  const uploadsHtml = await ejs.renderFile(path.join(viewsDirectory, 'uploads.ejs'), {
    ...shell,
    uploads: [],
    page: 1,
    pageCount: 1,
    search: '',
    errorMessage: null,
    successMessage: null
  });
  assert.match(uploadsHtml, /name="workbook"/);
  assert.match(uploadsHtml, /No workbooks yet/);
  assert.match(uploadsHtml, /name="_csrf" value="token"/);

  const previewHtml = await ejs.renderFile(path.join(viewsDirectory, 'upload-preview.ejs'), {
    ...shell,
    title: 'report.xlsx',
    upload: {
      id: 8,
      original_name: 'report.xlsx',
      uploaded_at: new Date('2026-01-01T00:00:00Z'),
      worksheets: [{ worksheet_index: 0, name: 'Summary', rowCount: 1, columnCount: 1 }]
    },
    worksheet: { worksheet_index: 0, rowCount: 1, columnCount: 1 },
    preview: {
      headers: ['Column 1'],
      rows: [['safe value']]
    }
  });
  assert.match(previewHtml, /READ-ONLY WORKSHEET PREVIEW/);
  assert.match(previewHtml, /safe value/);
  assert.match(previewHtml, /Original workbook remains unchanged/);
});

test('profiling setup and results render saved analysis data with escaped workbook values', async () => {
  const shell = {
    title: 'Data Profiling',
    activePage: 'profiling',
    csrfToken: 'profile-token',
    currentUser: { username: 'analyst', email: 'analyst@example.com' },
    notice: null
  };
  const setupHtml = await ejs.renderFile(path.join(viewsDirectory, 'profiling-setup.ejs'), {
    ...shell,
    sources: [],
    selectedSource: null,
    headers: [],
    columnNames: [],
    suggestedColumns: {},
    countryOptions: [],
    recentRuns: [],
    errorMessage: null
  });
  assert.match(setupHtml, /No worksheets to profile yet/);
  assert.match(setupHtml, /Recent profiling runs/);

  const resultsHtml = await ejs.renderFile(path.join(viewsDirectory, 'profiling-results.ejs'), {
    ...shell,
    title: 'Profiling Results',
    profilePolling: false,
    run: {
      id: 2,
      upload_id: 8,
      status: 'completed',
      original_name: '<script>bad.xlsx</script>',
      worksheet_name: 'Customers',
      created_at: new Date('2026-01-01T00:00:00Z'),
      total_records: 1,
      complete_records: 0,
      incomplete_records: 1,
      missing_values: 1,
      invalid_phone_count: 0,
      suspicious_phone_count: 0,
      duplicate_record_count: 0,
      address_issue_count: 0,
      country_inconsistency_count: 0,
      column_count: 1,
      overall_completeness: 0
    },
    options: { columnNames: ['Email'] },
    recordColumns: [{ name: 'Email', index: 0 }],
    columns: [{ column_name: 'Email', value_count: 0, missing_count: 1, completeness_percent: 0 }],
    columnPage: 1,
    columnPageCount: 1,
    records: [{
      id: 7,
      excel_row_number: 2,
      original_values: [''],
      suggestions: {},
      issues: { missingColumnIndexes: [0] },
      missing_count: 1,
      invalid_phone: false,
      suspicious_phone: false,
      address_issue: false,
      country_inconsistent: false
    }],
    duplicateDetails: {},
    issue: 'all',
    recordPage: 1,
    recordPageCount: 1,
    recordTotal: 1,
    columnTotal: 1
  });
  assert.match(resultsHtml, /Column completeness/);
  assert.match(resultsHtml, /href="\/review\?upload=8"/);
  assert.match(resultsHtml, /Missing<\/span>/);
  assert.match(resultsHtml, /&lt;script&gt;bad\.xlsx&lt;\/script&gt;/);
  assert.doesNotMatch(resultsHtml, /<script>bad\.xlsx<\/script>/);
});

test('word manipulation renders the active navigation and empty worksheet state', async () => {
  const html = await ejs.renderFile(path.join(viewsDirectory, 'word-manipulation.ejs'), {
    title: 'Word Manipulation',
    activePage: 'word-manipulation',
    csrfToken: 'word-token',
    currentUser: { username: 'analyst', email: 'analyst@example.com' },
    notice: null,
    sources: [],
    selectedSource: null,
    errorMessage: null,
    preview: null,
    submitted: null,
    operationLabels: []
  });
  assert.match(html, /href="\/word-manipulation"/);
  assert.match(html, /No worksheets available/);
  assert.match(html, /Word Manipulation/);
  assert.match(html, /name="_csrf" value="word-token"/);
});

test('word manipulation previews selected-cell edits and escapes workbook values', async () => {
  const html = await ejs.renderFile(path.join(viewsDirectory, 'word-manipulation.ejs'), {
    title: 'Word Manipulation',
    activePage: 'word-manipulation',
    csrfToken: 'word-token',
    currentUser: { username: 'analyst', email: 'analyst@example.com' },
    notice: null,
    sources: [{ upload_id: 8, worksheet_index: 0, original_name: 'customers.xlsx', worksheet_name: 'Customers' }],
    selectedSource: {
      key: '8:0',
      revision: '2',
      upload: { id: 8, original_name: 'customers.xlsx', file_extension: 'xlsx' },
      worksheet: { worksheet_index: 0, name: 'Customers', rowCount: 2, columnCount: 1 },
      columnChoices: [{ index: 0, letters: 'A', label: 'A — Name' }],
      history: [{
        id: 11,
        operation: 'uppercase',
        displayOperation: 'Convert to uppercase',
        username: 'analyst',
        created_at: new Date('2026-01-01T00:00:00Z'),
        change_count: 2,
        status: 'applied',
        cellChanges: [{
          cell_reference: 'A2',
          original_value: 'ada',
          modified_value: 'ADA'
        }]
      }]
    },
    errorMessage: null,
    preview: {
      operation: 'Convert to uppercase',
      affectedCount: 1,
      rows: [{
        cellReference: 'A2',
        originalDisplay: '<script>bad()</script>',
        modifiedDisplay: 'ADA',
        operation: 'Convert to uppercase',
        status: 'Ready to submit for review'
      }],
      truncated: false,
      selection: { columns: [], cells: [{ row: 2, column: 0 }], includeHeader: false },
      source: '8:0',
      revision: 2
    },
    submitted: {
      operation: 'uppercase',
      selection: { columns: [], cells: [{ row: 2, column: 0 }], includeHeader: false }
    },
    operationLabels: [{ value: 'uppercase', label: 'Convert to uppercase' }]
  });
  assert.match(html, /name="selection" value=/);
  assert.match(html, /Preview changes/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>bad\(\)<\/script>/);
  assert.match(html, /View all 2 cell changes/);
});

test('word manipulation history renders operation metadata and cell-level values', async () => {
  const shell = {
    activePage: 'word-manipulation',
    csrfToken: 'undo-token',
    currentUser: { username: 'analyst', email: 'analyst@example.com' },
    notice: null
  };
  const historyHtml = await ejs.renderFile(path.join(viewsDirectory, 'word-manipulation-history.ejs'), {
    ...shell,
    title: 'Word Manipulation History',
    upload: { id: 8, original_name: 'customers.xlsx' },
    revision: '4',
    page: 1,
    pageCount: 1,
    total: 1,
    canUndo: true,
    history: [{
      id: 11,
      displayOperation: 'Convert to uppercase',
      operation: 'uppercase',
      worksheet_index: 0,
      username: 'analyst',
      created_at: new Date('2026-01-01T00:00:00Z'),
      change_count: 1,
      status: 'applied',
      cellChanges: [{ cell_reference: 'A2', original_value: 'ada', modified_value: 'ADA' }]
    }]
  });
  assert.match(historyHtml, /Undo latest operation/);
  assert.match(historyHtml, /ada/);
  assert.match(historyHtml, /ADA/);
  assert.match(historyHtml, /expectedRevision/);

  const detailHtml = await ejs.renderFile(path.join(viewsDirectory, 'word-manipulation-history-detail.ejs'), {
    ...shell,
    title: 'Operation Details',
    upload: { id: 8, original_name: 'customers.xlsx' },
    history: {
      displayOperation: 'Convert to uppercase',
      worksheet_index: 0,
      change_count: 1,
      status: 'applied',
      username: 'analyst',
      created_at: new Date('2026-01-01T00:00:00Z')
    },
    changes: [{ cell_reference: 'A2', original_value: 'ada', modified_value: 'ADA' }],
    page: 1,
    pageCount: 1,
    total: 1
  });
  assert.match(detailHtml, /Operation details/);
  assert.match(detailHtml, /Original value/);
  assert.match(detailHtml, /Modified value/);
});

test('review dashboard renders decision controls, statuses, and escaped cell values', async () => {
  const html = await ejs.renderFile(path.join(viewsDirectory, 'review.ejs'), {
    title: 'Review Changes',
    activePage: 'review',
    csrfToken: 'review-token',
    currentUser: { username: 'analyst', email: 'analyst@example.com' },
    notice: null,
    uploads: [{ id: 8, originalName: 'customers.xlsx' }],
    selectedUploadId: 8,
    summary: {
      pending_count: 1,
      approved_count: 2,
      rejected_count: 3,
      requires_review_count: 1
    },
    changes: [{
      id: 14,
      upload_id: 8,
      worksheet_index: 0,
      worksheet_name: 'Customers',
      excel_row_number: 4,
      column_name: 'Phone',
      cell_reference: 'B4',
      original_name: 'customers.xlsx',
      displayOriginal: '<script>bad()</script>',
      displayProposed: '+14155550100',
      displayDetails: '',
      inputValue: '+14155550100',
      reason: 'Suggested phone normalization.',
      source_type: 'profiling',
      sourceLabel: 'Data Profiling',
      status: 'pending',
      is_actionable: 1
    }],
    audit: [{
      username: 'analyst',
      created_at: new Date('2026-01-01T00:00:00Z'),
      original_name: 'customers.xlsx',
      worksheet_index: 0,
      cell_reference: 'B4',
      action: 'approved',
      displayOriginal: 'raw phone',
      displayProposed: '+14155550100',
      new_status: 'approved'
    }],
    status: '',
    sourceType: '',
    search: '',
    page: 1,
    pageCount: 2,
    total: 26
  });

  assert.match(html, /Pending changes/);
  assert.match(html, /Approve selected/);
  assert.match(html, /name="proposedValue"/);
  assert.match(html, /name="_csrf" value="review-token"/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>bad\(\)<\/script>/);
  assert.match(html, /Recent audit activity/);
  assert.match(html, /\/review\?upload=8&amp;page=2/);
});

test('export configuration and summary views show selections and required before-download counts', async () => {
  const shell = {
    title: 'Excel Export',
    activePage: 'exports',
    csrfToken: 'export-token',
    currentUser: { username: 'analyst', email: 'analyst@example.com' },
    notice: null
  };
  const settingsHtml = await ejs.renderFile(path.join(viewsDirectory, 'exports.ejs'), {
    ...shell,
    uploads: [{ id: 8, original_name: 'customers.xlsx', uploaded_at: new Date('2026-01-01T00:00:00Z') }],
    selectedUploadId: 8,
    selectedUpload: {
      id: 8,
      original_name: 'customers.xlsx',
      file_extension: 'xlsx',
      worksheets: [{ worksheet_index: 0 }]
    },
    worksheetOptions: [{
      worksheetIndex: 0,
      name: 'Customers',
      columns: [{ index: 0, name: 'Name' }, { index: 1, name: 'Email' }]
    }],
    recentExports: [],
    errorMessage: null
  });
  assert.match(settingsHtml, /name="exportType"/);
  assert.match(settingsHtml, /data-export-sheet/);
  assert.match(settingsHtml, /data-export-column="0"/);
  assert.match(settingsHtml, /value="0:1"/);
  assert.match(settingsHtml, /name="selection"/);
  assert.match(settingsHtml, /Original workbook \(untouched exact copy\)/);
  assert.match(settingsHtml, /name="_csrf" value="export-token"/);

  const detailHtml = await ejs.renderFile(path.join(viewsDirectory, 'export-detail.ejs'), {
    ...shell,
    isExpired: false,
    exportItem: {
      id: 12,
      filename: 'customers-cleaned-20261121T110102Z.xlsx',
      original_name: 'customers.xlsx',
      export_type: 'cleaned',
      record_filter: 'all',
      record_count: 21,
      complete_count: 18,
      incomplete_count: 3,
      approved_change_count: 4,
      rejected_change_count: 2,
      worksheet_count: 1,
      column_count: 5,
      created_at: new Date('2026-11-21T11:01:02Z'),
      expires_at: new Date('2026-11-22T11:01:02Z')
    }
  });
  assert.match(detailHtml, /Total records in export/);
  assert.match(detailHtml, /Approved modifications/);
  assert.match(detailHtml, /Rejected modifications/);
  assert.match(detailHtml, /href="\/exports\/12\/download"/);
});