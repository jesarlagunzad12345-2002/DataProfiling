const { pool } = require('../config/database');

const DUPLICATE_KEYS = [
  { type: 'exact', hashColumn: 'exact_duplicate_hash', flagColumn: 'duplicate_exact' },
  { type: 'phone', hashColumn: 'phone_duplicate_hash', flagColumn: 'duplicate_phone' },
  { type: 'email', hashColumn: 'email_duplicate_hash', flagColumn: 'duplicate_email' }
];
const PROFILING_TABLES = [
  'profiling_runs',
  'profiling_columns',
  'profiling_records',
  'profiling_duplicate_groups',
  'profiling_duplicate_members'
];

async function getMissingProfilingTables() {
  const placeholders = PROFILING_TABLES.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT TABLE_NAME AS table_name FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name IN (${placeholders})`,
    PROFILING_TABLES
  );
  const existing = new Set(rows.map((row) => String(row.table_name).toLowerCase()));
  return PROFILING_TABLES.filter((tableName) => !existing.has(tableName));
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

async function listRecentRuns(userId, limit = 10) {
  const [rows] = await pool.execute(
    `SELECT r.id, r.status, r.overall_completeness, r.total_records, r.created_at,
            u.original_name, w.worksheet_name
     FROM profiling_runs r
     JOIN uploads u ON u.id = r.upload_id AND u.user_id = r.user_id
     JOIN worksheets w ON w.upload_id = r.upload_id AND w.worksheet_index = r.worksheet_index
     WHERE r.user_id = ?
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT ?`,
    [userId, limit]
  );
  return rows;
}

async function createRun({ userId, uploadId, worksheetIndex, options }) {
  const [result] = await pool.execute(
    `INSERT INTO profiling_runs (user_id, upload_id, worksheet_index, options_json)
     VALUES (?, ?, ?, ?)`,
    [userId, uploadId, worksheetIndex, JSON.stringify(options)]
  );
  return result.insertId;
}

async function getRunForUser(userId, runId) {
  const [rows] = await pool.execute(
    `SELECT r.*, u.original_name, w.worksheet_name
     FROM profiling_runs r
     JOIN uploads u ON u.id = r.upload_id AND u.user_id = r.user_id
     JOIN worksheets w ON w.upload_id = r.upload_id AND w.worksheet_index = r.worksheet_index
     WHERE r.id = ? AND r.user_id = ?
     LIMIT 1`,
    [runId, userId]
  );
  return rows[0] || null;
}

async function markRunProcessing(runId) {
  await pool.execute(
    `UPDATE profiling_runs
     SET status = 'processing', started_at = CURRENT_TIMESTAMP, error_message = NULL
     WHERE id = ? AND status = 'queued'`,
    [runId]
  );
}

async function insertRecords(connection, runId, records) {
  if (!records.length) return;
  const valuesPerRecord = 13;
  const placeholders = records.map(() => `(${new Array(valuesPerRecord).fill('?').join(',')})`).join(',');
  const values = records.flatMap((record) => [
    runId,
    record.excelRowNumber,
    JSON.stringify(record.originalValues),
    JSON.stringify(record.suggestions),
    JSON.stringify(record.issues),
    record.missingCount,
    record.invalidPhone,
    record.suspiciousPhone,
    record.addressIssue,
    record.countryInconsistent,
    record.exactDuplicateHash,
    record.phoneDuplicateHash,
    record.emailDuplicateHash
  ]);
  await connection.execute(
    `INSERT INTO profiling_records
       (run_id, excel_row_number, original_values, suggestions, issues, missing_count,
        invalid_phone, suspicious_phone, address_issue, country_inconsistent,
        exact_duplicate_hash, phone_duplicate_hash, email_duplicate_hash)
     VALUES ${placeholders}`,
    values
  );
}

async function updateProcessedCount(connection, runId, processedRecords) {
  await connection.execute(
    'UPDATE profiling_runs SET processed_records = ? WHERE id = ?',
    [processedRecords, runId]
  );
}

async function saveColumnSummaries(connection, runId, columns, totalRecords) {
  if (!columns.length) return;
  const batchSize = 500;
  for (let offset = 0; offset < columns.length; offset += batchSize) {
    const batch = columns.slice(offset, offset + batchSize);
    const values = batch.flatMap((column, batchIndex) => {
      const columnIndex = offset + batchIndex;
      const valueCount = totalRecords - column.missingCount;
      const percent = totalRecords
        ? Math.round((valueCount / totalRecords) * 10000) / 100
        : 0;
      return [runId, columnIndex, column.name, column.missingCount, valueCount, percent];
    });
    const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?)').join(',');
    await connection.execute(
      `INSERT INTO profiling_columns
         (run_id, column_index, column_name, missing_count, value_count, completeness_percent)
       VALUES ${placeholders}`,
      values
    );
  }
}

async function buildDuplicateGroups(connection, runId) {
  for (const duplicate of DUPLICATE_KEYS) {
    await connection.execute(
      `INSERT INTO profiling_duplicate_groups (run_id, duplicate_type, fingerprint, member_count)
       SELECT ?, ?, ${duplicate.hashColumn}, COUNT(*)
       FROM profiling_records
       WHERE run_id = ? AND ${duplicate.hashColumn} IS NOT NULL
       GROUP BY ${duplicate.hashColumn}
       HAVING COUNT(*) > 1`,
      [runId, duplicate.type, runId]
    );
    await connection.execute(
      `INSERT INTO profiling_duplicate_members (group_id, record_id)
       SELECT g.id, r.id
       FROM profiling_duplicate_groups g
       JOIN profiling_records r
         ON r.run_id = g.run_id AND r.${duplicate.hashColumn} = g.fingerprint
       WHERE g.run_id = ? AND g.duplicate_type = ?`,
      [runId, duplicate.type]
    );
    await connection.execute(
      `UPDATE profiling_records r
       JOIN profiling_duplicate_members m ON m.record_id = r.id
       JOIN profiling_duplicate_groups g ON g.id = m.group_id
       SET r.${duplicate.flagColumn} = TRUE
       WHERE r.run_id = ? AND g.duplicate_type = ?`,
      [runId, duplicate.type]
    );
  }
}

async function completeRun({ runId, columns, totalRecords }) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await saveColumnSummaries(connection, runId, columns, totalRecords);
    await buildDuplicateGroups(connection, runId);
    const [rows] = await connection.execute(
      `SELECT COUNT(*) AS total_records,
              COALESCE(SUM(missing_count = 0), 0) AS complete_records,
              COALESCE(SUM(missing_count > 0), 0) AS incomplete_records,
              COALESCE(SUM(missing_count), 0) AS missing_values,
              COALESCE(SUM(invalid_phone), 0) AS invalid_phone_count,
              COALESCE(SUM(suspicious_phone), 0) AS suspicious_phone_count,
              COALESCE(SUM(duplicate_exact OR duplicate_phone OR duplicate_email), 0) AS duplicate_record_count,
              COALESCE(SUM(address_issue), 0) AS address_issue_count,
              COALESCE(SUM(country_inconsistent), 0) AS country_inconsistency_count
       FROM profiling_records WHERE run_id = ?`,
      [runId]
    );
    const stats = rows[0];
    const totalCells = Number(stats.total_records) * columns.length;
    const overallCompleteness = totalCells
      ? Math.round(((totalCells - Number(stats.missing_values)) / totalCells) * 10000) / 100
      : 0;
    await connection.execute(
      `UPDATE profiling_runs
       SET status = 'completed', total_records = ?, complete_records = ?, incomplete_records = ?,
           missing_values = ?, invalid_phone_count = ?, suspicious_phone_count = ?,
           duplicate_record_count = ?, address_issue_count = ?, country_inconsistency_count = ?,
           column_count = ?, overall_completeness = ?, processed_records = ?, finished_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        stats.total_records,
        stats.complete_records,
        stats.incomplete_records,
        stats.missing_values,
        stats.invalid_phone_count,
        stats.suspicious_phone_count,
        stats.duplicate_record_count,
        stats.address_issue_count,
        stats.country_inconsistency_count,
        columns.length,
        overallCompleteness,
        totalRecords,
        runId
      ]
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function failRun(runId, message) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute('DELETE FROM profiling_duplicate_groups WHERE run_id = ?', [runId]);
    await connection.execute('DELETE FROM profiling_columns WHERE run_id = ?', [runId]);
    await connection.execute('DELETE FROM profiling_records WHERE run_id = ?', [runId]);
    await connection.execute(
      `UPDATE profiling_runs
       SET status = 'failed', error_message = ?, finished_at = CURRENT_TIMESTAMP,
           total_records = 0, processed_records = 0
       WHERE id = ?`,
      [message.slice(0, 500), runId]
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function updateRunProgress(runId, processedRecords) {
  await pool.execute(
    `UPDATE profiling_runs SET processed_records = ?
     WHERE id = ? AND status = 'processing'`,
    [processedRecords, runId]
  );
}

async function listColumnSummaries(runId, { page = 1, pageSize = 25 } = {}) {
  const [countRows] = await pool.execute(
    'SELECT COUNT(*) AS total FROM profiling_columns WHERE run_id = ?',
    [runId]
  );
  const [rows] = await pool.execute(
    `SELECT column_index, column_name, missing_count, value_count, completeness_percent
     FROM profiling_columns WHERE run_id = ? ORDER BY column_index LIMIT ? OFFSET ?`,
    [runId, pageSize, (page - 1) * pageSize]
  );
  return { columns: rows, total: countRows[0].total };
}

const issueConditions = {
  incomplete: 'missing_count > 0',
  phone: '(invalid_phone = TRUE OR suspicious_phone = TRUE)',
  duplicates: '(duplicate_exact = TRUE OR duplicate_phone = TRUE OR duplicate_email = TRUE)',
  address: 'address_issue = TRUE',
  country: 'country_inconsistent = TRUE'
};

async function listRecordsPage(runId, { page = 1, pageSize = 25, issue = 'all' } = {}) {
  const condition = issueConditions[issue];
  const where = condition ? `run_id = ? AND ${condition}` : 'run_id = ?';
  const [countRows] = await pool.execute(
    `SELECT COUNT(*) AS total FROM profiling_records WHERE ${where}`,
    [runId]
  );
  const [records] = await pool.execute(
    `SELECT id, excel_row_number, original_values, suggestions, issues, missing_count,
            invalid_phone, suspicious_phone, address_issue, country_inconsistent,
            duplicate_exact, duplicate_phone, duplicate_email
     FROM profiling_records WHERE ${where}
     ORDER BY excel_row_number LIMIT ? OFFSET ?`,
    [runId, pageSize, (page - 1) * pageSize]
  );
  return { records, total: countRows[0].total };
}

async function getDuplicateDetails(recordIds) {
  if (!recordIds.length) return {};
  const placeholders = recordIds.map(() => '?').join(',');
  const [memberships] = await pool.execute(
    `SELECT m.record_id, g.id AS group_id, g.duplicate_type, g.member_count
     FROM profiling_duplicate_members m
     JOIN profiling_duplicate_groups g ON g.id = m.group_id
     WHERE m.record_id IN (${placeholders})`,
    recordIds
  );
  if (!memberships.length) return {};
  const groupIds = [...new Set(memberships.map((item) => item.group_id))];
  const groupPlaceholders = groupIds.map(() => '?').join(',');
  const [rowNumbers] = await pool.execute(
    `SELECT group_id, excel_row_number FROM (
       SELECT m.group_id, r.excel_row_number,
              ROW_NUMBER() OVER (PARTITION BY m.group_id ORDER BY r.excel_row_number) AS position
       FROM profiling_duplicate_members m
       JOIN profiling_records r ON r.id = m.record_id
       WHERE m.group_id IN (${groupPlaceholders})
     ) grouped_rows
     WHERE position <= 10
     ORDER BY group_id, excel_row_number`,
    groupIds
  );
  const rowsByGroup = new Map();
  for (const row of rowNumbers) {
    const groupRows = rowsByGroup.get(row.group_id) || [];
    groupRows.push(row.excel_row_number);
    rowsByGroup.set(row.group_id, groupRows);
  }
  const details = {};
  for (const membership of memberships) {
    const groups = details[membership.record_id] || [];
    groups.push({
      type: membership.duplicate_type,
      memberCount: membership.member_count,
      rowNumbers: rowsByGroup.get(membership.group_id) || []
    });
    details[membership.record_id] = groups;
  }
  return details;
}

async function markInterruptedRuns() {
  await pool.execute(
    `UPDATE profiling_runs
     SET status = 'failed', error_message = 'Profiling was interrupted by a server restart. Run it again.',
         finished_at = CURRENT_TIMESTAMP
     WHERE status IN ('queued', 'processing')`
  );
}

module.exports = {
  getMissingProfilingTables,
  listSources,
  listRecentRuns,
  createRun,
  getRunForUser,
  markRunProcessing,
  insertRecords,
  updateProcessedCount,
  updateRunProgress,
  completeRun,
  failRun,
  listColumnSummaries,
  listRecordsPage,
  getDuplicateDetails,
  markInterruptedRuns
};
