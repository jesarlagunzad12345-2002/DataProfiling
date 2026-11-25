const { pool } = require('../config/database');

const MANIPULATION_TABLES = [
  'manipulation_jobs',
  'manipulation_history',
  'manipulation_cell_changes'
];

async function getMissingManipulationTables() {
  const placeholders = MANIPULATION_TABLES.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT TABLE_NAME AS table_name FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name IN (${placeholders})`,
    MANIPULATION_TABLES
  );
  const existing = new Set(rows.map((row) => String(row.table_name).toLowerCase()));
  return MANIPULATION_TABLES.filter((tableName) => !existing.has(tableName));
}

async function listSources(userId) {
  const [rows] = await pool.execute(
    `SELECT u.id AS upload_id, u.original_name, u.uploaded_at,
            w.worksheet_index, w.worksheet_name, w.row_count, w.column_count
     FROM uploads u
     JOIN worksheets w ON w.upload_id = u.id
     WHERE u.user_id = ?
     ORDER BY u.uploaded_at DESC, u.id DESC, w.worksheet_index`,
    [userId]
  );
  return rows;
}

async function getJobForUpload(userId, uploadId) {
  const [rows] = await pool.execute(
    `SELECT id, user_id, upload_id, working_name, revision, created_at, updated_at
     FROM manipulation_jobs
     WHERE user_id = ? AND upload_id = ?
     LIMIT 1`,
    [userId, uploadId]
  );
  return rows[0] || null;
}

async function lockUpload(connection, userId, uploadId) {
  const [rows] = await connection.execute(
    'SELECT id FROM uploads WHERE id = ? AND user_id = ? FOR UPDATE',
    [uploadId, userId]
  );
  return rows[0] || null;
}

async function getJobForUpdate(connection, userId, uploadId) {
  const [rows] = await connection.execute(
    `SELECT id, user_id, upload_id, working_name, revision
     FROM manipulation_jobs
     WHERE user_id = ? AND upload_id = ?
     LIMIT 1 FOR UPDATE`,
    [userId, uploadId]
  );
  return rows[0] || null;
}

async function createJob(connection, { userId, uploadId, workingName }) {
  const [result] = await connection.execute(
    `INSERT INTO manipulation_jobs (user_id, upload_id, working_name)
     VALUES (?, ?, ?)`,
    [userId, uploadId, workingName]
  );
  return result.insertId;
}

async function createHistory(connection, {
  jobId,
  userId,
  worksheetIndex,
  operation,
  parameters,
  changeCount,
  revisionBefore,
  revisionAfter,
  status = 'applied',
  undoOfHistoryId = null
}) {
  const [result] = await connection.execute(
    `INSERT INTO manipulation_history
       (job_id, user_id, worksheet_index, operation, parameters_json, change_count,
        revision_before, revision_after, status, undo_of_history_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      jobId,
      userId,
      worksheetIndex,
      operation,
      JSON.stringify(parameters),
      changeCount,
      revisionBefore,
      revisionAfter,
      status,
      undoOfHistoryId
    ]
  );
  return result.insertId;
}

async function insertCellChanges(connection, historyId, changes) {
  const batchSize = 250;
  for (let offset = 0; offset < changes.length; offset += batchSize) {
    const batch = changes.slice(offset, offset + batchSize);
    const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?)').join(',');
    const values = batch.flatMap((change) => [
      historyId,
      change.cellReference,
      change.row,
      change.column,
      JSON.stringify(change.originalValue),
      JSON.stringify(change.modifiedValue)
    ]);
    await connection.execute(
      `INSERT INTO manipulation_cell_changes
         (history_id, cell_reference, excel_row_number, column_index, original_value, modified_value)
       VALUES ${placeholders}`,
      values
    );
  }
}

async function updateJobRevision(connection, jobId, revision) {
  await connection.execute(
    'UPDATE manipulation_jobs SET revision = ? WHERE id = ?',
    [revision, jobId]
  );
}

async function listRecentHistory(userId, uploadId, limit = 20) {
  const [rows] = await pool.execute(
    `SELECT h.id, h.worksheet_index, h.operation, h.parameters_json, h.change_count,
            h.revision_before, h.revision_after, h.status, h.undo_of_history_id, h.created_at,
            u.username, up.original_name
     FROM manipulation_history h
     JOIN manipulation_jobs j ON j.id = h.job_id AND j.user_id = h.user_id
     JOIN users u ON u.id = h.user_id
     JOIN uploads up ON up.id = j.upload_id AND up.user_id = j.user_id
     WHERE h.user_id = ? AND j.upload_id = ?
     ORDER BY h.id DESC
     LIMIT ?`,
    [userId, uploadId, limit]
  );
  return rows;
}

async function listHistoryPage(userId, uploadId, { page = 1, pageSize = 20 } = {}) {
  const [countRows] = await pool.execute(
    `SELECT COUNT(*) AS total
     FROM manipulation_history h
     JOIN manipulation_jobs j ON j.id = h.job_id AND j.user_id = h.user_id
     WHERE h.user_id = ? AND j.upload_id = ?`,
    [userId, uploadId]
  );
  const total = Number(countRows[0].total);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const actualPage = Math.min(page, pageCount);
  const offset = (actualPage - 1) * pageSize;
  const [rows] = await pool.execute(
    `SELECT h.id, h.worksheet_index, h.operation, h.parameters_json, h.change_count,
            h.revision_before, h.revision_after, h.status, h.undo_of_history_id, h.created_at,
            u.username, up.original_name
     FROM manipulation_history h
     JOIN manipulation_jobs j ON j.id = h.job_id AND j.user_id = h.user_id
     JOIN users u ON u.id = h.user_id
     JOIN uploads up ON up.id = j.upload_id AND up.user_id = j.user_id
     WHERE h.user_id = ? AND j.upload_id = ?
     ORDER BY h.id DESC
     LIMIT ? OFFSET ?`,
    [userId, uploadId, pageSize, offset]
  );
  return { history: rows, total, page: actualPage, pageCount };
}

async function hasUndoableHistory(userId, uploadId) {
  const [rows] = await pool.execute(
    `SELECT EXISTS(
       SELECT 1 FROM manipulation_history h
       JOIN manipulation_jobs j ON j.id = h.job_id AND j.user_id = h.user_id
       WHERE h.user_id = ? AND j.upload_id = ? AND h.status = 'applied'
     ) AS can_undo`,
    [userId, uploadId]
  );
  return Boolean(rows[0].can_undo);
}

async function listHistoryChanges(userId, historyId, limit = 50) {
  const [rows] = await pool.execute(
    `SELECT c.cell_reference, c.excel_row_number AS row_number, c.column_index,
            CAST(c.original_value AS CHAR) AS original_value_json,
            CAST(c.modified_value AS CHAR) AS modified_value_json
     FROM manipulation_cell_changes c
     JOIN manipulation_history h ON h.id = c.history_id
     WHERE h.user_id = ? AND h.id = ?
     ORDER BY c.excel_row_number, c.column_index
     LIMIT ?`,
    [userId, historyId, limit]
  );
  return rows;
}

async function getHistoryForUser(userId, uploadId, historyId) {
  const [rows] = await pool.execute(
    `SELECT h.id, h.job_id, h.user_id, h.worksheet_index, h.operation,
            h.parameters_json, h.change_count, h.revision_before, h.revision_after,
            h.status, h.undo_of_history_id, h.created_at, u.username, up.original_name
     FROM manipulation_history h
     JOIN manipulation_jobs j ON j.id = h.job_id AND j.user_id = h.user_id
     JOIN users u ON u.id = h.user_id
     JOIN uploads up ON up.id = j.upload_id AND up.user_id = j.user_id
     WHERE h.user_id = ? AND j.upload_id = ? AND h.id = ?
     LIMIT 1`,
    [userId, uploadId, historyId]
  );
  return rows[0] || null;
}

async function listHistoryChangesPage(userId, historyId, { page = 1, pageSize = 50 } = {}) {
  const [countRows] = await pool.execute(
    `SELECT COUNT(*) AS total
     FROM manipulation_cell_changes c
     JOIN manipulation_history h ON h.id = c.history_id
     WHERE h.user_id = ? AND h.id = ?`,
    [userId, historyId]
  );
  const total = Number(countRows[0].total);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const actualPage = Math.min(page, pageCount);
  const offset = (actualPage - 1) * pageSize;
  const [rows] = await pool.execute(
    `SELECT c.cell_reference, c.excel_row_number AS row_number, c.column_index,
            CAST(c.original_value AS CHAR) AS original_value_json,
            CAST(c.modified_value AS CHAR) AS modified_value_json
     FROM manipulation_cell_changes c
     JOIN manipulation_history h ON h.id = c.history_id
     WHERE h.user_id = ? AND h.id = ?
     ORDER BY c.excel_row_number, c.column_index
     LIMIT ? OFFSET ?`,
    [userId, historyId, pageSize, offset]
  );
  return { changes: rows, total, page: actualPage };
}

async function getLatestAppliedHistory(connection, userId, jobId) {
  const [rows] = await connection.execute(
    `SELECT id, worksheet_index, operation, parameters_json, change_count,
            revision_before, revision_after
     FROM manipulation_history
     WHERE user_id = ? AND job_id = ? AND status = 'applied'
     ORDER BY id DESC
     LIMIT 1 FOR UPDATE`,
    [userId, jobId]
  );
  return rows[0] || null;
}

async function getHistoryChangesForUpdate(connection, historyId) {
  const [rows] = await connection.execute(
    `SELECT cell_reference, excel_row_number AS row_number, column_index,
            CAST(original_value AS CHAR) AS original_value_json,
            CAST(modified_value AS CHAR) AS modified_value_json
     FROM manipulation_cell_changes
     WHERE history_id = ?
     ORDER BY excel_row_number, column_index
     FOR UPDATE`,
    [historyId]
  );
  return rows;
}

async function markHistoryUndone(connection, historyId) {
  await connection.execute(
    `UPDATE manipulation_history SET status = 'undone'
     WHERE id = ? AND status = 'applied'`,
    [historyId]
  );
}

module.exports = {
  getMissingManipulationTables,
  listSources,
  getJobForUpload,
  lockUpload,
  getJobForUpdate,
  createJob,
  createHistory,
  insertCellChanges,
  updateJobRevision,
  listRecentHistory,
  listHistoryPage,
  hasUndoableHistory,
  listHistoryChanges,
  getHistoryForUser,
  listHistoryChangesPage,
  getLatestAppliedHistory,
  getHistoryChangesForUpdate,
  markHistoryUndone
};
