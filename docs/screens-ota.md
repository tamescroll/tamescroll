# Over-the-air screens

His ask, 2026-11-25: stop needing a new build for every change to the
app's own screens.

## What travels and what does not

| Travels over the air (signed) | Still needs a build |
|---|---|
| `app/index.html`, `app/src/` (home, settings, library, links, tour, onboarding) | Rust (`app/src-tauri/src/`), Kotlin (the bar and menus over a site), Swift plugin |
| Their CSS, fonts and images (`app/dist`) | Anything injected into a site: gaze, scriptlets, page scripts, kid controls |
| | A screen change that needs a new command, URL parameter or window global |

Site rules already travel separately (`rules/`, `ota.rs`).

## How a change reaches a phone

1. A PR that touches only screen files merges to `main`.
2. `.github/workflows/screens.yml` runs `scripts/screens-compat.mjs`:
   - **publish**: screens changed since the build phones run
     (`CURRENT_VERSION_CODE`) was released, and nothing native did.
   - **hold**: native code changed since that release. The screens ship
     with the next build. Re-run by hand with `native_ok` once you have
     checked the screens do not depend on that native change.
   - **sealed**: the screens equal the build's own; nothing to send.
3. It builds `app/dist`, and `scripts/publish-screens.mjs` signs a
   manifest (Ed25519, key in the `SCREENS_SIGNING_KEY` secret) and writes
   it plus every file, named by its SHA-256, to the `screens` branch.
4. Phones check `raw.githubusercontent.com/tamescroll/tamescroll/screens/`
   at launch, every 24 hours and on Settings, About, "Check for updates".
   They download only files that differ from their sealed copy (usually
   the page, one script and one stylesheet, about 200 KB).
5. The new screens show the next time the home page loads. About shows
   "Version X · screens <date>".

## Safety

- **Tamper check.** The manifest signature must verify against the key
  compiled into `screens.rs`, and every file must match its hash, at
  download and again at every launch.
- **One build only.** A bundle names the build it was made for
  (`for_build`). Other builds ignore it; a new build deletes it and starts
  from its own sealed screens.
- **Automatic fallback.** A bundle that has not proven itself must call
  `screens_ready` (main.ts, after the first paint) within 15 seconds of
  loading. If it does not, the phone switches back to the sealed screens
  for that run and reloads the home page. Two misses ban that bundle on
  that phone.
- **Undo for everyone.** Run the workflow by hand with `disable`: phones
  drop their bundle and use the sealed screens.
- The sealed copy inside the app is never changed, so the worst case is
  the screens the build shipped with.

## Store fit

- Google Play: allowed. The Device and Network Abuse policy exempts code
  running in a WebView or JavaScript interpreter.
- Apple: allowed by the developer agreement (3.3.1(B) / guideline 2.5.2)
  for JavaScript run by WebKit, as long as the update does not change
  the app's main purpose or add features that should be reviewed. Keep
  big new features going through TestFlight builds.

## One-time setup

```
node scripts/screens-keygen.mjs          # prints the public key
# put it in PUBLIC_KEY_HEX in app/src-tauri/src/screens.rs
gh secret set SCREENS_SIGNING_KEY --repo tamescroll/tamescroll < secrets/screens-signing-key.pem
```

A build carrying the real public key must ship before any bundle can
reach a phone. Never replace the key casually: phones on builds with the
old public key would stop taking screens until they update.
