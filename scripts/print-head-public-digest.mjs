import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { extname, resolve } from "node:path";

// Compute the deployment payload from committed files only. The working tree
// may contain unrelated edits that must not enter a reviewed-release hash.
const root = resolve(import.meta.dirname, "..");
const git = (...args) => execFileSync("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
const names = git("ls-tree", "-r", "--name-only", "-z", "HEAD", "public")
  .toString("utf8").split("\0").filter(Boolean).sort();
const canonicalTextExtensions = new Set([".css", ".html", ".js", ".json", ".txt"]);
const tree = createHash("sha256");
let totalBytes = 0;
for (const path of names) {
  const name = path.slice("public/".length);
  let bytes = git("show", `HEAD:${path}`);
  if (canonicalTextExtensions.has(extname(name).toLowerCase())) {
    bytes = Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n"), "utf8");
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  totalBytes += bytes.length;
  tree.update(`${name}\0${bytes.length}\0${digest}\n`, "utf8");
}
console.log(JSON.stringify({
  publicFileCount: names.length,
  publicTotalBytes: totalBytes,
  publicTreeSha256: tree.digest("hex"),
}, null, 2));
