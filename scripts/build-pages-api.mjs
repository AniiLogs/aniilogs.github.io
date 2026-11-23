// game-audit: n/a build script; only blocks private game data from the bundle
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { siteRoutes } from "./site-routes.mjs";

const root = resolve(import.meta.dirname, "..");
const sourceRoot = resolve(root, "src");
const publicRoot = resolve(root, "public");
const outputRoot = resolve(root, ".pages-api-dist");
let source = await readFile(resolve(sourceRoot, "index.js"), "utf8");

if (!source.includes('url.pathname.startsWith("/api/")')) {
  throw new Error("API source no longer contains the expected request boundary.");
}
// The worker stays one _worker.js file: each `import { a, b } from "./module.js";` of src/index.js is replaced by that
// module's code in its own scope (its `export` keywords dropped, the imported names taken from it). A module may
// export only named functions, classes and constants, and import nothing itself.
const IMPORT = /^import \{([^}]+)\} from "\.\/([a-z0-9-]+\.js)";\r?$/gmu;
const modules = [];
for (const [line, names, file] of [...source.matchAll(IMPORT)]) {
  const text = await readFile(resolve(sourceRoot, file), "utf8");
  if (/^\s*(import|export \{|export \*|export default)/mu.test(text)) throw new Error(`src/${file}: only named exports, and no imports, can be inlined.`);
  const exported = [...text.matchAll(/^export (?:async )?(?:function\*? |class |const |let )([A-Za-z_$][\w$]*)/gmu)].map((match) => match[1]);
  const wanted = names.split(",").map((name) => name.trim()).filter(Boolean);
  for (const name of wanted) if (!exported.includes(name)) throw new Error(`src/${file} does not export ${name}.`);
  const body = text.replace(/^export (?=(?:async )?(?:function|class|const|let) )/gmu, "");
  // a function, so "$`" and "$'" in the module's code aren't read as replacement patterns
  source = source.replace(line, () => `// ---- src/${file} (inlined by scripts/build-pages-api.mjs)\nconst { ${wanted.join(", ")} } = (() => {\n${body}\nreturn { ${wanted.join(", ")} };\n})();\n// ---- end of src/${file}`);
  modules.push(file);
}
if (/^import /mu.test(source)) throw new Error("API source has an import the build can't inline.");
if (/\b_private\b|\b[A-Z]:\\|PMDATA|bundle[-_ ]index/iu.test(source)) {
  throw new Error("API source contains a private extraction reference.");
}

// The site's files (public/) are served by the same Pages project, next to the worker: https://aniilogs.app is the
// site, https://aniilogs-api.pages.dev the API (both hosts answer both). public/_headers gives the static files their
// security headers; _routes.json (scripts/site-routes.mjs) keeps them off the worker.
const routes = await siteRoutes(publicRoot);
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
await cp(publicRoot, outputRoot, { recursive: true });
await writeFile(resolve(outputRoot, "_worker.js"), source, "utf8");
await writeFile(resolve(outputRoot, "_routes.json"), `${JSON.stringify(routes, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  status: "built", output: outputRoot, inlined: modules, workerBytes: Buffer.byteLength(source),
  routes: { include: routes.include.length, exclude: routes.exclude.length },
}));
