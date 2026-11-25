const { pool } = require('../config/database');

async function findByLogin(login) {
  const [rows] = await pool.execute(
    `SELECT id, username, email, password_hash, is_active
     FROM users
     WHERE email = ? OR username = ?
     LIMIT 1`,
    [login, login]
  );
  return rows[0] || null;
}

async function createUser({ username, email, passwordHash }) {
  const [result] = await pool.execute(
    'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
    [username, email, passwordHash]
  );
  return result.insertId;
}

async function updatePassword(userId, passwordHash) {
  const [result] = await pool.execute(
    'UPDATE users SET password_hash = ? WHERE id = ?',
    [passwordHash, userId]
  );
  return result.affectedRows;
}

async function findByUsernameOrEmail(value) {
  const [rows] = await pool.execute(
    'SELECT id, username, email FROM users WHERE email = ? OR username = ? LIMIT 1',
    [value, value]
  );
  return rows[0] || null;
}

module.exports = { findByLogin, createUser, updatePassword, findByUsernameOrEmail };