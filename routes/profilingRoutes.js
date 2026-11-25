const express = require('express');
const { requireAuthentication } = require('../middleware/auth');
const { createOperationLimiter } = require('../middleware/operationLimiter');
const profilingController = require('../controllers/profilingController');

const router = express.Router();
const profilingLimiter = createOperationLimiter(5);

function requireProfilingSchema(req, res, next) {
  if (req.app.locals.profilingSchemaReady === false) {
    return res.status(503).render('error', {
      title: 'Profiling database setup required',
      message: 'Apply database/schema.sql in MySQL Workbench to enable Data Profiling.',
      statusCode: 503
    });
  }
  next();
}

router.get('/profiling', requireAuthentication, requireProfilingSchema, profilingController.getProfilingPage);
router.post('/profiling', requireAuthentication, profilingLimiter, requireProfilingSchema, profilingController.postProfiling);
router.get('/profiling/:runId', requireAuthentication, requireProfilingSchema, profilingController.getProfileResults);

module.exports = router;
