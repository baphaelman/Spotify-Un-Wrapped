// The graphs' hidden variables: line widths, tints, blur and cutoffs that are otherwise fixed. The code reads
// them from `tune` rather than from literals. With the settings panel's "Visual tweaks" off, `tune`
// holds the defaults (TUNES), so the page is exactly as designed; on, it holds the reader's values, remembered
// on this device, and each card shows a row of sliders for its own (buildTunes).
// Imports nothing, so anything can read it (it comes before state.js).

// card: the id of the card whose row holds the slider. fmt: how its value reads. Multipliers (×) scale a value
// that differs by theme or by setting, so their default is 1.
const x = (v) => `×${(+v).toFixed(2).replace(/\.?0+$/, "")}`;
const px = (v) => `${+v} px`;
const h = (v) => `${+v} h`;
export const TUNES = [
  { key: "bandTint", card: "rolling-card", label: "Band tint", def: 1, min: 0.05, max: 3, step: 0.05, fmt: x },
  { key: "hoverTint", card: "rolling-card", label: "Lit band tint", def: 1, min: 0.05, max: 3, step: 0.05, fmt: x },
  { key: "dimTint", card: "rolling-card", label: "Dimmed band tint", def: 1, min: 0, max: 5, step: 0.1, fmt: x },
  { key: "edgeWidth", card: "rolling-card", label: "Edge width", def: 1.5, min: 0, max: 5, step: 0.25, fmt: px },
  { key: "partDepth", card: "rolling-card", label: "Part shading", def: 1, min: 0, max: 3, step: 0.05, fmt: x },
  { key: "blurScale", card: "rolling-card", label: "Blur", def: 1, min: 0, max: 4, step: 0.05, fmt: x },
  { key: "curveScale", card: "rolling-card", label: "Curve rounding", def: 1, min: 0, max: 1.5, step: 0.05, fmt: x },
  { key: "hoursLine", card: "hours-card", label: "Line width", def: 1.5, min: 0.25, max: 6, step: 0.25, fmt: px },
  { key: "lineFill", card: "hours-card", label: "Lit line fill", def: 1, min: 0, max: 6, step: 0.1, fmt: x },
  { key: "maxBars", card: "monthly-card", label: "Most bars", def: 18, min: 4, max: 60, step: 1, fmt: (v) => `${v}` },
  { key: "barGap", card: "monthly-card", label: "Gap between bars", def: 30, min: 0, max: 90, step: 5, fmt: (v) => `${v}%` },
  { key: "clockReach", card: "clock-card", label: "Blur reach", def: 4, min: 0, max: 12, step: 0.5, fmt: h },
  { key: "clockMinBlur", card: "clock-card", label: "Least blur", def: 0.5, min: 0, max: 4, step: 0.25, fmt: h },
  { key: "clockCurve", card: "clock-card", label: "Least curve rounding", def: 0.3, min: 0, max: 1, step: 0.05, fmt: (v) => `${v}` },
  { key: "sharePx", card: "mix-card", label: "Shows % from", def: 30, min: 0, max: 200, step: 2, fmt: px },
  { key: "hoursPx", card: "mix-card", label: "Shows hours from", def: 48, min: 0, max: 200, step: 2, fmt: px },
];
const DEFAULTS = Object.fromEntries(TUNES.map((s) => [s.key, s.def]));

// What the graphs read
export const tune = { ...DEFAULTS };

// The reader's values (only the ones they changed are stored)
const STORE = "unwrapped-tunes";
let mine = {};
try { mine = JSON.parse(localStorage.getItem(STORE)) ?? {}; } catch {}
const save = () => {
  try { localStorage.setItem(STORE, JSON.stringify(mine)); } catch {}
};
let on = false;

// Whether the reader has changed any value
export const tunesChanged = () => Object.keys(mine).length > 0;

// Everything on or off: the graphs read the reader's values, or the defaults
export function useTunes(everything) {
  on = everything;
  for (const s of TUNES) tune[s.key] = on && Number.isFinite(mine[s.key]) ? mine[s.key] : s.def;
  for (const row of document.querySelectorAll(".tune-row")) {
    row.classList.toggle("on", on);
    row.inert = !on;
  }
  syncInputs();
}

const inputs = new Map(); // key -> { input, val, spec }
function syncInputs() {
  for (const { input, val, spec } of inputs.values()) {
    const v = Number.isFinite(mine[spec.key]) ? mine[spec.key] : spec.def;
    input.value = v;
    input.style.setProperty("--p", (v - spec.min) / (spec.max - spec.min)); // the fill, as the page's sliders (style.css)
    val.textContent = spec.fmt(v);
    val.classList.toggle("changed", v !== spec.def);
  }
  for (const btn of document.querySelectorAll(".tune-reset")) {
    btn.disabled = !TUNES.some((s) => s.card === btn.dataset.card && Number.isFinite(mine[s.key]));
  }
}

// A row of sliders at the foot of each card, folded away until everything's on. redraw(card) redraws what that
// card shows, through the page's usual paths; it's called at most once a frame while a slider is dragged.
export function buildTunes(redraw) {
  const pending = new Set();
  let raf = 0;
  const later = (card) => {
    pending.add(card);
    raf ||= requestAnimationFrame(() => {
      raf = 0;
      const cards = [...pending];
      pending.clear();
      for (const c of cards) redraw(c);
    });
  };
  const set = (spec, v) => {
    if (v === spec.def) delete mine[spec.key];
    else mine[spec.key] = v;
    save();
    if (on) tune[spec.key] = v;
    syncInputs();
    later(spec.card);
  };
  for (const card of new Set(TUNES.map((s) => s.card))) {
    const host = document.getElementById(card);
    if (!host) continue;
    const row = document.createElement("div");
    row.className = "tune-row";
    const inner = document.createElement("div");
    const grid = document.createElement("div");
    grid.className = "tune-grid";
    for (const spec of TUNES.filter((s) => s.card === card)) {
      const label = document.createElement("label");
      label.className = "tune";
      const name = document.createElement("span");
      name.className = "tune-name";
      name.textContent = spec.label;
      const input = document.createElement("input");
      input.type = "range";
      input.min = spec.min;
      input.max = spec.max;
      input.step = spec.step;
      input.value = spec.def;
      const val = document.createElement("span");
      val.className = "tune-val";
      const def = document.createElement("span");
      def.className = "tune-def";
      def.textContent = `default ${spec.fmt(spec.def)}`;
      input.addEventListener("input", () => set(spec, +input.value));
      // A double-click puts it back
      input.addEventListener("dblclick", () => set(spec, spec.def));
      const slider = document.createElement("span");
      slider.className = "slider";
      slider.append(input);
      label.append(name, val, slider, def);
      grid.append(label);
      inputs.set(spec.key, { input, val, spec });
    }
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "ghost tune-reset";
    reset.dataset.card = card;
    reset.textContent = "Reset";
    reset.title = "Put this card's settings back to their defaults";
    reset.addEventListener("click", () => {
      for (const spec of TUNES.filter((s) => s.card === card)) {
        delete mine[spec.key];
        if (on) tune[spec.key] = spec.def;
      }
      save();
      syncInputs();
      later(card);
    });
    grid.append(reset);
    inner.append(grid);
    row.append(inner);
    host.append(row);
    row.classList.toggle("on", on);
    row.inert = !on;
  }
  syncInputs();
}
