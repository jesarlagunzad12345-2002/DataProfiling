const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const sourceDirectories = ['config', 'controllers', 'middleware', 'models', 'routes', 'scripts', 'services', 'test', 'public/js'];
const sourceFiles = ['app.js', 'server.js'];

function collectJavaScript(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectJavaScript(entryPath));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(entryPath);
  }
  return files;
}

const files = [
  ...sourceFiles.map((file) => path.join(root, file)),
  ...sourceDirectories.flatMap((directory) => collectJavaScript(path.join(root, directory)))
];
let failed = false;

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(result.stderr || `Syntax check failed: ${file}\n`);
  }
}

if (failed) process.exitCode = 1;
else console.log(`Syntax check passed for ${files.length} JavaScript files.`);
