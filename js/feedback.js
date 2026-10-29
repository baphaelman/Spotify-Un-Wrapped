// "Missing something?" requests, plus the owner's inbox (open the site with #inbox).
import * as api from "./api.js";

const $ = (id) => document.getElementById(id);
const ADMIN_KEY = "feedback-admin";

function stored() {
  try { return localStorage.getItem(ADMIN_KEY) || ""; } catch { return ""; }
}
function store(v) {
  try { v ? localStorage.setItem(ADMIN_KEY, v) : localStorage.removeItem(ADMIN_KEY); } catch {}
}

// ---------- Sending ----------

$("feedback-open").addEventListener("click", () => {
  $("feedback-status").textContent = "";
  $("feedback-send").disabled = false;
  $("feedback-dialog").showModal();
  $("feedback-message").focus();
});
$("feedback-close").addEventListener("click", () => $("feedback-dialog").close());

$("feedback-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = $("feedback-message").value.trim();
  if (!message || $("feedback-website").value) return; // the website field is a honeypot for bots
  $("feedback-send").disabled = true;
  $("feedback-status").classList.remove("error");
  $("feedback-status").textContent = "Sending…";
  try {
    await api.submitFeedback(message, $("feedback-contact").value);
    $("feedback-message").value = "";
    $("feedback-status").textContent = "Thanks, got it!";
    setTimeout(() => $("feedback-dialog").close(), 1200);
  } catch (err) {
    $("feedback-status").classList.add("error");
    $("feedback-status").textContent = `Couldn't send: ${err.message}`;
    $("feedback-send").disabled = false;
  }
});

// ---------- Inbox ----------

let admin = "";

function row(item) {
  const li = document.createElement("li");
  li.className = "inbox-item" + (item.done ? " done" : "");
  const msg = document.createElement("p");
  msg.textContent = item.message;
  const meta = document.createElement("div");
  meta.className = "inbox-meta muted small";
  const when = new Date(item.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  const label = document.createElement("span");
  label.textContent = item.contact ? `${when} · ${item.contact}` : when;
  const done = document.createElement("button");
  done.type = "button"; done.className = "ghost"; done.textContent = item.done ? "Reopen" : "Done";
  done.addEventListener("click", () => act(() => api.setFeedbackDone(admin, item.id, !item.done)));
  const del = document.createElement("button");
  del.type = "button"; del.className = "ghost"; del.textContent = "Delete";
  del.addEventListener("click", () => act(() => api.deleteFeedback(admin, item.id)));
  meta.append(label, done, del);
  li.append(msg, meta);
  return li;
}

async function act(fn) {
  try { await fn(); await refresh(); } catch (err) { $("inbox-status").textContent = err.message; }
}

async function refresh() {
  const items = await api.listFeedback(admin);
  $("inbox-login").hidden = true;
  $("inbox-body").hidden = false;
  $("inbox-status").textContent = items.length ? `${items.filter((i) => !i.done).length} open of ${items.length}` : "Nothing yet.";
  $("inbox-list").replaceChildren(...items.map(row));
}

async function openInbox() {
  $("inbox-dialog").showModal();
  $("inbox-status").textContent = "";
  $("inbox-body").hidden = true;
  $("inbox-login").hidden = false;
  if (stored()) {
    admin = stored();
    try { await refresh(); return; } catch { store(""); }
  }
  $("inbox-pass").focus();
}

$("inbox-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  admin = $("inbox-pass").value;
  try {
    await refresh();
    store(admin);
    $("inbox-pass").value = "";
  } catch (err) {
    $("inbox-status").textContent = err.message;
  }
});
$("inbox-close").addEventListener("click", () => $("inbox-dialog").close());
$("inbox-signout").addEventListener("click", () => { store(""); admin = ""; $("inbox-dialog").close(); });
$("inbox-dialog").addEventListener("close", () => {
  if (location.hash === "#inbox") history.replaceState(null, "", location.pathname + location.search);
});

function checkHash() {
  if (location.hash === "#inbox" && !$("inbox-dialog").open) openInbox();
}
addEventListener("hashchange", checkHash);
checkHash();
