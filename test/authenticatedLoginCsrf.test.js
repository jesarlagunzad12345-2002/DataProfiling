const assert = require('node:assert/strict');
const http = require('node:http');
const signature = require('cookie-signature');
const session = require('express-session');
const test = require('node:test');

const sessionSecret = 'test-secret-with-more-than-thirty-two-characters';
process.env.SESSION_SECRET = sessionSecret;
process.env.NODE_ENV = 'test';

const { createApp } = require('../app');
const sessionStore = new session.MemoryStore();
const app = createApp({ sessionStore });
const server = http.createServer(app);

test('redirects an authenticated stale login submission to the dashboard', async () => {
  const sessionId = 'authenticated-stale-login-session';
  await new Promise((resolve, reject) => {
    sessionStore.set(sessionId, {
      cookie: { originalMaxAge: null, expires: null, httpOnly: true, path: '/', sameSite: 'lax' },
      user: { id: 7, username: 'test-user', email: 'test@example.com' },
      csrfToken: 'current-session-token'
    }, (error) => error ? reject(error) : resolve());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const signedSessionId = signature.sign(sessionId, sessionSecret);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie: `data_profile.sid=${encodeURIComponent(`s:${signedSessionId}`)}`,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ _csrf: 'stale-form-token' })
    });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/dashboard');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
