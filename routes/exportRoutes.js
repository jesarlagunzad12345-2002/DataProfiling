const express = require('express');
const { requireAuthentication } = require('../middleware/auth');
const { createOperationLimiter } = require('../middleware/operationLimiter');
const exportController = require('../controllers/exportController');

const router = express.Router();
const exportLimiter = createOperationLimiter(5);

function requireExportSchema(req, res, next) {
  if (req.app.locals.exportSchemaReady === false) {
    return res.status(503).render('error', {
      title: 'Excel Export database setup required',
      message: 'Apply the current database/schema.sql in MySQL Workbench, then restart the app to enable exports.',
      statusCode: 503
    });
  }
  next();
}

router.get('/exports', requireAuthentication, requireExportSchema, exportController.getExports);
router.post('/exports', requireAuthentication, exportLimiter, requireExportSchema, exportController.postExport);
router.get('/exports/:exportId', requireAuthentication, requireExportSchema, exportController.getExportDetails);
router.get('/exports/:exportId/download', requireAuthentication, requireExportSchema, exportController.getExportDownload);

module.exports = router;
