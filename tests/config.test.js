import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envFromPath, CONFIG, BACKENDS } from '../js/config.js';

test('environment comes from the page address', () => {
  assert.equal(envFromPath('/power-plan-web/'), 'prod');
  assert.equal(envFromPath('/power-plan-web/admin.html'), 'prod');
  assert.equal(envFromPath('/power-plan-web/uat/'), 'uat');
  assert.equal(envFromPath('/power-plan-web/uat'), 'uat');
  assert.equal(envFromPath('/power-plan-web/uat/admin.html'), 'uat');
  assert.equal(envFromPath('/power-plan-web/uatx/'), 'prod');
});

test('prod and UAT never share a backend', () => {
  assert.equal(CONFIG.env, 'prod'); // no page address in Node
  assert.match(CONFIG.apiUrl, /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/);
  assert.notEqual(BACKENDS.uat, BACKENDS.prod);
});
