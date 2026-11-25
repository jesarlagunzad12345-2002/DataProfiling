const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildProfilingReviewItems,
  parseIdList,
  ReviewValidationError,
  decideChanges
} = require('../services/reviewService');
const { buildWordReviewItems } = require('../services/manipulationPersistenceService');
const { pool } = require('../config/database');
const reviewModel = require('../models/reviewModel');

test('turns phone and country normalizations into actionable review items', () => {
  const items = buildProfilingReviewItems({
    userId: 3,
    uploadId: 8,
    run: { id: 21, worksheet_index: 0 },
    options: {
      phoneColumn: 1,
      countryColumn: 2,
      columnNames: ['Name', 'Phone', 'Country']
    },
    records: [{
      id: 44,
      excel_row_number: 7,
      original_values: ['Ada', '(415) 555-0100', 'US'],
      suggestions: {
        phone: { standardized: '+14155550100' },
        country: { standardized: 'United States', iso2: 'US', iso3: 'USA' }
      },
      issues: { missingColumnIndexes: [] }
    }],
    duplicateDetails: {}
  });

  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => [item.cellReference, item.columnName, item.proposedValue, item.status]), [
    ['B7', 'Phone', '+14155550100', 'pending'],
    ['C7', 'Country', 'United States', 'pending']
  ]);
  assert.ok(items.every((item) => item.isActionable));
});

test('keeps address components, missing values, and duplicates review-only until edited', () => {
  const items = buildProfilingReviewItems({
    userId: 3,
    uploadId: 8,
    run: { id: 21, worksheet_index: 0 },
    options: {
      phoneColumn: 1,
      addressColumn: 2,
      columnNames: ['Name', 'Phone', 'Address']
    },
    records: [{
      id: 44,
      excel_row_number: 7,
      original_values: ['Ada', 'bad number', 'One Main St'],
      suggestions: {
        address: { street: 'One Main St', city: 'Springfield' }
      },
      issues: { missingColumnIndexes: [0], phone: { status: 'invalid' } },
      missing_count: 1,
      invalid_phone: true,
      duplicate_email: true
    }],
    duplicateDetails: {
      44: [{ type: 'email', memberCount: 2, rowNumbers: [7, 9] }]
    }
  });

  assert.equal(items.length, 4);
  assert.deepEqual(items.map((item) => item.status), [
    'requires_review',
    'requires_review',
    'requires_review',
    'requires_review'
  ]);
  assert.ok(items.every((item) => !item.isActionable));
  assert.equal(items.find((item) => item.sourceKey.endsWith(':address')).details.city, 'Springfield');
  assert.equal(items.find((item) => item.sourceKey.endsWith(':phone-issue')).cellReference, 'B7');
  assert.equal(items.find((item) => item.sourceKey.endsWith(':duplicates')).cellReference, null);
});

test('stages Word Manipulation cell changes as pending review items', () => {
  const items = buildWordReviewItems({
    userId: 3,
    uploadId: 8,
    worksheetIndex: 1,
    historyId: 52,
    operation: 'findReplace',
    changes: [{
      row: 9,
      column: 0,
      cellReference: 'A9',
      originalValue: 'Old name',
      modifiedValue: 'New name'
    }],
    columnNames: ['Company']
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'pending');
  assert.equal(items[0].isActionable, true);
  assert.equal(items[0].sourceHistoryId, 52);
  assert.equal(items[0].columnName, 'Company');
  assert.equal(items[0].reason, 'Suggested by Word Manipulation: Find and replace.');
});

test('validates review selections and blocks duplicate or oversized bulk requests', () => {
  assert.deepEqual(parseIdList(['3', '9']), [3, 9]);
  assert.throws(() => parseIdList(['3', '3']), ReviewValidationError);
  assert.throws(() => parseIdList(Array.from({ length: 101 }, (_, index) => String(index + 1))), ReviewValidationError);
});

test('writes review audit actions using the database enum values', async () => {
  const saved = {
    getConnection: pool.getConnection,
    getChangesForUpdate: reviewModel.getChangesForUpdate,
    lockUpload: reviewModel.lockUpload,
    updateChange: reviewModel.updateChange,
    insertAudit: reviewModel.insertAudit
  };
  const auditRows = [];
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {}
  };
  try {
    pool.getConnection = async () => connection;
    reviewModel.getChangesForUpdate = async () => [{
      id: 12,
      upload_id: 8,
      user_id: 3,
      worksheet_index: 0,
      cell_reference: 'A2',
      original_value_json: '"before"',
      proposed_value_json: '"after"',
      status: 'pending',
      is_actionable: true,
      source_history_id: null
    }];
    reviewModel.lockUpload = async () => ({ id: 8 });
    reviewModel.updateChange = async () => {};
    reviewModel.insertAudit = async (_connection, rows) => auditRows.push(...rows);

    await decideChanges(3, ['12'], 'reject');

    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0].action, 'rejected');
  } finally {
    pool.getConnection = saved.getConnection;
    reviewModel.getChangesForUpdate = saved.getChangesForUpdate;
    reviewModel.lockUpload = saved.lockUpload;
    reviewModel.updateChange = saved.updateChange;
    reviewModel.insertAudit = saved.insertAudit;
  }
});
