// THUMBNAILS WAIT WHILE HE FLICKS. Blur-first: an unjudged thumbnail is
// already covered, so holding the drain mid-scroll delays only a reveal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { deferForScroll, IMG_DEFER_WHILE_SCROLLING } from '../src/image-budget.mjs';

test('the drain starts nothing while the page is scrolling, and runs when it is still', () => {
  assert.equal(IMG_DEFER_WHILE_SCROLLING, 1);
  assert.equal(deferForScroll(true), true);
  assert.equal(deferForScroll(false), false);
});

test('the hold sits ahead of the batch, releases the drain, and re-arms one timer', () => {
  const src = fs.readFileSync(new URL('../src/init-entry.js', import.meta.url), 'utf8');
  const drain = src.slice(src.indexOf('function drainImages(soon)'));
  const hold = drain.indexOf('if (imageBudget.deferForScroll(scrolling(nowMs))) {');
  assert.ok(hold > 0, 'drainImages asks deferForScroll');
  assert.ok(hold < drain.indexOf('var batch = [];'), 'before any image is dequeued');
  assert.match(drain.slice(hold, hold + 200), /release\(\);\s*armScrollSettle\(\);\s*return;/);
  assert.match(src, /function armScrollSettle\(\) \{\s*if \(scrollSettleTimer\) return;/);
});
