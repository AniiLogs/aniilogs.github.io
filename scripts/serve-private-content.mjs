import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback = "") => {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || fallback) : fallback;
};
const root = resolve(option("--root"));
const port = Number.parseInt(option("--port", "8788"), 10);
if (!option("--root") || !Number.isInteger(port)) {
  throw new Error("Usage: node serve-private-content.mjs --root <private explorer directory> [--port 8788]");
}

const contentTypes = new Map([
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".mp4", "video/mp4"],
]);

createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  const prefix = "/releases/3509129/";
  if (!url.pathname.startsWith(prefix) || !["GET", "HEAD"].includes(request.method || "")) {
    response.writeHead(404).end();
    return;
  }
  let relative;
  try {
    relative = decodeURIComponent(url.pathname.slice(prefix.length)).replaceAll("/", sep);
  } catch {
    response.writeHead(400).end();
    return;
  }
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "access-control-allow-origin": "http://127.0.0.1:8787",
      "cache-control": "no-store",
      "content-length": String(info.size),
      "content-type": contentTypes.get(extname(target).toLowerCase()) || "application/octet-stream",
      "x-content-type-options": "nosniff",
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(target).pipe(response);
  } catch {
    response.writeHead(404).end();
  }
}).listen(port, "127.0.0.1", () => {
  process.stdout.write(`AniiLogs private content preview: http://127.0.0.1:${port}\n`);
});
