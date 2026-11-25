const express = require('express');
const { requireAuthentication } = require('../middleware/auth');
const { createOperationLimiter } = require('../middleware/operationLimiter');
const wordManipulationController = require('../controllers/wordManipulationController');

const router = express.Router();
const manipulationPreviewLimiter = createOperationLimiter(20);
const manipulationWriteLimiter = createOperationLimiter(10);

function requireManipulationSchema(req, res, next) {
  if (req.app.locals.manipulationSchemaReady === false) {
    return res.status(503).render('error', {
      title: 'Word Manipulation database setup required',
      message: 'Apply the Phase 3 table definitions from database/schema.sql in MySQL Workbench to enable Word Manipulation.',
      statusCode: 503
    });
  }
  next();
}

function requireReviewSchema(req, res, next) {
  if (req.app.locals.reviewSchemaReady === false) {
    return res.status(503).render('error', {
      title: 'Review database setup required',
      message: 'Apply the current database/schema.sql in MySQL Workbench, then restart the app before submitting Word Manipulation changes.',
      statusCode: 503
    });
  }
  next();
}

router.get('/word-manipulation', requireAuthentication, requireManipulationSchema, wordManipulationController.getTool);
router.get(
  '/word-manipulation/worksheet/:uploadId/:worksheetIndex',
  requireAuthentication,
  requireManipulationSchema,
  wordManipulationController.getWorksheetGrid
);
router.post(
  '/word-manipulation/preview',
  requireAuthentication,
  manipulationPreviewLimiter,
  requireManipulationSchema,
  wordManipulationController.postPreview
);
router.post(
  '/word-manipulation/apply',
  requireAuthentication,
  manipulationWriteLimiter,
  requireManipulationSchema,
  requireReviewSchema,
  wordManipulationController.postApply
);
router.get(
  '/word-manipulation/history/:uploadId',
  requireAuthentication,
  requireManipulationSchema,
  wordManipulationController.getHistory
);
router.get(
  '/word-manipulation/history/:uploadId/:historyId',
  requireAuthentication,
  requireManipulationSchema,
  wordManipulationController.getHistoryDetail
);
router.post(
  '/word-manipulation/history/:uploadId/undo',
  requireAuthentication,
  manipulationWriteLimiter,
  requireManipulationSchema,
  wordManipulationController.postUndo
);

module.exports = router;
