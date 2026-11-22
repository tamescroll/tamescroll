import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest, validatePayload, planUpdates, refresh, sha256Hex, BASE_URL, rulesText } from '../src/ota.js';

test('parseManifest reads the app manifest shape and rejects garbage', () => {
  assert.deepEqual(parseManifest('{"version":1,"files":{"youtube.txt":{"sha256":"AB12"}}}'), { 'youtube.txt': 'ab12' });
  assert.throws(() => parseManifest('{"version":1}'));
  assert.throws(() => parseManifest('{"files":{"a":{}}}'));
});

test('validatePayload: hash over LF bytes, no HTML, no empty', async () => {
  const h = await sha256Hex('a\nb\n');
  await validatePayload('a\r\nb\r\n', h);
  await assert.rejects(validatePayload('a\nb', h), /hash/);
  await assert.rejects(validatePayload('<html>', await sha256Hex('<html>')), /HTML/);
  await assert.rejects(validatePayload('  ', await sha256Hex('  ')), /empty/);
});

test('planUpdates lists only wanted, changed files', () => {
  assert.deepEqual(planUpdates({ a: '1', b: '2', c: '3' }, ['a', 'b'], { a: '1', b: 'x' }), ['b']);
});

test('refresh applies a verified file, keeps the old one on a bad fetch, never fetches code', async () => {
  const good = '!surface: home Home\nyoutube.com##.feed\n';
  const manifest = JSON.stringify({ version: 1, files: {
    'youtube.txt': { sha256: await sha256Hex(good) },
    'reddit.txt': { sha256: 'f'.repeat(64) },
    'scriptlets.txt': { sha256: 'e'.repeat(64) },
  } });
  const fetched = [];
  const fetchText = async (url) => {
    fetched.push(url);
    if (url === BASE_URL + 'manifest.json') return manifest;
    if (url === BASE_URL + 'youtube.txt') return good;
    if (url === BASE_URL + 'reddit.txt') return '<html>rate limited</html>';
    throw new Error('unexpected ' + url);
  };
  const overrides = { 'reddit.txt': { sha256: 'old', text: 'old reddit' } };
  const next = await refresh({ fetchText, wanted: ['youtube.txt', 'reddit.txt'], bundled: { 'youtube.txt': 'x', 'reddit.txt': 'y' }, overrides });
  assert.equal(next['youtube.txt'].text, good);
  assert.equal(next['reddit.txt'].text, 'old reddit');
  assert.ok(!fetched.some((u) => u.endsWith('scriptlets.txt')));
  assert.equal(rulesText('youtube.txt', { 'youtube.txt': 'x' }, next), good);
  assert.equal(rulesText('youtube.txt', { 'youtube.txt': 'x' }, {}), 'x');
});
