// Every play's and Every day's flights, finer than flight_check.js (which boxes their canvases only as a whole): an
// EVAL for dev/shot.py, with __CARD__ (raster-card or calendar-card), __PLOT__ (#chart-raster or #chart-calendar)
// and __OTHER__ (raster-other or calendar-other) filled in:
//   EVAL="$(sed -e s/__CARD__/raster-card/ -e 's/__PLOT__/#chart-raster/' -e s/__OTHER__/raster-other/ dev/flight_every.js)" \
//     OFFLINE=1 python3 dev/shot.py "http://localhost:<port>/test.html?v=$RANDOM" /tmp/x.png 1280 1000
// At moments of an open and a close while the thumbnail shows (it fades over 0-25% of the flight), the thumbnail's
// box on screen cut into 40 bands across, and each band read in the thumbnail's canvas and in the card's, weighted by
// coverage (alpha): where its marks sit (the centre's height), how much is drawn (the ratio of the two), and its mean
// color (the largest RGB channel difference), as max and median over the bands. Then the same with the card's
// Everyone else off, and any errors.
(async () => {
  const CARD = "__CARD__", PLOT = "__PLOT__", OTHER = "__OTHER__";
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60 && !document.getElementById("thumb-" + CARD)?.offsetParent; i++) await wait(250);
  await wait(1000);
  const errs = [];
  addEventListener("error", (e) => errs.push(e.message));
  addEventListener("unhandledrejection", (e) => errs.push(String(e.reason)));
  const th = document.getElementById("thumb-" + CARD), tile = th.closest(".gal-tile");
  const card = document.getElementById(CARD);
  const thumbC = () => th.querySelector("canvas.every-thumb");
  const plotC = () => card.querySelector(PLOT + " > canvas:not(.chart-fade)");
  // A canvas's [r, g, b, alpha] under a point on screen
  const reader = (c) => {
    const r = c.getBoundingClientRect(), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    return (X, Y) => {
      const x = Math.floor(((X - r.left) / r.width) * c.width), y = Math.floor(((Y - r.top) / r.height) * c.height);
      if (x < 0 || y < 0 || x >= c.width || y >= c.height) return null;
      const i = (y * c.width + x) * 4;
      return d[i + 3] ? [d[i], d[i + 1], d[i + 2], d[i + 3] / 255] : null;
    };
  };
  const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : NaN);
  const band = (px, x0, x1, y0, y1) => {
    let m = 0, my = 0;
    const c = [0, 0, 0];
    for (let X = Math.floor(x0) + 0.5; X < x1; X++)
      for (let Y = Math.floor(y0) + 0.5; Y < y1; Y++) {
        const p = px(X, Y);
        if (!p) continue;
        m += p[3];
        my += p[3] * Y;
        for (let k = 0; k < 3; k++) c[k] += p[3] * p[k];
      }
    return m ? { m, y: my / m, c: c.map((v) => v / m) } : null;
  };
  const compare = () => {
    const box = th.getBoundingClientRect(), a = reader(thumbC()), b = reader(plotC());
    const dys = [], dms = [], dcs = [];
    let only = 0;
    for (let i = 0; i < 40; i++) {
      const x0 = box.left + (i / 40) * box.width, x1 = box.left + ((i + 1) / 40) * box.width;
      const p = band(a, x0, x1, box.top, box.bottom), q = band(b, x0, x1, box.top, box.bottom);
      if (!p && !q) continue;
      if (!p || !q || Math.min(p.m, q.m) < 2) {
        only += !p !== !q;
        continue;
      }
      dys.push(Math.abs(p.y - q.y));
      dms.push(Math.abs(100 * (q.m / p.m - 1)));
      dcs.push(Math.max(...p.c.map((v, k) => Math.abs(v - q.c[k]))));
    }
    const f = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : "-");
    const s = (a, u = "") => `max ${f(Math.max(...a))}${u} med ${f(med(a))}${u}`;
    return `bands ${dys.length} (+${only} in one only)  centre dy ${s(dys)}  drawn ${s(dms, "%")}  rgb ${s(dcs)}`;
  };
  const run = async (label) => {
    tile.scrollIntoView({ block: "center" });
    await wait(800);
    const out = [label, `  rest      ${compare()}`];
    tile.click();
    let t0 = 0;
    for (const t of [20, 120, 180]) {
      await wait(t - t0);
      t0 = t;
      out.push(`  open ${String(t).padStart(3)}  ${compare()}`);
    }
    await wait(1200);
    document.querySelector(".gal-back").click();
    t0 = 0;
    for (const t of [600, 680, 735]) {
      await wait(t - t0);
      t0 = t;
      out.push(`  close ${t} ${compare()}`);
    }
    await wait(800);
    return out;
  };
  const on = await run("Everyone else on:");
  const box = document.getElementById(OTHER);
  box.click(); // (the card's own toggle, while the card waits in the grid)
  await wait(1200);
  const off = await run("Everyone else off:");
  box.click();
  return [...on, ...off, "errors: " + JSON.stringify(errs)].join("\n");
})().catch((e) => "ERR " + e.stack);
