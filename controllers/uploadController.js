const fs = require('node:fs/promises');
const path = require('node:path');
const { pool } = require('../config/database');
const uploadModel = require('../models/uploadModel');
const { getWorkbookSummary, getWorksheetPreview, WorkbookValidationError } = require('../services/excelService');
const storagePaths = require('../config/storagePaths');

const uploadsDirectory = storagePaths.uploads;
const PAGE_SIZE = 10;

function setNotice(req, message) {
  req.session.notice = message;
}

async function getUploads(req, res, options = {}) {
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
  const parsedPage = Number(req.query.page);
  const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const result = await uploadModel.listUploadsForUser(req.session.user.id, {
    page,
    pageSize: PAGE_SIZE,
    search
  });
  const pageCount = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  res.render('uploads', {
    title: 'Excel Upload',
    activePage: 'uploads',
    uploads: result.uploads,
    page: Math.min(page, pageCount),
    pageCount,
    search,
    errorMessage: options.errorMessage || null,
    successMessage: options.successMessage || null
  });
}

async function postUpload(req, res, next) {
  if (!req.file) {
    return getUploads(req, res, { errorMessage: 'Choose a workbook to upload.' });
  }

  let connection;
  try {
    const extension = path.extname(req.file.originalname).toLowerCase();
    const worksheets = await getWorkbookSummary(req.file.path);
    const originalName = path.basename(req.file.originalname.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255);
    connection = await pool.getConnection();
    await connection.beginTransaction();
    await uploadModel.createUpload(connection, {
      userId: req.session.user.id,
      originalName: originalName || `workbook${extension}`,
      storedName: req.file.filename,
      extension: extension.slice(1),
      size: req.file.size,
      worksheets
    });
    await connection.commit();
    setNotice(req, `${originalName || 'Workbook'} was uploaded and is ready to preview.`);
    res.redirect('/uploads');
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Upload transaction rollback failed:', rollbackError.code || rollbackError.message);
      }
    }
    try {
      await fs.unlink(req.file.path);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') console.error('Failed to remove rejected upload:', cleanupError.message);
    }
    if (error instanceof WorkbookValidationError) {
      return getUploads(req, res, { errorMessage: error.message });
    }
    next(error);
  } finally {
    if (connection) connection.release();
  }
}

async function getUploadPreview(req, res, next) {
  const uploadId = Number(req.params.uploadId);
  const worksheetIndex = Number(req.params.worksheetIndex);
  if (!Number.isSafeInteger(uploadId) || uploadId < 1 || !Number.isInteger(worksheetIndex) || worksheetIndex < 0) {
    return res.status(404).render('error', {
      title: 'Workbook not found',
      message: 'This workbook or worksheet is not available in your account.',
      statusCode: 404
    });
  }

  try {
    const upload = await uploadModel.getUploadForUser(req.session.user.id, uploadId);
    if (!upload) {
      return res.status(404).render('error', {
        title: 'Workbook not found',
        message: 'This workbook or worksheet is not available in your account.',
        statusCode: 404
      });
    }
    const worksheet = upload.worksheets.find((item) => item.worksheet_index === worksheetIndex);
    if (!worksheet) {
      return res.status(404).render('error', {
        title: 'Worksheet not found',
        message: 'This worksheet is not available in your account.',
        statusCode: 404
      });
    }

    const filePath = path.resolve(uploadsDirectory, upload.stored_name);
    if (!filePath.startsWith(`${uploadsDirectory}${path.sep}`)) {
      throw new Error('Stored upload path is invalid.');
    }
    const preview = await getWorksheetPreview(filePath, worksheetIndex);
    res.render('upload-preview', {
      title: upload.original_name,
      activePage: 'uploads',
      upload,
      worksheet,
      preview
    });
  } catch (error) {
    next(error);
  }
}

module.exports = { getUploads, postUpload, getUploadPreview };