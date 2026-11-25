const { pool } = require('../config/database');

function escapeLike(value) {
  return value.replace(/[!%_]/g, '!$&');
}

async function createUpload(connection, { userId, originalName, storedName, extension, size, worksheets }) {
  const [uploadResult] = await connection.execute(
    `INSERT INTO uploads (user_id, original_name, stored_name, file_extension, file_size)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, originalName, storedName, extension, size]
  );
  const uploadId = uploadResult.insertId;
  for (const [worksheetIndex, worksheet] of worksheets.entries()) {
    await connection.execute(
      `INSERT INTO worksheets (upload_id, worksheet_index, worksheet_name, row_count, column_count)
       VALUES (?, ?, ?, ?, ?)`,
      [uploadId, worksheetIndex, worksheet.name, worksheet.rowCount, worksheet.columnCount]
    );
  }
  return uploadId;
}

async function listUploadsForUser(userId, { page = 1, pageSize = 10, search = '' } = {}) {
  const offset = (page - 1) * pageSize;
  const like = `%${escapeLike(search)}%`;
  const [uploads] = await pool.execute(
    `SELECT u.id, u.original_name, u.file_extension, u.file_size, u.uploaded_at,
            COUNT(w.id) AS worksheet_count,
            COALESCE(SUM(w.row_count), 0) AS total_rows
     FROM uploads u
     LEFT JOIN worksheets w ON w.upload_id = u.id
     WHERE u.user_id = ? AND u.original_name LIKE ? ESCAPE '!'
     GROUP BY u.id
     ORDER BY u.uploaded_at DESC, u.id DESC
     LIMIT ? OFFSET ?`,
    [userId, like, pageSize, offset]
  );
  const [countRows] = await pool.execute(
    "SELECT COUNT(*) AS total FROM uploads WHERE user_id = ? AND original_name LIKE ? ESCAPE '!'",
    [userId, like]
  );
  return { uploads, total: countRows[0].total };
}

async function getUploadForUser(userId, uploadId) {
  const [uploads] = await pool.execute(
    `SELECT id, user_id, original_name, stored_name, file_extension, file_size, uploaded_at
     FROM uploads WHERE id = ? AND user_id = ? LIMIT 1`,
    [uploadId, userId]
  );
  if (!uploads[0]) return null;
  const [worksheets] = await pool.execute(
    `SELECT worksheet_index, worksheet_name AS name, row_count AS rowCount,
            column_count AS columnCount
     FROM worksheets WHERE upload_id = ? ORDER BY worksheet_index`,
    [uploadId]
  );
  return { ...uploads[0], worksheets };
}

async function getDashboardSummary(userId) {
  const [rows] = await pool.execute(
    `SELECT COUNT(DISTINCT u.id) AS upload_count,
            COALESCE(SUM(w.row_count), 0) AS row_count,
            COALESCE(SUM(w.column_count), 0) AS column_count
     FROM uploads u
     LEFT JOIN worksheets w ON w.upload_id = u.id
     WHERE u.user_id = ?`,
    [userId]
  );
  return rows[0];
}

module.exports = {
  createUpload,
  listUploadsForUser,
  getUploadForUser,
  getDashboardSummary
};