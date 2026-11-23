// game-audit: n/a build script; the old GitHub Pages address forwards to the site's own domain
// The site lives on https://aniilogs.app (served with the API by the Cloudflare Pages project). GitHub Pages keeps the
// old address, https://aniilogs.github.io, as a forwarder: this writes .github-forwarder/, which pages.yml publishes
// instead of public/. Every page public/ has gets a page at the same address (so GitHub answers 200 for it), and
// 404.html answers every other address (/lb/<code> included); each one sends the visitor to the same path, query and
// #fragment on the new domain (the #fragment carries aLogs' one-time sign-in hand-off). Without JavaScript a meta
// refresh goes to the page itself. Each keeps its page's title, description and og/twitter tags, so a github.io link
// pasted in Discord still gets the site's card, and names the new address as canonical.
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

export const NEW_ORIGIN = "https://aniilogs.app";
const root = resolve(import.meta.dirname, "..");
const publicRoot = resolve(root, "public");
const outputRoot = resolve(root, ".github-forwarder");
// Search Console's ownership file for aniilogs.github.io: copied as it is (it must stay readable there).
const VERIFICATION = /^google[0-9a-f]+\.html$/u;

const escapeHtml = (value) => String(value).replace(/[&<>"]/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// the address a public/ file is served at: "index.html" files at their folder, "/privacy.html" as it is
export function publicPath(file) {
  const path = `/${file.split(sep).join("/")}`;
  return path.endsWith("/index.html") ? path.slice(0, -"index.html".length) : path;
}

// the page's own title and social tags (one line each), with og:url on the new domain
export function socialTags(html, target) {
  const head = html.slice(0, Math.max(0, html.indexOf("</head>")));
  const lines = [];
  const title = /<title>([^<]*)<\/title>/u.exec(head);
  if (title) lines.push(`<title>${title[1]}</title>`);
  for (const match of head.matchAll(/<meta\s+(?:name|property)="(description|og:[a-z:_]+|twitter:[a-z:_]+)"\s+content="([^"]*)">/gu)) {
    if (match[1] === "og:url") continue;
    const attribute = match[1].startsWith("og:") ? "property" : "name";
    lines.push(`<meta ${attribute}="${match[1]}" content="${match[2]}">`);
  }
  lines.push(`<meta property="og:url" content="${escapeHtml(target)}">`);
  return lines;
}

export function forwardingPage({ tags = [], target = `${NEW_ORIGIN}/`, notFound = false } = {}) {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // first, before anything else: the same path, query and #fragment on the new domain
    `<script>location.replace(${JSON.stringify(NEW_ORIGIN)} + location.pathname + location.search + location.hash);</script>`,
    ...(notFound ? ['<meta name="robots" content="noindex">', "<title>AniiLogs has moved to aniilogs.app</title>"]
      : [`<link rel="canonical" href="${escapeHtml(target)}">`, `<meta http-equiv="refresh" content="0; url=${escapeHtml(target)}">`, ...tags]),
    "</head>",
    "<body>",
    `<p>AniiLogs has moved to <a href="${escapeHtml(target)}">${escapeHtml(target)}</a>.</p>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

async function files(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) out.push(...await files(path));
    else out.push(relative(publicRoot, path));
  }
  return out.sort();
}

export async function buildForwarder({ output = outputRoot } = {}) {
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const written = [];
  for (const file of await files(publicRoot)) {
    if (!file.endsWith(".html")) continue;
    const destination = resolve(output, file);
    await mkdir(dirname(destination), { recursive: true });
    if (VERIFICATION.test(file)) {
      await cp(resolve(publicRoot, file), destination);
    } else if (file === "404.html") {
      await writeFile(destination, forwardingPage({ notFound: true }), "utf8");
    } else {
      const html = await readFile(resolve(publicRoot, file), "utf8");
      // the page's own canonical address when it names one on the new domain (privacy.html: /privacy)
      const canonical = /<link rel="canonical" href="([^"]+)">/u.exec(html)?.[1] || "";
      const target = canonical.startsWith(`${NEW_ORIGIN}/`) ? canonical : `${NEW_ORIGIN}${publicPath(file)}`;
      await writeFile(destination, forwardingPage({ tags: socialTags(html, target), target }), "utf8");
    }
    written.push(publicPath(file));
  }
  await writeFile(resolve(output, "robots.txt"), "User-agent: *\nAllow: /\n", "utf8");
  return written;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const written = await buildForwarder();
  console.log(JSON.stringify({ status: "built", output: outputRoot, forwardTo: NEW_ORIGIN, pages: written }));
}
