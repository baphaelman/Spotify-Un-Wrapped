# Cache-busts the site: GitHub Pages lets browsers cache files for 10 minutes, so a deploy can reach a visitor
# as new HTML with an old stylesheet or script. This stamps css/style.css and every JS file (the script tags
# in index.html, and each module's imports) with ?v=<hash of their contents>, so a change to any file changes
# every URL.
#   python3 dev/stamp.py [site_dir]      (default: the repo root)
# The deploy workflow (.github/workflows/pages.yml) runs it on a copy of the site, so the files in git stay
# unstamped. It's idempotent, and works the same on any copy of css/, js/ and index.html.
import hashlib, re, sys
from pathlib import Path

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent).resolve()
VERSIONED = re.compile(r"\?v=[0-9a-f]+")
files = [ROOT / "css" / "style.css", *sorted((ROOT / "js").glob("*.js"))]

# The hash covers the files as they are without any stamp, so stamping never changes the hash itself
h = hashlib.sha256()
for f in files:
    h.update(f.name.encode())
    h.update(VERSIONED.sub("", f.read_text()).encode())
v = h.hexdigest()[:8]

def rewrite(path, pattern, repl):
    text = path.read_text()
    new = re.sub(pattern, repl, text)
    if new != text:
        path.write_text(new)

# index.html: the stylesheet and the entry scripts
rewrite(ROOT / "index.html", r'((?:css|js)/[a-z]+\.(?:css|js))(\?v=[0-9a-f]+)?"', rf'\1?v={v}"')
# every module: its relative imports
for f in (ROOT / "js").glob("*.js"):
    rewrite(f, r'(from "\./[a-z]+\.js)(\?v=[0-9a-f]+)?"', rf'\1?v={v}"')
print(f"stamped v={v}")
