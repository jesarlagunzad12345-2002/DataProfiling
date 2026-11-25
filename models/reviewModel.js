const { pool } = require('../config/database');

const REVIEW_TABLES = ['review_changes', 'review_audit'];
const REVIEW_STATUSES = new Set(['pending', 'requires_review', 'approved', 'rejected']);

function serializeJson(value) {
  return value === undefined ? null : JSON.stringify(value);
}

function escapeLike(value) {
  return value.replace(/[!%_]/g, '!$&');
}

async function getMissingReviewTables() {
  const placeholders = REVIEW_TABLES.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT TABLE_NAME AS table_name FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name IN (${placeholders})`,
    REVIEW_TABLES
  );
  const existing = new Set(rows.map((row) => String(row.table_name).toLowerCase()));
  return REVIEW_TABLES.filter((tableName) => !existing.has(tableName));
}

async function getReviewSchemaIssues() {
  const missingTables = await getMissingReviewTables();
  const issues = [...missingTables];
  const [columns] = await pool.execute(
    `SELECT COLUMN_TYPE AS column_type
     FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'manipulation_history'
       AND column_name = 'status'
     LIMIT 1`
  );
  const columnType = columns[0] && String(columns[0].column_type);
  if (!columnType || !columnType.includes("'pending'") || !columnType.includes("'partial'")) {
    issues.push('manipulation_history.status Phase 4 update');
  }
  return issues;
}

async function listUploads(userId) {
  const [rows] = await pool.execute(
    `SELECT u.id AS upload_id, u.original_name, u.uploaded_at,
            w.worksheet_index, w.worksheet_name
     FROM uploads u
     JOIN worksheets w ON w.upload_id = u.id
     WHERE u.user_id = ?
     ORDER BY u.uploaded_at DESC, u.id DESC, w.worksheet_index`,
    [userId]
  );
  return rows;
}

async function listLatestCompletedRuns(userId, uploadId) {
  const [rows] = await pool.execute(
    `SELECT r.id, r.upload_id, r.worksheet_index, r.options_json,
            w.worksheet_name
     FROM profiling_runs r
     JOIN (
       SELECT worksheet_index, MAX(id) AS id
       FROM profiling_runs
       WHERE user_id = ? AND upload_id = ? AND status = 'completed'
       GROUP BY worksheet_index
     ) latest ON latest.id = r.id
     JOIN worksheets w
       ON w.upload_id = r.upload_id AND w.worksheet_index = r.worksheet_index
     WHERE r.user_id = ? AND r.upload_id = ?
     ORDER BY r.worksheet_index`,
    [userId, uploadId, userId, uploadId]
  );
  return rows;
}

async function listProfilingRecordsAfter(runId, lastId, limit = 200) {
  const [rows] = await pool.execute(
    `SELECT id, excel_row_number,
            CAST(original_values AS CHAR) AS original_values_json,
            CAST(suggestions AS CHAR) AS suggestions_json,
            CAST(issues AS CHAR) AS issues_json,
            missing_count, invalid_phone, suspicious_phone, address_issue,
            country_inconsistent, duplicate_exact, duplicate_phone, duplicate_email
     FROM profiling_records
     WHERE run_id = ? AND id > ?
     ORDER BY id
     LIMIT ?`,
    [runId, lastId, limit]
  );
  return rows;
}

async function insertChanges(connection, changes) {
  const batchSize = 100;
  const columns = [
    'user_id',
    'upload_id',
    'worksheet_index',
    'cell_reference',
    'excel_row_number',
    'column_index',
    'column_name',
    'original_value',
    'proposed_value',
    'details_json',
    'reason',
    'source_type',
    'source_key',
    'source_run_id',
    'source_record_id',
    'source_history_id',
    'is_actionable',
    'status'
  ];
  for (let offset = 0; offset < changes.length; offset += batchSize) {
    const batch = changes.slice(offset, offset + batchSize);
    const placeholders = batch.map(() => `(${columns.map(() => '?').join(',')})`).join(',');
    const values = batch.flatMap((change) => [
      change.userId,
      change.uploadId,
      change.worksheetIndex,
      change.cellReference || null,
      change.row,
      change.columnIndex === undefined ? null : change.columnIndex,
      change.columnName || null,
      serializeJson(change.originalValue),
      serializeJson(change.proposedValue),
      serializeJson(change.details),
      change.reason,
      change.sourceType,
      change.sourceKey,
      change.sourceRunId || null,
      change.sourceRecordId || null,
      change.sourceHistoryId || null,
      change.isActionable === true,
      change.status || 'pending'
    ]);
    await connection.execute(
      `INSERT INTO review_changes (${columns.join(', ')})
       VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE id = id`,
      values
    );
  }
}

async function listLegacyWordChangesAfter(userId, uploadId, cursor, limit = 200) {
  const [rows] = await pool.execute(
    `SELECT h.id AS history_id, h.user_id, h.worksheet_index, h.operation,
            c.cell_reference, c.excel_row_number AS excel_row_number, c.column_index,
            CAST(c.original_value AS CHAR) AS original_value_json,
            CAST(c.modified_value AS CHAR) AS modified_value_json,
            w.worksheet_name
     FROM manipulation_history h
     JOIN manipulation_jobs j ON j.id = h.job_id AND j.user_id = h.user_id
     JOIN manipulation_cell_changes c ON c.history_id = h.id
     JOIN worksheets w
       ON w.upload_id = j.upload_id AND w.worksheet_index = h.worksheet_index
     WHERE h.user_id = ? AND j.upload_id = ? AND h.status = 'applied'
       AND NOT EXISTS (
         SELECT 1 FROM review_changes rc
         WHERE rc.user_id = h.user_id AND rc.upload_id = j.upload_id
           AND rc.source_history_id = h.id
       )
       AND (
         h.id > ? OR (
           h.id = ? AND (
             c.excel_row_number > ? OR (
               c.excel_row_number = ? AND c.column_index > ?
             )
           )
         )
       )
     ORDER BY h.id, c.excel_row_number, c.column_index
     LIMIT ?`,
    [
      userId,
      uploadId,
      cursor.historyId,
      cursor.historyId,
      cursor.row,
      cursor.row,
      cursor.columnIndex,
      limit
    ]
  );
  return rows;
}

async function listChanges(userId, {
  uploadId = null,
  status = '',
  sourceType = '',
  search = '',
  page = 1,
  pageSize = 25
} = {}) {
  const clauses = ['c.user_id = ?'];
  const values = [userId];
  if (Number.isSafeInteger(uploadId) && uploadId > 0) {
    clauses.push('c.upload_id = ?');
    values.push(uploadId);
  }
  if (REVIEW_STATUSES.has(status)) {
    clauses.push('c.status = ?');
    values.push(status);
  }
  if (sourceType === 'profiling' || sourceType === 'word-manipulation') {
    clauses.push('c.source_type = ?');
    values.push(sourceType);
  }
  if (search) {
    const term = `%${escapeLike(search)}%`;
    clauses.push('(u.original_name LIKE ? ESCAPE \'!\' OR c.reason LIKE ? ESCAPE \'!\' OR c.cell_reference LIKE ? ESCAPE \'!\')');
    values.push(term, term, term);
  }
  const where = clauses.join(' AND ');
  const [countRows] = await pool.execute(
    `SELECT COUNT(*) AS total
     FROM review_changes c
     JOIN uploads u ON u.id = c.upload_id AND u.user_id = c.user_id
     WHERE ${where}`,
    values
  );
  const total = Number(countRows[0].total);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const actualPage = Math.min(page, pageCount);
  const [rows] = await pool.execute(
    `SELECT c.id, c.upload_id, c.worksheet_index, c.cell_reference,
            c.excel_row_number, c.column_index, c.column_name,
            CAST(c.original_value AS CHAR) AS original_value_json,
            CAST(c.proposed_value AS CHAR) AS proposed_value_json,
            CAST(c.details_json AS CHAR) AS details_json,
            c.reason, c.source_type, c.source_key, c.source_history_id,
            c.is_actionable, c.status, c.reviewed_by, c.reviewed_at, c.created_at,
            u.original_name, w.worksheet_name, h.operation
     FROM review_changes c
     JOIN uploads u ON u.id = c.upload_id AND u.user_id = c.user_id
     LEFT JOIN worksheets w
       ON w.upload_id = c.upload_id AND w.worksheet_index = c.worksheet_index
     LEFT JOIN manipulation_history h ON h.id = c.source_history_id
     WHERE ${where}
     ORDER BY CASE c.status
       WHEN 'pending' THEN 0
       WHEN 'requires_review' THEN 1
       WHEN 'approved' THEN 2
       ELSE 3
     END, c.created_at DESC, c.id DESC
     LIMIT ? OFFSET ?`,
    [...values, pageSize, (actualPage - 1) * pageSize]
  );
  return { changes: rows, total, page: actualPage, pageCount };
}

async function getSummary(userId, uploadId = null) {
  const values = [userId];
  const uploadFilter = Number.isSafeInteger(uploadId) && uploadId > 0
    ? ' AND upload_id = ?'
    : '';
  if (uploadFilter) values.push(uploadId);
  const [rows] = await pool.execute(
    `SELECT
       COALESCE(SUM(status = 'pending'), 0) AS pending_count,
       COALESCE(SUM(status = 'approved'), 0) AS approved_count,
       COALESCE(SUM(status = 'rejected'), 0) AS rejected_count,
       COALESCE(SUM(status = 'requires_review'), 0) AS requires_review_count
     FROM review_changes
     WHERE user_id = ?${uploadFilter}`,
    values
  );
  return rows[0];
}

async function listRecentAudit(userId, uploadId = null, limit = 20) {
  const values = [userId];
  const uploadFilter = Number.isSafeInteger(uploadId) && uploadId > 0
    ? ' AND a.upload_id = ?'
    : '';
  if (uploadFilter) values.push(uploadId);
  const [rows] = await pool.execute(
    `SELECT a.id, a.review_change_id, a.upload_id, a.worksheet_index,
            a.cell_reference, a.action, a.previous_status, a.new_status,
            CAST(a.original_value AS CHAR) AS original_value_json,
            CAST(a.previous_proposed_value AS CHAR) AS previous_proposed_value_json,
            CAST(a.proposed_value AS CHAR) AS proposed_value_json,
            a.created_at, actor.username, u.original_name, c.reason
     FROM review_audit a
     JOIN users actor ON actor.id = a.user_id
     JOIN uploads u ON u.id = a.upload_id AND u.user_id = a.user_id
     JOIN review_changes c ON c.id = a.review_change_id
     WHERE a.user_id = ?${uploadFilter}
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT ?`,
    [...values, limit]
  );
  return rows;
}

async function getChangeForUpdate(connection, userId, changeId) {
  const [rows] = await connection.execute(
    `SELECT id, user_id, upload_id, worksheet_index, cell_reference,
            excel_row_number, column_index, column_name,
            CAST(original_value AS CHAR) AS original_value_json,
            CAST(proposed_value AS CHAR) AS proposed_value_json,
            reason, source_type, source_history_id, is_actionable, status
     FROM review_changes
     WHERE id = ? AND user_id = ?
     LIMIT 1 FOR UPDATE`,
    [changeId, userId]
  );
  return rows[0] || null;
}

async function getChangesForUpdate(connection, userId, ids) {
  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await connection.execute(
    `SELECT id, user_id, upload_id, worksheet_index, cell_reference,
            excel_row_number, column_index, column_name,
            CAST(original_value AS CHAR) AS original_value_json,
            CAST(proposed_value AS CHAR) AS proposed_value_json,
            reason, source_type, source_history_id, is_actionable, status
     FROM review_changes
     WHERE user_id = ? AND id IN (${placeholders})
     ORDER BY id
     FOR UPDATE`,
    [userId, ...ids]
  );
  return rows;
}

async function lockUpload(connection, userId, uploadId) {
  const [rows] = await connection.execute(
    `SELECT id, stored_name, file_extension
     FROM uploads WHERE id = ? AND user_id = ? FOR UPDATE`,
    [uploadId, userId]
  );
  return rows[0] || null;
}

async function updateChange(connection, change, {
  proposedValue,
  status,
  isActionable,
  reviewedBy,
  reviewed
}) {
  await connection.execute(
    `UPDATE review_changes
     SET proposed_value = ?, status = ?, is_actionable = ?,
         reviewed_by = ?, reviewed_at = ?
     WHERE id = ? AND user_id = ?`,
    [
      serializeJson(proposedValue),
      status,
      isActionable,
      reviewedBy,
      reviewed ? new Date() : null,
      change.id,
      change.user_id
    ]
  );
}

async function insertAudit(connection, auditRows) {
  if (!auditRows.length) return;
  const values = auditRows.flatMap((audit) => [
    audit.changeId,
    audit.userId,
    audit.uploadId,
    audit.worksheetIndex,
    audit.cellReference || null,
    serializeJson(audit.originalValue),
    serializeJson(audit.previousProposedValue),
    serializeJson(audit.proposedValue),
    audit.previousStatus,
    audit.newStatus,
    audit.action
  ]);
  const placeholders = auditRows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
  await connection.execute(
    `INSERT INTO review_audit
       (review_change_id, user_id, upload_id, worksheet_index, cell_reference,
        original_value, previous_proposed_value, proposed_value, previous_status,
        new_status, action)
     VALUES ${placeholders}`,
    values
  );
}

async function countHistoryReviewStates(connection, historyId) {
  const [rows] = await connection.execute(
    `SELECT COALESCE(SUM(status = 'pending' OR status = 'requires_review'), 0) AS open_count,
            COALESCE(SUM(status = 'approved'), 0) AS approved_count,
            COALESCE(SUM(status = 'rejected'), 0) AS rejected_count
     FROM review_changes
     WHERE source_history_id = ?`,
    [historyId]
  );
  return rows[0];
}

async function updateHistoryStatus(connection, historyId, status) {
  await connection.execute(
    `UPDATE manipulation_history SET status = ?
     WHERE id = ? AND status IN ('pending', 'partial', 'applied')`,
    [status, historyId]
  );
}

module.exports = {
  getMissingReviewTables,
  getReviewSchemaIssues,
  listUploads,
  listLatestCompletedRuns,
  listProfilingRecordsAfter,
  insertChanges,
  listLegacyWordChangesAfter,
  listChanges,
  getSummary,
  listRecentAudit,
  getChangeForUpdate,
  getChangesForUpdate,
  lockUpload,
  updateChange,
  insertAudit,
  countHistoryReviewStates,
  updateHistoryStatus,
  REVIEW_STATUSES,
  serializeJson
};
