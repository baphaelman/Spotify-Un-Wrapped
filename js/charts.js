// ECharts renderers. Colors come from the CSS tokens so light/dark stay in one place (style.css).

const instances = new Map();

function tokens() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  return {
    surface: v("--surface"),
    primary: v("--text-primary"),
    secondary: v("--text-secondary"),
    muted: v("--text-muted"),
    grid: v("--grid"),
    axis: v("--axis"),
    accent: v("--accent"),
    other: v("--other"),
    series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`--series-${i}`)),
    seq: [0, 1, 2, 3, 4, 5].map((i) => v(`--seq-${i}`)),
  };
}

function chart(el) {
  let c = instances.get(el);
  if (!c) {
    c = echarts.init(el, null, { renderer: "canvas" });
    instances.set(el, c);
    new ResizeObserver(() => c.resize()).observe(el);
  }
  return c;
}

// Theme changed: throw away instances so the next render picks up new tokens.
export function disposeAll() {
  for (const c of instances.values()) c.dispose();
  instances.clear();
}

// [startValue, endValue] of a chart's current zoom, so re-renders can keep the reader's place.
export function currentZoom(el) {
  const dz = instances.get(el)?.getOption()?.dataZoom?.[0];
  return dz ? [dz.startValue, dz.endValue] : undefined;
}

// Artist and track names come from user files: escape before they enter tooltip HTML.
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const fmtHours = (h) => (h >= 100 ? Math.round(h).toLocaleString() : h.toFixed(1)) + " h";

function baseAxis(t) {
  return {
    axisLine: { lineStyle: { color: t.axis } },
    axisTick: { show: false },
    axisLabel: { color: t.muted },
    splitLine: { lineStyle: { color: t.grid, width: 1 } },
  };
}

function tooltipBase(t) {
  return {
    backgroundColor: t.surface,
    borderColor: t.grid,
    borderWidth: 1,
    padding: [8, 12],
    textStyle: { color: t.primary, fontSize: 13 },
    extraCssText: "border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12);",
  };
}

// Line-key row: value leads, label follows.
const row = (color, value, label) =>
  `<div style="display:flex;align-items:center;gap:8px;line-height:1.6">` +
  `<span style="width:12px;height:2px;background:${color};border-radius:1px"></span>` +
  `<b style="min-width:3.5em">${value}</b><span style="opacity:.75">${esc(label)}</span></div>`;

export function renderRolling(el, data, names, window, zoom) {
  const t = tokens();
  const colors = names.map((_, i) => t.series[i] ?? t.other);
  const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

  const series = names.map((name, s) => ({
    name,
    type: "line",
    stack: "share",
    showSymbol: false,
    symbol: "none",
    smooth: false,
    // The line in surface color is the 2px-style gap between stacked bands
    lineStyle: { width: 1, color: t.surface },
    areaStyle: { color: colors[s], opacity: 1 },
    itemStyle: { color: colors[s] },
    emphasis: { focus: "series", areaStyle: { opacity: 1 } },
    blur: { areaStyle: { opacity: 0.25 } },
    data: data.dates.map((d, i) => [d, data.share[s][i]]),
  }));

  chart(el).setOption(
    {
      animationDuration: 400,
      grid: { left: 48, right: 16, top: 40, bottom: 72 },
      legend: {
        type: "scroll",
        top: 0,
        left: 0,
        icon: "rect",
        itemWidth: 12,
        itemHeight: 12,
        textStyle: { color: t.secondary },
        pageTextStyle: { color: t.muted },
      },
      tooltip: {
        ...tooltipBase(t),
        trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: t.muted, width: 1 } },
        formatter: (params) => {
          if (params[0].value[1] == null) return "";
          const i = params[0].dataIndex;
          const rows = params
            .map((p) => ({ p, share: p.value[1], hours: data.hours[p.seriesIndex][i] }))
            .filter((r) => r.share > 0)
            .sort((a, b) => b.share - a.share)
            .map((r) => row(r.p.color, (r.share * 100).toFixed(0) + "%", `${r.p.seriesName} · ${fmtHours(r.hours)}`));
          return `<div style="color:${t.muted};margin-bottom:4px">${window} days around ${fmtDate(params[0].value[0])}</div>${rows.join("")}`;
        },
      },
      xAxis: { type: "time", ...baseAxis(t), splitLine: { show: false } },
      yAxis: {
        type: "value",
        min: 0,
        max: 1,
        interval: 0.25,
        ...baseAxis(t),
        axisLine: { show: false },
        axisLabel: { color: t.muted, formatter: (v) => `${v * 100}%` },
      },
      dataZoom: [
        { type: "inside", startValue: zoom?.[0], endValue: zoom?.[1] },
        {
          type: "slider",
          startValue: zoom?.[0],
          endValue: zoom?.[1],
          bottom: 12,
          height: 32,
          borderColor: t.grid,
          fillerColor: "rgba(127,127,127,0.12)",
          handleStyle: { color: t.surface, borderColor: t.axis },
          moveHandleStyle: { color: t.axis },
          textStyle: { color: t.muted },
          dataBackground: { lineStyle: { color: t.axis }, areaStyle: { color: t.grid } },
          selectedDataBackground: { lineStyle: { color: t.accent }, areaStyle: { color: t.accent, opacity: 0.15 } },
        },
      ],
      series,
    },
    { notMerge: true }
  );
}

export function renderMonthly(el, rows) {
  const t = tokens();
  const label = (d) => d.toLocaleDateString(undefined, { year: "numeric", month: "short" });
  chart(el).setOption(
    {
      animationDuration: 400,
      grid: { left: 48, right: 16, top: 16, bottom: 32 },
      tooltip: {
        ...tooltipBase(t),
        trigger: "item",
        formatter: (p) => `<b>${fmtHours(p.value[1])}</b> <span style="opacity:.75">${label(new Date(p.value[0]))}</span>`,
      },
      xAxis: { type: "time", ...baseAxis(t), splitLine: { show: false } },
      yAxis: {
        type: "value",
        ...baseAxis(t),
        axisLine: { show: false },
        axisLabel: { color: t.muted, formatter: (v) => `${v} h` },
      },
      series: [
        {
          type: "bar",
          barMaxWidth: 24,
          barCategoryGap: "20%",
          itemStyle: { color: t.accent, borderRadius: [4, 4, 0, 0] },
          emphasis: { itemStyle: { opacity: 0.8 } },
          data: rows.map((r) => [r.month.getTime() + 15 * 86400000, r.hours]),
        },
      ],
    },
    { notMerge: true }
  );
}

export function renderClock(el, grid) {
  const t = tokens();
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const hours = Array.from({ length: 24 }, (_, h) => (h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`));
  const data = [];
  let max = 0;
  grid.forEach((row, d) => row.forEach((v, h) => { data.push([h, d, v]); max = Math.max(max, v); }));

  chart(el).setOption(
    {
      animationDuration: 400,
      grid: { left: 48, right: 16, top: 8, bottom: 56 },
      tooltip: {
        ...tooltipBase(t),
        trigger: "item",
        formatter: (p) => `<b>${fmtHours(p.value[2])}</b> <span style="opacity:.75">${days[p.value[1]]} ${hours[p.value[0]]}</span>`,
      },
      xAxis: { type: "category", data: hours, ...baseAxis(t), axisLine: { show: false }, splitLine: { show: false } },
      yAxis: { type: "category", data: days, inverse: true, ...baseAxis(t), axisLine: { show: false }, splitLine: { show: false } },
      visualMap: {
        min: 0,
        max,
        calculable: false,
        orient: "horizontal",
        left: "center",
        bottom: 0,
        itemHeight: 160,
        itemWidth: 10,
        text: [fmtHours(max), "0 h"],
        textStyle: { color: t.muted },
        inRange: { color: t.seq },
      },
      series: [
        {
          type: "heatmap",
          data,
          itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 4 },
          emphasis: { itemStyle: { borderColor: t.primary, borderWidth: 1 } },
        },
      ],
    },
    { notMerge: true }
  );
}

// Contributors by total hours, with the viewer's bin picked out in the accent.
export function renderHistogram(el, hours, yours) {
  const t = tokens();
  const max = Math.max(...hours, yours ?? 0);
  const step = [50, 100, 250, 500, 1000, 2500].find((s) => max / s <= 24) ?? 5000;
  const bins = new Array(Math.floor(max / step) + 1).fill(0);
  for (const h of hours) bins[Math.floor(h / step)]++;
  const you = yours == null ? -1 : Math.floor(yours / step);
  const range = (i) => `${(i * step).toLocaleString()}–${((i + 1) * step).toLocaleString()} h`;

  chart(el).setOption(
    {
      animationDuration: 400,
      grid: { left: 40, right: 16, top: 24, bottom: 32 },
      tooltip: {
        ...tooltipBase(t),
        trigger: "item",
        formatter: (p) =>
          `<b>${p.value} ${p.value === 1 ? "person" : "people"}</b> <span style="opacity:.75">${range(p.dataIndex)}</span>` +
          (p.dataIndex === you ? `<div style="opacity:.75">You're here</div>` : ""),
      },
      xAxis: {
        type: "category",
        data: bins.map((_, i) => (i * step).toLocaleString()),
        ...baseAxis(t),
        splitLine: { show: false },
      },
      yAxis: { type: "value", minInterval: 1, ...baseAxis(t), axisLine: { show: false } },
      series: [
        {
          type: "bar",
          barMaxWidth: 24,
          data: bins.map((v, i) => ({
            value: v,
            itemStyle: { color: i === you ? t.accent : t.other, borderRadius: [4, 4, 0, 0] },
          })),
          // A marker rather than a bar label, so it shows even when no one else is in your bin
          markLine: you < 0 ? undefined : {
            silent: true,
            symbol: "none",
            lineStyle: { color: t.accent, width: 2, type: "solid" },
            label: { formatter: "You", color: t.primary, fontWeight: 600 },
            data: [{ xAxis: you }],
          },
        },
      ],
    },
    { notMerge: true }
  );
}

// Share of listening by hour of day: viewer vs community.
export function renderHourLines(el, community, yours) {
  const t = tokens();
  const labels = Array.from({ length: 24 }, (_, h) => (h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`));
  const series = [{ name: "Community", data: community, color: t.muted }];
  if (yours) series.push({ name: "You", data: yours, color: t.accent });

  chart(el).setOption(
    {
      animationDuration: 400,
      grid: { left: 40, right: 16, top: 40, bottom: 32 },
      legend: { top: 0, left: 0, icon: "roundRect", itemWidth: 14, itemHeight: 2, itemStyle: { borderWidth: 0 }, textStyle: { color: t.secondary } },
      tooltip: {
        ...tooltipBase(t),
        trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: t.muted, width: 1 } },
        formatter: (params) =>
          `<div style="color:${t.muted};margin-bottom:4px">${labels[params[0].dataIndex]}</div>` +
          params.map((p) => row(p.color, (p.value * 100).toFixed(1) + "%", p.seriesName)).join(""),
      },
      xAxis: { type: "category", data: labels, boundaryGap: false, ...baseAxis(t), splitLine: { show: false } },
      yAxis: {
        type: "value",
        ...baseAxis(t),
        axisLine: { show: false },
        axisLabel: { color: t.muted, formatter: (v) => `${Math.round(v * 100)}%` },
      },
      series: series.map((s) => ({
        name: s.name,
        type: "line",
        color: s.color,
        data: s.data,
        showSymbol: false,
        symbolSize: 8,
        lineStyle: { width: 2, color: s.color, cap: "round", join: "round" },
        itemStyle: { color: s.color, borderColor: t.surface, borderWidth: 2 },
      })),
    },
    { notMerge: true }
  );
}
