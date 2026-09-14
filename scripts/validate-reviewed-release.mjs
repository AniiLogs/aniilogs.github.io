import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const publicRoot = resolve(root, "public");
const review = JSON.parse(await readFile(resolve(root, "release-review.json"), "utf8"));
const requireApproved = process.argv.includes("--require-approved");

async function collectFiles(directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Reviewed public payload contains a symbolic link: ${relative(publicRoot, path)}`);
    }
    if (metadata.isDirectory()) await collectFiles(path, files);
    else if (metadata.isFile()) files.push(path);
  }
  return files;
}

const canonicalTextExtensions = new Set([".css", ".html", ".js", ".json", ".txt"]);

async function canonicalBytes(path) {
  const bytes = await readFile(path);
  if (!canonicalTextExtensions.has(extname(path).toLowerCase())) return bytes;
  return Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n"), "utf8");
}

if (review.schemaVersion !== 1 || !Number.isInteger(review.packageVersion)) {
  throw new Error("release-review.json has an unsupported schema or package version.");
}
if (!/^[a-f0-9]{64}$/u.test(String(review.publicTreeSha256 || ""))) {
  throw new Error("release-review.json has an invalid public tree hash.");
}
if (requireApproved && review.deploymentApproved !== true) {
  throw new Error("Deployment is not approved in release-review.json.");
}

const paths = (await collectFiles(publicRoot)).sort((left, right) => {
  const a = relative(publicRoot, left).split(sep).join("/");
  const b = relative(publicRoot, right).split(sep).join("/");
  return a < b ? -1 : a > b ? 1 : 0;
});
const tree = createHash("sha256");
let totalBytes = 0;
for (const path of paths) {
  const name = relative(publicRoot, path).split(sep).join("/");
  const bytes = await canonicalBytes(path);
  const digest = createHash("sha256").update(bytes).digest("hex");
  totalBytes += bytes.length;
  tree.update(`${name}\0${bytes.length}\0${digest}\n`, "utf8");
}
const actual = {
  publicFileCount: paths.length,
  publicTotalBytes: totalBytes,
  publicTreeSha256: tree.digest("hex"),
};
const mismatches = Object.entries(actual)
  .filter(([key, value]) => review[key] !== value)
  .map(([key, value]) => `${key}=${value}, approved=${review[key]}`);
if (mismatches.length) throw new Error(`Reviewed public payload drifted: ${mismatches.join("; ")}.`);

console.log(JSON.stringify({
  status: "pass",
  packageVersion: review.packageVersion,
  deploymentApproved: review.deploymentApproved,
  ...actual,
}));
