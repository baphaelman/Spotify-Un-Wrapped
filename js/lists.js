// Ranked list with inline bars: every value is readable without hovering.
// rows: [{ name, detail, value, frac, tag?, muted? }]. Names come from user files, so textContent only.
export function renderList(ol, rows) {
  ol.replaceChildren(
    ...rows.map((r, i) => {
      const li = document.createElement("li");
      const rank = document.createElement("span");
      rank.className = "rank";
      rank.textContent = i + 1;
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = r.name;
      name.title = r.detail ? `${r.name} — ${r.detail}` : r.name;
      if (r.tag) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = r.tag;
        name.append(tag);
      }
      if (r.detail) {
        const small = document.createElement("small");
        small.textContent = r.detail;
        name.append(small);
      }
      const val = document.createElement("span");
      val.className = "val";
      val.textContent = r.value;
      const bar = document.createElement("span");
      bar.className = "bar" + (r.muted ? " muted-bar" : "");
      bar.style.width = `${Math.max(0, Math.min(1, r.frac)) * 100}%`;
      li.append(rank, name, val, bar);
      return li;
    })
  );
}

// Stat tiles: [{ label, value, sub, hero? }]
export function renderTiles(el, tiles) {
  el.replaceChildren(
    ...tiles.map((t) => {
      const tile = document.createElement("div");
      tile.className = "stat" + (t.hero ? " hero" : "");
      for (const [cls, text] of [["label", t.label], ["value", t.value], ["sub", t.sub]]) {
        const d = document.createElement("div");
        d.className = cls;
        d.textContent = text ?? "";
        tile.append(d);
      }
      return tile;
    })
  );
}
