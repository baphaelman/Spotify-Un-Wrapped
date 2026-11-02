# Measures how an action moves, in numbers instead of screenshots: frame times (lag) and the largest single-frame
# jump in the charts' pixels (a cut in an animation). Loads test.html once, then runs each scenario in turn.
#   python3 dev/motion_check.py <port> [scenario ...]        (default: every scenario below)
#   python3 dev/motion_check.py <port> custom --setup "<js>" --action "<js>" [--seconds 3] [--charts chart-rolling,...]
# Scenarios: slice (15 → 180 days per slice over All time, the first time after load), slice-back (180 → 7),
#   smooth (smoothing Off → Max), drag (drags a 2-year window across the bar), preset (All time → the newest year)
# Per scenario it prints:
#   frames   median / p95 / max frame time and the frames over 50 ms; "blocked" is the long tasks' total
#   jump     the biggest one-frame change as a share of the whole change, and when it came (ms after the action).
#            Over ~30% with a frame time near the median is a cut; check that moment with shot.py CLICK_JS/CLICK_TIMES.
#   --profile  also samples the CPU through each action and prints the functions with the most self time, and the
#              share spent in native code ("(program)": mostly drawing the charts' canvases)
# Headless Brave draws in software, so frame times run slower than a real browser: compare before against after.
# Runs offline (no Supabase), so it costs no Spotify calls. Needs the server from CLAUDE.md running on <port>.
import argparse, json, os, socket, statistics, subprocess, sys, time, urllib.request
from pathlib import Path
import websocket

PROFILE = Path(__file__).resolve().parent / "site" / ".profile"
B = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"

# Records each frame's time and how much the charts' pixels changed since the frame before, on 64×24 thumbnails
RECORDER = """
window.__rec = (ids) => {
  const charts = ids.map((id) => document.querySelector('#' + id + ' canvas')).filter(Boolean);
  const W = 64, H = 24, small = document.createElement('canvas');
  small.width = W; small.height = H * charts.length;
  const g = small.getContext('2d', { willReadFrequently: true });
  const r = { t: [], diff: [], long: 0, stop: false };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) r.long += e.duration; }).observe({ type: 'longtask' });
  let prev = null;
  const tick = (now) => {
    if (r.stop) return;
    charts.forEach((c, i) => { g.clearRect(0, i * H, W, H); g.drawImage(c, 0, i * H, W, H); });
    const px = g.getImageData(0, 0, W, small.height).data;
    if (prev) { let d = 0; for (let k = 0; k < px.length; k += 4) d += Math.abs(px[k] - prev[k]) + Math.abs(px[k + 1] - prev[k + 1]) + Math.abs(px[k + 2] - prev[k + 2]); r.t.push(now); r.diff.push(d); }
    else r.t.push(now), r.diff.push(0);
    prev = px;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__recNow = r;
};
"""

SET_SLICE = "(v) => { const s = document.getElementById('window'); s.value = v; s.dispatchEvent(new Event('input')); }"
SET_SELECT = "(id, v) => { const s = document.getElementById(id); s.value = v; s.dispatchEvent(new Event('change')); }"
NEWEST = "[...document.getElementById('year-filter').options].at(-1).value"
SCENARIOS = {
    "slice": dict(setup=f"({SET_SELECT})('year-filter', 'all'); ({SET_SLICE})(1)", action=f"({SET_SLICE})(6)", seconds=4),
    "slice-back": dict(setup=f"({SET_SELECT})('year-filter', 'all'); ({SET_SLICE})(6)", action=f"({SET_SLICE})(0)", seconds=4),
    "smooth": dict(setup=f"({SET_SELECT})('year-filter', 'all'); ({SET_SELECT})('smoothify', '0')", action=f"({SET_SELECT})('smoothify', '4')", seconds=4),
    "drag": dict(setup=f"({SET_SELECT})('year-filter', [...document.getElementById('year-filter').options][1].value);"
                       "document.querySelector('#period-resize [data-len=\"2y\"]').click()", action=None, seconds=3),
    "preset": dict(setup=f"({SET_SELECT})('year-filter', 'all')", action=f"({SET_SELECT})('year-filter', {NEWEST})", seconds=4),
}

ap = argparse.ArgumentParser()
ap.add_argument("port")
ap.add_argument("scenarios", nargs="*")
ap.add_argument("--setup", default="")
ap.add_argument("--action", default="")
ap.add_argument("--seconds", type=float, default=3)
ap.add_argument("--charts", default="chart-rolling,chart-rolling-hours")
ap.add_argument("--profile", action="store_true")
args = ap.parse_args()
names = args.scenarios or list(SCENARIOS)
if "custom" in names:
    SCENARIOS["custom"] = dict(setup=args.setup, action=args.action, seconds=args.seconds)

with socket.socket() as s:
    s.bind(("127.0.0.1", 0)); PORT = s.getsockname()[1]
proc = subprocess.Popen([B, "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--remote-debugging-port={PORT}",
                         "--remote-allow-origins=*", f"--user-data-dir={PROFILE}", "--window-size=1280,1400", "about:blank",
                         "--host-resolver-rules=MAP qvsoxqeuvpnryitechsf.supabase.co ~NOTFOUND"], stderr=subprocess.DEVNULL)
try:
    for _ in range(50):
        try:
            page = next(t for t in json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json")) if t["type"] == "page")
            break
        except Exception:
            time.sleep(0.2)
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=120)
    n = [0]
    errors = []
    def call(method, **params):
        n[0] += 1
        ws.send(json.dumps({"id": n[0], "method": method, "params": params}))
        while True:
            m = json.loads(ws.recv())
            if m.get("method") == "Runtime.exceptionThrown":
                errors.append(json.dumps(m["params"]["exceptionDetails"])[:300])
            if m.get("id") == n[0]:
                return m.get("result")
    js = lambda expr: call("Runtime.evaluate", expression=expr, awaitPromise=True, returnByValue=True)["result"].get("value")
    call("Runtime.enable")
    call("Network.enable")
    call("Network.setCacheDisabled", cacheDisabled=True)
    call("Emulation.setDeviceMetricsOverride", width=1280, height=1400, deviceScaleFactor=1, mobile=False)
    call("Page.navigate", url=f"http://localhost:{args.port}/test.html?v={time.time_ns()}")
    t0 = time.time()
    while not (js("document.title") or "").startswith("DONE"):
        if time.time() - t0 > 90:
            sys.exit("test.html never set its title to DONE")
        time.sleep(0.5)
    time.sleep(2)
    js(RECORDER)
    charts = json.dumps(args.charts.split(","))

    for name in names:
        sc = SCENARIOS[name]
        js("window.scrollTo(0, document.getElementById('rolling-card').offsetTop - 200)")
        if sc["setup"]:
            js(sc["setup"])
        time.sleep(3)  # long enough for any setup morph (scaledMs tops out at 2.2 s) to settle
        js(f"window.__rec({charts})")
        time.sleep(0.3)
        if args.profile:
            call("Profiler.enable")
            call("Profiler.setSamplingInterval", interval=200)
            call("Profiler.start")
        start = js("performance.now()")
        if name == "drag":
            b = js("JSON.stringify(document.getElementById('brush-win').getBoundingClientRect())")
            b = json.loads(b)
            x, y = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
            track = json.loads(js("JSON.stringify(document.getElementById('brush-track').getBoundingClientRect())"))
            call("Input.dispatchMouseEvent", type="mousePressed", x=x, y=y, button="left", clickCount=1)
            for k in range(1, 41):
                call("Input.dispatchMouseEvent", type="mouseMoved", x=x + (track["right"] - b["right"] - 4) * k / 40, y=y, button="left")
                time.sleep(1.5 / 40)
            call("Input.dispatchMouseEvent", type="mouseReleased", x=x + track["right"] - b["right"] - 4, y=y, button="left", clickCount=1)
        else:
            js(sc["action"])
        time.sleep(sc["seconds"])
        r = js("(() => { const r = window.__recNow; r.stop = true; return { t: r.t, diff: r.diff, long: r.long }; })()")
        prof = call("Profiler.stop")["profile"] if args.profile else None

        t, diff = r["t"], r["diff"]
        keep = [i for i in range(1, len(t)) if t[i] >= start]
        dts = [t[i] - t[i - 1] for i in keep]
        moves = [diff[i] for i in keep]
        total = sum(moves)
        if not dts:
            print(f"{name:11} no frames recorded"); continue
        q = sorted(dts)
        frames = (f"frames {len(dts):3}  median {statistics.median(dts):5.1f}  p95 {q[int(len(q) * .95) - 1]:6.1f}  max {q[-1]:6.1f} ms"
                  f"  >50ms {sum(d > 50 for d in dts):2}  blocked {r['long']:6.0f} ms")
        if total == 0:
            print(f"{name:11} {frames}  |  no visible change"); continue
        big = max(range(len(moves)), key=lambda i: moves[i])
        at = t[keep[big]] - start
        print(f"{name:11} {frames}  |  jump {moves[big] / total:4.0%} at {at:5.0f} ms (that frame took {dts[big]:.0f} ms)")
        if prof:
            nodes = {n["id"]: n["callFrame"] for n in prof["nodes"]}
            self_ms = {}
            for sid, dt in zip(prof["samples"], prof["timeDeltas"]):
                f = nodes[sid]
                k = f'{f["functionName"] or "(anon)"} {f["url"].rsplit("/", 1)[-1]}:{f["lineNumber"] + 1}'
                self_ms[k] = self_ms.get(k, 0) + dt / 1000
            for k, ms in sorted(self_ms.items(), key=lambda x: -x[1])[:12]:
                if k.split()[0] != "(idle)":
                    print(f"    {ms:7.0f} ms  {k}")
    for e in errors:
        print("EXC", e)
finally:
    proc.kill()
