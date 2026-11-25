// The what's-hidden count behind the app's shield chip (#76): hidden means
// matched and not visible, showing means brought back and on screen, and a
// bad selector from a rules OTA never stops the count.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pageStatus } from '../src/page/hidden-status.mjs';

function el(visible) {
  return {
    visible,
    getBoundingClientRect: () => (visible ? { width: 10, height: 10 } : { width: 0, height: 0 }),
  };
}

globalThis.getComputedStyle = (e) => ({ display: e.visible ? 'block' : 'none' });

const doc = {
  querySelectorAll(sel) {
    if (sel === 'bad[') throw new SyntaxError('bad selector');
    return { '.feed': [el(false), el(false)], '.shorts': [el(true)], '.chips': [el(true)], '.gone': [] }[sel] || [];
  },
};

test('hidden, showing, slipped and absent surfaces are told apart', () => {
  const status = pageStatus([
    { l: 'Home feed', s: false, q: ['bad[', '.feed'] },
    { l: 'Shorts', s: true, q: ['.shorts'] },
    { l: 'Chips', s: false, q: ['.chips'] },
    { l: 'Nothing here', s: false, q: ['.gone'] },
  ], doc);
  assert.deepEqual(status, { h: ['Home feed'], s: ['Shorts'] });
});
