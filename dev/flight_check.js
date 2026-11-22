// A gallery flight in numbers (docs/arrivals.md): an EVAL for dev/shot.py, with __CARD__ (the card's id) and __PLOT__
// (its plot's selector, gallery.js PLOT) filled in:
//   EVAL="$(sed -e s/__CARD__/monthly-card/ -e 's/__PLOT__/#chart-monthly/' dev/flight_check.js)" OFFLINE=1 \
//     python3 dev/shot.py "http://localhost:<port>/test.html?v=$RANDOM" /tmp/x.png 1280 1000
// Prints, at moments of an open and a close: the thumbnail's and the plot's shapes on screen as one box (left, top,
// width, height of their series' shapes; an element's own box when it isn't ECharts), the thumbnail's opacity and the
// card header's. A solid flight's two boxes agree within a few px while the thumbnail shows. Then: an open/close round
// trip's scroll and tile position (equal), Esc midway through an open and a tile click midway through a close (each
// lands, the card back to itself), and any errors. Finer checks (per bar, per row) are the graph's own: add them.
(async () => {
  const CARD = "__CARD__", PLOT = "__PLOT__";
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // (until the history has loaded and the tile shows)
  for (let i = 0; i < 60 && !document.getElementById("thumb-" + CARD)?.offsetParent; i++) await wait(250);
  await wait(1000);
  const errs = [];
  addEventListener("error", (e) => errs.push(e.message));
  addEventListener("unhandledrejection", (e) => errs.push(String(e.reason)));
  const th = document.getElementById("thumb-" + CARD), tile = th.closest(".gal-tile");
  const card = document.getElementById(CARD), plot = card.querySelector(PLOT);
  tile.scrollIntoView({ block: "center" });
  await wait(600);
  const shapes = (el) => {
    const r = el.getBoundingClientRect();
    const c = echarts.getInstanceByDom(el);
    if (!c) return [r.left, r.top, r.width, r.height].map(Math.round).join(",");
    const sx = r.width / el.offsetWidth, sy = r.height / el.offsetHeight;
    const own = new Set();
    c._chartsViews.forEach((v) => v.group.traverse((e) => void own.add(e)));
    let l = 1e9, t = 1e9, R = -1e9, B = -1e9;
    for (const e of c.getZr().storage.getDisplayList(true)) {
      if (!own.has(e) || e.invisible || (e.style?.opacity ?? 1) < 0.05) continue;
      const b = e.getBoundingRect().clone();
      const m = e.getComputedTransform();
      if (m) b.applyTransform(m);
      if (b.width * b.height === 0 && !b.width && !b.height) continue;
      l = Math.min(l, b.x); t = Math.min(t, b.y); R = Math.max(R, b.x + b.width); B = Math.max(B, b.y + b.height);
    }
    return l > R ? "-" : [r.left + l * sx, r.top + t * sy, (R - l) * sx, (B - t) * sy].map(Math.round).join(",");
  };
  const op = (el) => (+getComputedStyle(el).opacity).toFixed(2);
  const head = card.firstElementChild; // (the header, chrome in a solid flight)
  const take = async (marks) => {
    const out = [];
    let t0 = 0;
    for (const t of marks) {
      await wait(t - t0);
      t0 = t;
      out.push(`${t}ms  thumb ${shapes(th)} (${op(th)})  plot ${shapes(plot)}  head ${op(head)}`);
    }
    return out;
  };
  const isOpen = () => document.getElementById("gallery").classList.contains("open");
  const y0 = scrollY, T0 = Math.round(tile.getBoundingClientRect().top);
  tile.click();
  const open = await take([20, 120, 250, 500, 800]);
  document.querySelector(".gal-back").click();
  const close = await take([20, 400, 600, 735, 900]);
  await wait(300);
  const trip = `round trip: scroll ${y0} -> ${scrollY}, tile top ${T0} -> ${Math.round(tile.getBoundingClientRect().top)}`;
  tile.click();
  await wait(300);
  dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  await wait(1000);
  const esc = `Esc midway open: open=${isOpen()} card waiting=${!!document.querySelector(".gal-stage #" + CARD)} scroll ${scrollY}`;
  tile.click();
  await wait(1200);
  document.querySelector(".gal-back").click();
  await wait(300);
  tile.click();
  await wait(1200);
  const re = `click midway close: open=${isOpen()} head ${op(head)}`;
  document.querySelector(".gal-back").click();
  await wait(1200);
  return ["open:", ...open, "close:", ...close, trip, esc, re, `closed: scroll ${scrollY}`, "errors: " + JSON.stringify(errs)].join("\n");
})().catch((e) => "ERR " + e.stack);
