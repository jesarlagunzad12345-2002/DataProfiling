require('dotenv').config();
const readline = require('node:readline');
const bcrypt = require('bcryptjs');
const userModel = require('../models/userModel');
const { closeDatabase } = require('../config/database');

function askLine(prompt) {
  const interfaceInstance = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    interfaceInstance.question(prompt, (answer) => {
      interfaceInstance.close();
      resolve(answer.trim());
    });
  });
}

function askHidden(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return askLine(prompt);
  }

  return new Promise((resolve, reject) => {
    let value = '';
    const onKeypress = (text, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        process.stdout.write('\n');
        cleanup();
        reject(new Error('Password entry cancelled.'));
      } else if (key.name === 'return' || key.name === 'enter') {
        process.stdout.write('\n');
        cleanup();
        resolve(value);
      } else if (key.name === 'backspace') {
        value = value.slice(0, -1);
      } else if (text && !key.ctrl && !key.meta) {
        value += text;
      }
    };
    const cleanup = () => {
      process.stdin.removeListener('keypress', onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };

    process.stdout.write(prompt);
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', onKeypress);
  });
}

function validatePassword(password) {
  const length = Buffer.byteLength(password, 'utf8');
  if (length < 12 || length > 72) {
    throw new Error('Use a password between 12 and 72 UTF-8 bytes.');
  }
}

async function readNewPassword() {
  const password = await askHidden('Password (12–72 bytes): ');
  const confirmation = await askHidden('Confirm password: ');
  validatePassword(password);
  if (password !== confirmation) throw new Error('The passwords do not match.');
  return password;
}

async function createUser() {
  const username = (await askLine('Username (3–50 letters, numbers, dots, dashes, or underscores): ')).toLowerCase();
  const email = (await askLine('Email: ')).toLowerCase();
  if (!/^[a-z0-9._-]{3,50}$/.test(username)) throw new Error('Username format is invalid.');
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Email address is invalid.');

  const password = await readNewPassword();
  const passwordHash = await bcrypt.hash(password, 12);
  const userId = await userModel.createUser({ username, email, passwordHash });
  console.log(`Created user ${username} (ID ${userId}).`);
}

async function resetPassword() {
  const account = (await askLine('Account email or username: ')).toLowerCase();
  if (!account || account.length > 254) throw new Error('Enter a valid email address or username.');
  const user = await userModel.findByUsernameOrEmail(account);
  if (!user) throw new Error('No matching account was found.');
  const password = await readNewPassword();
  const passwordHash = await bcrypt.hash(password, 12);
  await userModel.updatePassword(user.id, passwordHash);
  console.log(`Password reset for ${user.username}.`);
}

async function main() {
  const command = process.argv[2];
  if (command !== 'create' && command !== 'reset') {
    throw new Error('Usage: node scripts/manage-user.js create|reset');
  }

  try {
    if (command === 'create') await createUser();
    else await resetPassword();
  } finally {
    await closeDatabase();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});