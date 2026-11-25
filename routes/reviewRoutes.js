const express = require('express');
const { requireAuthentication } = require('../middleware/auth');
const { createOperationLimiter } = require('../middleware/operationLimiter');
const reviewController = require('../controllers/reviewController');

const router = express.Router();
const reviewMutationLimiter = createOperationLimiter(30);

function requireReviewSchema(req, res, next) {
  if (req.app.locals.reviewSchemaReady === false) {
    return res.status(503).render('error', {
      title: 'Review database setup required',
      message: 'Apply the current database/schema.sql in MySQL Workbench, then restart the app to enable Review Changes.',
      statusCode: 503
    });
  }
  next();
}

router.get('/review', requireAuthentication, requireReviewSchema, reviewController.getDashboard);
router.post('/review/sync/:uploadId', requireAuthentication, reviewMutationLimiter, requireReviewSchema, reviewController.postSync);
router.post('/review/bulk', requireAuthentication, reviewMutationLimiter, requireReviewSchema, reviewController.postBulk);
router.post('/review/:changeId/edit', requireAuthentication, reviewMutationLimiter, requireReviewSchema, reviewController.postEdit);
router.post('/review/:changeId/approve', requireAuthentication, reviewMutationLimiter, requireReviewSchema, reviewController.postApprove);
router.post('/review/:changeId/reject', requireAuthentication, reviewMutationLimiter, requireReviewSchema, reviewController.postReject);

module.exports = router;
