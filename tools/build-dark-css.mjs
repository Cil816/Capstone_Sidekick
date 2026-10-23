// Builds mobile-app/css/dark.css, the app's dark mode, from the app's own stylesheets.
//
//   node tools/build-dark-css.mjs
//
// Run it again after changing colours in mobile-app/css so dark mode stays in step.
// Every rule that sets a colour is repeated under html[data-theme="dark"] with:
//   - light backgrounds turned into dark surfaces (keeping their tint),
//   - dark text turned light,
//   - light borders turned into dark lines,
// and every other colour (teal buttons, white text on them, photos...) kept as is.
// Repeating all colour rules in the same order keeps states such as "selected"
// winning over the base style, exactly as in light mode.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cssDir = path.join(root, 'mobile-app', 'css');

// Same order as the pages load them: shared, page styles, theme, effects, a11y last.
const FILES = [
  'common.css',
  'alerts.css', 'app-rating.css', 'chat.css', 'dashboard.css', 'itinerary.css', 'legal.css',
  'login.css', 'navbar.css', 'onboarding.css', 'otp.css', 'past-trips.css', 'register.css', 'settings.css', 'welcome.css',
  'theme.css', 'tab-motion.css', 'travel-map.css', 'a11y.css',
];

const DARK = 'html[data-theme="dark"]';

// ---- colours -------------------------------------------------------------------------
function parseColor(text) {
  const t = text.trim().toLowerCase();
  if (t === 'white') return { r: 255, g: 255, b: 255, a: 1 };
  let m = /^#([0-9a-f]{3})$/.exec(t);
  if (m) return { r: parseInt(m[1][0] + m[1][0], 16), g: parseInt(m[1][1] + m[1][1], 16), b: parseInt(m[1][2] + m[1][2], 16), a: 1 };
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(t);
  if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.%]+))?\s*\)$/.exec(t);
  if (m) {
    const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: +m[1], g: +m[2], b: +m[3], a: alpha };
  }
  return null;
}

function toHsl({ r, g, b }) {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return { h: h * 60, s, l };
}

function hslString({ h, s, l }, a) {
  const hue = Math.round(h);
  const sat = Math.round(s * 100);
  const lig = Math.round(l * 100);
  return a < 1 ? `hsla(${hue}, ${sat}%, ${lig}%, ${+a.toFixed(3)})` : `hsl(${hue}, ${sat}%, ${lig}%)`;
}

// role: 'bg' | 'text' | 'border'
function darkColor(raw, role) {
  const color = parseColor(raw);
  if (!color) return raw;
  const hsl = toHsl(color);
  // Plain whites and greys take the app's navy tint instead of turning neutral grey.
  if (hsl.s < 0.08) {
    hsl.h = 208;
    hsl.s = role === 'bg' ? 0.32 : role === 'border' ? 0.26 : 0.16;
  }
  if (role === 'bg' && hsl.l >= 0.78) {
    return hslString({ h: hsl.h, s: Math.min(hsl.s, 0.38), l: 0.11 + (1 - hsl.l) * 0.5 }, color.a);
  }
  if (role === 'text' && hsl.l <= 0.55) {
    return hslString({ h: hsl.h, s: Math.min(hsl.s, 0.32), l: 0.93 - hsl.l * 0.42 }, color.a);
  }
  if (role === 'border' && hsl.l >= 0.72) {
    return hslString({ h: hsl.h, s: Math.min(hsl.s, 0.3), l: 0.2 + (1 - hsl.l) * 0.35 }, color.a);
  }
  return raw;
}

const COLOR_TOKEN = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\bwhite\b/g;

function roleFor(property) {
  if (/^background/.test(property)) return 'bg';
  if (/^(border|outline)/.test(property)) return 'border';
  if (property === 'color' || property === '-webkit-text-fill-color' || property === 'caret-color') return 'text';
  return null;
}

// Returns the dark value, or null when the declaration has no colour to repeat.
function darkDeclaration(property, value) {
  const role = roleFor(property);
  if (!role) return null;
  const withoutUrls = value.replace(/url\([^)]*\)/g, '');
  if (!COLOR_TOKEN.test(withoutUrls)) { COLOR_TOKEN.lastIndex = 0; return null; }
  COLOR_TOKEN.lastIndex = 0;
  // Leave url(...) parts (images, inline SVG) untouched.
  const parts = value.split(/(url\([^)]*\))/g);
  return parts.map((part) => (part.startsWith('url(') ? part : part.replace(COLOR_TOKEN, (token) => darkColor(token, role)))).join('');
}

// ---- CSS parsing (rules, one level of @media/@supports) ---------------------------------
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function splitDeclarations(body) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ';' && depth === 0) { out.push(body.slice(start, i)); start = i + 1; }
  }
  out.push(body.slice(start));
  return out.map((d) => d.trim()).filter(Boolean);
}

// Rules from a stylesheet that only some pages load are limited to those pages
// (js/theme-init.js puts the page name in <html data-page>). :where() adds no
// specificity, so the dark rules win and lose exactly as the light ones do.
let SCOPE = '';

function prefixSelector(selector) {
  const D = DARK + SCOPE;
  return selector.split(',').map((part) => {
    const s = part.trim();
    if (!s) return s;
    if (s.startsWith(':root')) return D + s.slice(5);
    if (/^html\b/.test(s)) return D + s.slice(4);
    if (s.startsWith('.perf-lite')) return `${D}${s}`; // .perf-lite is set on <html>
    return `${D} ${s}`;
  }).join(',\n');
}

function transformBlock(css) {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open === -1) break;
    const head = css.slice(i, open).trim();
    // find the matching close brace
    let depth = 1;
    let j = open + 1;
    for (; j < css.length && depth; j += 1) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') depth -= 1;
    }
    const body = css.slice(open + 1, j - 1);
    i = j;
    if (head.startsWith('@media') || head.startsWith('@supports')) {
      const inner = transformBlock(body);
      if (inner.trim()) out += `${head} {\n${inner}}\n`;
      continue;
    }
    if (head.startsWith('@')) continue; // @keyframes, @font-face, @import...
    const declarations = [];
    for (const decl of splitDeclarations(body)) {
      const colon = decl.indexOf(':');
      if (colon === -1) continue;
      const property = decl.slice(0, colon).trim().toLowerCase();
      let value = decl.slice(colon + 1).trim();
      const important = /!important\s*$/i.test(value);
      if (important) value = value.replace(/\s*!important\s*$/i, '');
      const dark = darkDeclaration(property, value);
      if (dark !== null) declarations.push(`  ${property}: ${dark}${important ? ' !important' : ''};`);
      // A see-through background is repeated too, so it still overrides an earlier dark
      // surface the same way it does in light mode (e.g. screens that show the travel map).
      else if ((property === 'background' || property === 'background-color') && /^(transparent|none)$/i.test(value)) {
        declarations.push(`  ${property}: ${value}${important ? ' !important' : ''};`);
      }
    }
    if (declarations.length) out += `${prefixSelector(head)} {\n${declarations.join('\n')}\n}\n`;
  }
  return out;
}

// ---- hand-picked values for the colour variables ------------------------------------------
const VARIABLES = `${DARK} {
  color-scheme: dark;
  --sidekick-ink: #e2edf5;
  --sidekick-muted: #9db3c5;
  --sidekick-line: #263a4c;
  --itinerary-ink: #e2edf5;
  --itinerary-muted: #9db3c5;
  --itinerary-blue: #6cc7dd;
  --sk-ink: #e2edf5;
  --sk-muted: #9db3c5;
  --sk-line: #263a4c;
  --sk-soft: #172a3b;
  --sk-bg: #0c1722;
  --sk-danger: #ff8a98;
  --sk-danger-soft: #3a1a20;
  --sk-shadow: 0 10px 26px rgba(0, 0, 0, .35);
  --sk-shadow-lg: 0 20px 44px rgba(0, 0, 0, .5);
}
${DARK} .register-screen {
  --register-ink: #e2edf5;
  --register-muted: #9db3c5;
}
`;

// ---- finishing touches the automatic pass cannot know about ------------------------------
const EXTRAS = `
/* Page background and native controls */
${DARK} body { background-color: #0c1722; }
${DARK} input,
${DARK} select,
${DARK} textarea { color: #e2edf5; }
${DARK} ::placeholder { color: #6f879b; }
${DARK} img { opacity: .94; }

/* Raised tab icon keeps a ring that matches the dark bar */
${DARK} body[data-tab] .bottom-nav .nav-item.active svg {
  box-shadow: 0 0 0 4px #132232, 0 10px 20px rgba(0, 0, 0, .45);
}

/* The faint map pattern and travel map are dimmed */
${DARK} body::before { opacity: .05; }
${DARK} .sk-map-canvas { filter: brightness(.4) saturate(.85); }
${DARK} .sk-map-wash {
  background: linear-gradient(180deg, hsla(208, 38%, 9%, .78) 0%, hsla(208, 38%, 9%, .5) 34%, hsla(208, 38%, 9%, .34) 100%);
}
${DARK} body[data-map-stop="index"] .sk-map-wash {
  background: radial-gradient(ellipse at 50% 55%, hsla(208, 38%, 9%, .8) 0%, hsla(208, 38%, 9%, .55) 55%, hsla(208, 38%, 9%, .36) 100%);
}

/* Logo loading screen: a slightly lighter box so it stands out on the dimmed page */
${DARK} .sk-loader-box { background: #1a2e40; border: 1px solid #2c4659; }
${DARK} .sk-loader::backdrop { background: rgba(0, 0, 0, .55); }
${DARK} .sk-offline::backdrop { background: #0c1722; }

/* Drop-down arrow in a light colour */
${DARK} select:not([multiple]):not([size]) {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%239db3c5' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E") !important;
}
${DARK} .sk-ptr { background: #1a2e40; border: 1px solid #2c4659; box-shadow: 0 6px 18px rgba(0, 0, 0, .45); }

/* Profile picture placeholder (inline light background in profile.html) */
${DARK} .profile-card div[style*="#F5F7FA"] { background: #1a2d3d !important; color: #9db3c5; }

/* Google map inside the app stays readable */
${DARK} .gm-style { color-scheme: light; }
`;

// Which pages load each stylesheet (only pages that use dark mode count).
const appDir = path.join(root, 'mobile-app');
const pages = readdirSync(appDir).filter((name) => name.endsWith('.html'))
  .map((name) => ({ name: name.replace(/\.html$/, ''), html: readFileSync(path.join(appDir, name), 'utf8') }))
  .filter((page) => page.html.includes('css/dark.css'));
const pagesUsing = (file) => pages
  .filter((page) => page.html.includes(`href="css/${file}"`) || page.html.includes(`href="/css/${file}"`))
  .map((page) => page.name);

let generated = '';
for (const file of FILES) {
  const using = pagesUsing(file);
  if (!using.length) continue; // no page loads it, so its styles never apply
  SCOPE = using.length === pages.length ? '' : `:where(${using.map((name) => `[data-page="${name}"]`).join(', ')})`;
  const css = stripComments(readFileSync(path.join(cssDir, file), 'utf8'));
  const block = transformBlock(css);
  if (block.trim()) generated += `\n/* ---- from ${file} (${SCOPE ? using.join(', ') : 'all pages'}) ---- */\n${block}`;
}
SCOPE = '';

const header = `/* ==========================================================================
   Sidekick app - dark mode. GENERATED by tools/build-dark-css.mjs from the app's
   stylesheets; edit those (or the script), then run: node tools/build-dark-css.mjs
   Applies when <html data-theme="dark"> is set by js/theme-init.js.
   ========================================================================== */
`;
writeFileSync(path.join(cssDir, 'dark.css'), `${header}\n${VARIABLES}${generated}${EXTRAS}`);
console.log(`dark.css written: ${generated.split('\n').length} lines from ${FILES.length} stylesheets`);
