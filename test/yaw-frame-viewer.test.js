import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const explorer = await readFile(new URL("../public/explorer/app.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../public/explorer/styles.css", import.meta.url), "utf8");
const validatorSource = explorer.slice(
  explorer.indexOf("function approvedYawFrames("),
  explorer.indexOf("const LEGACY_ANIILOG_EXPANDED_GROUPS_STORAGE_KEY"),
);
const approve = new Function(`${validatorSource}; return approvedPetManualVariants;`)();
const viewerSource = explorer.slice(
  explorer.indexOf("function attachYawFrameViewer("),
  explorer.indexOf("function attachPackedAniimoBackdrop("),
);

const entry = { form_id: "1002603", form_key: "rainbow", name: "Test Aniimo", form_label: "Rainbow" };
const turntable = {
  renderVerified: true,
  transparentBackground: true,
  basePath: "./assets/aniimo-turntables/1002603/sparkling-03",
  frameCount: 36,
  format: "webp",
};
const videoVariant = {
  id: "sparkling-03",
  style: 3,
  video: "./media/aniimo/petmanual/1002603/sparkling-03.mp4",
  video_layout: "rgb-alpha-vertical",
  renderSource: "client-authored-capture",
  renderVerified: true,
  representativeHash: "a".repeat(64),
  turntable,
};
const manifest = {
  schema: "aniilogs.private.petmanual-artwork-manifest.v1",
  reviewStatus: "approved",
  sourcePackage: 3535596,
  forms: { "1002603": { formId: 1002603, variants: [videoVariant] } },
};

test("normal Aniilog video preview remains visible while unopened frame output stays hidden", () => {
  assert.match(styles, /\.catalog-aniimo-video-backdrop \{[^}]*opacity: 0\.24;/u);
  assert.match(styles, /\.catalog-aniimo-turntable \{[^}]*opacity: 0;/u);
  assert.match(styles, /\.catalog-aniimo-turntable \{[^}]*grid-template-rows: minmax\(0, 1fr\);/u);
  assert.match(explorer, /if \(state\.aniilogShowcaseMode\) turntable\.start\(\);/u);
});

test("only package-matched, approved transparent frame outputs reach the viewer", () => {
  const approved = approve(manifest, entry, 3535596);
  assert.deepEqual(approved[0].turntable, {
    basePath: turntable.basePath,
    frameCount: 36,
    format: "webp",
  });
  assert.deepEqual(approve({ ...manifest, reviewStatus: "staged-unapproved" }, entry, 3535596), []);
  assert.deepEqual(approve(manifest, entry, 3535597), []);
  assert.deepEqual(approve({ ...manifest, sourcePackage: undefined }, entry, undefined), []);

  for (const invalid of [
    { renderVerified: false },
    { transparentBackground: false },
    { basePath: "https://example.com/frames" },
    { basePath: "./assets/aniimo-turntables/1017300/diagnostic" },
    { frameCount: 0 },
  ]) {
    const candidate = {
      ...manifest,
      forms: {
        "1002603": {
          formId: 1002603,
          variants: [{ ...videoVariant, turntable: { ...turntable, ...invalid } }],
        },
      },
    };
    const [appearance] = approve(candidate, entry, 3535596);
    assert.equal(appearance.turntable, null);
    assert.equal(appearance.video, videoVariant.video, "the approved MP4 stays available");
  }
});

test("reviewed frame-only output is accepted without inventing a rarity video", () => {
  const frameOnly = {
    ...videoVariant,
    video: "",
    video_layout: "",
    renderSource: "client-authored-capture",
  };
  const candidate = {
    ...manifest,
    forms: { "1002603": { formId: 1002603, variants: [frameOnly] } },
  };
  const [appearance] = approve(candidate, entry, 3535596);
  assert.equal(appearance.video, "");
  assert.deepEqual(appearance.turntable, {
    basePath: turntable.basePath,
    frameCount: turntable.frameCount,
    format: turntable.format,
  });
  assert.deepEqual(approve({
    ...candidate,
    forms: { "1002603": { formId: 1002603, variants: [{ ...frameOnly, renderSource: "browser-reconstruction" }] } },
  }, entry, 3535596), []);
  assert.deepEqual(approve({
    ...candidate,
    forms: { "1002603": { formId: 1002603, variants: [{ ...frameOnly, renderSource: "offline-game-render" }] } },
  }, entry, 3535596), []);
});

function viewerFixture() {
  const requests = [];
  const fallbacks = [];
  class FakeElement {
    constructor() {
      this.children = [];
      this.attributes = new Map();
      this.listeners = new Map();
      this.isConnected = true;
      this.clientWidth = 360;
      const classes = new Set();
      this.classList = {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
      };
    }

    append(...children) {
      for (const child of children) child.parent = this;
      this.children.push(...children);
    }

    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name); }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    dispatch(name, event) { this.listeners.get(name)?.(event); }
    focus() { this.focused = true; }
    setPointerCapture(id) { this.pointerCapture = id; }
    hasPointerCapture(id) { return this.pointerCapture === id; }
    releasePointerCapture() { this.pointerCapture = null; }
    remove() { this.isConnected = false; }
  }
  class FakeImage {
    set src(url) { this.url = url; requests.push(this); }
    get src() { return this.url; }
  }
  const document = { createElement: () => new FakeElement() };
  const contentUrl = (path) => `https://aniilogs-api.pages.dev/api/content/releases/3535596/${path.slice(2)}`;
  const attach = new Function(
    "document", "Image", "contentUrl", "attachPackedAniimoBackdrop",
    `${viewerSource}; return attachYawFrameViewer;`,
  )(document, FakeImage, contentUrl, (...args) => fallbacks.push(args));
  return { attach, requests, fallbacks, FakeElement };
}

test("yaw viewer loads frames on demand and supports touch and keyboard rotation", async () => {
  const { attach, requests, FakeElement } = viewerFixture();
  const record = new FakeElement();
  record.classList.add("is-showcase");
  const appearance = { ...videoVariant, turntable: {
    basePath: turntable.basePath,
    frameCount: turntable.frameCount,
    format: turntable.format,
  } };
  assert.equal(attach(record, entry, appearance), true);
  const viewer = record.children[0];
  assert.equal(viewer.getAttribute("role"), "slider");
  assert.equal(requests.length, 0, "artwork stays unloaded until Show Artwork is opened");
  viewer.start();
  assert.equal(requests.length, 1, "the first frame loads without downloading the sequence");
  assert.match(requests[0].url, /aniilogs-api\.pages\.dev\/api\/content\/releases\/3535596\/assets\/aniimo-turntables\/1002603\/sparkling-03\/frame-000\.webp$/u);

  requests[0].onload();
  await new Promise(setImmediate);
  assert.deepEqual(requests.map((image) => image.url.match(/frame-(\d{3})/u)[1]), ["000", "001", "035"]);

  let prevented = false;
  viewer.dispatch("keydown", { key: "ArrowRight", preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(viewer.getAttribute("aria-valuenow"), "1");
  requests[1].onload();
  await new Promise(setImmediate);
  assert.match(viewer.children[0].src, /frame-001\.webp$/u);

  viewer.dispatch("pointerdown", {
    pointerId: 7, pointerType: "touch", button: 0, clientX: 100, preventDefault() {},
  });
  const requestsBeforeDrag = requests.length;
  viewer.dispatch("pointermove", { pointerId: 7, clientX: 120 });
  assert.equal(viewer.getAttribute("aria-valuenow"), "3");
  assert.equal(requests.length, requestsBeforeDrag, "rapid drag updates are coalesced");
  viewer.dispatch("pointerup", { pointerId: 7 });
  assert.equal(viewer.pointerCapture, null);
});

test("a missing reviewed frame restores the approved MP4", async () => {
  const { attach, requests, fallbacks, FakeElement } = viewerFixture();
  const record = new FakeElement();
  const appearance = { ...videoVariant, turntable: {
    basePath: turntable.basePath,
    frameCount: turntable.frameCount,
    format: turntable.format,
  } };
  attach(record, entry, appearance);
  record.children[0].start();
  requests[0].onerror();
  await new Promise(setImmediate);
  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0][1].showcase_media.turntable, null);
  assert.equal(fallbacks[0][1].showcase_media.video, videoVariant.video);
});

test("a missing frame-only appearance shows an error instead of a wrong rarity video", async () => {
  const { attach, requests, fallbacks, FakeElement } = viewerFixture();
  const record = new FakeElement();
  const appearance = { ...videoVariant, video: "", turntable: {
    basePath: turntable.basePath,
    frameCount: turntable.frameCount,
    format: turntable.format,
  } };
  attach(record, entry, appearance);
  const viewer = record.children[0];
  viewer.start();
  requests[0].onerror();
  await new Promise(setImmediate);
  assert.equal(fallbacks.length, 0);
  assert.equal(viewer.getAttribute("role"), "status");
  assert.match(viewer.children[1].textContent, /could not load/u);
});
