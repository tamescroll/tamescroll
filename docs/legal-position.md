# Legal position (summary)

The full review, with sources, the decision log, the store-policy table,
the roadblocks and the release plan, is the Claude Doc "Tame Scroll:
legal position and store release plan"
(https://claude.ai/artifact/DuFVPnAmXzVXfwCr6w7wF9), written 2026-10-22.
It is not legal advice.

## Decided 2026-10-22

- Store builds become a real browser: one "search or type a site" box
  above the platform tiles, visible by default. Still built on Android
  WebView, the same engine DuckDuckGo and Kahf ship on in both stores.
- A per-platform "Block ads" setting, on by default, that users can turn
  off. This replaces the earlier rule that ads never come back.
  (2026-10-27, ZV: YouTube's starts OFF, so blocking ads there is the
  user's act; the other platforms keep it on by default. Never say "no
  YouTube ads" in a store listing; see 2026-10-28 for the website.)
- Our own icon and palette in every build: no red play tile, no brand
  colours. (2026-10-28: the sideloaded build's red tile retired too.)

## Decided 2026-10-28

- Keep our own YouTube request rule (`rules/scriptlets.txt`) built in.
  A side-by-side test build without it was checked on ZV's phone and the
  alternatives (user-added lists only, a list published by someone else,
  telling people to use Brave) were compared:
  https://claude.ai/artifact/7JsmyLVmiPJJUztToN2GdD. Publishing the rule
  through a third party "so nobody is responsible" was rejected; it reads
  as intent and moves the risk onto them. If a complaint ever names it,
  remove that one line over the air.
- iPhone keeps YouTube ad blocking too, off by default, like Android.
- Marketing follows Brave (brave.com/youtube-ad-blocker): our website may
  describe a calmer YouTube with ads blocked if the user wants it. Store
  listings stay general. Never "free YouTube Premium", "bypass" or "skip
  YouTube's ads", never YouTube's logo or red.
- Full research: `/mnt/project-files/research/reports/Tame Scroll legal
  and store risk.md` (project files, not in the repo).
- Launch under the owner's own name on personal store accounts; form a
  company later, when there is money or scale.
- No lawyer before launch. If a platform or store complains: don't ignore
  it, don't argue in public, remove what it names if that is quick, then
  consult a lawyer with the questions at the end of the review.

## The lines that keep us defensible

Each of these is a line another app crossed and was removed or sued for.
A change that crosses one needs the owner's word first.

- Load the platform's own website in the system WebView. Never patch,
  repackage or hook a platform's app (the ReVanced / ProTube route).
- Never use a platform's API, and never download, save or convert media.
- Never copy, store or send what the user sees. Filtering happens on the
  device and keeps nothing; diagnostics never contain URLs. (Meta's wins
  against third-party tools, such as BrandTotal in 2022, were all about
  tools that collected data.)
- Never act on an account automatically or use fake accounts.
- Never ship code over the air. Rules travel as JSON only (also Play's
  self-update rule).
- Never use a platform's logo, icon shape or brand colour as ours. Names
  in plain text, to say what we work with, are fine.
- Never infer anything about a person beyond the user's own filter choice
  (no race, religion or identity; per-race calibration stays refused).

## The open exposures, in order

1. YouTube detecting the ad blocker and throttling playback, as it has
   done to Brave. The ads toggle is the user's way out.
2. Store "authorization on request" rules (Apple 5.2.2, Play Webviews):
   Juno, a CSS-only YouTube web view, was removed under 5.2.2 in 2024.
   The browser shape is the answer.
3. Meta: it sent a cease-and-desist over the Unfollow Everything tool in
   2021. Staying on the data line above is the defence.
4. The gender filter: EU AI Act Annex III (high-risk duties provisionally
   moved to December 2027). Illinois BIPA risk is lower after G.T. v.
   Samsung (7th Cir., 2026).

The public statement lives in `web/index.html` (#platforms) and the
privacy policy in `web/privacy.html`, the terms of use in `web/terms.html`.
Keep them true: when the app's data
flows change, change `web/privacy.html` in the same PR.
