const mysql = require('mysql2/promise');
const fs = require('node:fs');
const path = require('node:path');

const databaseTlsEnabled = process.env.DB_SSL === 'true';
function readDatabaseCa() {
  const ca = process.env.DB_SSL_CA;
  if (!ca) return undefined;

  const normalizedCa = ca.replace(/\\n/g, '\n').trim();
  if (normalizedCa.startsWith('-----BEGIN CERTIFICATE-----')) return normalizedCa;

  const base64Certificate = normalizedCa.replace(/\s/g, '');
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(base64Certificate) && base64Certificate.length % 4 === 0) {
    const lines = base64Certificate.match(/.{1,64}/g);
    return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
  }

  return fs.readFileSync(path.resolve(ca), 'utf8');
}

const databaseCa = databaseTlsEnabled ? readDatabaseCa() : undefined;
const databaseTlsOptions = databaseTlsEnabled
  ? {
    rejectUnauthorized: true,
    ...(databaseCa ? { ca: databaseCa } : {})
  }
  : undefined;

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  database: process.env.DB_NAME || 'data_profiling_platform',
  user: process.env.DB_USER || 'data_app',
  password: process.env.DB_PASSWORD || '',
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  queueLimit: 0,
  charset: 'utf8mb4',
  enableKeepAlive: true,
  ...(databaseTlsOptions ? { ssl: databaseTlsOptions } : {})
});

pool.on('error', (error) => {
  console.error('MySQL pool error:', error.code || error.message);
});

async function verifyDatabaseConnection() {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.query('SELECT 1');
    console.log('MySQL connection verified.');
  } catch (error) {
    console.error('Unable to connect to MySQL:', error.code || error.message, JSON.stringify({
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 3306),
      database: process.env.DB_NAME || 'data_profiling_platform',
      tls: databaseTlsEnabled
    }));
    throw new Error('Check DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, and the MySQL server.');
  } finally {
    if (connection) connection.release();
  }
}

async function closeDatabase() {
  await pool.end();
}

module.exports = { pool, verifyDatabaseConnection, closeDatabase };