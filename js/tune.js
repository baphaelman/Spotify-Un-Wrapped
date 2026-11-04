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
// A spec with `live` is also set from the graph itself, so its value applies with the switch off too.
// A spec with `options` is a dropdown of named choices rather than a slider; its value is the chosen index.
// A spec with `idle(values)` shows dimmed while another value leaves it with little to do.
const SKIPS_LOOKS = ["Horizontal bars", "Vertical bars"];
const SUN_REACH = ["A circle", "Out to the card"];
const SUN_TEETH = ["Left empty", "One piece", "Light line", "Ring gaps", "Lighter"];
const LANE_LOOKS = ["Dots on a line", "Shaded lane", "Ruler ticks", "Track with holes", "Dots over a dashed rule", "Framed strip"];
const CURSOR_LOOKS = ["Thick white line", "Thin line", "Soft column", "Column and line", "Glowing line"];
const DENSITY_LOOKS = ["Default (played bright)", "Gray, blue played", "Blue", "Gray, white played", "Green", "Amber", "Orange", "Pink", "Violet", "Line only"];
const PLAY_LOOKS = ["Bare", "Filled circle", "Ring", "Soft circle"];
const PLAY_CHANGES = ["Morph", "Morph and turn", "Shrink and grow"];
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
  // (only the least gap while ridgeFollow is on, so it shows dimmed)
  { key: "ridgeGap", card: "hours-card", label: "Distance between graphs", def: 24, min: 4, max: 70, step: 1, fmt: px, idle: (v) => v.ridgeFollow > 0 },
  // (0: every gap ridgeGap; more: a tall ridge lifts the ones above it, see ridgeLayout)
  { key: "ridgeFollow", card: "hours-card", label: "Distance follows the peak below", def: 0.5, min: 0, max: 1.5, step: 0.05, fmt: (v) => (+v ? `${Math.round(v * 100)}% of it` : "Off (even)") },
  { key: "maxBars", card: "monthly-card", label: "Most bars", def: 18, min: 4, max: 60, step: 1, fmt: (v) => `${v}` },
  { key: "barGap", card: "monthly-card", label: "Gap between bars", def: 30, min: 0, max: 90, step: 5, fmt: (v) => `${v}%` },
  { key: "clockReach", card: "clock-card", label: "Blur reach", def: 4, min: 0, max: 12, step: 0.5, fmt: h },
  { key: "clockMinBlur", card: "clock-card", label: "Least blur", def: 0.5, min: 0, max: 4, step: 0.25, fmt: h },
  { key: "clockCurve", card: "clock-card", label: "Least curve rounding", def: 0.3, min: 0, max: 1, step: 0.05, fmt: (v) => `${v}` },
  { key: "rasterHeight", card: "raster-card", label: "Height", def: 400, min: 260, max: 1100, step: 10, fmt: px },
  // (Every day's too)
  { key: "waitFade", card: "raster-card", label: "Shown while the period moves", def: 0.6, min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  // (the same in every layout; the boxes' height fills it)
  { key: "calendarHeight", card: "calendar-card", label: "Height", def: 240, min: 160, max: 600, step: 10, fmt: px },
  { key: "discoveryFloor", card: "discovery-card", label: "Listening Threshold", def: 1, min: 0.25, max: 60, step: 0.25, live: true, fmt: (v) => (v >= 60 ? "1 hour" : `${v} min`) },
  { key: "discoveryDot", card: "discovery-card", label: "Dot size", def: 5, min: 2, max: 12, step: 0.5, fmt: px },
  { key: "discoveryNameGap", card: "discovery-card", label: "Room around gray names", def: 18, min: 0, max: 60, step: 2, fmt: px },
  { key: "densityLook", card: "race-card", label: "Strip color", def: 0, options: DENSITY_LOOKS, fmt: (v) => DENSITY_LOOKS[v] },
  { key: "playLook", card: "race-card", label: "Play button", def: 0, options: PLAY_LOOKS, fmt: (v) => PLAY_LOOKS[v] },
  { key: "playChange", card: "race-card", label: "Play ↔ pause", def: 0, options: PLAY_CHANGES, fmt: (v) => PLAY_CHANGES[v] },
  { key: "raceRate", card: "race-card", label: "1× speed", def: 7, min: 1, max: 30, step: 0.5, fmt: (v) => `${v} days/s` },
  // (also set by the card's Positions slider, which goes to 20)
  { key: "rankMax", card: "rank-card", label: "Positions", def: 12, min: 4, max: 40, step: 1, live: true, fmt: (v) => `${v}` },
  { key: "rankDot", card: "rank-card", label: "Circle size (your artists)", def: 11, min: 2, max: 20, step: 0.5, fmt: px },
  { key: "rankGrayDot", card: "rank-card", label: "Circle size (others)", def: 8, min: 0, max: 16, step: 0.5, fmt: px },
  { key: "rankWidth", card: "rank-card", label: "Line width (your artists)", def: 3.5, min: 0.5, max: 8, step: 0.25, fmt: px },
  { key: "rankGrayWidth", card: "rank-card", label: "Line width (others)", def: 2.5, min: 0, max: 5, step: 0.1, fmt: px },
  { key: "rankGrayOpacity", card: "rank-card", label: "Opacity of other lines", def: 0.55, min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: "rankGrayText", card: "rank-card", label: "Opacity of other names", def: 1, min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: "rankText", card: "rank-card", label: "Name size", def: 10, min: 7, max: 18, step: 0.5, fmt: px },
  { key: "rankDim", card: "rank-card", label: "Dimming of the rest when one is lit", def: 0.25, min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}% left` },
  { key: "rankCursor", card: "rank-card", label: "Where you are", def: 2, options: CURSOR_LOOKS, fmt: (v) => CURSOR_LOOKS[v] },
  { key: "rankLane", card: "rank-card", label: "The timeline", def: 0, options: LANE_LOOKS, fmt: (v) => LANE_LOOKS[v] },
  { key: "rankDive", card: "rank-card", label: "How far lines dive below the chart", def: 1.6, min: 0.2, max: 4, step: 0.1, fmt: x },
  { key: "sharePx", card: "mix-card", label: "Shows % from", def: 30, min: 0, max: 200, step: 2, fmt: px },
  // (smaller slices fold into their parent's "Other …" until it's gone into)
  { key: "sunMinShare", card: "sunburst-card", label: "Smallest slice", def: 1.5, min: 0.25, max: 5, step: 0.25, fmt: (v) => `${v}% of the middle` },
  { key: "sunReach", card: "sunburst-card", label: "Outer ring", def: 1, options: SUN_REACH, fmt: (v) => SUN_REACH[v] },
  // (a slice with nothing drawn outside it: its rings left empty, or it reaching out to the edge, marked or not)
  { key: "sunTeeth", card: "sunburst-card", label: "Slices with nothing outside", def: 2, options: SUN_TEETH, fmt: (v) => SUN_TEETH[v] },
  { key: "sunMargin", card: "sunburst-card", label: "Margin to the card", def: 12, min: 0, max: 48, step: 2, fmt: px, idle: (v) => !v.sunReach },
  { key: "skipsLook", card: "skips-card", label: "Bars", def: 0, options: SKIPS_LOOKS, fmt: (v) => SKIPS_LOOKS[v] },
  { key: "skipsBar", card: "skips-card", label: "Bar thickness", def: 18, min: 4, max: 40, step: 1, fmt: px },
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

// Sets a value from the graph itself (a `live` spec), redrawing its card
let setFromGraph = () => {};
export const setTune = (key, v) => setFromGraph(key, v);

// Everything on or off: the graphs read the reader's values, or the defaults
export function useTunes(everything) {
  on = everything;
  for (const s of TUNES) tune[s.key] = (on || s.live) && Number.isFinite(mine[s.key]) ? mine[s.key] : s.def;
  for (const row of document.querySelectorAll(".tune-row")) {
    row.classList.toggle("on", on);
    row.inert = !on;
  }
  // Options kept from earlier choices (a faster speed, say) show only while it's on
  for (const el of document.querySelectorAll(".tweak-only")) el.hidden = !on;
  syncInputs();
}

const inputs = new Map(); // key -> { input, val, spec }
function syncInputs() {
  for (const { input, val, spec } of inputs.values()) {
    const v = Number.isFinite(mine[spec.key]) ? mine[spec.key] : spec.def;
    input.value = v;
    if (!spec.options) input.style.setProperty("--p", (v - spec.min) / (spec.max - spec.min)); // the fill, as the page's sliders (style.css)
    val.textContent = spec.fmt(v);
    val.classList.toggle("changed", v !== spec.def);
  }
  const values = Object.fromEntries(TUNES.map((s) => [s.key, Number.isFinite(mine[s.key]) ? mine[s.key] : s.def]));
  for (const { input, spec } of inputs.values()) input.closest(".tune")?.classList.toggle("idle", !!spec.idle?.(values));
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
    if (on || spec.live) tune[spec.key] = v;
    syncInputs();
    later(spec.card);
  };
  setFromGraph = (key, v) => set(TUNES.find((s) => s.key === key), v);
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
      const input = document.createElement(spec.options ? "select" : "input");
      if (spec.options) {
        spec.options.forEach((o, i) => input.append(new Option(o, i)));
      } else {
        input.type = "range";
        input.min = spec.min;
        input.max = spec.max;
        input.step = spec.step;
      }
      input.value = spec.def;
      const val = document.createElement("span");
      val.className = "tune-val";
      const def = document.createElement("span");
      def.className = "tune-def";
      def.textContent = `default ${spec.fmt(spec.def)}`;
      input.addEventListener("input", () => set(spec, +input.value));
      // A double-click puts it back
      input.addEventListener("dblclick", () => set(spec, spec.def));
      let control = input;
      if (!spec.options) {
        control = document.createElement("span");
        control.className = "slider";
        control.append(input);
      }
      label.append(name, val, control, def);
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
        if (on || spec.live) tune[spec.key] = spec.def;
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
