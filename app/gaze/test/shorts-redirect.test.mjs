import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchUrlForShorts, watchUrlForShortsHref } from '../src/shorts-redirect.mjs';

test('a /shorts/ path becomes the watch page for the same video', () => {
  assert.equal(watchUrlForShorts('/shorts/jNQXAC9IVRw', ''), '/watch?v=jNQXAC9IVRw');
  assert.equal(watchUrlForShorts('/shorts/jNQXAC9IVRw/', '?t=15'), '/watch?v=jNQXAC9IVRw&t=15s');
});

test('anything that is not a short is left alone', () => {
  assert.equal(watchUrlForShorts('/watch?v=x', ''), null);
  assert.equal(watchUrlForShorts('/shorts', ''), null);
  assert.equal(watchUrlForShorts('/shorts/', ''), null);
  assert.equal(watchUrlForShorts('/feed/subscriptions', ''), null);
});

test('hrefs resolve relative to the page and stay on youtube', () => {
  assert.equal(watchUrlForShortsHref('/shorts/abcdefg', 'https://m.youtube.com'), '/watch?v=abcdefg');
  assert.equal(watchUrlForShortsHref('https://www.youtube.com/shorts/abcdefg', 'https://m.youtube.com'), '/watch?v=abcdefg');
  assert.equal(watchUrlForShortsHref('https://example.com/shorts/abcdefg', 'https://m.youtube.com'), null);
  assert.equal(watchUrlForShortsHref('/watch?v=abcdefg', 'https://m.youtube.com'), null);
});

test('the bare Shorts feed goes home, a short goes to its watch page', async () => {
  const { shortsExitFor, isShortsFeedPath } = await import('../src/shorts-redirect.mjs');
  assert.equal(isShortsFeedPath('/shorts'), true);
  assert.equal(isShortsFeedPath('/shorts/'), true);
  assert.equal(isShortsFeedPath('/shorts/abcdefg'), false);
  assert.equal(shortsExitFor('/shorts', 'https://m.youtube.com/results?search_query=x'), '/');
  assert.equal(shortsExitFor('/shorts/?feature=x', 'https://m.youtube.com/'), '/');
  // what YouTube's own router hands pushState when a playlist or a search
  // result opens a short: root-relative, with a query
  assert.equal(
    shortsExitFor('/shorts/abc_-9XYZ12?list=PLxyz&pp=abc', 'https://m.youtube.com/playlist?list=PLxyz'),
    '/watch?v=abc_-9XYZ12'
  );
  assert.equal(shortsExitFor('https://m.youtube.com/shorts/abcdefg', 'https://m.youtube.com/'), '/watch?v=abcdefg');
  assert.equal(shortsExitFor('/watch?v=abcdefg&list=PLx', 'https://m.youtube.com/'), null);
  assert.equal(shortsExitFor('/results?search_query=shorts', 'https://m.youtube.com/'), null);
  assert.equal(shortsExitFor('/hashtag/shorts', 'https://m.youtube.com/'), null);
  assert.equal(shortsExitFor(null, 'https://m.youtube.com/'), null);
  assert.equal(shortsExitFor('https://example.com/shorts/abcdefg', 'https://m.youtube.com/'), null);
});

test('a swipe player found on screen always leaves', async () => {
  const { reelPlayerExit, REEL_PLAYER_SELECTOR } = await import('../src/shorts-redirect.mjs');
  assert.equal(reelPlayerExit('/shorts/abcdefg', ''), '/watch?v=abcdefg');
  assert.equal(reelPlayerExit('/playlist', '?list=PLx'), '/');
  assert.equal(reelPlayerExit('/results', '?search_query=shorts'), '/');
  assert.match(REEL_PLAYER_SELECTOR, /ytm-reel-player-renderer/);
});
