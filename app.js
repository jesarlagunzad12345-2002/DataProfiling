const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const createSessionStore = require('./config/session');
const authRoutes = require('./routes/authRoutes');
const pageRoutes = require('./routes/pageRoutes');
const uploadRoutes = require('./routes/uploadRoutes');
const profilingRoutes = require('./routes/profilingRoutes');
const wordManipulationRoutes = require('./routes/wordManipulationRoutes');
const reviewRoutes = require('./routes/reviewRoutes');
const exportRoutes = require('./routes/exportRoutes');
const reportsRoutes = require('./routes/reportsRoutes');
const { csrfProtection } = require('./middleware/csrf');

function createApp(options = {}) {
  const app = express();
  const secret = process.env.SESSION_SECRET;

  if (!secret || secret.length < 32 || secret.startsWith('replace-with-')) {
    throw new Error('SESSION_SECRET must be set to a random value of at least 32 characters.');
  }
  const sessionStore = options.sessionStore || createSessionStore();
  app.locals.sessionStore = sessionStore;
  app.locals.sessionStoreReady = typeof sessionStore.onReady === 'function'
    ? sessionStore.onReady()
    : Promise.resolve();

  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'"],
        fontSrc: ["'self'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"]
      }
    }
  }));
  app.use(express.urlencoded({ extended: false, limit: '1mb', parameterLimit: 100 }));
  app.use(express.json({ limit: '20kb' }));
  app.use(express.static(path.join(__dirname, 'public'), {
    index: false,
    maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0
  }));
  app.use('/vendor/chart.js', express.static(path.join(__dirname, 'node_modules', 'chart.js', 'dist'), {
    maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0
  }));
  app.use(session({
    name: process.env.SESSION_COOKIE_NAME || 'data_profile.sid',
    secret,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 8 * 60 * 60 * 1000
    }
  }));
  app.use(csrfProtection);
  app.use((req, res, next) => {
    res.locals.currentUser = req.session.user || null;
    res.locals.csrfToken = req.session.csrfToken;
    res.locals.notice = req.session.notice || null;
    delete req.session.notice;
    next();
  });

  app.use(authRoutes);
  app.use(pageRoutes);
  app.use(uploadRoutes);
  app.use(profilingRoutes);
  app.use(wordManipulationRoutes);
  app.use(reviewRoutes);
  app.use(exportRoutes);
  app.use(reportsRoutes);

  app.use((req, res) => {
    res.status(404).render('error', {
      title: 'Page not found',
      message: 'We could not find the page you requested.',
      statusCode: 404
    });
  });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.locals.currentUser = req.session && req.session.user ? req.session.user : null;
    res.locals.csrfToken = req.session && req.session.csrfToken ? req.session.csrfToken : '';
    if (error.code === 'EBADCSRFTOKEN') {
      return res.status(403).render('error', {
        title: 'Session expired',
        message: 'Your form session expired. Please reload the page and try again.',
        statusCode: 403
      });
    }
    const statusCode = Number.isInteger(error.status) && error.status >= 400 && error.status < 500
      ? error.status
      : 500;
    console.error(JSON.stringify({
      event: 'http_request_failed',
      method: req.method,
      path: req.path,
      statusCode,
      errorCode: error.code || null,
      errorType: error.name || 'Error'
    }));
    res.status(statusCode).render('error', {
      title: statusCode === 500 ? 'Something went wrong' : 'Request could not be completed',
      message: statusCode === 500
        ? 'The request could not be completed. Please try again later.'
        : error.message,
      statusCode
    });
  });

  return app;
}

module.exports = { createApp };