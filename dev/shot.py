# Screenshots a page in headless Brave over the DevTools protocol, after it sets document.title to
# "DONE..." (see dev/harness.py). Prints the title, console logs and uncaught exceptions.
#   python3 dev/shot.py <url> <out.png> [width] [height] [dark]
# Optional env vars, applied after load (in this order):
#   WHEEL="x,y;x,y"  wheel-scroll at each spot and print the resulting scrollY
#   FRAMES="hours,share"  click each mode and save frame_<mode>_<k>.png mid-morph (cwd)
#   HOVER_SEL="css selector"  hover the element's center   HOVER="x,y"  hover a page point
#   EVAL="js expression"  evaluate (promises awaited) and print the value
# The browser profile persists in dev/site/.profile (IndexedDB = remembered data); delete it for a
# clean first visit. Add ?v=$RANDOM to URLs, or the profile's cache serves stale pages.
# Needs: pip3 install websocket-client
import base64, json, os, socket, subprocess, sys, time, urllib.request
from pathlib import Path
import websocket

PROFILE = Path(__file__).resolve().parent / "site" / ".profile"

url, out = sys.argv[1], sys.argv[2]
w = int(sys.argv[3]) if len(sys.argv) > 3 else 1280
h = int(sys.argv[4]) if len(sys.argv) > 4 else 2400
dark = len(sys.argv) > 5 and sys.argv[5] == "dark"
# A free DevTools port, so agents in different worktrees can take screenshots at the same time
with socket.socket() as s:
    s.bind(("127.0.0.1", 0)); PORT = s.getsockname()[1]
B = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
proc = subprocess.Popen([B, "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--remote-debugging-port={PORT}", "--remote-allow-origins=*",
                         f"--user-data-dir={PROFILE}",
                         f"--window-size={w},{h}", "about:blank"], stderr=subprocess.DEVNULL)
try:
    for _ in range(50):
        try:
            tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json"))
            page = next(t for t in tabs if t["type"] == "page")
            break
        except Exception:
            time.sleep(0.2)
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=120)
    n = [0]
    logs = []
    def call(method, **params):
        n[0] += 1
        ws.send(json.dumps({"id": n[0], "method": method, "params": params}))
        while True:
            m = json.loads(ws.recv())
            if m.get("method") == "Runtime.consoleAPICalled":
                logs.append(" ".join(str(a.get("value", a.get("description"))) for a in m["params"]["args"]))
            if m.get("method") == "Runtime.exceptionThrown":
                logs.append("EXC " + json.dumps(m["params"]["exceptionDetails"])[:500])
            if m.get("id") == n[0]:
                return m.get("result")
    call("Runtime.enable")
    call("Emulation.setDeviceMetricsOverride", width=w, height=h, deviceScaleFactor=1, mobile=False)
    call("Emulation.setEmulatedMedia", features=[{"name": "prefers-color-scheme", "value": "dark" if dark else "light"}])
    call("Page.navigate", url=url)
    t0 = time.time()
    while time.time() - t0 < 90:
        r = call("Runtime.evaluate", expression="document.title")
        if r["result"].get("value", "").startswith("DONE"):
            break
        time.sleep(0.5)
    time.sleep(2)
    if os.environ.get("WHEEL"):
        for spot in os.environ["WHEEL"].split(";"):
            x, y = map(int, spot.split(","))
            call("Runtime.evaluate", expression="window.scrollTo(0,0)")
            time.sleep(0.3)
            call("Input.dispatchMouseEvent", type="mouseMoved", x=x, y=y)
            call("Input.dispatchMouseEvent", type="mouseWheel", x=x, y=y, deltaX=0, deltaY=300)
            time.sleep(0.6)
            print("wheel at", x, y, "-> scrollY", call("Runtime.evaluate", expression="window.scrollY")["result"]["value"])
    if os.environ.get("FRAMES"):
        for mode in os.environ["FRAMES"].split(","):
            call("Runtime.evaluate", expression=f"document.querySelector('#rolling-mode [data-mode=\"{mode}\"]').click()")
            for k, delay in enumerate([0.15, 0.35, 0.9]):
                time.sleep(delay if k == 0 else delay - [0.15, 0.35, 0.9][k-1])
                shot = call("Page.captureScreenshot", format="png", clip={"x": 56, "y": 380, "width": 1170, "height": 450, "scale": 0.5})
                open(f"frame_{mode}_{k}.png", "wb").write(base64.b64decode(shot["data"]))
    if os.environ.get("CLICK_SEL") or os.environ.get("CLICK_JS"):
        # CLICK_SEL clicks an element, then saves the chart area at each CLICK_TIMES second (default 0.2,0.5,0.9,1.4,2.2) as click_<k>.png
        times = [float(x) for x in os.environ.get("CLICK_TIMES", "0.2,0.5,0.9,1.4,2.2").split(",")]
        if os.environ.get("CLICK_PRE"):  # JS to run (and wait for) first, e.g. to move to another period
            call("Runtime.evaluate", expression=os.environ["CLICK_PRE"], awaitPromise=True)
        # CLICK_JS runs arbitrary JS at the click instant instead of clicking CLICK_SEL
        call("Runtime.evaluate", expression=os.environ.get("CLICK_JS") or f"document.querySelector({json.dumps(os.environ['CLICK_SEL'])}).click()")
        t_click = time.time()
        for k, at in enumerate(times):
            time.sleep(max(0, at - (time.time() - t_click)))
            shot = call("Page.captureScreenshot", format="png", clip={"x": 56, "y": 380, "width": 1170, "height": 450, "scale": 0.5})
            open(os.path.join(os.environ.get("CLICK_OUT", "."), f"click_{k}.png"), "wb").write(base64.b64decode(shot["data"]))
    if os.environ.get("HOVER_SEL"):
        # Scroll so the chart's top sits at y=0-ish, then hover the element (its center)
        sel = os.environ["HOVER_SEL"]
        call("Runtime.evaluate", expression=f"window.scrollTo(0, 0)")
        r = call("Runtime.evaluate", expression=f"JSON.stringify(document.querySelector({json.dumps(sel)}).getBoundingClientRect())")["result"]["value"]
        b = json.loads(r)
        x, y = int(b["x"] + min(b["width"] / 2, 60)), int(b["y"] + b["height"] / 2)
        call("Input.dispatchMouseEvent", type="mouseMoved", x=x - 3, y=y)
        time.sleep(0.2)
        call("Input.dispatchMouseEvent", type="mouseMoved", x=x, y=y)
        time.sleep(0.8)
    if os.environ.get("HOVER"):
        x, y = map(int, os.environ["HOVER"].split(","))
        call("Input.dispatchMouseEvent", type="mouseMoved", x=x - 5, y=y)
        time.sleep(0.2)
        call("Input.dispatchMouseEvent", type="mouseMoved", x=x, y=y)
        time.sleep(0.8)
    if os.environ.get("EVAL"):
        print("eval:", call("Runtime.evaluate", expression=os.environ["EVAL"], awaitPromise=True)["result"].get("value"))
    print("title:", call("Runtime.evaluate", expression="document.title")["result"].get("value"))
    print("status:", call("Runtime.evaluate", expression="document.getElementById('status').textContent")["result"].get("value"))
    shot = call("Page.captureScreenshot", format="png")
    open(out, "wb").write(base64.b64decode(shot["data"]))
    for l in logs:
        print("LOG", l)
finally:
    proc.kill()
