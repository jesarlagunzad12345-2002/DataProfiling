const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('uses writable temporary storage paths on Vercel', () => {
  const previousVercel = process.env.VERCEL;
  process.env.VERCEL = '1';
  delete require.cache[require.resolve('../config/storagePaths')];

  try {
    const storagePaths = require('../config/storagePaths');
    const expectedRoot = path.join(os.tmpdir(), 'data-profiling-platform');
    assert.equal(storagePaths.uploads, path.join(expectedRoot, 'uploads'));
    assert.equal(storagePaths.exports, path.join(expectedRoot, 'exports'));
    assert.equal(storagePaths.workingCopies, path.join(expectedRoot, 'working-copies'));
  } finally {
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
    delete require.cache[require.resolve('../config/storagePaths')];
  }
});
