import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderAmpViewer } from "./measure/amp-viewer.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dir = arg("--dir");
if (!dir) {
  console.error("usage: node src/amp-viewer.ts --dir <run-dir>");
  process.exit(1);
}
const data = JSON.parse(readFileSync(join(dir, "candidates.json"), "utf8"));
writeFileSync(join(dir, "report.html"), renderAmpViewer(data));
console.log(`wrote ${join(dir, "report.html")}`);
