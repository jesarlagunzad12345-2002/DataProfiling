const crypto = require('node:crypto');
const path = require('node:path');
const multer = require('multer');
const storagePaths = require('../config/storagePaths');

const configuredSize = Number(process.env.UPLOAD_MAX_SIZE_MB || 10);
const maxSizeMb = Number.isFinite(configuredSize)
  ? Math.min(Math.max(configuredSize, 1), 50)
  : 10;
const allowedExtensions = new Set(['.xlsx', '.xls']);
const allowedMimeTypes = new Map([
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.xls', 'application/vnd.ms-excel']
]);
const storage = multer.diskStorage({
  destination: storagePaths.uploads,
  filename(req, file, callback) {
    callback(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
  }
});

function isAllowedWorkbookType(file) {
  const extension = path.extname(file.originalname).toLowerCase();
  return allowedExtensions.has(extension) && file.mimetype === allowedMimeTypes.get(extension);
}

const workbookUpload = multer({
  storage,
  limits: {
    fileSize: maxSizeMb * 1024 * 1024,
    files: 1,
    fields: 1,
    fieldSize: 10 * 1024,
    fieldNameSize: 100,
    parts: 2
  },
  fileFilter(req, file, callback) {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!allowedExtensions.has(extension)) {
      const error = new Error('Choose an .xlsx or .xls workbook.');
      error.status = 400;
      return callback(error);
    }
    if (!isAllowedWorkbookType(file)) {
      const error = new Error('The workbook content type does not match its file extension.');
      error.status = 400;
      return callback(error);
    }
    callback(null, true);
  }
});

module.exports = { workbookUpload, maxSizeMb, isAllowedWorkbookType };