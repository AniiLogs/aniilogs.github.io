// game-audit: n/a build script; only blocks private game data from the bundle
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sourceRoot = resolve(root, "src");
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

await mkdir(outputRoot, { recursive: true });
await rm(resolve(outputRoot, "_worker.js"), { recursive: true, force: true });
await writeFile(resolve(outputRoot, "_worker.js"), source, "utf8");
await writeFile(
  resolve(outputRoot, "index.html"),
  "<!doctype html><meta charset=utf-8><meta name=robots content=noindex><title>AniiLogs API</title><p>AniiLogs account API</p>\n",
  "utf8",
);
console.log(JSON.stringify({ status: "built", output: outputRoot, inlined: modules, workerBytes: Buffer.byteLength(source) }));
