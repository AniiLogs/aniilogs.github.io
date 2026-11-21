// The Comments tab of the run viewer (proof-viewer.js): one thread per run (every copy of a team run opens the same
// one), anyone reads, a signed-in account writes. Comments are plain text, always put on the page as text, never as
// HTML. window.AniilogsComments.mount(runId) gives the viewer its tab (with the count) and draws the thread into the
// viewer's body when that tab is picked. Staff (administrators, the owner) get a "…" menu on each comment.
(() => {
  const siteConfig = window.ANIILOGS_CONFIG || {};
  const API_URL = String(siteConfig.apiUrl || siteConfig.shareApiUrl || "").replace(/\/+$/u, "");
  const AUTH_SESSION_STORAGE_KEY = "aniilogs:auth:session:v1";
  const MAX_CHARS = 500;

  function sessionToken() {
    try { return String(window.localStorage.getItem(AUTH_SESSION_STORAGE_KEY) || ""); } catch { return ""; }
  }
  async function apiFetch(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const token = sessionToken();
    if (token) headers.set("authorization", `Bearer ${token}`);
    if (options.body !== undefined) headers.set("content-type", "application/json");
    return fetch(`${API_URL}${path}`, { ...options, credentials: "omit", headers });
  }
  async function errorText(response, fallback) {
    try { return (await response.json()).error || fallback; } catch { return fallback; }
  }
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
    return node;
  }
  const chars = (text) => [...String(text || "")].length;
  // "just now", "12 minutes ago", "2 hours ago", "Yesterday", "3 days ago", then the date
  function age(ms) {
    const seconds = Math.max(0, (Date.now() - ms) / 1000);
    if (seconds < 60) return "just now";
    const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"} ago`;
    if (seconds < 3600) return plural(Math.floor(seconds / 60), "minute");
    if (seconds < 86400) return plural(Math.floor(seconds / 3600), "hour");
    if (seconds < 2 * 86400) return "Yesterday";
    if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)} days ago`;
    return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  function loader(text) {
    const art = el("span", { class: "cm-loader-art", "aria-hidden": "true" });
    window.AlogsLoader?.create(art)?.loop();
    return el("p", { class: "cm-loading", role: "status" }, art, el("span", { text }));
  }
  // a name as the site shows it: the Discord logo before a Discord name (site-sidebar.js), linked to a public profile
  function authorName(author) {
    const label = author.discord ? window.AniiSite?.playerName?.(author.name, "discord") || document.createTextNode(author.name)
      : document.createTextNode(author.name);
    return author.profileId
      ? el("a", { class: "cm-name", href: `/?profile=${encodeURIComponent(author.profileId)}`, title: "Open their profile" }, label)
      : el("span", { class: "cm-name" }, label);
  }
  const notifyChanged = () => window.dispatchEvent(new CustomEvent("aniilogs:notifications-changed"));
  const signInHref = () => `${API_URL}/auth/discord/start?return_to=${encodeURIComponent(window.location.href.replace(/#.*$/u, ""))}`;

  // One run's thread in the viewer: its tab (the count beside "Comments") and its panel.
  function mount(runId) {
    const count = el("span", { class: "cm-tab-count", hidden: true });
    const tab = el("button", { type: "button", role: "tab", class: "cm-tab", "data-proof-tab": "comments", "aria-selected": "false" },
      el("span", { text: "Comments" }), count);
    const state = { data: null, error: "", loading: null, host: null, draft: "", openMenu: null, reporting: null };
    const setCount = () => {
      const n = state.data?.count || 0;
      count.textContent = String(n);
      count.hidden = n === 0;
      tab.setAttribute("aria-label", n ? `Comments, ${n}` : "Comments");
    };
    async function load() {
      state.loading ??= (async () => {
        try {
          const response = await apiFetch(`/runs/${encodeURIComponent(runId)}/comments`);
          if (response.status === 404) { state.error = "This run isn't available."; state.missing = true; return; }
          if (!response.ok) { state.error = await errorText(response, "Could not load the comments."); return; }
          state.data = await response.json();
          state.error = "";
          setCount();
        } catch {
          state.error = "Could not load the comments. Check your connection.";
        }
      })().finally(() => { state.loading = null; });
      return state.loading;
    }
    const ready = load().then(() => !state.missing);

    // draws the thread into `host` (the viewer's body); signed in and following, the thread counts as read
    async function show(host) {
      state.host = host;
      if (!state.data) {
        host.replaceChildren(loader("Loading the comments…"));
        await load();
        if (state.host !== host) return;
      }
      render();
      if (state.data?.viewer?.signedIn) {
        apiFetch(`/runs/${encodeURIComponent(runId)}/thread/read`, { method: "POST", body: "{}" }).then(notifyChanged, () => {});
      }
    }
    function render() {
      const host = state.host;
      if (!host) return;
      if (!state.data) {
        host.replaceChildren(el("div", { class: "cm-panel" }, el("p", { class: "cm-empty", text: state.error || "Could not load the comments." }),
          state.missing ? null : el("button", { type: "button", class: "cm-link-button", text: "Try again", onclick: async () => {
            host.replaceChildren(loader("Loading the comments…"));
            await load();
            render();
          } })));
        return;
      }
      const { comments, viewer } = state.data;
      const list = comments.length ? el("div", { class: "cm-list" }, comments.map(commentNode))
        : el("p", { class: "cm-empty", text: "No comments yet." });
      host.replaceChildren(el("div", { class: "cm-panel" }, viewer.following ? notificationSwitch(viewer) : null, list, composer(viewer)));
    }

    // "Notifications for this thread: On / Off", for signed-in accounts who follow it (on the run, or commented)
    function notificationSwitch(viewer) {
      const on = viewer.notifications;
      const button = el("button", { type: "button", role: "switch", class: "cm-switch", "aria-checked": String(on),
        "aria-label": "Notifications for this thread", onclick: async () => {
          button.disabled = true;
          const response = await apiFetch(`/runs/${encodeURIComponent(runId)}/thread/notifications`, { method: "PUT", body: JSON.stringify({ on: !on }) }).catch(() => null);
          if (response?.ok) { viewer.notifications = !on; notifyChanged(); }
          render();
        } }, el("span", { text: on ? "On" : "Off" }), el("span", { class: "cm-switch-track", "aria-hidden": "true" }, el("span", { class: "cm-switch-knob" })));
      const bell = el("span", { class: "cm-bell", "aria-hidden": "true" });
      bell.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9a6 6 0 0 1 12 0c0 4.5 1.2 6.2 2 7.5H4c.8-1.3 2-3 2-7.5Z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/></svg>';
      return el("div", { class: "cm-follow" }, el("span", { class: "cm-follow-label" }, bell, el("span", { text: "Notifications for this thread" })), button);
    }

    function commentNode(comment) {
      const viewer = state.data.viewer;
      const actions = [];
      if (comment.own) {
        actions.push(el("button", { type: "button", class: "cm-action is-danger", text: "Delete", onclick: () => remove(comment, "Delete your comment? This can't be undone.") }));
      } else if (viewer.staff) {
        actions.push(staffMenu(comment));
      } else if (viewer.signedIn) {
        actions.push(comment.reported ? el("span", { class: "cm-action is-done", text: "Reported" })
          : el("button", { type: "button", class: "cm-action", text: "Report", "aria-expanded": String(state.reporting === comment.id),
            onclick: () => { state.reporting = state.reporting === comment.id ? null : comment.id; render(); } }));
      }
      const head = el("div", { class: "cm-head" }, authorName(comment.author),
        comment.own ? el("span", { class: "cm-you", text: "you" }) : null,
        comment.onRun ? el("span", { class: "cm-tag", text: "on this run" }) : null,
        el("time", { class: "cm-age", datetime: new Date(comment.at).toISOString(), title: new Date(comment.at).toLocaleString(), text: age(comment.at) }),
        viewer.staff && comment.reports ? el("span", { class: "cm-tag is-reported", text: `Reported ${comment.reports}×` }) : null,
        viewer.staff && comment.authorBanned ? el("span", { class: "cm-tag is-reported", text: "Can't comment" }) : null,
        el("span", { class: "cm-actions" }, actions));
      return el("article", { class: `cm-comment${comment.own ? " is-own" : ""}${comment.hidden ? " is-hidden" : ""}` }, head,
        comment.hidden ? el("p", { class: "cm-hidden-note", text: "Hidden by staff. Only staff see this comment." }) : null,
        el("p", { class: "cm-text", text: comment.text }),
        state.reporting === comment.id ? reportForm(comment) : null);
    }

    function reportForm(comment) {
      const reason = el("input", { type: "text", class: "cm-input", maxlength: "200", placeholder: "Why? (optional)", "aria-label": "Why are you reporting this comment? (optional)" });
      const message = el("p", { class: "cm-error", role: "alert", hidden: true });
      const send = el("button", { type: "submit", class: "cm-small-button", text: "Send report" });
      const form = el("form", { class: "cm-report", onsubmit: async (event) => {
        event.preventDefault();
        send.disabled = true;
        const response = await apiFetch(`/comments/${encodeURIComponent(comment.id)}/report`, { method: "POST", body: JSON.stringify({ reason: reason.value }) }).catch(() => null);
        if (response?.ok || response?.status === 409) {
          comment.reported = true;
          state.reporting = null;
          render();
          return;
        }
        send.disabled = false;
        message.hidden = false;
        message.textContent = response ? await errorText(response, "Could not send the report.") : "Could not send the report. Check your connection.";
      } }, el("p", { class: "cm-report-title", text: "Report this comment to staff" }), reason,
      el("div", { class: "cm-report-actions" }, send, el("button", { type: "button", class: "cm-link-button", text: "Cancel", onclick: () => { state.reporting = null; render(); } })),
      message);
      queueMicrotask(() => reason.focus());
      return form;
    }

    // staff: hide (or show again), delete, stop the author from commenting (or undo it)
    function staffMenu(comment) {
      const open = state.openMenu === comment.id;
      const toggle = el("button", { type: "button", class: "cm-menu-button", "aria-label": "Staff options for this comment", "aria-expanded": String(open),
        onclick: () => { state.openMenu = open ? null : comment.id; render(); } });
      toggle.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/></svg>';
      if (!open) return el("span", { class: "cm-menu-wrap" }, toggle);
      const item = (text, onclick, danger = false) => el("button", { type: "button", role: "menuitem", class: `cm-menu-item${danger ? " is-danger" : ""}`, text, onclick });
      return el("span", { class: "cm-menu-wrap" }, toggle, el("div", { class: "cm-menu", role: "menu" },
        item(comment.hidden ? "Show to everyone again" : "Hide from everyone", () => hide(comment, !comment.hidden)),
        item("Delete comment", () => remove(comment, "Delete this comment for everyone? This can't be undone."), true),
        item(comment.authorBanned ? "Let this account comment again" : "Stop this account from commenting", () => ban(comment, !comment.authorBanned), !comment.authorBanned)));
    }
    async function hide(comment, hidden) {
      state.openMenu = null;
      const response = await apiFetch(`/comments/${encodeURIComponent(comment.id)}`, { method: "PATCH", body: JSON.stringify({ hidden }) }).catch(() => null);
      if (!response?.ok) { window.alert(response ? await errorText(response, "Could not change this comment.") : "Could not reach AniiLogs."); render(); return; }
      comment.hidden = hidden;
      state.data.count += hidden ? -1 : 1;
      setCount();
      render();
      notifyChanged();
    }
    async function remove(comment, question) {
      state.openMenu = null;
      if (!window.confirm(question)) { render(); return; }
      const response = await apiFetch(`/comments/${encodeURIComponent(comment.id)}`, { method: "DELETE" }).catch(() => null);
      if (!response?.ok) { window.alert(response ? await errorText(response, "Could not delete this comment.") : "Could not reach AniiLogs."); render(); return; }
      state.data.comments = state.data.comments.filter((other) => other.id !== comment.id);
      if (!comment.hidden) state.data.count -= 1;
      setCount();
      render();
      notifyChanged();
    }
    async function ban(comment, banned) {
      state.openMenu = null;
      if (banned && !window.confirm(`Stop ${comment.author.name} from commenting anywhere on AniiLogs? You can undo this later.`)) { render(); return; }
      const response = await apiFetch(`/comments/${encodeURIComponent(comment.id)}/ban`, { method: banned ? "POST" : "DELETE" }).catch(() => null);
      if (!response?.ok) { window.alert(response ? await errorText(response, "Could not change this account.") : "Could not reach AniiLogs."); render(); return; }
      await load();     // every comment of that author in this thread shows it
      render();
    }

    // the box at the bottom: "Your comment", a character counter and Post; signed out, a sign-in link
    function composer(viewer) {
      if (!viewer.signedIn) {
        return el("p", { class: "cm-signin" }, el("a", { class: "cm-signin-link", href: signInHref(), text: "Sign in to comment" }));
      }
      if (viewer.banned) return el("p", { class: "cm-empty", text: "Staff have stopped this account from commenting." });
      const id = `cm-box-${runId}`;
      const box = el("textarea", { id, class: "cm-box", rows: "3", placeholder: "Write a comment…" });
      box.value = state.draft;
      const counter = el("span", { class: "cm-counter", "aria-live": "polite" });
      const post = el("button", { type: "submit", class: "cm-post", text: "Post" });
      const message = el("p", { class: "cm-error", role: "alert", hidden: true });
      const update = () => {
        state.draft = box.value;
        const n = chars(box.value.trim());
        counter.textContent = `${chars(box.value)} / ${MAX_CHARS}`;
        counter.classList.toggle("is-over", chars(box.value) > MAX_CHARS);
        post.disabled = n === 0 || n > MAX_CHARS;
      };
      box.addEventListener("input", update);
      update();
      return el("form", { class: "cm-compose", onsubmit: async (event) => {
        event.preventDefault();
        post.disabled = true;
        message.hidden = true;
        const response = await apiFetch(`/runs/${encodeURIComponent(runId)}/comments`, { method: "POST", body: JSON.stringify({ text: box.value }) }).catch(() => null);
        if (!response?.ok) {
          message.hidden = false;
          message.textContent = response ? await errorText(response, "Could not post your comment.") : "Could not post your comment. Check your connection.";
          update();
          return;
        }
        const { comment } = await response.json();
        state.data.comments.push(comment);
        state.data.count += 1;
        state.data.viewer.following = true;
        state.draft = "";
        setCount();
        render();
        state.host?.querySelector(".cm-list")?.lastElementChild?.scrollIntoView({ block: "nearest" });
      } }, el("label", { class: "cm-label", for: id, text: "Your comment" }), box,
      el("div", { class: "cm-compose-foot" }, counter, post), message);
    }

    // the viewer moved on to another run: a late answer no longer draws into its body
    const detach = () => { state.host = null; };
    return { tab, show, detach, ready, runId };
  }

  window.AniilogsComments = Object.freeze({ mount });
})();
