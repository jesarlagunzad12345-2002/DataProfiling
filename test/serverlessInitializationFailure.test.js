const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

process.env.SESSION_SECRET = 'invalid';
const handler = require('../server');

test('returns a service-unavailable response when serverless initialization fails', async () => {
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/login`);
    assert.equal(response.status, 503);
    assert.match(await response.text(), /Service temporarily unavailable/);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
