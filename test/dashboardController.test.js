const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildActivityDates,
  buildDashboardCharts,
  dateKey
} = require('../controllers/dashboardController');

test('dashboard chart payload uses profile results and daily activity returned by the model', () => {
  const charts = buildDashboardCharts({
    profile: {
      uploads: [{
        original_name: 'customers.xlsx',
        overall_completeness: 92.5,
        duplicate_record_count: 2
      }],
      totals: {
        complete_records: 8,
        incomplete_records: 2,
        missing_values: 4,
        invalid_phone_count: 1,
        address_issue_count: 3,
        country_inconsistency_count: 0
      }
    },
    activityDates: ['2026-03-01', '2026-03-02'],
    uploadActivity: new Map([['2026-03-02', 2]]),
    wordActivity: new Map([['2026-03-01', 1]])
  });

  assert.deepEqual(charts.completeness, { labels: ['customers.xlsx'], values: [92.5] });
  assert.deepEqual(charts.records, { labels: ['Complete', 'Incomplete'], values: [8, 2] });
  assert.deepEqual(charts.duplicates.values, [2]);
  assert.deepEqual(charts.profiling.values, [4, 1, 3, 0]);
  assert.deepEqual(charts.uploads.values, [0, 2]);
  assert.deepEqual(charts.manipulation.values, [1, 0]);
});

test('dashboard activity dates are consecutive local calendar days and SQL dates normalize', () => {
  assert.deepEqual(buildActivityDates(3, new Date(2026, 2, 2)), [
    '2026-02-28',
    '2026-03-01',
    '2026-03-02'
  ]);
  assert.equal(dateKey(new Date('2026-03-02T00:00:00.000Z')), '2026-03-02');
  assert.equal(dateKey('2026-03-02T00:00:00.000Z'), '2026-03-02');
});
