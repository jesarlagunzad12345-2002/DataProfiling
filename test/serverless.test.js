const assert = require('node:assert/strict');
const test = require('node:test');

test('exports a request handler for serverless deployments', () => {
  const handler = require('../server');
  assert.equal(typeof handler, 'function');
});
