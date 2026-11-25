const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const { pool } = require('./database');

module.exports = function createSessionStore() {
  const store = new MySQLStore({
    clearExpired: true,
    checkExpirationInterval: 15 * 60 * 1000,
    expiration: 30 * 24 * 60 * 60 * 1000,
    createDatabaseTable: true,
    schema: {
      tableName: 'user_sessions',
      columnNames: {
        session_id: 'session_id',
        expires: 'expires',
        data: 'data'
      }
    }
  }, pool);

  store.on('error', (error) => {
    console.error('MySQL session store error:', error.code || error.message);
  });
  return store;
};