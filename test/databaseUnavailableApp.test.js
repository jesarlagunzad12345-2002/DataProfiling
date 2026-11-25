const assert = require('node:assert/strict');
const http = require('node:http');
const session = require('express-session');
const test = require('node:test');

process.env.SESSION_SECRET = 'test-secret-with-more-than-thirty-two-characters';
const { createApp } = require('../app');

test('shows the login page while explicitly reporting a database outage', async () => {
  const app = createApp({
    sessionStore: new session.MemoryStore(),
    databaseUnavailable: true
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    const rootResponse = await fetch(origin, { redirect: 'manual' });
    assert.equal(rootResponse.status, 302);
    assert.equal(rootResponse.headers.get('location'), '/login');

    const loginResponse = await fetch(`${origin}/login`);
    assert.equal(loginResponse.status, 503);
    const html = await loginResponse.text();
    assert.match(html, /Welcome back/);
    assert.match(html, /database cannot be reached/);
    assert.match(html, /name="_csrf"/);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
