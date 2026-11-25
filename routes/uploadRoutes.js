const express = require('express');
const { requireAuthentication } = require('../middleware/auth');
const { workbookUpload, maxSizeMb } = require('../middleware/upload');
const { verifyCsrfToken } = require('../middleware/csrf');
const { createOperationLimiter } = require('../middleware/operationLimiter');
const uploadController = require('../controllers/uploadController');

const router = express.Router();
const uploadLimiter = createOperationLimiter(10, 60 * 60 * 1000);

router.get('/uploads', requireAuthentication, uploadController.getUploads);
router.post(
  '/uploads',
  requireAuthentication,
  uploadLimiter,
  (req, res, next) => workbookUpload.single('workbook')(req, res, (error) => {
    if (!error) return next();
    if (error.name === 'MulterError') {
      return uploadController.getUploads(req, res, {
        errorMessage: error.code === 'LIMIT_FILE_SIZE'
          ? `The workbook exceeds the configured ${maxSizeMb} MB upload limit.`
          : 'Upload one .xlsx or .xls workbook and try again.'
      }).catch(next);
    }
    if (error.status === 400) {
      return uploadController.getUploads(req, res, { errorMessage: error.message }).catch(next);
    }
    next(error);
  }),
  verifyCsrfToken,
  uploadController.postUpload
);
router.get('/uploads/:uploadId/worksheets/:worksheetIndex', requireAuthentication, uploadController.getUploadPreview);

module.exports = router;