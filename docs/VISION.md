# VISION — read this first, it overrides everything else in docs/

One sentence: **tamescroll is ONE self-contained app that opens the feed
platforms (YouTube, Reddit, X, Instagram, Facebook) as cleaned versions
of themselves — no ads, no Shorts, no algorithmic feed, optional gaze
blur — on desktop, Android and iOS.**

> AMENDED 2026-08-28 by the owner: Facebook joins the list. It ships with
> its algorithmic surfaces targeted (Reels, Watch, Marketplace, suggested
> posts, People You May Know) and NO claim about feed ads — uBlock
> Origin's maintainers stopped chasing those on 2026-08-10 because the
> "Sponsored" label is built to defeat static matching, and promising
> what they conceded would be the kind of scope drift this file exists to
> stop.

The user installs ONE thing. Nothing else. Ever.

## What "self-contained" means — the line past sessions kept blurring

- Users do NOT need Brave. Not as a pairing, not as a fallback.
- Users do NOT need any extension.
- Users do NOT need to "subscribe to a filter list". That concept is
  internal plumbing and must never appear in user-facing anything.
- Brave appears in this project in exactly ONE way: we embed its
  open-source blocking engine (the `adblock` Rust crate) as a library
  inside our app. A user never sees or hears the word Brave.

## What the app does, all by itself

1. Launcher: home-screen-like grid of platform tiles. Tap → cleaned
   platform in a webview. No address bar, nowhere to wander.
2. Removes algorithmic surfaces: home feed, Shorts, For You, sidebar
   recommendations, end screens. WORKING today (cosmetic CSS).
3. Blocks ads INSIDE the app. YouTube ads die by scriptlet injection
   (strip ad data from the player response before the player reads it),
   not by network blocking — the engine already supports this via
   `injected_script`; wiring it is current work. Display ads on other
   platforms: cosmetic hiding + scriptlets from EasyList lists.
4. Later: gaze module (3 modes, on-device), playbook, OS-lock pairing.

## Corrections that are settled — do not reopen

- "Desktop extension first" (original handoff §8): the app stays first.
  The owner rejected an extension in August, then asked for one on
  2026-11-21 so Tame Scroll reaches every platform: it now exists beside
  the app as `extension/`, built from the same rules and engine.
- "Pair with Brave / point users at Brave": DEAD. Owner rejected it.
  Self-contained or nothing.
- "The app cannot block ads" (said mid-session): WRONG. Tauri's inability
  to cancel network requests is real but irrelevant to YouTube ads,
  which are same-origin and are defeated by scriptlets. In-app ad
  blocking is IN SCOPE and expected.
- The standalone rules .txt that other blockers can consume: a nice
  side-effect of our file format, worth zero engineering effort, never
  a strategy, never user-facing.

## Non-negotiables (from the owner, stable across the whole project)

Free + open source forever (MPL-2.0 / CC0). Block-only — never modify,
repackage or impersonate platform apps, never unlock paid features.
Instant core, AI never in the critical path. No nags, ours or theirs.
Must not look or feel like a parental-control app. Harm reduction, not
abstinence: keep the access, remove the manipulation.
