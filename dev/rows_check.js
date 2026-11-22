// A row plot's flight, row by row (docs/arrivals.md): an EVAL for dev/shot.py, with __CARD__ (the card's id) and
// __BAR__ (a selector for each row's bar in the card) filled in:
//   EVAL="$(sed -e s/__CARD__/skips-card/ -e 's/__BAR__/#skips-list .skips-bar/' dev/rows_check.js)" OFFLINE=1 \
//     python3 dev/shot.py "http://localhost:<port>/test.html?v=$RANDOM" /tmp/x.png 1280 1000
// While the thumbnail shows (20 and 120 ms into an open, 650 and 745 ms into a close: every animation paused at the
// moment), each card bar's left, width and top on screen against the thumbnail's bar in the same place (both taken in order, top to bottom; a thumbnail bar is its series with ids starting "bar", as one box per
// row). Prints the worst difference of each, the rows compared, and any card bars the thumbnail lacks that still show.
(async () => {
  const CARD = "__CARD__", BAR = "__BAR__";
  const dur = 750; // MORPH_MS
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60 && !document.getElementById("thumb-" + CARD)?.offsetParent; i++) await wait(250);
  await wait(1000);
  const errs = [];
  addEventListener("error", (e) => errs.push(e.message));
  const th = document.getElementById("thumb-" + CARD), tile = th.closest(".gal-tile");
  tile.scrollIntoView({ block: "center" });
  await wait(600);
  const thumbBars = () => {
    const c = echarts.getInstanceByDom(th), R = th.getBoundingClientRect(), k = R.width / th.offsetWidth;
    const rows = [];
    c.getModel().eachSeries((s) => {
      if (!String(s.id).startsWith("bar")) return;
      const d = s.getData();
      d.each((i) => {
        const l = d.getItemLayout(i);
        if (!l || !(Math.abs(l.width) > 0.01)) return;
        const x = Math.min(l.x, l.x + l.width), y = Math.min(l.y, l.y + l.height);
        const b = rows[i] ?? (rows[i] = { l: 1e9, t: 1e9, r: -1e9, b: -1e9 });
        b.l = Math.min(b.l, x); b.t = Math.min(b.t, y); b.r = Math.max(b.r, x + Math.abs(l.width)); b.b = Math.max(b.b, y + Math.abs(l.height));
      });
    });
    return rows.filter(Boolean).map((b) => ({ left: R.left + b.l * k, top: R.top + b.t * k, width: (b.r - b.l) * k })).sort((a, b) => a.top - b.top);
  };
  const cardBars = () => [...document.querySelectorAll(BAR)].filter((e) => +getComputedStyle(e).opacity > 0.05 && e.closest("li") && +getComputedStyle(e.closest("li")).opacity > 0.05)
    .map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0).sort((a, b) => a.top - b.top);
  const T0 = thumbBars();
  const compare = (label) => {
    const C = cardBars();
    const n = Math.min(C.length, T0.length);
    let dl = 0, dw = 0, dt = 0;
    for (let i = 0; i < n; i++) {
      dl = Math.max(dl, Math.abs(C[i].left - T0[i].left));
      dw = Math.max(dw, Math.abs(C[i].width - T0[i].width));
      dt = Math.max(dt, Math.abs(C[i].top - T0[i].top));
    }
    return `${label}  rows ${n}/${T0.length} (card ${C.length})  worst: left ${dl.toFixed(1)}  width ${dw.toFixed(1)}  top ${dt.toFixed(1)}`;
  };
  // (every animation paused and sought to the moment, so a busy machine's late timers don't skew it)
  const at = async (ms) => {
    for (const a of document.getAnimations()) { a.pause(); a.currentTime = ms; }
    await new Promise((r) => requestAnimationFrame(() => r()));
  };
  const out = [];
  tile.click();
  for (const t of [20, 120]) {
    await at(t);
    out.push(compare(`open ${t}ms`.padEnd(12)));
  }
  await at(dur);
  for (const a of document.getAnimations()) a.play();
  await wait(1000);
  document.querySelector(".gal-back").click();
  for (const t of [650, 745]) {
    await at(t);
    out.push(compare(`close ${t}ms`.padEnd(12)));
  }
  for (const a of document.getAnimations()) a.play();
  await wait(1000);
  return [...out, "errors: " + JSON.stringify(errs)].join("\n");
})().catch((e) => "ERR " + e.stack);
