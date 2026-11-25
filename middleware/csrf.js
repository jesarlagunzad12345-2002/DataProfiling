const crypto = require('node:crypto');

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

function verifyCsrfToken(req, res, next) {
  const submitted = req.body && req.body._csrf;
  const expected = req.session.csrfToken;
  if (typeof submitted !== 'string' || typeof expected !== 'string'
    || submitted.length !== expected.length
    || !crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(expected))) {
    const error = new Error('Invalid CSRF token.');
    error.code = 'EBADCSRFTOKEN';
    return next(error);
  }
  next();
}

function csrfProtection(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }

  if (!safeMethods.has(req.method) && !req.is('multipart/form-data')) {
    return verifyCsrfToken(req, res, next);
  }
  next();
}

module.exports = { csrfProtection, verifyCsrfToken };