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

test('sets secure session cookies behind the Vercel HTTPS proxy', async () => {
  const previousVercel = process.env.VERCEL;
  const previousTrustProxy = process.env.TRUST_PROXY;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.VERCEL = '1';
  delete process.env.TRUST_PROXY;
  process.env.NODE_ENV = 'production';

  const app = createApp({
    sessionStore: new session.MemoryStore(),
    databaseUnavailable: true
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/login`, {
      headers: { 'x-forwarded-proto': 'https' }
    });
    assert.equal(response.status, 503);
    assert.match(response.headers.get('set-cookie') || '', /;\s*secure\b/i);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
    if (previousTrustProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previousTrustProxy;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});
