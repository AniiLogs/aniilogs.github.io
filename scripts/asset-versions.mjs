// Version tags on the site's scripts and stylesheets (?v=...): browsers may keep a tagged file for a year, so a file
// that changes must get a new tag, and every page must load it with the same tag.
//   node scripts/asset-versions.mjs          checks (the test runs this too)
//   node scripts/asset-versions.mjs --write  records the current tags and contents in test/asset-versions.json,
//                                            and refuses a file whose contents changed under the same tag
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");
const RECORD = join(ROOT, "test", "asset-versions.json");

function pages(dir = PUBLIC) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pages(path);
    return entry.name.endsWith(".html") ? [path] : [];
  });
}

// every tagged script or stylesheet: its file (from public/, with / between parts), its tags and the pages using them
export function currentAssets() {
  const assets = new Map();
  for (const page of pages()) {
    const html = readFileSync(page, "utf8");
    for (const match of html.matchAll(/(?:src|href)="([^"?#]+\.(?:js|css))\?v=([^"&#]+)"/gu)) {
      const [, ref, tag] = match;
      if (/^[a-z]+:\/\//iu.test(ref)) continue;                       // another site's file
      const file = ref.startsWith("/") ? join(PUBLIC, ref) : resolve(dirname(page), ref);
      const key = relative(PUBLIC, file).split(sep).join("/");
      const asset = assets.get(key) || { tags: new Set(), pages: new Set() };
      asset.tags.add(tag);
      asset.pages.add(relative(PUBLIC, page).split(sep).join("/"));
      assets.set(key, asset);
    }
  }
  return new Map([...assets].sort(([a], [b]) => a.localeCompare(b)).map(([key, asset]) => {
    const path = join(PUBLIC, key);
    // line endings don't count, so a Windows checkout and GitHub's agree
    const sha256 = existsSync(path)
      ? createHash("sha256").update(readFileSync(path, "utf8").replace(/\r\n/gu, "\n")).digest("hex")
      : null;
    return [key, { tags: [...asset.tags].sort(), pages: [...asset.pages].sort(), sha256 }];
  }));
}

export function recordedAssets() {
  return existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, "utf8")) : {};
}

// what's wrong, in words: a missing file, two tags for one file, a change without a new tag, or a stale record
export function problems(current = currentAssets(), recorded = recordedAssets()) {
  const found = [];
  for (const [key, asset] of current) {
    if (!asset.sha256) found.push(`${key}: the pages load a file that isn't there`);
    if (asset.tags.length > 1) found.push(`${key}: loaded with different tags (${asset.tags.join(", ")}) by ${asset.pages.join(", ")}; use one`);
    const before = recorded[key];
    if (!before) found.push(`${key}: new; run node scripts/asset-versions.mjs --write`);
    else if (before.sha256 !== asset.sha256 && before.tag === asset.tags[0]) {
      found.push(`${key}: changed but still tagged ?v=${before.tag}; give it a new tag on ${asset.pages.join(", ")}`);
    } else if (before.sha256 !== asset.sha256 || before.tag !== asset.tags[0]) {
      found.push(`${key}: new tag ?v=${asset.tags[0]}; run node scripts/asset-versions.mjs --write`);
    }
  }
  for (const key of Object.keys(recorded)) if (!current.has(key)) found.push(`${key}: no page loads it any more; run node scripts/asset-versions.mjs --write`);
  return found;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const current = currentAssets();
  const found = problems(current);
  if (process.argv.includes("--write")) {
    const blocking = found.filter((line) => !/run node scripts\/asset-versions\.mjs --write$/u.test(line));
    if (blocking.length) {
      console.error(blocking.join("\n"));
      process.exit(1);
    }
    const record = Object.fromEntries([...current].map(([key, asset]) => [key, { tag: asset.tags[0], sha256: asset.sha256 }]));
    writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`recorded ${current.size} files`);
  } else if (found.length) {
    console.error(found.join("\n"));
    process.exit(1);
  } else console.log(`${current.size} files, tags in order`);
}
