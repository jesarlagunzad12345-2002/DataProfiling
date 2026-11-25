const os = require('node:os');
const path = require('node:path');

const storageRoot = process.env.VERCEL
  ? path.join(os.tmpdir(), 'data-profiling-platform')
  : path.resolve(__dirname, '..');

module.exports = Object.freeze({
  uploads: path.join(storageRoot, 'uploads'),
  exports: path.join(storageRoot, 'exports'),
  workingCopies: path.join(storageRoot, 'working-copies')
});
