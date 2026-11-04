// Colors as the code reads them: the CSS tokens (style.css, light and dark in one place) and blends of them.

import { SHADE_TOKENS } from "./motion.js";

// Read again on each paint, so a theme or palette flip shows on the next one
export function tokens() {
  // body, not the root: a chosen palette overrides the series colors there (see theme.js)
  const css = getComputedStyle(document.body);
  const v = (name) => css.getPropertyValue(name).trim();
  return {
    surface: v("--surface"),
    primary: v("--text-primary"),
    secondary: v("--text-secondary"),
    muted: v("--text-muted"),
    grid: v("--grid"),
    axis: v("--axis"),
    accent: v("--accent"),
    other: v("--other"),
    series: Array.from({ length: 10 }, (_, i) => v(`--series-${i + 1}`)),
    seq: [0, 1, 2, 3, 4, 5].map((i) => v(`--seq-${i}`)),
    // The hover/pin rule's steps (the --shade-* and --fade-* tokens), keyed by litLook's looks: the share of the
    // artist's color mixed into the surface for a band in each look, the opacity of the fill under a lit hours
    // line in each, and how strongly a dimmed line shows
    shade: Object.fromEntries(
      Object.entries(SHADE_TOKENS).map(([look, name]) => [look, +v(`--shade-${name}`)])
    ),
    line: { hover: +v("--shade-line"), pin: +v("--shade-line-pin"), pinHover: +v("--shade-line-pin-hover") },
    fade: { rest: 1, hover: 1, pin: 1, pinHover: 1, dim: +v("--fade-dim"), dimHover: +v("--fade-dim-hover") },
    // how strongly a dimmed item shows (the --dim-item tokens), for marks that fade as a whole
    dimItem: { rest: 1, hover: 1, pin: 1, pinHover: 1, dim: +v("--dim-item"), dimHover: +v("--dim-item-hover") },
    font: css.fontFamily,
  };
}

// Blend two hex colors; w is the share of b
export function mix(a, b, w) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return "#" + x.map((v, i) => Math.round(v * (1 - w) + y[i] * w).toString(16).padStart(2, "0")).join("");
}

// A hex color at opacity a
export function alpha(hex, a) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${a})`;
}
