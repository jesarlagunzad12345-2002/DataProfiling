const assert = require('node:assert/strict');
const http = require('node:http');
const session = require('express-session');
const test = require('node:test');

process.env.SESSION_SECRET = 'test-secret-with-more-than-thirty-two-characters';
process.env.NODE_ENV = 'production';
process.env.VERCEL = '1';
delete process.env.TRUST_PROXY;

const { createApp } = require('../app');
const app = createApp({ sessionStore: new session.MemoryStore() });
const server = http.createServer(app);

test('sets a secure session cookie behind Vercel without TRUST_PROXY configuration', async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/login`, {
      headers: { 'x-forwarded-proto': 'https' }
    });
    const cookie = response.headers.get('set-cookie');
    const html = await response.text();
    const csrfToken = html.match(/name="_csrf" value="([^"]+)"/)[1];

    assert.equal(response.status, 200);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /HttpOnly/);

    const logoutResponse = await fetch(`http://127.0.0.1:${server.address().port}/logout`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie: cookie.split(';', 1)[0],
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ _csrf: csrfToken })
    });
    assert.equal(logoutResponse.status, 302);
    assert.equal(logoutResponse.headers.get('location'), '/login');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
