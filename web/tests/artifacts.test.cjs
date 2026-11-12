const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const root = resolve(__dirname, '../..');
test('the deployed terminal embeds the current trading client bundle', () => {
  const page = readFileSync(resolve(root,'site/index.html'),'utf8');
  const bundle = readFileSync(resolve(root,'dist/hl.js'),'utf8');
  const embedded = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  assert.equal(embedded.trim(),bundle.trim());
});
test('the trading client checksum matches the committed bundle', () => {
  const bundle = readFileSync(resolve(root,'dist/hl.js'));
  const checksum = readFileSync(resolve(root,'dist/hl.js.sha256'),'utf8').split(/\s/)[0];
  assert.equal(createHash('sha256').update(bundle).digest('hex'),checksum);
});
