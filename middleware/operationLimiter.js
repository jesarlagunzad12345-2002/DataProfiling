const rateLimit = require('express-rate-limit');

function createOperationLimiter(limit, windowMs = 15 * 60 * 1000) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    handler(req, res) {
      res.status(429).render('error', {
        title: 'Request limit reached',
        message: 'Too many requests were made. Please wait a few minutes and try again.',
        statusCode: 429
      });
    }
  });
}

module.exports = { createOperationLimiter };
