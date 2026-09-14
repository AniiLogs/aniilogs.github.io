import { createReadStream } from "node:fs";
import { lstat, opendir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const excludedDirectories = new Set([".git", ".pages-api-dist", ".wrangler", "node_modules"]);
const forbiddenSegments = new Set(["_private", "captures", "game-files", "raw-captures"]);
const forbiddenExtensions = new Set([".pcap", ".pcapng", ".proto"]);
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_REPOSITORY_BYTES = 1024 * 1024 * 1024;
const MAX_PUBLISHED_SITE_BYTES = 1024 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 3000;
const textExtensions = new Set([
  "", ".css", ".env", ".example", ".html", ".js", ".json", ".jsonc", ".md", ".mjs", ".sql", ".txt", ".yaml", ".yml",
]);
const forbiddenContent = [
  { label: "absolute private Windows path", pattern: /\b[A-Z]:\\(?:Users|PawPrint|ProgramData)\\/iu },
  { label: "private release directory", pattern: /release_[0-9]{8}_[0-9]+/iu },
  { label: "private workspace path", pattern: /(?:^|[\\/])_private(?:[\\/]|$)/iu },
  { label: "populated secret assignment", pattern: /(?:DISCORD_CLIENT_SECRET|SESSION_SECRET|CLOUDFLARE_API_TOKEN)[ \t]*=[ \t]*[^ \t\r\n#][^\r\n]*/iu },
];

async function* files(directory) {
  let entryCount = 0;
  for await (const entry of await opendir(directory)) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    entryCount += 1;
    const path = resolve(directory, entry.name);
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) throw new Error(`Repository boundary contains a symbolic link: ${relative(root, path)}`);
    if (stats.isDirectory()) yield* files(path);
    else if (stats.isFile()) yield { path, stats };
  }
  directoryEntryCounts.set(relative(root, directory).replaceAll("\\", "/") || ".", entryCount);
}

async function scanText(path) {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let carry = "";
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    const text = carry + decoder.decode(chunk, { stream: true });
    for (const check of forbiddenContent) {
      if (check.pattern.test(text)) throw new Error(`${check.label} found in ${relative(root, path)}`);
    }
    carry = text.slice(-512);
  }
  const finalText = carry + decoder.decode();
  for (const check of forbiddenContent) {
    if (check.pattern.test(finalText)) throw new Error(`${check.label} found in ${relative(root, path)}`);
  }
}

let fileCount = 0;
let byteCount = 0;
let textFileCount = 0;
let publicByteCount = 0;
let largestFileBytes = 0;
let largestFilePath = "";
const directoryEntryCounts = new Map();
for await (const file of files(root)) {
  const repoPath = relative(root, file.path).replaceAll("\\", "/");
  if (repoPath.startsWith("public/explorer/data/") || repoPath.startsWith("public/explorer/assets/")) {
    throw new Error(`Game-derived content must be stored in private R2, not GitHub: ${repoPath}`);
  }
  const segments = repoPath.split("/").map((part) => part.toLowerCase());
  if (segments.some((part) => forbiddenSegments.has(part))) {
    throw new Error(`Private directory segment is present in the repository: ${repoPath}`);
  }
  const extension = extname(repoPath).toLowerCase();
  if (forbiddenExtensions.has(extension)) throw new Error(`Private capture/schema file is present: ${repoPath}`);
  if (/^(?:\.dev\.vars|\.env(?:\..+)?)$/iu.test(repoPath) && repoPath !== ".env.example") {
    throw new Error(`Local credential file is present in the repository tree: ${repoPath}`);
  }
  fileCount += 1;
  byteCount += file.stats.size;
  if (repoPath.startsWith("public/")) publicByteCount += file.stats.size;
  if (file.stats.size > largestFileBytes) {
    largestFileBytes = file.stats.size;
    largestFilePath = repoPath;
  }
  if (textExtensions.has(extension)) {
    textFileCount += 1;
    await scanText(file.path);
  }
}

if (largestFileBytes >= MAX_FILE_BYTES) {
  throw new Error(`Repository file reaches the project's 50 MiB warning gate: ${largestFilePath}`);
}
if (byteCount >= MAX_REPOSITORY_BYTES) throw new Error("Repository working tree reaches the 1 GiB project gate.");
if (publicByteCount >= MAX_PUBLISHED_SITE_BYTES) throw new Error("Published site reaches the 1 GiB GitHub Pages gate.");
const widestDirectory = [...directoryEntryCounts].sort((left, right) => right[1] - left[1])[0] || [".", 0];
if (widestDirectory[1] > MAX_DIRECTORY_ENTRIES) {
  throw new Error(`Repository directory exceeds 3,000 entries: ${widestDirectory[0]}`);
}

const workflow = await readFile(resolve(root, ".github", "workflows", "pages.yml"), "utf8");
if (!/uses:\s*actions\/upload-pages-artifact@v5[\s\S]*?with:\s*[\s\S]*?path:\s*public/iu.test(workflow)) {
  throw new Error("GitHub Pages workflow is not pinned to the public directory.");
}
if (/path:\s*(?:\.|\.\/|\$\{\{)/iu.test(workflow)) {
  throw new Error("GitHub Pages workflow may upload a broader path than public.");
}
const approvalGateIndex = workflow.indexOf("npm run release:deploy-check");
const uploadIndex = workflow.indexOf("actions/upload-pages-artifact@v5");
if (approvalGateIndex < 0 || uploadIndex < 0 || approvalGateIndex > uploadIndex) {
  throw new Error("GitHub Pages workflow does not fail closed on reviewed release approval before upload.");
}

console.log(JSON.stringify({
  status: "pass",
  scannedFiles: fileCount,
  scannedTextFiles: textFileCount,
  scannedBytes: byteCount,
  publishedSiteBytes: publicByteCount,
  largestFileBytes,
  largestFilePath,
  widestDirectory: widestDirectory[0],
  widestDirectoryEntries: widestDirectory[1],
  projectFileLimitBytes: MAX_FILE_BYTES,
  projectRepositoryLimitBytes: MAX_REPOSITORY_BYTES,
  projectPublishedSiteLimitBytes: MAX_PUBLISHED_SITE_BYTES,
  githubPagesUploadRoot: "public",
  privatePathsFound: 0,
  credentialFilesFound: 0,
  packetOrProtoFilesFound: 0,
}, null, 2));
