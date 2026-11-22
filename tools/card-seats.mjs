// game-audit: n/a prints the boards' seat rule (src/bots.js cardSeats) for runs given on stdin; no game data
// Each card's seat (1P-4P) as the boards work it out, to check the rule against stored runs. Not part of the worker;
// reads stdin only. One JSON line in per run, {"players": [...], "lineup": [...]}, one line out: {"seats": [...]}
// (a seat or null per card, in the cards' order), or {"error": "..."} for a line that isn't JSON.
//   node tools/card-seats.mjs < runs.jsonl
import { createInterface } from "node:readline";
import { cardSeats } from "../src/bots.js";

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  let run;
  try { run = JSON.parse(line); } catch { console.log(JSON.stringify({ error: "not JSON" })); continue; }
  console.log(JSON.stringify({ seats: cardSeats(run?.players ?? null, run?.lineup ?? null) }));
}
