// The theme and the series palettes: the palette menu at the head of the period bar's artist key, and the
// light/dark toggle in the top bar.
import { disposeAll, currentZoom } from "./charts.js";
import { dur, MORPH_MS, EASE_IN_OUT } from "./motion.js";
import { renderCommunity } from "./community.js";
import { $, state, hooks } from "./state.js";

const renderAll = (...a) => hooks.renderAll(...a); // main.js

// ---------- Theme ----------

// Series palettes, chosen from the dot at the head of the period bar's artist key. "Default" is the stylesheet's own --series-N
// colors; the others override them on <body>, so the root keeps the stylesheet values to preview from.
// The checked ones pass the data-viz palette validator's hard gates in both modes, ordered for
// adjacent stacked bands.
const PALETTES = {
  current: { label: "Default" },
  earth: {
    label: "Earth",
    light: ["#386ca5", "#b5543a", "#04988e", "#d4932b", "#7d5a9e", "#6f8f3a", "#c06c84", "#96691b", "#5b7a8c", "#c9a27a"],
    dark: ["#4074ae", "#b5543a", "#04988e", "#c58513", "#825fa4", "#6f8f3a", "#c06c84", "#96691b", "#5f8197", "#bf9568"],
  },
  jewel: {
    label: "Jewel",
    light: ["#2b5ea7", "#d96a4f", "#0495a8", "#b83a55", "#d18f1d", "#1d8a63", "#7650ad", "#6d8c25", "#5a6f7e", "#a0763a"],
    dark: ["#3e71bc", "#d96a4f", "#0495a8", "#bc3e58", "#c68401", "#1d8a63", "#805ab8", "#6d8c25", "#6a8191", "#a8803f"],
  },
  ember: {
    label: "Ink & ember",
    light: ["#32548f", "#c9a227", "#2d7fae", "#d9733f", "#23a7aa", "#a84a5a", "#73a665", "#6c599c", "#7a8f9f", "#b8714f"],
    dark: ["#4d71af", "#b48f0a", "#2d7fae", "#d9733f", "#23a7aa", "#ad4f5e", "#71a463", "#7764a8", "#8aa0b0", "#c07c5a"],
  },
  soft: {
    label: "Soft",
    light: ["#4379b2", "#59a14f", "#b774a5", "#f28e2b", "#46beb7", "#e15759", "#d1ae21", "#f2919b", "#9c755f", "#bab0ac"],
    dark: ["#4379b2", "#59a14f", "#b774a5", "#d77806", "#28a8a2", "#e15759", "#b09100", "#d1747e", "#9c755f", "#8f8682"],
  },
  // Not validated: some fail the colorblind or contrast checks. One list serves both modes.
  morandi: { label: "Morandi", unchecked: true, colors: ["#8e9aaf", "#c59d8f", "#9bb0a5", "#d4b483", "#a9889e", "#7d9a8c", "#c9a9a6", "#a3a07e", "#b7a5c9", "#8d8d86"] },
  pastel: { label: "Pastel", unchecked: true, colors: ["#a7c7e7", "#f8b4a6", "#b5e0c9", "#f6d58e", "#d4b5e8", "#f4b6cf", "#a8dadc", "#e2c6a1", "#cfe3a0", "#c7c3e8"] },
  nord: { label: "Nord", unchecked: true, colors: ["#5e81ac", "#d08770", "#a3be8c", "#b48ead", "#ebcb8b", "#88c0d0", "#bf616a", "#8fbcbb", "#81a1c1", "#a6a38e"] },
  solarized: { label: "Solarized", unchecked: true, colors: ["#268bd2", "#cb4b16", "#2aa198", "#d33682", "#b58900", "#6c71c4", "#859900", "#dc322f", "#657b83", "#93a1a1"] },
  seventies: { label: "70s", unchecked: true, colors: ["#3a6b7e", "#d9822b", "#7a8b3a", "#c4492d", "#e3b23c", "#6b4e3d", "#a65e46", "#9a9a5b", "#b5651d", "#5f7a61"] },
  bauhaus: { label: "Bauhaus", unchecked: true, colors: ["#1f4e9c", "#d62828", "#f2b705", "#222222", "#4f8a8b", "#e76f51", "#7d7d7d", "#8a5a9f", "#f28c28", "#2e8b57"] },
  synthwave: { label: "Synthwave", unchecked: true, colors: ["#ff2a6d", "#05d9e8", "#d300c5", "#f9c80e", "#7a04eb", "#00ff9f", "#ff6c11", "#2de2e6", "#ff9de1", "#3a86ff"] },
  riso: { label: "Riso print", unchecked: true, colors: ["#0078bf", "#ff48b0", "#ffe800", "#00a95c", "#ff6c2f", "#765ba7", "#f15060", "#3d5588", "#00838a", "#ff9a9a"] },
  sunset: { label: "Sunset", unchecked: true, colors: ["#2a1250", "#3d1e6d", "#6a2c70", "#9b3675", "#c94b6d", "#e86a5b", "#f28f4b", "#f6b545", "#f9d65c", "#fce38a"] },
  ocean: { label: "Ocean", unchecked: true, colors: ["#06182e", "#0b2545", "#13315c", "#1d4e89", "#2a6f97", "#2c8c99", "#42a6a0", "#7bc6b5", "#b8e0d2", "#d9efe6"] },
  viridis: { label: "Viridis", unchecked: true, colors: ["#440154", "#482878", "#3e4989", "#31688e", "#26828e", "#1f9e89", "#35b779", "#6ece58", "#b5de2b", "#fde725"] },
  greens: { label: "Spotify greens", unchecked: true, colors: ["#1db954", "#168d40", "#57d27f", "#0f5e2c", "#8fe3a8", "#2f7d4f", "#b9f0c9", "#4a9e6b", "#6fdc94", "#0a3d1d"] },
  accent: { label: "Gray + accent", unchecked: true, colors: ["#e4572e", "#9aa0a6", "#b8bcc1", "#7d838a", "#cfd2d6", "#6b7178", "#a9aeb3", "#888e95", "#c1c5ca", "#767c83"] },
  mono: { label: "Monochrome blue", unchecked: true, colors: ["#0b3d91", "#1f5fbf", "#3a7fd9", "#5d9be6", "#86b6ef", "#a9cbf4", "#2c4f7c", "#6f8fb5", "#14284b", "#c9def7"] },
};

const isDark = () => {
  const root = document.documentElement;
  return root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
};

// The 10 colors a palette shows in the current theme in the current theme
function paletteColors(key) {
  const p = PALETTES[key];
  if (p.colors) return p.colors;
  if (p.light) return p[isDark() ? "dark" : "light"];
  const css = getComputedStyle(document.documentElement);
  return Array.from({ length: 10 }, (_, i) => css.getPropertyValue(`--series-${i + 1}`).trim());
}

// The choice is a per-device convenience; storage can be unavailable, so it's best effort
let paletteKey = "current";
try { paletteKey = localStorage.getItem("palette") ?? "current"; } catch {}
if (!PALETTES[paletteKey]) paletteKey = "current";

function applyPalette() {
  const style = document.body.style;
  const colors = paletteKey === "current" ? null : paletteColors(paletteKey);
  for (let i = 0; i < 10; i++) {
    if (colors) style.setProperty(`--series-${i + 1}`, colors[i]);
    else style.removeProperty(`--series-${i + 1}`);
  }
  // The picker is a pill of the chart's colors, blended left to right and back round to the first, so
  // its hover drift loops seamlessly (style.css). An image, not the background shorthand, which would
  // reset the stylesheet's size and repeat.
  const c = paletteColors(paletteKey);
  $("palette-button").style.backgroundImage = `linear-gradient(to right, ${[...c, c[0]].join(", ")})`;
}

function choosePalette(key) {
  paletteKey = key;
  try { localStorage.setItem("palette", key); } catch {}
  closePaletteMenu(true);
  rerenderForTheme();
}

function openPaletteMenu() {
  const menu = $("palette-menu");
  const option = (key) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "palette-option";
    b.setAttribute("role", "menuitemradio");
    b.setAttribute("aria-checked", key === paletteKey);
    const check = document.createElement("span");
    check.className = "check";
    check.textContent = key === paletteKey ? "✓" : "";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = PALETTES[key].label;
    const strip = document.createElement("span");
    strip.className = "strip";
    for (const col of paletteColors(key)) {
      const sw = document.createElement("span");
      sw.style.background = col;
      strip.append(sw);
    }
    b.append(check, name, strip);
    b.addEventListener("click", () => choosePalette(key));
    return b;
  };
  const group = (text) => {
    const g = document.createElement("div");
    g.className = "group";
    g.textContent = text;
    return g;
  };
  const keys = Object.keys(PALETTES);
  menu.replaceChildren(
    ...keys.filter((k) => !PALETTES[k].unchecked).map(option),
    group("Not colorblind-checked"),
    ...keys.filter((k) => PALETTES[k].unchecked).map(option)
  );
  menu.hidden = false;
  $("palette-button").setAttribute("aria-expanded", "true");
  // Bring the chosen palette into view inside the menu, without scrolling the page down to it
  const chosen = menu.querySelector('[aria-checked="true"]');
  if (chosen) {
    chosen.focus({ preventScroll: true });
    menu.scrollTop = Math.max(0, chosen.offsetTop - (menu.clientHeight - chosen.offsetHeight) / 2);
  }
}

function closePaletteMenu(refocus = false) {
  if ($("palette-menu").hidden) return;
  $("palette-menu").hidden = true;
  $("palette-button").setAttribute("aria-expanded", "false");
  if (refocus) $("palette-button").focus();
}

$("palette-button").addEventListener("click", () => ($("palette-menu").hidden ? openPaletteMenu() : closePaletteMenu()));
document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest(".palette-picker")) closePaletteMenu();
});
$("palette-menu").addEventListener("keydown", (e) => {
  const items = [...$("palette-menu").querySelectorAll(".palette-option")];
  const i = items.indexOf(document.activeElement);
  if (e.key === "Escape") closePaletteMenu(true);
  else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
  }
});
applyPalette();

let themeSwapping = false;
function flipTheme() {
  document.documentElement.dataset.theme = isDark() ? "light" : "dark";
  rerenderForTheme();
}
// The page changes theme through a circle at the toggle: light grows out of it, or shrinks back into it going dark.
// The charts are redrawn, not restyled, so this is what keeps them from snapping.
$("theme-toggle").addEventListener("click", async () => {
  const root = document.documentElement;
  if (!document.startViewTransition || !dur(MORPH_MS) || themeSwapping) return flipTheme();
  const b = $("theme-toggle").getBoundingClientRect();
  const x = b.left + b.width / 2, y = b.top + b.height / 2;
  const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const toDark = !isDark();
  const icon = $("theme-toggle").querySelector("svg"), ink = getComputedStyle(icon).color;
  themeSwapping = true;
  root.classList.add("theme-swap");
  root.classList.toggle("to-dark", toDark);
  const t = document.startViewTransition(flipTheme);
  try {
    await t.ready;
    // Light spreads out from the toggle; going dark, the light is drawn back into it. Held at its end (fill), or the
    // old light page shows whole for a frame before the transition is torn down.
    const open = `circle(${r}px at ${x}px ${y}px)`, shut = `circle(0px at ${x}px ${y}px)`;
    const anim = root.animate(
      { clipPath: toDark ? [open, shut] : [shut, open] },
      { duration: MORPH_MS, easing: EASE_IN_OUT.css, fill: "forwards", pseudoElement: toDark ? "::view-transition-old(root)" : "::view-transition-new(root)" }
    );
    // Going dark the icon still sits on the light page until the circle closes, so its ink follows the circle
    const inked = toDark && icon.animate({ color: [ink, getComputedStyle(icon).color] }, { duration: MORPH_MS, easing: EASE_IN_OUT.css });
    await t.finished;
    if (inked) inked.cancel();
    anim.cancel(); // or its held end carries into the next flip, hiding that one's old page
  } catch {}
  root.classList.remove("theme-swap", "to-dark");
  themeSwapping = false;
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", rerenderForTheme);

function rerenderForTheme() {
  applyPalette();
  const zoom = state.plays ? currentZoom($("chart-rolling")) : undefined;
  disposeAll();
  if (state.plays) renderAll(zoom);
  if (state.view === "community") renderCommunity(state.raw);
}
