const fs = require('node:fs/promises');
const exportModel = require('../models/exportModel');
const uploadModel = require('../models/uploadModel');
const exportService = require('../services/exportService');

function parseId(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function notFound(res) {
  return res.status(404).render('error', {
    title: 'Export not found',
    message: 'This export or workbook is not available in your account.',
    statusCode: 404
  });
}

async function getExports(req, res, next) {
  try {
    const userId = req.session.user.id;
    const uploads = await exportModel.listUploadsForUser(userId);
    const recentExports = await exportModel.listRecentExports(userId, 20);
    const requestedUploadId = req.query.upload ? parseId(req.query.upload) : null;
    if (req.query.upload && !requestedUploadId) return notFound(res);

    let selectedUpload = null;
    let worksheetOptions = [];
    if (requestedUploadId) {
      selectedUpload = await uploadModel.getUploadForUser(userId, requestedUploadId);
      if (!selectedUpload) return notFound(res);
      worksheetOptions = await exportService.buildWorksheetOptions(selectedUpload);
    }

    return res.render('exports', {
      title: 'Excel Export',
      activePage: 'exports',
      uploads,
      selectedUpload,
      selectedUploadId: requestedUploadId,
      worksheetOptions,
      recentExports,
      errorMessage: null
    });
  } catch (error) {
    return next(error);
  }
}

async function postExport(req, res, next) {
  try {
    const result = await exportService.createExportForUser(
      req.session.user.id,
      req.body,
      {
        profilingReady: req.app.locals.profilingSchemaReady !== false,
        reviewReady: req.app.locals.reviewSchemaReady !== false,
        manipulationReady: req.app.locals.manipulationSchemaReady !== false
      }
    );
    req.session.notice = 'Your export is ready. Review the summary before downloading it.';
    return res.redirect(`/exports/${result.id}`);
  } catch (error) {
    if (error instanceof exportService.ExportValidationError) {
      req.session.notice = error.message;
      const uploadId = parseId(req.body.uploadId);
      return res.redirect(uploadId ? `/exports?upload=${uploadId}` : '/exports');
    }
    return next(error);
  }
}

async function getExportDetails(req, res, next) {
  const exportId = parseId(req.params.exportId);
  if (!exportId) return notFound(res);
  try {
    const item = await exportModel.getExportForUser(req.session.user.id, exportId);
    if (!item) return notFound(res);
    return res.render('export-detail', {
      title: 'Export Summary',
      activePage: 'exports',
      exportItem: item,
      isExpired: Boolean(item.file_deleted_at)
        || new Date(item.expires_at).getTime() <= Date.now()
    });
  } catch (error) {
    return next(error);
  }
}

async function getExportDownload(req, res, next) {
  const exportId = parseId(req.params.exportId);
  if (!exportId) return notFound(res);
  try {
    const item = await exportModel.getExportForUser(req.session.user.id, exportId);
    if (!item) return notFound(res);
    if (item.file_deleted_at || new Date(item.expires_at).getTime() <= Date.now()) {
      return res.status(410).render('error', {
        title: 'Export expired',
        message: 'This temporary export has expired. Generate it again to download a fresh copy.',
        statusCode: 410
      });
    }
    const filePath = exportService.getExportFilePath(item.stored_name);
    try {
      await fs.access(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return res.status(410).render('error', {
          title: 'Export is unavailable',
          message: 'The temporary export file is no longer available. Generate it again to download a fresh copy.',
          statusCode: 410
        });
      }
      throw error;
    }
    res.set('Cache-Control', 'private, no-store');
    return res.download(filePath, item.filename, (error) => {
      if (error && !res.headersSent) next(error);
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getExports,
  postExport,
  getExportDetails,
  getExportDownload
};
