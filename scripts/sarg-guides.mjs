// Finds guides sargeeva has added to https://github.com/sargeeva/aniimo-guides that the Guides page doesn't list yet,
// and drafts their cards in public/guides/linked-guides.js (.github/workflows/sarg-guides.yml runs it every day).
//   node scripts/sarg-guides.mjs          lists the new guides as JSON, changes nothing
//   node scripts/sarg-guides.mjs --write  also adds a card for each, gives linked-guides.js a new ?v= tag, and records
//                                         the new tag and the release pin, so the branch passes the site's checks
// The card's title and summary are drafts taken from the guide's own page: a person rewrites the summary in our words
// and, for a limited-time event, adds `ends` from the event's end in the game, before anyone is asked to publish it.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIST = join(ROOT, "public", "guides", "linked-guides.js");
const PAGE = join(ROOT, "public", "guides", "index.html");
const PIN = join(ROOT, "release-review.json");
const REPO = "sargeeva/aniimo-guides";
const BASE = "https://sargeeva.github.io/aniimo-guides/";
const NOT_GUIDES = new Set(["assets"]);

// the ids the Guides page lists already
export function listedIds(source) {
  return new Set(Array.from(source.matchAll(/^\s*id: "([^"]+)",$/gmu), (match) => match[1]));
}

// folders of the guides repository that are guides: not "assets", nothing hidden, a plain lower-case id
export function guideFolders(entries) {
  return entries
    .filter((entry) => entry.type === "dir" && !NOT_GUIDES.has(entry.name) && /^[a-z0-9][a-z0-9-]*$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", "#39": "'", nbsp: " " };
const decode = (text) => text.replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/gu, (_, name) => ENTITIES[name]).replace(/\s+/gu, " ").trim();

// the page's own title and description; a trailing " Guide" is dropped, as on the other cards
export function pageFacts(html) {
  const title = decode(html.match(/<title[^>]*>([^<]*)<\/title>/iu)?.[1] || "");
  const description = decode(
    html.match(/<meta\s+name="description"\s+content="([^"]*)"/iu)?.[1]
      || html.match(/<meta\s+content="([^"]*)"\s+name="description"/iu)?.[1]
      || "",
  );
  return { title: title.replace(/\s+Guide$/u, "") || title, description };
}

const quote = (text) => JSON.stringify(text);

// one more guide({...}) at the end of the list
export function addCard(source, { id, title, summary }) {
  const end = source.lastIndexOf("\n  ]);");
  if (end < 0) throw new Error("linked-guides.js: the end of the guide list wasn't found");
  const card = [
    "    guide({",
    `      id: ${quote(id)},`,
    `      title: ${quote(title)},`,
    `      url: ${quote(`${BASE}${id}/`)},`,
    `      summary: ${quote(summary)},`,
    "    }),",
  ].join("\n");
  return `${source.slice(0, end)}\n${card}${source.slice(end)}`;
}

// the page loads linked-guides.js with the next patch version, so browsers fetch the new list
export function bumpTag(html) {
  let found = false;
  const next = html.replace(/(\/guides\/linked-guides\.js\?v=)(\d+)\.(\d+)\.(\d+)/u, (_, head, major, minor, patch) => {
    found = true;
    return `${head}${major}.${minor}.${Number(patch) + 1}`;
  });
  if (!found) throw new Error("guides/index.html: the linked-guides.js tag wasn't found");
  return next;
}

// the same count, size and tree hash scripts/validate-reviewed-release.mjs checks public/ against
export function releasePin(publicRoot = join(ROOT, "public")) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) throw new Error(`public/ holds a symbolic link: ${path}`);
      if (metadata.isDirectory()) walk(path);
      else if (metadata.isFile()) files.push(path);
    }
  };
  walk(publicRoot);
  const name = (path) => relative(publicRoot, path).split(sep).join("/");
  files.sort((a, b) => (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0));
  const text = new Set([".css", ".html", ".js", ".json", ".md", ".svg", ".txt", ".webmanifest", ".xml"]);
  const tree = createHash("sha256");
  let total = 0;
  for (const path of files) {
    let bytes = readFileSync(path);
    if (text.has(extname(path).toLowerCase())) bytes = Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n"), "utf8");
    total += bytes.length;
    tree.update(`${name(path)}\0${bytes.length}\0${createHash("sha256").update(bytes).digest("hex")}\n`, "utf8");
  }
  return { publicFileCount: files.length, publicTotalBytes: total, publicTreeSha256: tree.digest("hex") };
}

async function fetchText(url, json = false) {
  const headers = { "user-agent": "aniilogs-guide-check" };
  if (json && process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return json ? response.json() : response.text();
}

async function main() {
  const write = process.argv.includes("--write");
  let source = readFileSync(LIST, "utf8");
  const listed = listedIds(source);
  const folders = guideFolders(await fetchText(`https://api.github.com/repos/${REPO}/contents/`, true));
  const found = [];
  for (const id of folders.filter((folder) => !listed.has(folder))) {
    const url = `${BASE}${id}/`;
    let facts;
    try {
      facts = pageFacts(await fetchText(url));
    } catch (error) {
      console.error(`${id}: skipped, its page didn't load (${error.message})`);
      continue;
    }
    if (!facts.title || !facts.description) {
      console.error(`${id}: skipped, its page has no title or description yet`);
      continue;
    }
    found.push({ id, title: facts.title, summary: facts.description, url });
  }
  if (write && found.length) {
    for (const guide of found) source = addCard(source, guide);
    writeFileSync(LIST, source);
    writeFileSync(PAGE, bumpTag(readFileSync(PAGE, "utf8")));
    execFileSync(process.execPath, [join(ROOT, "scripts", "asset-versions.mjs"), "--write"], { stdio: ["ignore", 2, 2] });
    const pin = JSON.parse(readFileSync(PIN, "utf8"));
    writeFileSync(PIN, `${JSON.stringify({ ...pin, ...releasePin() }, null, 2)}\n`);
  }
  console.log(JSON.stringify(found, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
