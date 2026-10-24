import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = (await readFile(new URL("../public/explorer/app.js", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
function region(start, end) {
  const a = source.indexOf(start), z = source.indexOf(end, a + start.length);
  assert(a >= 0 && z > a);
  return source.slice(a, z);
}
const create = new Function(region("function createDeveloperModeAccountWrites(", "\nconst developerAccountWrites =") + ";return createDeveloperModeAccountWrites;")();
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const ack = (enabled = true, overrides = {}) => ({ ok: true, status: 200, json: async () => ({ ok: true,
  purpose: "aniilogs-dev-source-model-uid", devModeEnabled: enabled, serverDevModeRevision: 1, ...overrides }) });
function fixture(options = {}) {
  const state = { ownerId: "unit-owner", token: "unit-session", authenticated: true, available: true, selectedMode: true };
  const calls = [];
  const writes = create({ getContext: () => state,
    requestMode: async enabled => { calls.push(enabled); return options.requestMode ? options.requestMode(enabled) : ack(enabled); },
    writeProgress: options.writeProgress || (async () => {}) });
  return { state, calls, writes };
}

test("every already-on launch requires a new strict ACK; default/off/unavailable owners cannot enable", async () => {
  const f = fixture(); let tickets = 0;
  await f.writes.withMode(true, async () => tickets++);
  await f.writes.withMode(true, async () => tickets++);
  assert.deepEqual(f.calls, [true, true]); assert.equal(tickets, 2);
  for (const patch of [{ selectedMode: false }, { available: false }, { authenticated: false }, { ownerId: "" }, { token: "" }]) {
    const denied = fixture(); Object.assign(denied.state, patch);
    await assert.rejects(denied.writes.withMode(true, () => assert.fail("ticket")), /changed/);
    assert.deepEqual(denied.calls, []);
  }
  for (const response of [{ ok: false, status: 401 }, ack(true, { ok: false }), ack(true, { purpose: "wrong" }),
    ack(false), ack(true, { serverDevModeRevision: 0 }), ack(true, { serverDevModeRevision: "1" }),
    ack(true, { serverDevModeRevision: Number.MAX_SAFE_INTEGER + 1 })]) {
    const denied = fixture({ requestMode: () => response });
    await assert.rejects(denied.writes.withMode(true, () => assert.fail("ticket")), /acknowledge/);
  }
});

test("409 retries are bounded and off remains available after role revocation", async () => {
  let n = 0;
  const f = fixture({ requestMode: enabled => ++n < 3 ? { ok: false, status: 409 } : ack(enabled) });
  await f.writes.setMode(true); assert.equal(n, 3);
  const denied = fixture({ requestMode: () => ({ ok: false, status: 409 }) });
  await assert.rejects(denied.writes.withMode(true, () => assert.fail("ticket")), /acknowledged/);
  assert.equal(denied.calls.length, 3);
  f.state.selectedMode = false; f.state.available = false; f.writes.modeChanged();
  await f.writes.setMode(false); assert.equal(f.calls.at(-1), false);
});

test("queued ACK drains progress and holds the lease through ticket/handoff; later save takes latest snapshot", async () => {
  const upload = deferred(), ticket = deferred(), events = []; let snapshot = 1;
  const f = fixture({ writeProgress: async current => { assert(current()); events.push("save:" + snapshot); if (events.length === 1) await upload.promise; },
    requestMode: async enabled => { events.push("ack"); return ack(enabled); } });
  const first = f.writes.uploadProgress(); await turn();
  const launch = f.writes.withMode(true, async (_result, current) => { events.push("ticket"); await ticket.promise; current(); events.push("handoff"); });
  const last = f.writes.uploadProgress(); snapshot = 2; await turn(); assert.deepEqual(events, ["save:1"]);
  upload.resolve(); await first; await turn(); assert.deepEqual(events, ["save:1", "ack", "ticket"]);
  ticket.resolve(); await Promise.all([launch, last]); assert.deepEqual(events, ["save:1", "ack", "ticket", "handoff", "save:2"]);
});

test("ABA/off/account changes reject old ACK before retry, ticket or handoff", async () => {
  for (const change of [f => { f.state.selectedMode = false; f.writes.modeChanged(); },
    f => { f.state.selectedMode = false; f.writes.modeChanged(); f.state.selectedMode = true; f.writes.modeChanged(); },
    f => { f.state.ownerId = "other"; f.state.token = "other-session"; f.writes.invalidate(); },
    f => { f.state.authenticated = false; f.writes.invalidate(); }]) {
    const response = deferred(), f = fixture({ requestMode: () => response.promise });
    const old = f.writes.withMode(true, () => assert.fail("stale ticket")); await turn(); change(f);
    response.resolve({ ok: false, status: 409 });
    await assert.rejects(old, error => error.superseded === true); assert.equal(f.calls.length, 1);
  }
});

test("old queued jobs never use a new session; old 401 cannot clear the new session", async () => {
  const blocker = deferred(), events = []; let first = true;
  const f = fixture({ writeProgress: async current => {
    events.push(f.state.ownerId);
    if (first) { first = false; await blocker.promise; if (current()) events.push("clear-session"); }
  } });
  const active = f.writes.uploadProgress(); await turn();
  const queuedSave = f.writes.uploadProgress(), queuedAck = f.writes.withMode(true, () => assert.fail("old ticket"));
  f.state.ownerId = "other"; f.state.token = "new-session"; f.writes.invalidate(); blocker.resolve();
  await Promise.all([active, queuedSave]); await assert.rejects(queuedAck, error => error.superseded === true);
  assert.deepEqual(events, ["unit-owner"]); assert.deepEqual(f.calls, []);
  const productionWrite = region("  writeProgress: async current =>", "\n});");
  assert(productionWrite.indexOf("if (!current()) return;") < productionWrite.indexOf("clearAuthSession()"));
});

test("actual open flow checks current generation after ticket and JSON awaits; stale errors are silent", async () => {
  for (const phase of ["ticket", "json"]) {
    const pending = deferred(), f = fixture(), forms = [], alerts = [], calls = [];
    const state = { cloudSyncAuthenticated: true }, button = { disabled: false, textContent: "Preview" };
    const body = region("async function openDeveloperModelPreview(", "\nfunction signInReturnUrl(");
    const apiFetch = async path => { calls.push(path); if (phase === "ticket") return pending.promise;
      return { ok: true, json: () => pending.promise }; };
    const open = new Function("developerModeEnabled", "state", "developerSelectionFieldsV11040", "apiFetch", "authSessionToken", "window", "developerAccountWrites", "submitDeveloperPreviewHandoff", body + ";return openDeveloperModelPreview;")(
      () => f.state.selectedMode, state, value => value, apiFetch, () => f.state.token,
      { alert: value => alerts.push(value) }, f.writes, (...args) => forms.push(args));
    const launch = open(button, { choice: "unit-selection" }); await turn();
    f.state.selectedMode = false; f.writes.modeChanged(); f.state.selectedMode = true; f.writes.modeChanged();
    pending.resolve(phase === "ticket" ? { ok: true, json: async () => ({ ticket: "unit-ticket" }) } : { ticket: "unit-ticket" });
    await launch; assert.deepEqual(calls, ["/dev-preview/ticket"]); assert.deepEqual(forms, []); assert.deepEqual(alerts, []);
    assert.deepEqual(button, { disabled: false, textContent: "Preview" });
  }
});

test("settings invalidate ABA status and update immediately; public script identity is fresh", async () => {
  const settings = region("function renderDeveloperSettings(", "\nfunction ");
  assert.match(settings, /request === modeStatusRequest/u);
  assert(settings.indexOf("applyDeveloperVisibility();") < settings.indexOf("developerAccountWrites.setMode(selected)"));
  assert.match(settings, /developerAccountWrites\.modeChanged\(\)/u);
  const index = await readFile(new URL("../public/explorer/index.html", import.meta.url), "utf8");
  assert.match(index, /app\.js\?v=0.17.20-research-guides/u);
});
