// Bundles tfjs (core+cpu+webgl+converter, Apache-2.0) + our runtime into
// one self-contained minified IIFE, written straight to
// app/src-tauri/gaze-page.js — a committed generated artifact,
// `include_str!`-ed into the Rust binary, same treatment as the vendored
// EasyList/EasyPrivacy rule snapshots.
//
// The MODELS are not in here. They ship as the raw files lib.rs serves
// (model_asset), which the worker fetches and, where a service worker
// makes that impossible, lib.rs hands to the page as models_script.
const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// STAMP THE BUILD, not a hand-edited version string. `__TS_GAZE_BUNDLE__`
// read 'v7' across at least three distinct code states, so every gauntlet
// run recorded a boot marker that could not identify what it was running
// — two runs minutes apart reported the same 'v7' while logging different
// diagnostic counters. A round whose evidence cannot be attributed to a
// commit cannot be compared to any other round.
function buildStamp() {
  try {
    const head = execSync('git rev-parse --short HEAD', {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    // A dirty tree is the normal state mid-round, and it is exactly when
    // the marker matters most — say so rather than implying the commit.
    //
    // THE BUNDLE ITSELF IS EXCLUDED, and without that the marker could
    // never read clean AT ALL. `gaze-page.js` is this script's own
    // output, so it is dirty at the moment the marker is computed on
    // every build from every tree — which made `-dirty` unconditional
    // and the suffix meaningless. Phase-f F8 asked for a marker that
    // names a real commit and the first attempt at it could not
    // succeed: commit, rebuild, and the rebuild dirties the one file it
    // was watching. Excluding the output is what makes the remaining
    // suffix mean "a SOURCE file has moved since this commit", which is
    // the thing a reader of the marker actually needs to know.
    const dirty = execSync('git status --porcelain -- . ":(exclude)../src-tauri/gaze-page.js"', {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return head + (dirty ? '-dirty' : '');
  } catch (e) {
    // No git, no problem: never fail a build over a debug marker.
    return 'nogit';
  }
}

// globalThis, not window: the same artifact is also a worker script, and
// the worker's own eval cost is the thing that has to come down now.
const EVAL_CLOCK =
  'try{globalThis.__TS_GAZE_EVAL0=performance.now();}catch(e){}' + String.fromCharCode(10);

async function main() {
  // ONE ARTIFACT, NO MODELS.
  //
  // Pages, and the worker they start, all run this. model-blobs.mjs is
  // swapped for model-blobs-lazy.mjs, so nothing here carries a model:
  // the worker fetches them as raw bytes and the fallback asks lib.rs
  // for /__tamescroll/models.js. The models used to be inlined here AND
  // shipped raw, which cost 22MB of APK for a second copy of the same
  // four files.
  // The page was parsing 22MB on every single navigation for bytes it
  // does not use once inference moved off-thread.
  async function build(outfile) {
    return esbuild.build({
      entryPoints: [path.join(__dirname, '../src/init-entry.js')],
      bundle: true,
      minify: true,
      format: 'iife',
      target: ['es2019'],
      outfile,
      legalComments: 'none',
      metafile: true,
    });
  }

  const pagefile = path.join(__dirname, '../../src-tauri/gaze-page.js');
  const result = await build(pagefile);
  // Rewrite the marker in the built artifact rather than the source, so
  // the source stays a stable string and the stamp cannot drift.
  const stamp = buildStamp();
  // EVAL CLOCK, first statement in each output: what evaluating this
  // artifact costs on THIS device, per page load. Only the build can
  // guarantee the position -- an import in the entry module would
  // already be after the bundler's own module init. It is also how the
  // page/full split gets to prove itself rather than be assumed.
  for (const f of [pagefile]) {
    const raw = fs.readFileSync(f, 'utf8');
    const marked = raw.replace(/__TS_GAZE_BUNDLE__="v7"/, '__TS_GAZE_BUNDLE__="' + stamp + '"');
    if (marked === raw) {
      console.warn(`WARNING: bundle marker not found in ${f} — runs will not be attributable`);
      continue;
    }
    fs.writeFileSync(f, EVAL_CLOCK + marked);
  }
  console.log(`bundle marker: ${stamp}`);

  for (const f of [pagefile]) {
    const stat = fs.statSync(f);
    console.log(`built ${f}: ${(stat.size / 1024 / 1024).toFixed(3)} MB (${stat.size} bytes)`);
  }
  void result;

  // THE APP'S SITE PAGE CODE (#76): login pop-ups, Instagram and LinkedIn
  // feeds, Reddit discovery, old.reddit, and the what's-hidden count. The
  // same modules the extension bundles (app/gaze/src/page/). Embedded in
  // the binary by lib.rs page_scripts_script, never sent over OTA.
  const pagescripts = path.join(__dirname, '../../src-tauri/page-scripts.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '../src/page/app-entry.mjs')],
    bundle: true,
    minify: true,
    format: 'iife',
    target: ['es2019'],
    outfile: pagescripts,
    legalComments: 'none',
  });
  console.log(`built ${pagescripts}: ${fs.statSync(pagescripts).size} bytes`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
