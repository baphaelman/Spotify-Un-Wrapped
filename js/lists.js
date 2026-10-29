// Ranked list with inline bars: every value is readable without hovering.
// rows: [{ name, detail, value, frac, tag?, muted?, key? }]. Names come from user files, so textContent only.
// Rows are matched across renders by `key` (default: the name): one that stays glides to its new rank while
// its bar and number tween, and one that is new rises in with its bar growing from nothing.

import { MORPH_MS, dur, flip, tweenNumber } from "./motion.js";

const countOf = (text) => {
  const m = /^([\d,]+)(.*)$/.exec(text);
  return m ? { n: +m[1].replace(/,/g, ""), suffix: m[2] } : null;
};

export function renderList(ol, rows) {
  const old = new Map([...ol.children].filter((li) => li._key != null).map((li) => [li._key, li]));
  const before = new Map([...old].map(([k, li]) => [k, li.getBoundingClientRect()]));
  const els = new Map();
  const lis = rows.map((r, i) => {
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
    li.append(rank, name, val, bar);
    li._key = r.key ?? r.name;
    li._frac = frac;
    li._count = countOf(r.value);
    if (!els.has(li._key)) els.set(li._key, li);

    const was = old.get(li._key);
    const total = dur(MORPH_MS);
    if (total) {
      bar.animate([{ width: `${(was?._frac ?? 0) * 100}%` }, { width: `${frac * 100}%` }], {
        duration: total, delay: was ? 0 : Math.min(i * 18, 240), easing: "cubic-bezier(.65,0,.35,1)", fill: "backwards",
      });
      if (was?._count && li._count) {
        tweenNumber(val, li._count.n, { from: was._count.n, format: (n) => Math.round(n).toLocaleString() + li._count.suffix });
      }
    }
    return li;
  });
  ol.replaceChildren(...lis);
  flip(before, els);
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
    if (count && !count.suffix) {
      tweenNumber(value, count.n, { from: reuse ? undefined : 0 });
    } else {
      cancelAnimationFrame(value._raf);
      value._num = undefined;
      value.textContent = text;
    }
  });
}
