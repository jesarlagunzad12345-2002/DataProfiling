const { pool } = require('../config/database');

const ACTIVITY_DAYS = 14;

function buildLatestProfileJoins() {
  return `LEFT JOIN (
    SELECT selected.upload_id,
           SUM(selected.total_records) AS total_records,
           SUM(selected.complete_records) AS complete_records,
           SUM(selected.incomplete_records) AS incomplete_records,
           SUM(selected.missing_values) AS missing_values,
           SUM(selected.duplicate_record_count) AS duplicate_record_count,
           SUM(selected.invalid_phone_count) AS invalid_phone_count,
           SUM(selected.address_issue_count) AS address_issue_count,
           SUM(selected.country_inconsistency_count) AS country_inconsistency_count,
           ROUND(SUM(selected.overall_completeness * selected.total_records * selected.column_count)
             / NULLIF(SUM(selected.total_records * selected.column_count), 0), 2) AS overall_completeness
    FROM profiling_runs selected
    JOIN (
      SELECT upload_id, worksheet_index, MAX(id) AS id
      FROM profiling_runs
      WHERE user_id = ? AND status = 'completed'
      GROUP BY upload_id, worksheet_index
    ) latest ON latest.id = selected.id
    GROUP BY selected.upload_id
  ) profile ON profile.upload_id = u.id`;
}

function buildLatestStatusJoins() {
  return `LEFT JOIN (
    SELECT selected.upload_id,
           CASE
             WHEN SUM(selected.status IN ('queued', 'processing')) > 0 THEN 'processing'
             WHEN SUM(selected.status = 'completed') > 0 AND SUM(selected.status = 'failed') > 0 THEN 'partial'
             WHEN SUM(selected.status = 'completed') > 0 THEN 'completed'
             WHEN SUM(selected.status = 'failed') > 0 THEN 'failed'
             ELSE 'not_profiled'
           END AS processing_status
    FROM profiling_runs selected
    JOIN (
      SELECT upload_id, worksheet_index, MAX(id) AS id
      FROM profiling_runs WHERE user_id = ?
      GROUP BY upload_id, worksheet_index
    ) latest ON latest.id = selected.id
    GROUP BY selected.upload_id
  ) profile_status ON profile_status.upload_id = u.id`;
}

function summarizeUploadRows(rows) {
  return rows.map((row) => ({
    ...row,
    total_records: Number(row.total_records || 0),
    complete_records: Number(row.complete_records || 0),
    incomplete_records: Number(row.incomplete_records || 0),
    missing_values: Number(row.missing_values || 0),
    duplicate_record_count: Number(row.duplicate_record_count || 0),
    invalid_phone_count: Number(row.invalid_phone_count || 0),
    address_issue_count: Number(row.address_issue_count || 0),
    country_inconsistency_count: Number(row.country_inconsistency_count || 0),
    approved_changes: Number(row.approved_changes || 0),
    manipulation_operations: Number(row.manipulation_operations || 0),
    overall_completeness: row.overall_completeness === null
      ? null
      : Number(row.overall_completeness)
  }));
}

async function getDashboardSummary(userId, readiness = {}) {
  const [uploadRows] = await pool.execute(
    'SELECT COUNT(*) AS upload_count FROM uploads WHERE user_id = ?',
    [userId]
  );
  const [profileRows] = readiness.profilingReady === false
    ? [[{
      processed_records: 0,
      complete_records: 0,
      incomplete_records: 0,
      missing_values: 0,
      duplicate_record_count: 0,
      invalid_phone_count: 0,
      overall_completeness: null
    }]]
    : await pool.execute(
      `WITH latest AS (
         SELECT r.upload_id, r.worksheet_index, r.total_records,
                r.complete_records, r.incomplete_records, r.missing_values,
                r.duplicate_record_count, r.invalid_phone_count,
                r.column_count, r.overall_completeness
         FROM profiling_runs r
         JOIN (
           SELECT upload_id, worksheet_index, MAX(id) AS id
           FROM profiling_runs
           WHERE user_id = ? AND status = 'completed'
           GROUP BY upload_id, worksheet_index
         ) selected ON selected.id = r.id
       )
       SELECT COALESCE(SUM(total_records), 0) AS processed_records,
              COALESCE(SUM(complete_records), 0) AS complete_records,
              COALESCE(SUM(incomplete_records), 0) AS incomplete_records,
              COALESCE(SUM(missing_values), 0) AS missing_values,
              COALESCE(SUM(duplicate_record_count), 0) AS duplicate_record_count,
              COALESCE(SUM(invalid_phone_count), 0) AS invalid_phone_count,
              ROUND(
                SUM(overall_completeness * total_records * column_count)
                / NULLIF(SUM(total_records * column_count), 0), 2
              ) AS overall_completeness
       FROM latest`,
      [userId]
    );
  const [approvedRows] = readiness.reviewReady === false
    ? [[{ approved_changes: 0 }]]
    : await pool.execute(
      `SELECT COUNT(*) AS approved_changes
       FROM review_changes
       WHERE user_id = ? AND status = 'approved'`,
      [userId]
    );
  const [operationRows] = readiness.manipulationReady === false
    ? [[{ manipulation_operations: 0 }]]
    : await pool.execute(
      `SELECT COUNT(*) AS manipulation_operations
       FROM manipulation_history
       WHERE user_id = ?`,
      [userId]
    );
  return {
    upload_count: Number(uploadRows[0].upload_count),
    ...profileRows[0],
    approved_changes: Number(approvedRows[0].approved_changes),
    manipulation_operations: Number(operationRows[0].manipulation_operations)
  };
}

async function listDashboardUploads(userId, {
  limit = 10,
  profilingReady = true
} = {}) {
  if (!profilingReady) {
    const [rows] = await pool.execute(
      `SELECT u.id, u.original_name, u.uploaded_at, u.file_size,
              u.file_extension, actor.username AS uploaded_by,
              0 AS total_records, NULL AS overall_completeness,
              'not_profiled' AS processing_status
       FROM uploads u
       JOIN users actor ON actor.id = u.user_id
       WHERE u.user_id = ?
       ORDER BY u.uploaded_at DESC, u.id DESC
       LIMIT ?`,
      [userId, limit]
    );
    return summarizeUploadRows(rows);
  }
  const [rows] = await pool.execute(
    `SELECT u.id, u.original_name, u.uploaded_at, u.file_size,
            u.file_extension, actor.username AS uploaded_by,
            COALESCE(profile.total_records, 0) AS total_records,
            profile.overall_completeness,
            COALESCE(profile_status.processing_status, 'not_profiled') AS processing_status
     FROM uploads u
     JOIN users actor ON actor.id = u.user_id
     ${buildLatestProfileJoins()}
     ${buildLatestStatusJoins()}
     WHERE u.user_id = ?
     GROUP BY u.id, actor.username, profile.total_records,
              profile.overall_completeness, profile_status.processing_status
     ORDER BY u.uploaded_at DESC, u.id DESC
     LIMIT ?`,
    [userId, userId, userId, limit]
  );
  return summarizeUploadRows(rows);
}

async function getDashboardCharts(userId, { profilingReady = true } = {}) {
  const [uploadActivity] = await pool.execute(
    `SELECT DATE(uploaded_at) AS activity_date, COUNT(*) AS total
     FROM uploads
     WHERE user_id = ? AND uploaded_at >= DATE_SUB(CURRENT_DATE, INTERVAL ? DAY)
     GROUP BY DATE(uploaded_at)
     ORDER BY activity_date`,
    [userId, ACTIVITY_DAYS - 1]
  );
  const [wordActivity] = await pool.execute(
    `SELECT DATE(h.created_at) AS activity_date, COUNT(*) AS total
     FROM manipulation_history h
     WHERE h.user_id = ? AND h.created_at >= DATE_SUB(CURRENT_DATE, INTERVAL ? DAY)
     GROUP BY DATE(h.created_at)
     ORDER BY activity_date`,
    [userId, ACTIVITY_DAYS - 1]
  );
  const emptyProfile = {
    uploads: [],
    totals: {
      complete_records: 0,
      incomplete_records: 0,
      duplicate_record_count: 0,
      invalid_phone_count: 0,
      missing_values: 0,
      address_issue_count: 0,
      country_inconsistency_count: 0
    }
  };
  if (!profilingReady) {
    return { ...emptyProfile, uploadActivity, wordActivity, activityDays: ACTIVITY_DAYS };
  }
  const [rows] = await pool.execute(
    `WITH latest AS (
       SELECT r.upload_id, r.worksheet_index, r.total_records,
              r.complete_records, r.incomplete_records, r.missing_values,
              r.duplicate_record_count, r.invalid_phone_count,
              r.address_issue_count, r.country_inconsistency_count,
              r.column_count, r.overall_completeness
       FROM profiling_runs r
       JOIN (
         SELECT upload_id, worksheet_index, MAX(id) AS id
         FROM profiling_runs
         WHERE user_id = ? AND status = 'completed'
         GROUP BY upload_id, worksheet_index
       ) selected ON selected.id = r.id
     )
     SELECT u.id AS upload_id, u.original_name, u.uploaded_at,
            COALESCE(SUM(latest.total_records), 0) AS total_records,
            COALESCE(SUM(latest.complete_records), 0) AS complete_records,
            COALESCE(SUM(latest.incomplete_records), 0) AS incomplete_records,
            COALESCE(SUM(latest.missing_values), 0) AS missing_values,
            COALESCE(SUM(latest.duplicate_record_count), 0) AS duplicate_record_count,
            COALESCE(SUM(latest.invalid_phone_count), 0) AS invalid_phone_count,
            COALESCE(SUM(latest.address_issue_count), 0) AS address_issue_count,
            COALESCE(SUM(latest.country_inconsistency_count), 0) AS country_inconsistency_count,
            ROUND(SUM(latest.overall_completeness * latest.total_records * latest.column_count)
              / NULLIF(SUM(latest.total_records * latest.column_count), 0), 2) AS overall_completeness
     FROM uploads u
     JOIN latest ON latest.upload_id = u.id
     WHERE u.user_id = ?
     GROUP BY u.id
     ORDER BY u.uploaded_at DESC, u.id DESC
     LIMIT 12`,
    [userId, userId]
  );
  const uploads = summarizeUploadRows(rows).reverse();
  const totals = uploads.reduce((result, upload) => {
    for (const key of [
      'complete_records',
      'incomplete_records',
      'missing_values',
      'duplicate_record_count',
      'invalid_phone_count',
      'address_issue_count',
      'country_inconsistency_count'
    ]) result[key] += upload[key];
    return result;
  }, { ...emptyProfile.totals });
  return { uploads, totals, uploadActivity, wordActivity, activityDays: ACTIVITY_DAYS };
}

function buildReportFilter(filters) {
  const clauses = ['u.user_id = ?'];
  const values = [filters.userId];
  if (filters.fromDate) {
    clauses.push('u.uploaded_at >= ?');
    values.push(`${filters.fromDate} 00:00:00`);
  }
  if (filters.toDate) {
    clauses.push('u.uploaded_at < DATE_ADD(?, INTERVAL 1 DAY)');
    values.push(filters.toDate);
  }
  if (filters.uploadIds.length) {
    clauses.push(`u.id IN (${filters.uploadIds.map(() => '?').join(',')})`);
    values.push(...filters.uploadIds);
  }
  return { where: clauses.join(' AND '), values };
}

async function listReportUploadOptions(userId, limit = 500) {
  const [rows] = await pool.execute(
    `SELECT id, original_name, uploaded_at
     FROM uploads WHERE user_id = ?
     ORDER BY uploaded_at DESC, id DESC LIMIT ?`,
    [userId, limit]
  );
  return rows;
}

async function countReportUploads(filters) {
  const { where, values } = buildReportFilter(filters);
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS total FROM uploads u WHERE ${where}`,
    values
  );
  return Number(rows[0].total);
}

async function getReportRows(filters, {
  profilingReady = true,
  reviewReady = true,
  manipulationReady = true
} = {}, pagination = null) {
  const { where, values } = buildReportFilter(filters);
  if (pagination && (!Number.isSafeInteger(pagination.limit) || pagination.limit < 1
    || !Number.isSafeInteger(pagination.offset) || pagination.offset < 0)) {
    throw new TypeError('Report pagination values must be non-negative safe integers.');
  }
  const profileJoins = profilingReady
    ? `${buildLatestProfileJoins()}
       ${buildLatestStatusJoins()}`
    : '';
  const reviewJoin = reviewReady
    ? `LEFT JOIN (
         SELECT upload_id, COUNT(*) AS approved_changes
         FROM review_changes
         WHERE user_id = ? AND status = 'approved'
         GROUP BY upload_id
       ) review_summary ON review_summary.upload_id = u.id`
    : '';
  const manipulationJoin = manipulationReady
    ? `LEFT JOIN (
         SELECT j.upload_id, COUNT(*) AS manipulation_operations
         FROM manipulation_history h
         JOIN manipulation_jobs j ON j.id = h.job_id AND j.user_id = h.user_id
         WHERE h.user_id = ?
         GROUP BY j.upload_id
       ) manipulation_summary ON manipulation_summary.upload_id = u.id`
    : '';
  const profileFields = profilingReady
    ? `COALESCE(profile.total_records, 0) AS total_records,
       COALESCE(profile.complete_records, 0) AS complete_records,
       COALESCE(profile.incomplete_records, 0) AS incomplete_records,
       COALESCE(profile.missing_values, 0) AS missing_values,
       COALESCE(profile.duplicate_record_count, 0) AS duplicate_record_count,
       COALESCE(profile.invalid_phone_count, 0) AS invalid_phone_count,
       COALESCE(profile.address_issue_count, 0) AS address_issue_count,
       COALESCE(profile.country_inconsistency_count, 0) AS country_inconsistency_count,
       profile.overall_completeness AS overall_completeness,
       COALESCE(profile_status.processing_status, 'not_profiled') AS processing_status`
    : `0 AS total_records, 0 AS complete_records, 0 AS incomplete_records,
       0 AS missing_values, 0 AS duplicate_record_count, 0 AS invalid_phone_count,
       0 AS address_issue_count, 0 AS country_inconsistency_count,
       NULL AS overall_completeness, 'not_profiled' AS processing_status`;
  const [rows] = await pool.execute(
    `SELECT u.id AS upload_id, u.original_name, u.uploaded_at,
            actor.username AS uploaded_by,
            ${profileFields},
            ${reviewReady ? 'COALESCE(review_summary.approved_changes, 0)' : '0'} AS approved_changes,
            ${manipulationReady ? 'COALESCE(manipulation_summary.manipulation_operations, 0)' : '0'} AS manipulation_operations
     FROM uploads u
     JOIN users actor ON actor.id = u.user_id
     ${profileJoins}
     ${reviewJoin}
     ${manipulationJoin}
     WHERE ${where}
     GROUP BY u.id, actor.username
       ${profilingReady ? ', profile.total_records, profile.complete_records, profile.incomplete_records, profile.missing_values, profile.duplicate_record_count, profile.invalid_phone_count, profile.address_issue_count, profile.country_inconsistency_count, profile.overall_completeness, profile_status.processing_status' : ''}
       ${reviewReady ? ', review_summary.approved_changes' : ''}
       ${manipulationReady ? ', manipulation_summary.manipulation_operations' : ''}
     ORDER BY u.uploaded_at DESC, u.id DESC${pagination ? ' LIMIT ? OFFSET ?' : ''}`,
    [
      ...(profilingReady ? [filters.userId, filters.userId] : []),
      ...(reviewReady ? [filters.userId] : []),
      ...(manipulationReady ? [filters.userId] : []),
      ...values,
      ...(pagination ? [pagination.limit, pagination.offset] : [])
    ]
  );
  return summarizeUploadRows(rows);
}

async function getReportManipulationActivity(filters, { manipulationReady = true } = {}) {
  if (!manipulationReady) return [];
  const clauses = ['h.user_id = ?'];
  const values = [filters.userId];
  if (filters.fromDate) {
    clauses.push('h.created_at >= ?');
    values.push(`${filters.fromDate} 00:00:00`);
  }
  if (filters.toDate) {
    clauses.push('h.created_at < DATE_ADD(?, INTERVAL 1 DAY)');
    values.push(filters.toDate);
  }
  if (filters.uploadIds.length) {
    clauses.push(`j.upload_id IN (${filters.uploadIds.map(() => '?').join(',')})`);
    values.push(...filters.uploadIds);
  }
  const [rows] = await pool.execute(
    `SELECT DATE(h.created_at) AS activity_date, COUNT(*) AS total
     FROM manipulation_history h
     JOIN manipulation_jobs j ON j.id = h.job_id AND j.user_id = h.user_id
     WHERE ${clauses.join(' AND ')}
     GROUP BY DATE(h.created_at)
     ORDER BY activity_date`,
    values
  );
  return rows;
}

module.exports = {
  getDashboardSummary,
  listDashboardUploads,
  getDashboardCharts,
  listReportUploadOptions,
  countReportUploads,
  getReportRows,
  getReportManipulationActivity,
  buildReportFilter
};
