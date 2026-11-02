// Text the graphs share: names escaped for tooltip HTML, and days and hours as the page writes them.

import { dayToDate } from "./aggregate.js";

// Artist and track names come from user files: escape before they enter tooltip HTML.
export const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// A day index as a date, "Mar 4, 2021" unless opts says otherwise
export const fmtDay = (d, opts = { month: "short", day: "numeric", year: "numeric" }) =>
  dayToDate(d).toLocaleDateString(undefined, opts);

// Hours, four ways; each graph keeps the one it was drawn with.
// One decimal, "1,234.5 h": the mix bar, skips and picks, the rings
export const fmtHours = (h) => h.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " h";
// Whole hours from 100, "1,234 h" or "12.3 h": the ECharts readouts (charts.js)
export const fmtHoursRound = (h) => (h >= 100 ? Math.round(h).toLocaleString() : h.toFixed(1)) + " h";
// Minutes under an hour, whole hours from 10, "45 min", "3.2 h" or "12 h": Every play and Every day, Rank race
export const fmtH = (h) => (h >= 10 ? Math.round(h) + " h" : h >= 1 ? h.toFixed(1) + " h" : Math.max(1, Math.round(h * 60)) + " min");
// From milliseconds, as fmtH but with whole hours grouped ("1,234 h") and at least `floor` minutes: the ranked
// list, Top … over time (whose items not played yet read "0 min")
export const hoursText = (ms, floor = 1) => {
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(floor, Math.round(h * 60))} min`;
  return h < 10 ? `${h.toFixed(1)} h` : `${Math.round(h).toLocaleString()} h`;
};
