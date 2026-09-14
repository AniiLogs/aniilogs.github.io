import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sourcePath = resolve(root, "src", "index.js");
const outputRoot = resolve(root, ".pages-api-dist");
const source = await readFile(sourcePath, "utf8");

if (/\b_private\b|\b[A-Z]:\\|PMDATA|bundle[-_ ]index/iu.test(source)) {
  throw new Error("API source contains a private extraction reference.");
}
if (!source.includes('url.pathname.startsWith("/api/")')) {
  throw new Error("API source no longer contains the expected request boundary.");
}

await mkdir(outputRoot, { recursive: true });
await writeFile(resolve(outputRoot, "_worker.js"), source, "utf8");
await writeFile(
  resolve(outputRoot, "index.html"),
  "<!doctype html><meta charset=utf-8><title>AniiLogs API</title><p>AniiLogs account API</p>\n",
  "utf8",
);
console.log(JSON.stringify({ status: "built", output: outputRoot, workerBytes: Buffer.byteLength(source) }));
