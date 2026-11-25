const uploadModel = require('../models/uploadModel');
const reviewModel = require('../models/reviewModel');
const reviewService = require('../services/reviewService');
const wordService = require('../services/wordManipulationService');

const PAGE_SIZE = 25;

function parsePage(value) {
  const page = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : 1;
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

function parseUploadId(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function displayJson(value) {
  if (value === null || value === undefined) return '—';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function parseStoredJson(value) {
  return reviewService.parseJson(value);
}

function notFound(res) {
  return res.status(404).render('error', {
    title: 'Review item not found',
    message: 'This workbook or review item is not available in your account.',
    statusCode: 404
  });
}

async function getDashboard(req, res, next) {
  try {
    const userId = req.session.user.id;
    const uploadRows = await reviewModel.listUploads(userId);
    const uploadsById = new Map();
    for (const row of uploadRows) {
      const uploadId = Number(row.upload_id);
      if (!uploadsById.has(uploadId)) {
        uploadsById.set(uploadId, {
          id: uploadId,
          originalName: row.original_name,
          uploadedAt: row.uploaded_at
        });
      }
    }
    const uploads = [...uploadsById.values()];
    const requestedUploadId = req.query.upload ? parseUploadId(req.query.upload) : null;
    if (req.query.upload && (!requestedUploadId || !uploadsById.has(requestedUploadId))) {
      return notFound(res);
    }
    const uploadId = requestedUploadId;
    const status = reviewModel.REVIEW_STATUSES.has(req.query.status) ? req.query.status : '';
    const sourceType = req.query.source === 'profiling' || req.query.source === 'word-manipulation'
      ? req.query.source
      : '';
    const search = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 120) : '';
    const page = parsePage(req.query.page);
    const [summary, result, audit] = await Promise.all([
      reviewModel.getSummary(userId, uploadId),
      reviewModel.listChanges(userId, {
        uploadId,
        status,
        sourceType,
        search,
        page,
        pageSize: PAGE_SIZE
      }),
      reviewModel.listRecentAudit(userId, uploadId)
    ]);

    const changes = result.changes.map((change) => {
      const originalValue = parseStoredJson(change.original_value_json);
      const proposedValue = parseStoredJson(change.proposed_value_json);
      const details = parseStoredJson(change.details_json);
      const scalarProposal = typeof proposedValue === 'string' || typeof proposedValue === 'number';
      return {
        ...change,
        originalValue,
        proposedValue,
        details,
        displayOriginal: displayJson(originalValue),
        displayProposed: displayJson(proposedValue),
        displayDetails: details === null ? '' : JSON.stringify(details),
        inputValue: scalarProposal ? String(proposedValue) : '',
        sourceLabel: change.source_type === 'word-manipulation'
          ? wordService.getOperationLabel(change.operation) || change.operation || 'Word Manipulation'
          : 'Data Profiling'
      };
    });
    const auditRows = audit.map((entry) => ({
      ...entry,
      displayOriginal: displayJson(parseStoredJson(entry.original_value_json)),
      displayPrevious: displayJson(parseStoredJson(entry.previous_proposed_value_json)),
      displayProposed: displayJson(parseStoredJson(entry.proposed_value_json))
    }));

    return res.render('review', {
      title: 'Review Changes',
      activePage: 'review',
      uploads,
      selectedUploadId: uploadId,
      summary,
      changes,
      audit: auditRows,
      status,
      sourceType,
      search,
      page: result.page,
      pageCount: result.pageCount,
      total: result.total
    });
  } catch (error) {
    return next(error);
  }
}

async function postSync(req, res, next) {
  try {
    const uploadId = Number(req.params.uploadId);
    if (!Number.isSafeInteger(uploadId) || uploadId < 1) return notFound(res);
    const upload = await uploadModel.getUploadForUser(req.session.user.id, uploadId);
    if (!upload) return notFound(res);
    await reviewService.syncUpload(req.session.user.id, upload);
    req.session.notice = 'Profiling findings and earlier confirmed Word Manipulation changes have been synchronized with review.';
    return res.redirect(`/review?upload=${uploadId}`);
  } catch (error) {
    return next(error);
  }
}

async function postEdit(req, res, next) {
  try {
    const changeId = Number(req.params.changeId);
    if (!Number.isSafeInteger(changeId) || changeId < 1) return notFound(res);
    const result = await reviewService.editProposedValue(
      req.session.user.id,
      changeId,
      req.body.proposedValue
    );
    req.session.notice = 'The proposed value was saved. It remains pending until approved.';
    return res.redirect(`/review?upload=${result.uploadId}`);
  } catch (error) {
    if (error instanceof reviewService.ReviewValidationError) {
      req.session.notice = error.message;
      return res.redirect('/review');
    }
    return next(error);
  }
}

async function decide(req, res, next, action) {
  try {
    const changeId = Number(req.params.changeId);
    if (!Number.isSafeInteger(changeId) || changeId < 1) return notFound(res);
    const result = await reviewService.decideChanges(
      req.session.user.id,
      [String(changeId)],
      action
    );
    req.session.notice = `${result.affectedCount} change${result.affectedCount === 1 ? '' : 's'} ${action === 'approve' ? 'approved and applied to the working copy' : 'rejected'}.`;
    return res.redirect(`/review?upload=${result.uploadId}`);
  } catch (error) {
    if (error instanceof reviewService.ReviewValidationError) {
      req.session.notice = error.message;
      return res.redirect('/review');
    }
    return next(error);
  }
}

async function postBulk(req, res, next) {
  try {
    const action = req.body.action;
    const result = await reviewService.decideChanges(
      req.session.user.id,
      req.body.ids,
      action
    );
    req.session.notice = `${result.affectedCount} selected change${result.affectedCount === 1 ? '' : 's'} ${action === 'approve' ? 'approved and applied to the working copy' : 'rejected'}.`;
    return res.redirect(`/review?upload=${result.uploadId}`);
  } catch (error) {
    if (error instanceof reviewService.ReviewValidationError) {
      req.session.notice = error.message;
      return res.redirect('/review');
    }
    return next(error);
  }
}

module.exports = {
  getDashboard,
  postSync,
  postEdit,
  postApprove: (req, res, next) => {
    return decide(req, res, next, 'approve');
  },
  postReject: (req, res, next) => {
    return decide(req, res, next, 'reject');
  },
  postBulk
};
