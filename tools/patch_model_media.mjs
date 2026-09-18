import fs from "node:fs";

const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error("Usage: node patch_model_media.mjs input.json output.json");
const payload = JSON.parse(fs.readFileSync(source, "utf8"));
const target = payload.entries.find((entry) => String(entry.form_id) === "1014302");
if (!target) throw new Error("Form 1014302 is missing from aniilog media data");
target.model = "assets/models/1014302/parmon-body-default-rigged-full.glb";
target.model_label = "Parmon animated model";
fs.writeFileSync(destination, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ package_version: payload.package_version, form_id: target.form_id, model: target.model }));
