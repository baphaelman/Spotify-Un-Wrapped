# Builds dev/site/: the app plus test pages that load real streaming history without a drag-and-drop.
# Re-run after every change to index.html (the test pages are copies of it).
#   python3 dev/harness.py [data_dir]      (default: ../spotify/datas/Spotify Extended Streaming History)
# Then serve it:  cd dev/site && python3 -m http.server 8765
#   test.html  loads the data, then runs the hash actions below, then sets document.title = "DONE"
#              #hours  switch to Hours · #community  open Community · #preview  open the share preview
#              #n5  5 artists · #five  5 artists + "Everyone else" (actions combine, e.g. #n5-hours)
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
if (h.includes("hours")) { document.querySelector('#rolling-mode [data-mode="hours"]').click(); await sleep(1500); }
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

(SITE / "test.html").write_text(html.replace("</body>", test_hook + "</body>"))
(SITE / "plain.html").write_text(html.replace("</body>", plain_hook + "</body>"))
print(f"dev/site ready: {len(files)} history files from {data}")
