const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const test = require('node:test');
const authController = require('../controllers/authController');
const userModel = require('../models/userModel');

test('rotates and saves a CSRF token with the regenerated authenticated session', async () => {
  const originalFindByLogin = userModel.findByLogin;
  const password = 'correct-horse-battery';
  const passwordHash = await bcrypt.hash(password, 4);
  userModel.findByLogin = async () => ({
    id: 7,
    username: 'test-user',
    email: 'test@example.com',
    password_hash: passwordHash,
    is_active: 1
  });

  const req = {
    body: { login: 'test@example.com', password },
    session: {
      csrfToken: 'pre-authentication-token',
      cookie: {}
    }
  };
  req.session.regenerate = (callback) => {
    req.session = {
      cookie: {},
      save: (saveCallback) => saveCallback()
    };
    callback();
  };

  let redirectPath;
  let nextError;
  const res = { redirect: (path) => { redirectPath = path; } };

  try {
    await authController.postLogin(req, res, (error) => { nextError = error; });

    assert.equal(nextError, undefined);
    assert.equal(redirectPath, '/dashboard');
    assert.equal(req.session.user.id, 7);
    assert.match(req.session.csrfToken, /^[a-f0-9]{64}$/);
    assert.notEqual(req.session.csrfToken, 'pre-authentication-token');
  } finally {
    userModel.findByLogin = originalFindByLogin;
  }
});
