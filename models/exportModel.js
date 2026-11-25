const { pool } = require('../config/database');

const EXPORT_TABLES = ['excel_exports'];

async function getMissingExportTables() {
  const placeholders = EXPORT_TABLES.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT TABLE_NAME AS table_name FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name IN (${placeholders})`,
    EXPORT_TABLES
  );
  const existing = new Set(rows.map((row) => String(row.table_name).toLowerCase()));
  return EXPORT_TABLES.filter((tableName) => !existing.has(tableName));
}

async function getExportSchemaIssues() {
  const missingTables = await getMissingExportTables();
  if (missingTables.length) return missingTables;
  const [rows] = await pool.execute(
    `SELECT COLUMN_NAME AS column_name
     FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'excel_exports'`
  );
  const existing = new Set(rows.map((row) => String(row.column_name).toLowerCase()));
  const required = [
    'id',
    'user_id',
    'upload_id',
    'export_type',
    'record_filter',
    'stored_name',
    'filename',
    'record_count',
    'complete_count',
    'incomplete_count',
    'approved_change_count',
    'rejected_change_count',
    'worksheet_count',
    'column_count',
    'created_at',
    'expires_at',
    'file_deleted_at'
  ];
  return required.filter((column) => !existing.has(column)).map((column) => `excel_exports.${column}`);
}

async function listUploadsForUser(userId) {
  const [rows] = await pool.execute(
    `SELECT id, original_name, file_extension, file_size, uploaded_at
     FROM uploads
     WHERE user_id = ?
     ORDER BY uploaded_at DESC, id DESC`,
    [userId]
  );
  return rows;
}

async function getLatestCompletedRuns(userId, uploadId, worksheetIndexes) {
  if (!worksheetIndexes.length) return [];
  const placeholders = worksheetIndexes.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT r.id, r.upload_id, r.worksheet_index, r.options_json,
            r.total_records, r.complete_records, r.incomplete_records
     FROM profiling_runs r
     JOIN (
       SELECT worksheet_index, MAX(id) AS id
       FROM profiling_runs
       WHERE user_id = ? AND upload_id = ? AND status = 'completed'
         AND worksheet_index IN (${placeholders})
       GROUP BY worksheet_index
     ) latest ON latest.id = r.id
     WHERE r.user_id = ? AND r.upload_id = ?
     ORDER BY r.worksheet_index`,
    [userId, uploadId, ...worksheetIndexes, userId, uploadId]
  );
  return rows;
}

async function listProfileRowsAfter(runId, lastId, limit = 500) {
  const [rows] = await pool.execute(
    `SELECT id, excel_row_number, missing_count
     FROM profiling_records
     WHERE run_id = ? AND id > ?
     ORDER BY id
     LIMIT ?`,
    [runId, lastId, limit]
  );
  return rows;
}

async function getDecisionCounts(userId, uploadId, selectedSheets) {
  let approved = 0;
  let rejected = 0;
  for (const sheet of selectedSheets) {
    const columnFilter = sheet.allColumns
      ? ''
      : ` AND column_index IN (${sheet.columns.map(() => '?').join(',')})`;
    const [rows] = await pool.execute(
      `SELECT COALESCE(SUM(status = 'approved'), 0) AS approved_count,
              COALESCE(SUM(status = 'rejected'), 0) AS rejected_count
       FROM review_changes
       WHERE user_id = ? AND upload_id = ? AND worksheet_index = ?
         AND is_actionable = TRUE AND cell_reference IS NOT NULL${columnFilter}`,
      [
        userId,
        uploadId,
        sheet.worksheetIndex,
        ...(sheet.allColumns ? [] : sheet.columns)
      ]
    );
    approved += Number(rows[0].approved_count);
    rejected += Number(rows[0].rejected_count);
  }
  return { approved, rejected };
}

async function createExport({
  userId,
  uploadId,
  exportType,
  recordFilter,
  storedName,
  filename,
  recordCount,
  completeCount,
  incompleteCount,
  approvedChangeCount,
  rejectedChangeCount,
  worksheetCount,
  columnCount,
  expiresAt
}) {
  const [result] = await pool.execute(
    `INSERT INTO excel_exports
       (user_id, upload_id, export_type, record_filter, stored_name, filename, record_count,
        complete_count, incomplete_count, approved_change_count, rejected_change_count,
        worksheet_count, column_count, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      uploadId,
      exportType,
      recordFilter,
      storedName,
      filename,
      recordCount,
      completeCount,
      incompleteCount,
      approvedChangeCount,
      rejectedChangeCount,
      worksheetCount,
      columnCount,
      expiresAt
    ]
  );
  return result.insertId;
}

async function getExportForUser(userId, exportId) {
  const [rows] = await pool.execute(
    `SELECT e.id, e.user_id, e.upload_id, e.export_type, e.record_filter, e.stored_name, e.filename,
            e.record_count, e.complete_count, e.incomplete_count,
            e.approved_change_count, e.rejected_change_count, e.worksheet_count,
            e.column_count, e.created_at, e.expires_at, e.file_deleted_at, u.original_name
     FROM excel_exports e
     JOIN uploads u ON u.id = e.upload_id AND u.user_id = e.user_id
     WHERE e.id = ? AND e.user_id = ?
     LIMIT 1`,
    [exportId, userId]
  );
  return rows[0] || null;
}

async function listRecentExports(userId, limit = 20) {
  const [rows] = await pool.execute(
    `SELECT e.id, e.upload_id, e.export_type, e.record_filter, e.filename, e.record_count,
            e.complete_count, e.incomplete_count, e.approved_change_count,
            e.rejected_change_count, e.worksheet_count, e.column_count,
            e.created_at, e.expires_at, e.file_deleted_at, u.original_name
     FROM excel_exports e
     JOIN uploads u ON u.id = e.upload_id AND u.user_id = e.user_id
     WHERE e.user_id = ?
     ORDER BY e.created_at DESC, e.id DESC
     LIMIT ?`,
    [userId, limit]
  );
  return rows;
}

async function listExpiredExports(limit = 500) {
  const [rows] = await pool.execute(
    `SELECT id, stored_name
     FROM excel_exports
     WHERE expires_at <= CURRENT_TIMESTAMP AND file_deleted_at IS NULL
     ORDER BY expires_at
     LIMIT ?`,
    [limit]
  );
  return rows;
}

async function listStoredExportNames() {
  const [rows] = await pool.execute(
    `SELECT stored_name
     FROM excel_exports
     WHERE expires_at > CURRENT_TIMESTAMP AND file_deleted_at IS NULL`
  );
  return rows.map((row) => row.stored_name);
}

async function markExportFileDeleted(exportId) {
  await pool.execute(
    `UPDATE excel_exports SET file_deleted_at = CURRENT_TIMESTAMP
     WHERE id = ? AND file_deleted_at IS NULL`,
    [exportId]
  );
}

module.exports = {
  getMissingExportTables,
  getExportSchemaIssues,
  listUploadsForUser,
  getLatestCompletedRuns,
  listProfileRowsAfter,
  getDecisionCounts,
  createExport,
  getExportForUser,
  listRecentExports,
  listExpiredExports,
  listStoredExportNames,
  markExportFileDeleted
};
