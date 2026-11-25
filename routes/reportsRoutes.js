const express = require('express');
const { requireAuthentication } = require('../middleware/auth');
const { createOperationLimiter } = require('../middleware/operationLimiter');
const reportsController = require('../controllers/reportsController');

const router = express.Router();
const reportExportLimiter = createOperationLimiter(10);

router.get('/reports/export.csv', requireAuthentication, reportExportLimiter, reportsController.getReportCsv);
router.get('/reports', requireAuthentication, reportsController.getReports);

module.exports = router;
