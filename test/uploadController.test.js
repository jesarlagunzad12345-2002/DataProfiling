const assert = require('node:assert/strict');
const test = require('node:test');
const { isAllowedWorkbookType } = require('../middleware/upload');

test('only accepts workbook extensions paired with their expected Excel MIME type', () => {
  assert.equal(isAllowedWorkbookType({
    originalname: 'customers.xlsx',
    mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }), true);
  assert.equal(isAllowedWorkbookType({
    originalname: 'legacy.xls',
    mimetype: 'application/vnd.ms-excel'
  }), true);
  assert.equal(isAllowedWorkbookType({
    originalname: 'customers.xlsx',
    mimetype: 'text/html'
  }), false);
  assert.equal(isAllowedWorkbookType({
    originalname: 'payload.exe',
    mimetype: 'application/vnd.ms-excel'
  }), false);
});