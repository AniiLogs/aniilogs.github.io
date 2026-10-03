import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const explorer = await readFile(new URL("../public/explorer/app.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../public/explorer/styles.css", import.meta.url), "utf8");
const config = await readFile(new URL("../public/explorer/app-config.js", import.meta.url), "utf8");
const origin = "https://aniilogs-viewer.pages.dev";
const originSource = explorer.slice(
  explorer.indexOf("const LIVE_VIEWER_ORIGIN ="),
  explorer.indexOf("const LIVE_VIEWER_MANIFEST_URL ="),
);
const configuredOrigin = (liveViewerOrigin) => new Function(
  "SITE_CONFIG", "CONTENT_BASE_URL", "window",
  `${originSource}; return LIVE_VIEWER_ORIGIN;`,
)(
  { liveViewerOrigin }, "https://aniilogs-api.pages.dev/api/content/releases/3535596",
  { location: { href: "https://aniilogs.github.io/explorer/" } },
);
const validationSource = explorer.slice(
  explorer.indexOf("function approvedLiveViewer("),
  explorer.indexOf("const LEGACY_ANIILOG_EXPANDED_GROUPS_STORAGE_KEY"),
);
const makeApproval = (allowedOrigin = origin) => new Function(
  "LIVE_VIEWER_ORIGIN", "CONTENT_PACKAGE_VERSION",
  `${validationSource}; return approvedLiveViewer;`,
)(allowedOrigin, "3535596");
const entry = { form_id: "1002603", name: "Test Aniimo", form_label: "Rainbow" };
const media = { id: "sparkling-03", label: "Sparkling Type III", renderVerified: true };
const manifest = {
  schema: "aniilogs.public.live-viewer-manifest.v1",
  reviewStatus: "approved",
  sourcePackage: 3535596,
  forms: {
    "1002603": {
      formId: 1002603,
      appearances: { "sparkling-03": { renderVerified: true, transparentBackground: true } },
    },
  },
};

test("live artwork remains disabled until a dedicated Pages origin is configured", () => {
  assert.match(config, /liveViewerOrigin: ""/u);
  assert.equal(makeApproval("")(manifest, entry, media, 3535596), null);
  assert.equal(configuredOrigin(origin), origin);
  assert.equal(configuredOrigin("https://aniilogs-api.pages.dev"), "");
  assert.equal(configuredOrigin("https://example.com"), "");
  assert.equal(configuredOrigin("https://aniilogs-viewer.pages.dev.evil.example"), "");
  assert.equal(configuredOrigin(`${origin}/unexpected`), "");
  assert.match(explorer, /if \(!LIVE_VIEWER_MANIFEST_URL\) return null;[\s\S]*controller\.abort\(\), 2500\);/u);
  assert.match(explorer, /loadOptionalLiveViewerManifest\(\),/u);
});

test("the reviewed manifest matches package, form, appearance, and transparency", () => {
  const approve = makeApproval();
  assert.deepEqual(approve(manifest, entry, media, 3535596), {
    origin,
    url: `${origin}/releases/3535596/forms/1002603/sparkling-03/index.html`,
    packageVersion: "3535596",
    formId: "1002603",
    appearanceId: "sparkling-03",
  });
  assert.equal(approve({ ...manifest, viewerUrl: "https://example.com/override" }, entry, media, 3535596)?.origin, origin);
  assert.equal(approve(manifest, entry, media, 3535597), null);
  assert.equal(approve({ ...manifest, sourcePackage: 3535597 }, entry, media, 3535596), null);
  assert.equal(approve({ ...manifest, reviewStatus: "staged" }, entry, media, 3535596), null);
  assert.equal(approve(manifest, { ...entry, form_id: "1002604" }, media, 3535596), null);
  assert.equal(approve(manifest, entry, { ...media, id: "sparkling-04" }, 3535596), null);
  assert.equal(approve(manifest, entry, { ...media, id: "../sparkling-03" }, 3535596), null);
  assert.equal(approve(manifest, entry, { ...media, renderVerified: false }, 3535596), null);
  const altered = (appearance) => ({
    ...manifest,
    forms: { "1002603": { ...manifest.forms["1002603"], appearances: { "sparkling-03": appearance } } },
  });
  assert.equal(approve(altered({ renderVerified: false, transparentBackground: true }), entry, media, 3535596), null);
  assert.equal(approve(altered({ renderVerified: true, transparentBackground: false }), entry, media, 3535596), null);
  const specialAppearance = { ...media, id: "prismana" };
  const specialManifest = {
    ...manifest,
    forms: { "1002603": {
      ...manifest.forms["1002603"],
      appearances: { prismana: { renderVerified: true, transparentBackground: true } },
    } },
  };
  assert.equal(approve(specialManifest, entry, specialAppearance, 3535596)?.appearanceId, "prismana");
});

function shellFixture() {
  const listeners = new Map();
  const timers = new Map();
  let nextTimer = 1;
  const document = { activeElement: null };
  const makeElement = (tag = "div") => {
    const classes = new Set();
    const attributes = new Map();
    const localListeners = new Map();
    return {
      tag,
      children: [],
      isConnected: true,
      contentWindow: tag === "iframe" ? {} : undefined,
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
      },
      append(...children) {
        for (const child of children) child.parent = this;
        this.children.push(...children);
      },
      setAttribute: (name, value) => attributes.set(name, value),
      getAttribute: (name) => attributes.get(name),
      addEventListener: (name, listener) => localListeners.set(name, listener),
      dispatch: (name) => localListeners.get(name)?.(),
      focus() { document.activeElement = this; },
      remove() {
        this.isConnected = false;
        if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
      },
      querySelector(selector) {
        return selector === ".catalog-aniimo-turntable" ? this.turntable || null : null;
      },
    };
  };
  document.createElement = makeElement;
  const window = {
    crypto: { randomUUID: () => "test-nonce" },
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name, listener) => {
      if (listeners.get(name) === listener) listeners.delete(name);
    },
    message: (event) => listeners.get("message")?.(event),
  };
  const state = { aniilogLiveViewerManifest: manifest, aniilogData: { package_version: 3535596 } };
  const shellSource = explorer.slice(
    explorer.indexOf("function attachLiveAniimoViewer("),
    explorer.indexOf("function attachPackedAniimoBackdrop("),
  );
  const attach = new Function(
    "state", "document", "window", "approvedLiveViewer", "setTimeout", "clearTimeout",
    `${shellSource}; return attachLiveAniimoViewer;`,
  )(
    state, document, window, makeApproval(),
    (callback) => { const id = nextTimer++; timers.set(id, callback); return id; },
    (id) => timers.delete(id),
  );
  const record = makeElement();
  record.classList.add("is-showcase");
  record.turntable = makeElement();
  record.turntable.tabIndex = 0;
  return { attach, record, document, window, timers, listeners };
}

test("the fallback stays active until an exact origin, source, identity, and nonce ready message", () => {
  const { attach, record, window, timers } = shellFixture();
  assert.equal(attach(record, entry, media), true);
  const host = record.children[0];
  assert.equal(host.children.length, 0, "closed artwork does not load the runtime");
  host.start();
  const frame = host.children[0];
  assert.match(frame.src, /^https:\/\/aniilogs-viewer\.pages\.dev\/releases\/3535596\/forms\/1002603\/sparkling-03\/index\.html\?nonce=test-nonce$/u);
  assert.equal(frame.getAttribute("sandbox"), "allow-scripts allow-same-origin");
  assert.equal(frame.getAttribute("allow"), "webgpu");
  assert.equal(record.classList.contains("is-live-ready"), false);
  assert.equal(record.turntable.tabIndex, 0);
  const ready = { type: "aniilogs.live-viewer.ready.v1", nonce: "test-nonce", packageVersion: "3535596", formId: "1002603", appearanceId: "sparkling-03" };
  window.message({ origin: "https://example.com", source: frame.contentWindow, data: ready });
  window.message({ origin, source: {}, data: ready });
  window.message({ origin, source: frame.contentWindow, data: { ...ready, nonce: "wrong" } });
  window.message({ origin, source: frame.contentWindow, data: { ...ready, appearanceId: "sparkling-04" } });
  assert.equal(record.classList.contains("is-live-ready"), false);
  window.message({ origin, source: frame.contentWindow, data: ready });
  assert.equal(record.classList.contains("is-live-ready"), true);
  assert.equal(record.turntable.tabIndex, -1);
  assert.equal(record.turntable.getAttribute("aria-hidden"), "true");
  assert.equal(host.getAttribute("aria-hidden"), "false");
  assert.equal(timers.size, 0);
  window.message({ origin, source: frame.contentWindow, data: { ...ready, type: "aniilogs.live-viewer.error.v1" } });
  assert.equal(record.classList.contains("is-live-ready"), false);
  assert.equal(record.turntable.tabIndex, 0);
  assert.equal(frame.isConnected, false);
});

test("a stalled frame times out to approved artwork and changing form stops the old frame", () => {
  const { attach, record, timers, listeners } = shellFixture();
  attach(record, entry, media);
  const host = record.children[0];
  host.start();
  const firstFrame = host.children[0];
  assert.equal(timers.size, 1);
  [...timers.values()][0]();
  assert.equal(firstFrame.isConnected, false);
  assert.equal(record.turntable.tabIndex, 0);
  assert.equal(listeners.has("message"), false);
  host.start();
  const nextFrame = host.children[0];
  host.stop();
  assert.equal(nextFrame.isConnected, false);
  assert.equal(timers.size, 0);
  assert.equal(listeners.has("message"), false);
});

test("the live layer follows the existing mobile fullscreen and desktop index layout", () => {
  assert.match(styles, /\.catalog-aniimo-live-viewer \{[^}]*position: fixed;[^}]*opacity: 0;[^}]*pointer-events: none;/u);
  assert.match(styles, /\.catalog-aniilog-record\.is-showcase \.catalog-aniimo-live-viewer\.is-ready \{[^}]*opacity: 1;/u);
  assert.match(styles, /\.catalog-aniilog-record\.is-live-ready \.catalog-aniimo-turntable,\s*\.catalog-aniilog-record\.is-live-ready \.catalog-aniimo-video-backdrop/u);
  assert.match(styles, /body\.aniilog-artwork-mode \.app-shell:not\(\.is-sidebar-collapsed\) \.catalog-aniimo-live-viewer \{\s*left: 360px;/u);
  assert.match(explorer, /if \(state\.aniilogShowcaseMode\) liveViewer\?\.start\(\);\s*else liveViewer\?\.stop\(\);/u);
});
