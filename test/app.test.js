const assert = require('node:assert/strict');
const http = require('node:http');
const session = require('express-session');
const test = require('node:test');

process.env.SESSION_SECRET = 'test-secret-with-more-than-thirty-two-characters';
const { createApp } = require('../app');

let server;
let origin;

test.before(async () => {
  const app = createApp({ sessionStore: new session.MemoryStore() });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('serves the login page and redirects unauthenticated private pages', async () => {
  const loginResponse = await fetch(`${origin}/login`);
  assert.equal(loginResponse.status, 200);
  const sessionCookie = loginResponse.headers.get('set-cookie');
  const expiry = sessionCookie.match(/Expires=([^;]+)/);
  assert.ok(expiry);
  assert.ok(Date.parse(expiry[1]) - Date.now() <= 8 * 60 * 60 * 1000);
  assert.ok(Date.parse(expiry[1]) - Date.now() > 7 * 60 * 60 * 1000);
  assert.match(sessionCookie, /HttpOnly/);
  assert.match(sessionCookie, /SameSite=Lax/);
  assert.match(await loginResponse.text(), /Welcome back/);

  const dashboardResponse = await fetch(`${origin}/dashboard`, { redirect: 'manual' });
  assert.equal(dashboardResponse.status, 302);
  assert.equal(dashboardResponse.headers.get('location'), '/login');
  assert.equal(dashboardResponse.headers.get('cache-control'), null);

  const profilingResponse = await fetch(`${origin}/profiling`, { redirect: 'manual' });
  assert.equal(profilingResponse.status, 302);
  assert.equal(profilingResponse.headers.get('location'), '/login');

  const wordResponse = await fetch(`${origin}/word-manipulation`, { redirect: 'manual' });
  assert.equal(wordResponse.status, 302);
  assert.equal(wordResponse.headers.get('location'), '/login');

  const reviewResponse = await fetch(`${origin}/review`, { redirect: 'manual' });
  assert.equal(reviewResponse.status, 302);
  assert.equal(reviewResponse.headers.get('location'), '/login');

  const exportResponse = await fetch(`${origin}/exports`, { redirect: 'manual' });
  assert.equal(exportResponse.status, 302);
  assert.equal(exportResponse.headers.get('location'), '/login');

  const reportsResponse = await fetch(`${origin}/reports`, { redirect: 'manual' });
  assert.equal(reportsResponse.status, 302);
  assert.equal(reportsResponse.headers.get('location'), '/login');

  const reportExportResponse = await fetch(`${origin}/reports/export.csv`, { redirect: 'manual' });
  assert.equal(reportExportResponse.status, 302);
  assert.equal(reportExportResponse.headers.get('location'), '/login');

  const missingPageResponse = await fetch(`${origin}/not-a-route`, { redirect: 'manual' });
  assert.equal(missingPageResponse.status, 404);
});

test('serves the locally installed Chart.js bundle under the self-only content policy', async () => {
  const response = await fetch(`${origin}/vendor/chart.js/chart.umd.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /javascript/);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
});

test('requires a valid CSRF token to sign out and clears the server session', async () => {
  const loginResponse = await fetch(`${origin}/login`);
  const html = await loginResponse.text();
  const csrfToken = html.match(/name="_csrf" value="([^"]+)"/)[1];
  const cookie = loginResponse.headers.get('set-cookie').split(';', 1)[0];

  const rejected = await fetch(`${origin}/logout`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: ''
  });
  assert.equal(rejected.status, 403);

  const logoutResponse = await fetch(`${origin}/logout`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrfToken })
  });
  assert.equal(logoutResponse.status, 302);
  assert.equal(logoutResponse.headers.get('location'), '/login');

  const privateResponse = await fetch(`${origin}/uploads`, { redirect: 'manual' });
  assert.equal(privateResponse.status, 302);
  assert.equal(privateResponse.headers.get('location'), '/login');
});
