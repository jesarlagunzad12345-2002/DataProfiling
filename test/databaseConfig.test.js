const assert = require('node:assert/strict');
const test = require('node:test');

test('accepts a PEM certificate from the DB_SSL_CA environment variable', async () => {
  const previousSsl = process.env.DB_SSL;
  const previousCa = process.env.DB_SSL_CA;
  const certificate = '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----';

  process.env.DB_SSL = 'true';
  process.env.DB_SSL_CA = String.raw`-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----`;

  const databaseModulePath = require.resolve('../config/database');
  delete require.cache[databaseModulePath];
  const { pool, closeDatabase } = require('../config/database');

  try {
    assert.equal(pool.pool.config.connectionConfig.ssl.rejectUnauthorized, true);
    assert.equal(pool.pool.config.connectionConfig.ssl.ca, certificate);
  } finally {
    await closeDatabase();
    delete require.cache[databaseModulePath];
    if (previousSsl === undefined) delete process.env.DB_SSL;
    else process.env.DB_SSL = previousSsl;
    if (previousCa === undefined) delete process.env.DB_SSL_CA;
    else process.env.DB_SSL_CA = previousCa;
  }
});
