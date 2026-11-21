// game-audit: n/a build script; only blocks private game data from the bundle
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sourceRoot = resolve(root, "src");
const outputRoot = resolve(root, ".pages-api-dist");
// The worker is src/index.js plus the modules it imports from src/ (comments.js): Pages runs a `_worker.js` folder
// with index.js as its entry and bundles its imports, and never serves that folder's files as static assets.
const modules = (await readdir(sourceRoot)).filter((name) => name.endsWith(".js")).sort();
const sources = new Map();
for (const name of modules) sources.set(name, await readFile(resolve(sourceRoot, name), "utf8"));
const source = sources.get("index.js");

for (const [name, text] of sources) {
  if (/\b_private\b|\b[A-Z]:\\|PMDATA|bundle[-_ ]index/iu.test(text)) {
    throw new Error(`API source ${name} contains a private extraction reference.`);
  }
}
if (!source.includes('url.pathname.startsWith("/api/")')) {
  throw new Error("API source no longer contains the expected request boundary.");
}
for (const [, imported] of source.matchAll(/^import [^;]+ from "\.\/([a-z0-9-]+\.js)";$/gmu)) {
  if (!sources.has(imported)) throw new Error(`API source imports ./${imported}, which is not in src/.`);
}

await rm(resolve(outputRoot, "_worker.js"), { recursive: true, force: true });
await mkdir(resolve(outputRoot, "_worker.js"), { recursive: true });
for (const [name, text] of sources) await writeFile(resolve(outputRoot, "_worker.js", name), text, "utf8");
await writeFile(
  resolve(outputRoot, "index.html"),
  "<!doctype html><meta charset=utf-8><meta name=robots content=noindex><title>AniiLogs API</title><p>AniiLogs account API</p>\n",
  "utf8",
);
const workerBytes = [...sources.values()].reduce((sum, text) => sum + Buffer.byteLength(text), 0);
console.log(JSON.stringify({ status: "built", output: outputRoot, modules, workerBytes }));
