// Ranked list with inline bars: every value is readable without hovering.
// rows: [{ name, detail, value, frac, tag?, muted?, key? }]. Names come from user files, so textContent only.
// Rows are matched across renders by `key` (default: the name): one that stays glides to its new rank while
// its bar and number tween, and one that is new rises in with its bar growing from nothing.

import { MORPH_MS, STAGGER_MS, STAGGER_MAX_MS, EASE_IN_OUT, dur, flip, tweenNumber } from "./motion.js";

// A value's leading number ("1,204 plays", "3.5 h"), so it can count to its next value
const countOf = (text) => {
  const m = /^(\d[\d,]*(?:\.(\d+))?)(.*)$/.exec(text);
  return m ? { n: +m[1].replace(/,/g, ""), dec: m[2]?.length ?? 0, suffix: m[3] } : null;
};
const formatCount = ({ dec, suffix }) => (n) =>
  n.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec }) + suffix;

export function renderList(ol, rows) {
  const old = new Map([...ol.children].filter((li) => li._key != null).map((li) => [li._key, li]));
  const before = new Map([...old].map(([k, li]) => [k, li.getBoundingClientRect()]));
  const els = new Map();
  const lis = rows.map((r, i) => {
    const li = makeRow(r, i);
    if (!els.has(li._key)) els.set(li._key, li);

    const was = old.get(li._key);
    const total = dur(MORPH_MS);
    if (total) {
      li._bar.animate([{ width: `${(was?._frac ?? 0) * 100}%` }, { width: `${li._frac * 100}%` }], {
        duration: total, delay: was ? 0 : Math.min(i * STAGGER_MS, STAGGER_MAX_MS), easing: EASE_IN_OUT.css, fill: "backwards",
      });
      if (was?._count && li._count && was._count.suffix === li._count.suffix) {
        tweenNumber(li._val, li._count.n, { from: was._count.n, format: formatCount(li._count) });
      }
    }
    return li;
  });
  ol.replaceChildren(...lis);
  flip(before, els);
}

// Adds rows to the end of a list (the next chunk of a long one): they rise in, staggered, their bars growing
export function appendList(ol, rows, start = ol.children.length) {
  const els = new Map();
  const lis = rows.map((r, i) => {
    const li = makeRow(r, start + i);
    els.set(li._key + "\u0000" + (start + i), li);
    const total = dur(MORPH_MS);
    if (total) {
      li._bar.animate([{ width: "0%" }, { width: `${li._frac * 100}%` }], {
        duration: total, delay: Math.min(i * STAGGER_MS, STAGGER_MAX_MS), easing: EASE_IN_OUT.css, fill: "backwards",
      });
    }
    return li;
  });
  ol.append(...lis);
  flip(new Map(), els);
}

function makeRow(r, i) {
  const li = document.createElement("li");
  const rank = document.createElement("span");
  rank.className = "rank";
  rank.textContent = i + 1;
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = r.name;
  name.title = r.detail ? `${r.name} — ${r.detail}` : r.name;
  if (r.tag) {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = r.tag;
    name.append(tag);
  }
  if (r.detail) {
    const small = document.createElement("small");
    small.textContent = r.detail;
    name.append(small);
  }
  const val = document.createElement("span");
  val.className = "val";
  val.textContent = r.value;
  const bar = document.createElement("span");
  bar.className = "bar" + (r.muted ? " muted-bar" : "");
  const frac = Math.max(0, Math.min(1, r.frac));
  bar.style.width = `${frac * 100}%`;
  if (r.color) li.style.setProperty("--c", r.color); // on the row, so a hover tint can use it too
  li.append(rank, name, val, bar);
  li._key = r.key ?? r.name;
  li._frac = frac;
  li._count = countOf(r.value);
  li._bar = bar;
  li._val = val;
  return li;
}

// Stat tiles: [{ label, value, sub, hero? }]. The same tiles are kept between renders, and numbers count to
// their new value.
export function renderTiles(el, tiles) {
  const reuse = el.children.length === tiles.length;
  if (!reuse) el.replaceChildren(...tiles.map(() => document.createElement("div")));
  tiles.forEach((t, i) => {
    const tile = el.children[i];
    tile.className = "stat" + (t.hero ? " hero" : "");
    if (!tile.children.length) {
      for (const cls of ["label", "value", "sub"]) {
        const d = document.createElement("div");
        d.className = cls;
        tile.append(d);
      }
    }
    const [label, value, sub] = tile.children;
    label.textContent = t.label ?? "";
    sub.textContent = t.sub ?? "";
    const text = t.value ?? "";
    const count = countOf(text);
    if (count && !count.suffix && !count.dec) {
      tweenNumber(value, count.n, { from: reuse ? undefined : 0 });
    } else {
      cancelAnimationFrame(value._raf);
      value._num = undefined;
      value.textContent = text;
    }
  });
}
