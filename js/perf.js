// ?perf in the address: a readout, in a corner, of what each action costs on this screen, for tuning where headless
// can't (a real refresh rate, a Retina canvas). An action is a click, a key, or a control's input; for 3 s after it:
// how long its handlers took, when its first frame was done, each paint the change queued for later (state.js soon:
// the thumbnails on screen, the open graph's neighbours, …) and each idle paint, by when it started and how long it
// took, and every frame slower than 20 ms. The last action shows in full, the ones before in a line; Copy puts them
// all on the clipboard as text. Loaded by main.js only with ?perf; the page doesn't import it otherwise.
import { hooks } from "./state.js";

const WATCH_MS = 3000; // how long after an action its paints and frames count
const SLOW_MS = 20; // a frame longer than this is listed
const KEEP = 8; // actions kept
const actions = [];
let cur = null;

const ms = (x) => Math.round(x);
// "▫rank" for Rank race's thumbnail, "rank" for its card
const label = (k) => {
  if (typeof k === "string") return k;
  const id = k?.id || k?.closest?.("[id]")?.id || k?.tagName?.toLowerCase() || "?";
  return id.startsWith("thumb-") ? "▫" + id.slice(6).replace(/-card$/, "") : id.replace(/-card$/, "");
};
const named = (t) => {
  const id = t.closest?.("[id]")?.id ?? "";
  const words = (t.getAttribute?.("aria-label") || t.textContent || t.value || "").trim().replace(/\s+/g, " ").slice(0, 24);
  return [id && "#" + id, words && `"${words}"`].filter(Boolean).join(" ");
};

// ---------- Listening ----------
const box = document.createElement("div");
const onAction = (e) => {
  if (box.contains(e.target)) return;
  if (e.type === "keydown" && !["Enter", " ", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
  const at = e.timeStamp || performance.now();
  // (an input and its change, a label's click and its box's: one action)
  if (cur && at - cur.t0 < 100) return;
  const a = (cur = { what: `${e.type} ${named(e.target)}`, t0: at, delay: performance.now() - at, paints: [], slow: [], frames: 0 });
  actions.push(a);
  if (actions.length > KEEP) actions.shift();
  const ch = new MessageChannel();
  ch.port1.onmessage = () => (a.handlers = performance.now() - at);
  ch.port2.postMessage(0);
  requestAnimationFrame(() => setTimeout(() => (a.firstFrame = performance.now() - at)));
  watch();
  show();
  setTimeout(() => {
    a.done = true;
    if (cur === a) cur = null;
    show();
  }, WATCH_MS);
};
for (const type of ["click", "input", "change", "keydown"]) addEventListener(type, onAction, true);

hooks.perf = (kind, key, start, rank) => {
  const a = actions.findLast((x) => !x.done && start >= x.t0);
  if (a) a.paints.push({ kind, who: label(key), at: start - a.t0, ms: performance.now() - start, rank });
};

// Frames, while any action is being watched
let looping = false, last = 0;
function watch() {
  if (looping) return;
  looping = true;
  last = performance.now();
  const loop = (t) => {
    const live = actions.filter((a) => !a.done);
    for (const a of live) {
      if (t < a.t0) continue;
      a.frames++;
      if (t - last > SLOW_MS) a.slow.push([last - a.t0, t - last]);
    }
    last = t;
    if (live.length) requestAnimationFrame(loop);
    else looping = false;
  };
  requestAnimationFrame(loop);
}

// ---------- The readout ----------
function full(a) {
  const n = (x) => (x == null ? "…" : ms(x) + " ms");
  const lines = [a.what + (a.done ? "" : "  (measuring)")];
  lines.push(`  handlers ${n(a.handlers)} · first frame done at ${n(a.firstFrame)} · waited ${n(a.delay)} to start`);
  const slowSum = a.slow.reduce((s, [, d]) => s + d, 0);
  lines.push(`  ${a.frames} frames in ${WATCH_MS / 1000} s; ${a.slow.length} over ${SLOW_MS} ms` +
    (a.slow.length ? ` (${ms(slowSum)} ms): ` + a.slow.map(([at, d]) => `${ms(at)}+${ms(d)}`).join(" ") : ""));
  for (const [kind, title] of [["soon", "queued"], ["idle", "idle"]]) {
    const ps = a.paints.filter((p) => p.kind === kind);
    if (!ps.length) continue;
    const sum = ps.reduce((s, p) => s + p.ms, 0);
    lines.push(`  ${title} ${ps.length}, ${ms(sum)} ms, last at ${ms(ps.at(-1).at)}: ` + ps.map((p) => `${p.who} ${ms(p.at)}+${ms(p.ms)}`).join(" · "));
  }
  return lines.join("\n");
}
const brief = (a) => `${a.what}: handlers ${a.handlers == null ? "…" : ms(a.handlers)} ms, ${a.slow.length} slow frames, ` +
  `${a.paints.length} paints, last at ${a.paints.length ? ms(Math.max(...a.paints.map((p) => p.at))) : "-"} ms`;

box.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:10000;max-width:min(520px,calc(100vw - 24px));" +
  "max-height:45vh;overflow:auto;padding:8px 10px;border-radius:8px;border:1px solid var(--border);" +
  "background:var(--surface-2);color:var(--text-secondary);font:11px/1.45 ui-monospace,Menlo,monospace;" +
  "box-shadow:0 4px 16px rgba(0,0,0,.25)";
const bar = document.createElement("div");
bar.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:4px;color:var(--text-primary)";
const title = document.createElement("strong");
title.textContent = "perf";
title.style.flex = "1";
const button = (text, fn) => {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.style.cssText = "font:inherit;color:inherit;background:none;border:1px solid var(--border);border-radius:4px;padding:0 6px;cursor:pointer";
  b.addEventListener("click", fn);
  return b;
};
const text = document.createElement("pre");
text.style.cssText = "margin:0;white-space:pre-wrap;word-break:break-word";
bar.append(title,
  button("Copy", (e) => {
    const all = actions.map(full).join("\n\n") + `\n\n${innerWidth}×${innerHeight} @${devicePixelRatio}x, ${navigator.userAgent}`;
    navigator.clipboard?.writeText(all).then(() => (e.target.textContent = "Copied"), () => (e.target.textContent = "Copy failed"));
    setTimeout(() => (e.target.textContent = "Copy"), 1500);
  }),
  button("Clear", () => {
    actions.length = 0;
    show();
  }),
  button("–", (e) => {
    text.hidden = !text.hidden;
    e.target.textContent = text.hidden ? "+" : "–";
  }),
);
box.append(bar, text);
document.body.append(box);
// (written only as an action starts and ends, so the readout doesn't cost the frames it measures)
function show() {
  const last = actions.at(-1);
  text.textContent = last ? [full(last), ...actions.slice(0, -1).reverse().map(brief)].join("\n") : "Click, pin, hide or change a setting.";
}
show();
