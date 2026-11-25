const assert = require('node:assert/strict');
const test = require('node:test');
const {
  parseReportFilters,
  escapeCsv,
  toCsv
} = require('../controllers/reportsController');

test('report filters validate date range and deduplicate selected upload IDs', () => {
  assert.deepEqual(parseReportFilters({
    from: '2026-01-02',
    to: '2026-02-01',
    uploadIds: ['8', '8', '12']
  }, 4), {
    userId: 4,
    fromDate: '2026-01-02',
    toDate: '2026-02-01',
    uploadIds: [8, 12]
  });
  assert.throws(() => parseReportFilters({ from: '2026-02-01', to: '2026-01-01' }, 4), {
    status: 400,
    message: 'The start date must be on or before the end date.'
  });
  assert.throws(() => parseReportFilters({ uploadIds: ['not-an-id'] }, 4), {
    status: 400,
    message: 'The selected workbook filter is invalid.'
  });
});

test('report CSV quotes values and neutralizes spreadsheet formulas', () => {
  assert.equal(escapeCsv('=HYPERLINK("https://example.test")'), `"'=HYPERLINK(""https://example.test"")"`);
  const csv = toCsv([{
    original_name: 'customers,"2026".xlsx',
    uploaded_at: '2026-01-01 10:00:00',
    uploaded_by: '=CMD()',
    total_records: 1,
    complete_records: 1,
    incomplete_records: 0,
    overall_completeness: 100,
    missing_values: 0,
    duplicate_record_count: 0,
    invalid_phone_count: 0,
    approved_changes: 0,
    manipulation_operations: 0,
    processing_status: 'completed'
  }]);

  assert.match(csv, /"customers,""2026""\.xlsx"/);
  assert.match(csv, /"'=CMD\(\)"/);
  assert.match(csv, /"Processing status"/);
});
