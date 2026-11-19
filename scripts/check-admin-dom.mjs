import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
const js = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
const referencedIds = [...new Set([...js.matchAll(/\$\("([^"]+)"\)/g)].map(match => match[1]))];
const missing = referencedIds.filter(id => !htmlIds.has(id));
if (missing.length) {
  console.error("Admin app references missing HTML element IDs:", missing.join(", "));
  process.exit(1);
}
console.log(`Admin DOM check passed (${referencedIds.length} referenced IDs).`);
