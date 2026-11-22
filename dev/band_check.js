// Per band (or ridge, or line) in a solid flight (docs/arrivals.md): each series' top edge on screen in the tile's
// thumbnail and in the card's plot, compared at the thumbnail's points, and its fill. An EVAL for dev/shot.py, with
// __CARD__, __PLOT__ and __AT__ (ms after the tile's click, comma separated) filled in:
//   EVAL="$(sed -e s/__CARD__/rolling-card/ -e 's/__PLOT__/#chart-rolling/' -e s/__AT__/20,120/ dev/band_check.js)" \
//     OFFLINE=1 python3 dev/shot.py "http://localhost:<port>/test.html?v=$RANDOM" /tmp/x.png 1280 1000
// Prints, per moment, the worst gap in px (and where), each series' worst, and any fill that differs by more than one
// RGB unit. __SETUP__ (optional JS, run before the click) sets a card's choices first.
(async () => {
  const CARD = "__CARD__", PLOT = "__PLOT__", AT = "__AT__".split(",").map(Number);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60 && !document.getElementById("thumb-" + CARD)?.offsetParent; i++) await wait(250);
  await wait(1000);
  /*__SETUP__*/
  const th = document.getElementById("thumb-" + CARD), tile = th.closest(".gal-tile");
  const plot = document.getElementById(CARD).querySelector(PLOT);
  tile.scrollIntoView({ block: "center" });
  await wait(700);
  // each series' area (or line) top, in screen px: id -> { pts: [[x, y]…], fill }
  const edges = (el) => {
    const c = echarts.getInstanceByDom(el);
    const r = el.getBoundingClientRect(), sx = r.width / el.offsetWidth, sy = r.height / el.offsetHeight;
    const out = new Map();
    for (const m of c.getModel().getSeries()) {
      const v = c.getViewOfSeriesModel(m);
      let poly = null, line = null;
      v.group.traverse((e) => void (e.type === "ec-polygon" ? (poly = e) : e.type === "ec-polyline" ? (line = e) : 0));
      const shape = poly ?? line;
      if (!shape?.shape?.points) continue;
      const tr = shape.getComputedTransform() ?? [1, 0, 0, 1, 0, 0];
      const p = shape.shape.points, pts = [];
      for (let i = 0; i < p.length; i += 2) {
        const x = tr[0] * p[i] + tr[2] * p[i + 1] + tr[4], y = tr[1] * p[i] + tr[3] * p[i + 1] + tr[5];
        pts.push([r.left + x * sx, r.top + y * sy]);
      }
      const visible = (poly?.style.opacity ?? 1) * (poly?.style.fill ? 1 : 0) > 0.02 || (line?.style.opacity ?? 0) > 0.02;
      out.set(m.id, { pts, fill: poly?.style.fill, visible });
    }
    return out;
  };
  const yAt = (pts, x) => {
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      if (x >= x0 && x <= x1) return x1 === x0 ? y0 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
    return null;
  };
  const rgb = (c) => (typeof c === "string" && c.startsWith("#") ? [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) : (c?.match?.(/[\d.]+/g) ?? []).slice(0, 3).map(Number));
  const report = [];
  const t0 = performance.now();
  tile.click();
  for (const at of AT) {
    await wait(at - (performance.now() - t0));
    const A = edges(th), B = edges(plot);
    let worst = [0, ""], fills = [], per = [];
    for (const [id, a] of A) {
      const b = B.get(id);
      if (!b || !a.visible) continue;
      let w = 0;
      const lo = a.pts[0][0] + 2, hi = a.pts[a.pts.length - 1][0] - 2; // (inside the ends: the points past them are the chart's)
      for (const [x, y] of a.pts) {
        if (x < lo || x > hi) continue;
        const yb = yAt(b.pts, x);
        if (yb == null) continue;
        const d = Math.abs(y - yb);
        if (d > w) w = d;
        if (d > worst[0]) worst = [d, `${id} at x ${Math.round(x)}`];
      }
      per.push(`${id} ${w.toFixed(1)}`);
      const ca = rgb(a.fill), cb = rgb(b.fill);
      if (ca.length && cb.length && ca.some((v, i) => Math.abs(v - cb[i]) > 1)) fills.push(`${id} ${a.fill} vs ${b.fill}`);
    }
    report.push(`${Math.round(performance.now() - t0)}ms  worst ${worst[0].toFixed(1)}px (${worst[1]})  fills off: ${fills.join("; ") || "none"}\n  ${per.join("  ")}`);
  }
  document.querySelector(".gal-back").click();
  await wait(1200);
  return report.join("\n");
})()
