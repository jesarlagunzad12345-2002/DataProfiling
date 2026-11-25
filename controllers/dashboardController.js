const dashboardModel = require('../models/dashboardModel');

function buildDashboardCharts(data) {
  const uploads = data.profile.uploads;
  const totals = data.profile.totals;
  return {
    completeness: {
      labels: uploads.map((item) => item.original_name),
      values: uploads.map((item) => item.overall_completeness)
    },
    records: {
      labels: ['Complete', 'Incomplete'],
      values: [totals.complete_records, totals.incomplete_records]
    },
    duplicates: {
      labels: uploads.map((item) => item.original_name),
      values: uploads.map((item) => item.duplicate_record_count)
    },
    profiling: {
      labels: ['Missing values', 'Invalid phones', 'Address issues', 'Country issues'],
      values: [
        totals.missing_values,
        totals.invalid_phone_count,
        totals.address_issue_count,
        totals.country_inconsistency_count
      ]
    },
    uploads: {
      labels: data.activityDates,
      values: data.activityDates.map((date) => data.uploadActivity.get(date) || 0)
    },
    manipulation: {
      labels: data.activityDates,
      values: data.activityDates.map((date) => data.wordActivity.get(date) || 0)
    }
  };
}

function dateKey(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function buildActivityDates(days, now = new Date()) {
  const dates = [];
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(end);
    date.setDate(end.getDate() - offset);
    dates.push([
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')
    ].join('-'));
  }
  return dates;
}

async function getDashboard(req, res, next) {
  try {
    const userId = req.session.user.id;
    const readiness = {
      profilingReady: req.app.locals.profilingSchemaReady !== false,
      reviewReady: req.app.locals.reviewSchemaReady !== false,
      manipulationReady: req.app.locals.manipulationSchemaReady !== false
    };
    const [summary, uploads, chartData] = await Promise.all([
      dashboardModel.getDashboardSummary(userId, readiness),
      dashboardModel.listDashboardUploads(userId, { limit: 10, profilingReady: readiness.profilingReady }),
      dashboardModel.getDashboardCharts(userId, { profilingReady: readiness.profilingReady })
    ]);
    const activityDates = buildActivityDates(chartData.activityDays);
    const data = {
      profile: chartData,
      activityDates,
      uploadActivity: new Map(chartData.uploadActivity.map((item) => [dateKey(item.activity_date), Number(item.total)])),
      wordActivity: new Map(chartData.wordActivity.map((item) => [dateKey(item.activity_date), Number(item.total)]))
    };
    return res.render('dashboard', {
      title: 'Dashboard',
      activePage: 'dashboard',
      summary,
      recentUploads: uploads,
      charts: buildDashboardCharts(data),
      profilingReady: readiness.profilingReady
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = { getDashboard, buildDashboardCharts, buildActivityDates, dateKey };
