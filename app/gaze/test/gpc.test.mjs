import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installGpc } from '../src/page/gpc.mjs';

function fakeWindow() {
  class Navigator {}
  return { navigator: new Navigator() };
}

test('the switch on: navigator.globalPrivacyControl is true, read-only', () => {
  const win = fakeWindow();
  assert.equal(win.navigator.globalPrivacyControl, undefined);
  assert.equal(installGpc(win, () => true), true);
  assert.equal(win.navigator.globalPrivacyControl, true);
  assert.throws(() => {
    'use strict';
    win.navigator.globalPrivacyControl = false;
  }, TypeError);
  assert.equal(win.navigator.globalPrivacyControl, true);
});

test('the switch off: the property is not there at all', () => {
  const win = fakeWindow();
  assert.equal(installGpc(win, () => false), false);
  assert.equal('globalPrivacyControl' in win.navigator, false);
});

test('it lives on the prototype, where the spec puts it, not on the instance', () => {
  const win = fakeWindow();
  installGpc(win, () => true);
  assert.equal(Object.prototype.hasOwnProperty.call(win.navigator, 'globalPrivacyControl'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.getPrototypeOf(win.navigator), 'globalPrivacyControl'), true);
});

test('a bridge that throws, or no window at all, never throws into the page', () => {
  assert.equal(installGpc(fakeWindow(), () => { throw new Error('bridge'); }), false);
  assert.equal(installGpc(undefined, () => true), false);
  assert.equal(installGpc({}, () => true), false);
});
