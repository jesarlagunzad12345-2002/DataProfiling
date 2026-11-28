const bcrypt = require('bcryptjs');
const { generateCsrfToken } = require('../middleware/csrf');
const userModel = require('../models/userModel');

const DEFAULT_SESSION_MS = 8 * 60 * 60 * 1000;
const REMEMBER_ME_MS = 30 * 24 * 60 * 60 * 1000;

function renderLogin(req, res, errorMessage = null, statusCode = 200) {
  const body = req.body || {};
  res.status(statusCode).render('login', {
    title: 'Sign in',
    errorMessage,
    loginValue: typeof body.login === 'string' ? body.login.trim().slice(0, 254) : ''
  });
}

function getLoginPage(req, res) {
  if (req.session.user) return res.redirect('/dashboard');
  renderLogin(req, res);
}

async function postLogin(req, res, next) {
  const login = typeof req.body.login === 'string' ? req.body.login.trim().toLowerCase() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  const validLogin = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login)
    || /^[a-z0-9._-]{3,50}$/.test(login);
  if (!validLogin || login.length > 254 || !password || Buffer.byteLength(password, 'utf8') > 72) {
    return renderLogin(req, res, 'Enter a valid email or username and password.', 400);
  }

  try {
    const user = await userModel.findByLogin(login);
    const passwordMatches = user ? await bcrypt.compare(password, user.password_hash) : false;
    if (!user || !user.is_active || !passwordMatches) {
      return renderLogin(req, res, 'The email/username or password is incorrect.', 401);
    }

    const returnTo = req.session.returnTo;
    await new Promise((resolve, reject) => {
      req.session.regenerate((error) => error ? reject(error) : resolve());
    });
    req.session.user = { id: user.id, username: user.username, email: user.email };
    req.session.csrfToken = generateCsrfToken();
    if (req.body.remember === 'on') {
      req.session.cookie.maxAge = REMEMBER_ME_MS;
    } else {
      req.session.cookie.maxAge = DEFAULT_SESSION_MS;
    }
    const target = typeof returnTo === 'string' && returnTo.startsWith('/') && !returnTo.startsWith('//')
      ? returnTo
      : '/dashboard';
    await new Promise((resolve, reject) => {
      req.session.save((error) => error ? reject(error) : resolve());
    });
    res.redirect(target);
  } catch (error) {
    next(error);
  }
}

function getForgotPassword(req, res) {
  res.render('forgot-password', { title: 'Password help' });
}

function postLogout(req, res, next) {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie(process.env.SESSION_COOKIE_NAME || 'data_profile.sid', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production'
    });
    res.redirect('/login');
  });
}

module.exports = { getLoginPage, postLogin, getForgotPassword, postLogout };