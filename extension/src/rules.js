// Turns the app's rules files and settings into the stylesheet a page
// gets. Pure functions only, so every one of them runs under node --test.
//
// The surface parser follows app/src-tauri/src/rules.rs parse_surfaces
// line for line, and test/rules.test.mjs holds it to the same "every rule
// reaches a surface" check the Rust side runs, over the same files.

/** Ad, promo and nag surfaces: no toggle of their own (rules.rs is_always_on). */
export function isAlwaysOn(id) {
  return id === 'ads' || id === 'mobile_nags' || id === 'promoted';
}

/** Surfaces that ship SHOWN (rules.rs is_default_shown). */
export function isDefaultShown(id) {
  return id === 'watch_recs' || id === 'home_chips';
}

/**
 * Parses one `!surface:`-annotated rules file. A marker starts a surface;
 * each `domain##selector` line belongs to the latest marker; a rule line
 * before any marker is dropped, never guessed at.
 */
export function parseSurfaces(text) {
  const surfaces = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('!surface:')) {
      const rest = line.slice('!surface:'.length).trim();
      const sp = rest.indexOf(' ');
      const id = sp === -1 ? rest : rest.slice(0, sp);
      const label = sp === -1 ? '' : rest.slice(sp + 1);
      surfaces.push({
        id,
        label,
        alwaysOn: isAlwaysOn(id),
        defaultShown: isDefaultShown(id),
        rules: [],
      });
      continue;
    }
    if (line === '' || line.startsWith('!')) continue;
    const at = line.indexOf('##');
    if (at === -1) continue;
    const last = surfaces[surfaces.length - 1];
    if (last) last.rules.push([line.slice(0, at).trim(), line.slice(at + 2).trim()]);
  }
  return surfaces;
}

/**
 * The switches the popup lists for a site, in the app's order: the
 * rules file's own surfaces (minus always-on ones), then page-code
 * settings, then Ads last (lib.rs `surfaces`).
 */
export function toggles(site, surfaces) {
  const out = surfaces
    .filter((s) => !s.alwaysOn)
    .map((s) => ({ id: s.id, label: s.label, defaultShown: s.defaultShown }));
  for (const p of site.pageSurfaces) out.push({ ...p });
  out.push({ id: 'ads', label: 'Ads', defaultShown: site.adsDefaultShown });
  return out;
}

/** A fresh install's shown list for one site. */
export function defaultShown(site, surfaces) {
  return toggles(site, surfaces)
    .filter((t) => t.defaultShown)
    .map((t) => t.id);
}

/** CSS hiding every surface not in `shown` (lib.rs surfaces_css). */
export function surfacesCss(surfaces, shown) {
  const adsShown = shown.includes('ads');
  let css = '';
  for (const s of surfaces) {
    const isShown = s.alwaysOn
      ? (s.id === 'ads' || s.id === 'promoted') && adsShown
      : shown.includes(s.id);
    if (isShown) continue;
    // One rule per selector: one invalid selector in a list kills the
    // whole rule (lib.rs cosmetic_css learned this the hard way).
    for (const [, selector] of s.rules) css += selector + ' { display: none !important; }\n';
  }
  return css;
}

/** The vendor-list cosmetics the engine compiled for this host. */
export function engineCss(engine, site, host) {
  const entry = (engine.hosts || {})[host] || (engine.hosts || {})[site.hosts[0]];
  if (!entry) return '';
  let css = '';
  for (const sel of entry.hide) css += sel + ' { display: none !important; }\n';
  for (const [sel, decl] of entry.styles) css += `${sel} { ${decl} }\n`;
  return css;
}

// Google's consent wall and the scroll lock under it. COPIED from
// lib.rs consent_css, which explains why the hide and the release must
// arrive together; test/rules.test.mjs fails if the two copies differ.
export const CONSENT_CSS =
  'body[modal-open-body]:has(ytm-consent-bump-v2-renderer) { position: static !important; top: auto !important; left: auto !important; right: auto !important; }\n' +
  'body:has(ytm-consent-bump-v2-renderer) ytm-consent-bump-v2-renderer { display: none !important; }\n' +
  'ytd-consent-bump-v2-lightbox { display: none !important; }\n';

/** lib.rs blur_vars_css. */
export function blurVarsCss(px) {
  return `:root { --ts-blur: ${px}px; --ts-blur-strong: ${Math.floor((px * 3) / 2)}px; }\n`;
}

/**
 * The whole stylesheet for one page (lib.rs page_css): vendor cosmetics
 * unless the site's Ads switch shows ads, the consent fix on YouTube,
 * our surfaces, and Stage A blur last when it is on.
 */
export function pageCss({ site, host, engine, rulesText, blurText, prefs, blurStrength }) {
  if (!prefs || prefs.on === false) return '';
  const shown = prefs.shown || [];
  let css = shown.includes('ads') ? '' : engineCss(engine, site, host);
  if (site.id === 'youtube') css += CONSENT_CSS;
  css += surfacesCss(parseSurfaces(rulesText), shown);
  if (prefs.blur) {
    css += blurVarsCss(blurStrength);
    css += blurText || '';
  }
  return css;
}
