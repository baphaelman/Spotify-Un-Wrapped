# Builds dev/site/: the app plus test pages that load real streaming history without a drag-and-drop.
# Re-run after every change to index.html (the test pages are copies of it).
#   python3 dev/harness.py [data_dir]      (default: ../spotify/datas/Spotify Extended Streaming History)
# Then serve it:  cd dev/site && python3 -m http.server 8765
#   test.html  loads the data, then runs the hash actions below, then sets document.title = "DONE"
#              #community  open Community · #preview  open the share preview
#              #tracks / #albums  the Tracks or Albums view
#              #split-album / #split-track  split the rolling chart's bands into albums or songs
#              #m18  18 monthly bars · #n10  10 artists · #n5  5 artists · #five  5 artists + "Everyone else" (actions combine, e.g. #n5-albums)
#   plain.html reopens data remembered from an earlier test.html visit; title "DONE <ms>" once shown
import json, os, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "dev" / "site"
# Agents work in worktrees under .claude/worktrees/, so look for the data next to the main checkout
MAIN = (ROOT / subprocess.run(["git", "rev-parse", "--git-common-dir"], cwd=ROOT, capture_output=True, text=True).stdout.strip()).resolve().parent
data = Path(sys.argv[1] if len(sys.argv) > 1 else MAIN.parent / "spotify/datas/Spotify Extended Streaming History").resolve()

SITE.mkdir(parents=True, exist_ok=True)
for name, target in [("css", ROOT / "css"), ("js", ROOT / "js"), ("data", data)]:
    link = SITE / name
    if link.is_symlink() or link.exists():
        link.unlink()
    link.symlink_to(target)

files = sorted(p.name for p in data.glob("Streaming_History_Audio*.json"))
html = (ROOT / "index.html").read_text()

test_hook = """<script type="module">
const names = %s;
const dt = new DataTransfer();
for (const n of names) dt.items.add(new File([await (await fetch("data/" + n)).blob()], n));
const q = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
q("file-input").files = dt.files;
q("file-input").dispatchEvent(new Event("change"));
while (q("dashboard").hidden) await sleep(100);
await sleep(1500);
const h = location.hash;
const setArtists = (n) => { q("n-artists").value = n; q("n-artists").dispatchEvent(new Event("input")); };
if (h.includes("five")) { q("include-other").checked = true; setArtists(5); await sleep(600); }
if (h.includes("n5")) { setArtists(5); await sleep(600); }
if (h.includes("tracks")) { document.querySelector('#view-tabs [data-dim="track"]').click(); await sleep(1500); }
if (h.includes("albums")) { document.querySelector('#view-tabs [data-dim="album"]').click(); await sleep(1500); }
// 18 monthly bars, the most the chart draws (a 17-month window touches 18 calendar months), through a length button made for it
if (h.includes("m18")) { const b = document.createElement("button"); b.dataset.len = "17m"; b.hidden = true; q("period-resize").append(b); b.click(); b.remove(); await sleep(1500); }
if (h.includes("n10")) { setArtists(10); await sleep(600); }
if (h.includes("split-album")) { document.querySelector('#rolling-split [data-split="album"]').click(); await sleep(2000); }
if (h.includes("split-track")) { document.querySelector('#rolling-split [data-split="track"]').click(); await sleep(2000); }
if (h.includes("community")) { q("tab-community").click(); await sleep(2500); }
if (h.includes("preview")) q("share-preview").click();
document.title = "DONE";
</script>""" % json.dumps(files)

plain_hook = """<script>
const t0 = performance.now();
const iv = setInterval(() => {
  if (!document.getElementById("dashboard").hidden) { document.title = "DONE " + Math.round(performance.now() - t0) + "ms"; clearInterval(iv); }
}, 50);
setTimeout(() => { if (!document.title.startsWith("DONE")) document.title = "DONE never"; }, 20000);
</script>"""

# Trying out the hours strip's look (temporary): a panel of its options, kept across reloads
strip_panel = """<style>
#strip-try { position: fixed; left: 12px; bottom: 12px; z-index: 50; background: var(--surface-2); border: 1px solid var(--border);
  border-radius: 8px; padding: 10px 12px; font-size: 12px; display: grid; grid-template-columns: auto auto; gap: 6px 10px; align-items: center;
  box-shadow: 0 6px 24px rgba(0,0,0,.35); }
#strip-try b { grid-column: 1 / -1; font-size: 12px; }
#strip-try .opts { display: flex; gap: 4px; flex-wrap: wrap; }
#strip-try button { font: inherit; font-size: 11px; padding: 3px 7px; border-radius: 5px; border: 1px solid var(--border); background: transparent; color: inherit; cursor: pointer; }
#strip-try button[aria-pressed="true"] { background: var(--text-primary); color: var(--surface); }
</style>
<script type="module">
import { stripLook, currentZoom } from "./js/charts.js";
import { renderRollingChart } from "./js/rollingview.js";
const OPTS = {
  height: ["90", "120", "160", "200", "260", "320", "400"],
  gap: ["0", "12", "24", "40"],
  marker: ["none", "rule", "label", "rule label", "panel", "panel label", "own card"],
  line: ["1", "1.5", "2", "2.5", "3"],
  shading: ["none", "lit", "all"],
  breakdown: ["on", "off"],
};
const DEF = { height: "260", gap: "12", marker: "panel label", line: "2", shading: "all", breakdown: "off" };
let cur = { ...DEF };
try { cur = { ...DEF, ...JSON.parse(localStorage.getItem("strip-try") || "{}") }; } catch {}
const wrap = document.getElementById("strip-wrap");
// "own card": the strip moves out into a card of its own under the rolling chart's, with its own dates
const home = wrap.parentElement;
const card = document.createElement("article");
card.className = "card";
card.hidden = true;
card.innerHTML = '<h2>Hours per week</h2><p class="muted">Each artist\\'s hours per week, same days per slice as above</p>';
home.closest(".card").after(card);
const apply = (redraw) => {
  const own = cur.marker === "own card";
  card.hidden = !own;
  (own ? card : home).append(wrap);
  stripLook.labels = own;
  wrap.style.setProperty("--strip-h", cur.height + "px");
  wrap.style.setProperty("--strip-gap", own ? "0px" : cur.gap + "px");
  wrap.dataset.sep = own ? "" : cur.marker;
  stripLook.width = +cur.line;
  stripLook.fill = cur.shading;
  stripLook.parts = cur.breakdown === "on";
  try { localStorage.setItem("strip-try", JSON.stringify(cur)); } catch {}
  if (readout) readout.textContent = Object.values(cur).join(", ");
  if (redraw) renderRollingChart(currentZoom(document.getElementById("chart-rolling")), true);
};
const panel = document.createElement("div");
panel.id = "strip-try";
panel.innerHTML = "<b>Hours strip</b>";
for (const [k, list] of Object.entries(OPTS)) {
  const label = document.createElement("span");
  label.textContent = k;
  const opts = document.createElement("div");
  opts.className = "opts";
  for (const v of list) {
    const b = document.createElement("button");
    b.textContent = v;
    b.setAttribute("aria-pressed", cur[k] === v);
    b.onclick = () => {
      cur[k] = v;
      for (const x of opts.children) x.setAttribute("aria-pressed", x === b);
      apply(true);
    };
    opts.append(b);
  }
  panel.append(label, opts);
}
// The choices as text, to paste back
var readout = document.createElement("code");
readout.style.cssText = "grid-column: 1 / -1; user-select: all; color: var(--text-secondary)";
panel.append(readout);
document.body.append(panel);
apply(false);
const q = (id) => document.getElementById(id);
while (q("dashboard").hidden) await new Promise((r) => setTimeout(r, 100));
apply(true);
</script>"""

(SITE / "test.html").write_text(html.replace("</body>", strip_panel + test_hook + "</body>"))
(SITE / "plain.html").write_text(html.replace("</body>", plain_hook + "</body>"))
print(f"dev/site ready: {len(files)} history files from {data}")
