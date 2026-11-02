import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderYamahaViewer } from "./measure/yamaha-viewer.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dir = arg("--dir");
if (!dir) {
  console.error("usage: node src/yamaha-viewer.ts --dir <run-dir>");
  process.exit(1);
}
const raw = readFileSync(join(dir, "candidates.json"), "utf8");
const data = JSON.parse(raw);
writeFileSync(join(dir, "viewer.html"), renderYamahaViewer(data));
console.log(`wrote ${join(dir, "viewer.html")}`);
