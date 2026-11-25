require('dotenv').config();
const fs = require('node:fs/promises');
const { verifyDatabaseConnection } = require('./config/database');
const storagePaths = require('./config/storagePaths');

async function initializeApp() {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < 32 || sessionSecret.startsWith('replace-with-')) {
    throw new Error('Set SESSION_SECRET to a random value of at least 32 characters.');
  }

  await Promise.all([
    fs.mkdir(storagePaths.uploads, { recursive: true }),
    fs.mkdir(storagePaths.exports, { recursive: true }),
    fs.mkdir(storagePaths.workingCopies, { recursive: true })
  ]);
  try {
    await verifyDatabaseConnection();
  } catch (error) {
    if (!process.env.VERCEL) throw error;
    console.error('Database is unavailable; serving the sign-in page in degraded mode.');
    const session = require('express-session');
    const { createApp } = require('./app');
    const app = createApp({
      sessionStore: new session.MemoryStore(),
      databaseUnavailable: true
    });
    app.locals.profilingSchemaReady = false;
    app.locals.manipulationSchemaReady = false;
    app.locals.reviewSchemaReady = false;
    app.locals.exportSchemaReady = false;
    return { app, exportService: null, exportSchemaReady: false };
  }
  const profilingModel = require('./models/profilingModel');
  const manipulationModel = require('./models/manipulationModel');
  const reviewModel = require('./models/reviewModel');
  const exportModel = require('./models/exportModel');
  const exportService = require('./services/exportService');
  const missingProfilingTables = await profilingModel.getMissingProfilingTables();
  const missingManipulationTables = await manipulationModel.getMissingManipulationTables();
  const reviewSchemaIssues = await reviewModel.getReviewSchemaIssues();
  const exportSchemaIssues = await exportModel.getExportSchemaIssues();
  const profilingSchemaReady = missingProfilingTables.length === 0;
  const manipulationSchemaReady = missingManipulationTables.length === 0;
  const reviewSchemaReady = reviewSchemaIssues.length === 0;
  const exportSchemaReady = exportSchemaIssues.length === 0 && reviewSchemaReady;
  if (profilingSchemaReady) {
    await profilingModel.markInterruptedRuns();
  } else {
    console.warn(
      `Profiling is disabled until database/schema.sql is applied. Missing tables: ${missingProfilingTables.join(', ')}`
    );
  }
  if (!manipulationSchemaReady) {
    console.warn(
      `Word Manipulation is disabled until Phase 3 tables are applied. Missing tables: ${missingManipulationTables.join(', ')}`
    );
  }
  if (!reviewSchemaReady) {
    console.warn(
      `Review Changes is disabled until the Phase 4 database schema is applied. Missing tables or updates: ${reviewSchemaIssues.join(', ')}`
    );
  }
  if (!exportSchemaReady) {
    const issues = [...exportSchemaIssues, ...reviewSchemaIssues];
    console.warn(
      `Excel Export is disabled until the Phase 5 database schema is applied. Missing tables or updates: ${issues.join(', ')}`
    );
  } else {
    try {
      await exportService.cleanupExpiredExports();
    } catch (error) {
      console.error('Unable to clean expired exports during startup:', error.code || error.message);
    }
  }

  const { createApp } = require('./app');
  const app = createApp();
  app.locals.profilingSchemaReady = profilingSchemaReady;
  app.locals.manipulationSchemaReady = manipulationSchemaReady;
  app.locals.reviewSchemaReady = reviewSchemaReady;
  app.locals.exportSchemaReady = exportSchemaReady;
  try {
    await app.locals.sessionStoreReady;
  } catch (error) {
    console.error('MySQL session store initialization failed:', error.code || error.message);
    try {
      await app.locals.sessionStore.close();
    } catch (closeError) {
      console.error('Session store cleanup failed:', closeError.code || closeError.message);
    }
    try {
      await require('./config/database').closeDatabase();
    } catch (closeError) {
      console.error('Database pool cleanup failed:', closeError.code || closeError.message);
    }
    throw new Error('Unable to initialize MySQL session storage. Confirm the database and user_sessions table permissions.');
  }

  return { app, exportService, exportSchemaReady };
}

let appInitialization;
function getInitializedApp() {
  if (!appInitialization) {
    appInitialization = initializeApp().catch((error) => {
      appInitialization = null;
      throw error;
    });
  }
  return appInitialization;
}

async function startServer() {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be a valid TCP port.');
  }

  const { app, exportService, exportSchemaReady } = await getInitializedApp();
  const server = app.listen(port, () => {
    console.log(`Data Profiling Platform listening at http://localhost:${port}`);
  });
  server.headersTimeout = 60 * 1000;
  server.requestTimeout = 5 * 60 * 1000;
  server.keepAliveTimeout = 5 * 1000;
  const exportCleanupTimer = exportSchemaReady
    ? setInterval(() => {
      exportService.cleanupExpiredExports().catch((error) => {
        console.error('Automatic export cleanup failed:', error.code || error.message);
      });
    }, 60 * 60 * 1000)
    : null;
  if (exportCleanupTimer) exportCleanupTimer.unref();

  const shutdown = (signal) => {
    console.log(`${signal} received; closing server.`);
    if (exportCleanupTimer) clearInterval(exportCleanupTimer);
    server.close(async (error) => {
      if (error) {
        console.error('HTTP server shutdown failed:', error);
        process.exitCode = 1;
      }
      try {
        const sessionStore = app.locals.sessionStore;
        if (sessionStore && typeof sessionStore.close === 'function') {
          await sessionStore.close();
        }
        await require('./config/database').closeDatabase();
      } catch (closeError) {
        console.error('Database pool shutdown failed:', closeError);
        process.exitCode = 1;
      }
    });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

async function handleRequest(req, res) {
  const { app } = await getInitializedApp();
  return app(req, res);
}

module.exports = handleRequest;

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Application startup failed:', error.message);
    process.exitCode = 1;
  });
}
