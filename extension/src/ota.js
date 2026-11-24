// Rules over the air: the same rules/manifest.json the app's ota.rs reads,
// the same checks, DATA ONLY. Only the files in sites.js rulesFiles() are
// ever fetched -- cosmetic rules and blur CSS. Scriptlets and every other
// line of code ship inside the package (MV3 forbids remote code, and the
// repo forbids code over OTA for the same reason).

export const BASE_URL = 'https://raw.githubusercontent.com/tamescroll/tamescroll/main/rules/';

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text).replace(/\r\n/g, '\n'));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** ota.rs parse_manifest: { name: sha256 } or a thrown error. */
export function parseManifest(json) {
  const v = JSON.parse(json);
  if (!v || typeof v.files !== 'object' || v.files === null) throw new Error('manifest missing files object');
  const out = {};
  for (const [name, entry] of Object.entries(v.files)) {
    if (!entry || typeof entry.sha256 !== 'string') throw new Error(`manifest entry ${name} missing sha256`);
    out[name] = entry.sha256.toLowerCase();
  }
  return out;
}

/** ota.rs validate_payload: the promised hash, and not an error page. */
export async function validatePayload(text, expected) {
  if ((await sha256Hex(text)) !== String(expected).toLowerCase()) throw new Error('hash mismatch');
  const head = String(text).trimStart();
  if (head === '') throw new Error('empty payload');
  if (head.startsWith('<')) throw new Error('looks like HTML, not rules');
}

/** Which of `wanted` the manifest has changed, against what is in use now. */
export function planUpdates(manifest, wanted, currentHashes) {
  return wanted.filter((name) => manifest[name] && manifest[name] !== currentHashes[name]);
}

/**
 * One refresh. `fetchText(url)` resolves to the body or throws. Returns
 * the new overrides map ({ name: { sha256, text } }), keeping every file
 * it could not update exactly as it was.
 */
export async function refresh({ fetchText, wanted, bundled, overrides }) {
  const manifest = parseManifest(await fetchText(BASE_URL + 'manifest.json'));
  const current = {};
  for (const name of wanted) {
    current[name] = overrides[name] ? overrides[name].sha256 : await sha256Hex(bundled[name] || '');
  }
  const next = { ...overrides };
  for (const name of planUpdates(manifest, wanted, current)) {
    try {
      const text = await fetchText(BASE_URL + name);
      await validatePayload(text, manifest[name]);
      next[name] = { sha256: manifest[name], text };
    } catch (e) {
      // A bad fetch never blanks the rules: the old text stays in use.
    }
  }
  // A manifest that now matches the bundled copy again drops the override.
  for (const name of wanted) {
    if (next[name] && manifest[name] && manifest[name] === (await sha256Hex(bundled[name] || ''))) delete next[name];
  }
  return next;
}

/** The text in use for one rules file: the OTA copy, else the bundled one. */
export function rulesText(name, bundled, overrides) {
  return overrides && overrides[name] ? overrides[name].text : bundled[name] || '';
}
