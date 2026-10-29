// Thin client for the Postgres functions in supabase/schema.sql.
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

async function rpc(fn, args = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `Request failed (${res.status})`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export const submitSummary = (key, summary) => rpc("submit_summary", { p_key: key, p_summary: summary });
export const deleteSummary = (key) => rpc("delete_summary", { p_key: key });
export const isShared = (key) => rpc("is_shared", { p_key: key });
export const communityStats = () => rpc("community_stats");
export const artistRanks = (artists) =>
  rpc("artist_ranks", { p_artists: artists.map((a) => a.name), p_hours: artists.map((a) => a.hours) });

export const submitFeedback = (message, contact) => rpc("submit_feedback", { p_message: message, p_contact: contact || null });
export const listFeedback = (admin) => rpc("list_feedback", { p_admin: admin });
export const setFeedbackDone = (admin, id, done) => rpc("set_feedback_done", { p_admin: admin, p_id: id, p_done: done });
export const deleteFeedback = (admin, id) => rpc("delete_feedback", { p_admin: admin, p_id: id });
