const assert = require('node:assert/strict');
const test = require('node:test');
const { requireAuthentication } = require('../middleware/auth');
const { csrfProtection, verifyCsrfToken } = require('../middleware/csrf');

test('requires authentication and preserves a safe requested path', () => {
  const req = { session: {}, method: 'GET', originalUrl: '/uploads?page=2' };
  let redirectPath;
  requireAuthentication(req, { redirect(path) { redirectPath = path; } }, () => {
    assert.fail('Unauthenticated request must not continue.');
  });
  assert.equal(redirectPath, '/login');
  assert.equal(req.session.returnTo, '/uploads?page=2');
});

test('rejects protocol-relative return paths', () => {
  const req = { session: {}, method: 'GET', originalUrl: '//outside.example/path' };
  let redirectPath;
  requireAuthentication(req, { redirect(path) { redirectPath = path; } }, () => {});
  assert.equal(redirectPath, '/login');
  assert.equal(req.session.returnTo, undefined);
});

test('creates a CSRF token for a session and verifies state-changing forms', () => {
  const session = {};
  csrfProtection({ session, method: 'GET', body: {} }, {}, (error) => {
    assert.ifError(error);
  });
  assert.match(session.csrfToken, /^[a-f0-9]{64}$/);

  let nextCalled = false;
  verifyCsrfToken({ session, body: { _csrf: session.csrfToken } }, {}, (error) => {
    assert.ifError(error);
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});

test('rejects missing CSRF tokens and defers multipart forms until parsed', () => {
  const session = { csrfToken: 'a'.repeat(64) };
  let csrfError;
  verifyCsrfToken({ session, body: {} }, {}, (error) => { csrfError = error; });
  assert.equal(csrfError.code, 'EBADCSRFTOKEN');

  let nextCalled = false;
  csrfProtection({
    session,
    method: 'POST',
    body: {},
    is(type) { return type === 'multipart/form-data'; }
  }, {}, (error) => {
    assert.ifError(error);
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});