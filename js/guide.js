// The guide in the Controls panel: a row per feature, each with a small copy of its control. The copies mirror the
// real controls (the view, the lengths and period, the artists in the key and their colors, the palette, the theme)
// and are refreshed whenever the panel opens or a mirrored control changes while it's open. The view, length and
// step copies pass a click on to the real control. Hovering a row rings the real control(s) on the page.
import { dur, FADE_MS } from "./motion.js";
import { $, noun } from "./state.js";

// The panel hangs under the period bar, so it covers as little as possible of the controls it points at, and
// stays there as the page scrolls (the bar sticks to the top). Without the bar it hangs from its button.
// Fixed to the window, so it's placed again on every scroll and resize while it's open
export function placeControls() {
  const panel = $("controls-panel");
  if (panel.hidden) return;
  const bar = document.querySelector(".period-bar");
  const button = $("controls-button").getBoundingClientRect();
  const top = (bar && !$("dashboard").hidden ? bar.getBoundingClientRect().bottom : button.bottom) + 8;
  panel.style.top = `${top}px`;
  panel.style.right = `${document.documentElement.clientWidth - button.right}px`;
  panel.style.maxHeight = `calc(100vh - ${top + 16}px)`;
}
let placing = 0;
const replace = () => (placing ||= requestAnimationFrame(() => ((placing = 0), placeControls())));
addEventListener("scroll", replace, { passive: true });
addEventListener("resize", replace);

// Copies of a segmented control's buttons, with their pressed state; a click on one clicks the real one
function mirrorSegments(copy, real) {
  copy.replaceChildren(
    ...[...real.children].filter((b) => !b.hidden).map((b) => {
      const c = document.createElement("button");
      c.type = "button";
      c.tabIndex = -1;
      c.textContent = b.textContent;
      c.setAttribute("aria-pressed", b.getAttribute("aria-pressed"));
      c.addEventListener("click", () => b.click());
      return c;
    })
  );
}

export function syncGuide() {
  mirrorSegments($("g-views"), $("view-tabs"));
  mirrorSegments($("g-lengths"), $("period-resize"));
  // A date is shortened ("Jul 14, 2025" to "Jul 14 '25") so the row never wraps
  $("g-year").textContent = $("year-label").textContent.replace(/,? \d\d(\d\d)$/, " '$1");
  $("g-search-text").textContent = $("artist-search").placeholder;
  $("g-palette").style.backgroundImage = $("palette-button").style.backgroundImage;
  // The theme icon, with its own mask id (the page's styles turn it with the theme, as they turn the real one)
  const icon = $("theme-toggle").querySelector("svg").cloneNode(true);
  icon.querySelector("mask").id = "g-moon-mask";
  icon.querySelector(".orb").setAttribute("mask", "url(#g-moon-mask)");
  $("g-theme").replaceChildren(icon);
  // The chips and tiles show the first artists in the key, in their own colors (names come from user files)
  const keyed = [...document.querySelectorAll("#artist-key [data-artist]:not(.other-chip)")];
  for (const el of document.querySelectorAll("#guide [data-n]")) {
    const real = keyed[+el.dataset.n];
    el.style.setProperty("--c", real ? real.style.getPropertyValue("--c") : `var(--series-${+el.dataset.n + 1})`);
    const name = real?.dataset.artist ?? noun().Many.slice(0, -1);
    for (const t of el.querySelectorAll(".name, .g-card")) t.textContent = name;
  }
}

// Mirrored controls can change while the panel is open (a click on a copy, or a view's new names)
const watch = new MutationObserver(() => syncGuide());
export function watchGuide(on) {
  watch.disconnect();
  if (!on) return ringOff();
  for (const id of ["view-tabs", "period-resize", "year-label", "artist-key"]) {
    watch.observe($(id), { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-pressed", "hidden"] });
  }
  syncGuide();
}

for (const s of document.querySelectorAll("#guide [data-forward]")) {
  s.addEventListener("click", () => document.querySelector(s.dataset.forward).click());
}

// ---------- Rings on the real controls ----------

let rings = [];
function ringOff() {
  for (const r of rings) {
    r.classList.remove("on");
    setTimeout(() => r.remove(), dur(FADE_MS));
  }
  rings = [];
}

// One ring per |-separated group of selectors, around everything the group matches
function ringOn(target) {
  ringOff();
  for (const group of target.split("|")) {
    const els = [...document.querySelectorAll(group)].filter((el) => el.getBoundingClientRect().width);
    if (!els.length) continue;
    const rects = els.map((el) => el.getBoundingClientRect());
    const b = {
      left: Math.min(...rects.map((r) => r.left)),
      top: Math.min(...rects.map((r) => r.top)),
      right: Math.max(...rects.map((r) => r.right)),
      bottom: Math.max(...rects.map((r) => r.bottom)),
    };
    if (b.bottom < 0 || b.top > innerHeight) continue;
    const r = document.createElement("div");
    r.className = "guide-ring";
    Object.assign(r.style, { left: `${b.left - 4}px`, top: `${b.top - 4}px`, width: `${b.right - b.left + 8}px`, height: `${b.bottom - b.top + 8}px` });
    // Rings sit under the panel: one around a control in the top bar goes in the bar (whose layer the panel tops),
    // the rest just above the period bar's layer (style.css)
    (els[0].closest(".topbar") ?? document.body).append(r);
    requestAnimationFrame(() => r.classList.add("on"));
    rings.push(r);
  }
}

for (const row of document.querySelectorAll(".guide-row")) {
  row.addEventListener("pointerenter", () => ringOn(row.dataset.target));
  row.addEventListener("pointerleave", ringOff);
}
addEventListener("scroll", ringOff, { passive: true });

// The guide opens and closes by growing, from a row in the panel
$("guide-toggle").addEventListener("click", () => {
  const open = $("guide-toggle").getAttribute("aria-expanded") !== "true";
  $("guide-toggle").setAttribute("aria-expanded", open);
  $("guide").classList.toggle("open", open);
  $("guide").inert = !open;
  if (open) syncGuide();
  else ringOff();
});
