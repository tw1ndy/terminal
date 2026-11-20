import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";

const production = process.argv.includes("--production");
const config = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const fail = message => { console.error("Preflight failed:", message); process.exitCode = 1; };
const capture = (pattern, label) => {
  const match = config.match(pattern);
  if (!match) { fail(`Missing ${label} in wrangler.toml`); return null; }
  return match[1];
};

const workerName = capture(/^name\\s*=\\s*"([^"]+)"/m, "Worker name");
const main = capture(/^main\\s*=\\s*"([^"]+)"/m, "Worker entrypoint");
const compatibilityDate = capture(/^compatibility_date\\s*=\\s*"([^"]+)"/m, "compatibility_date");
const databaseName = capture(/^database_name\\s*=\\s*"([^"]+)"/m, "D1 database name");
const databaseId = capture(/^database_id\\s*=\\s*"([^"]+)"/m, "D1 database ID");
const migrationsDir = capture(/^migrations_dir\\s*=\\s*"([^"]+)"/m, "D1 migrations directory");
const assetsDir = capture(/^directory\\s*=\\s*"([^"]+)"/m, "Static assets directory");

if (workerName !== "nk-activity") fail("Worker name must remain nk-activity.");
if (databaseName !== "nk-activity-db") fail("D1 must use the dedicated nk-activity-db database.");
if (main !== "src/index.ts") fail("Unexpected Worker entrypoint.");
if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(compatibilityDate ?? "")) fail("Invalid compatibility_date.");
if (migrationsDir !== "migrations") fail("Migrations directory must be migrations.");
if (assetsDir !== "./web") fail("Static assets must be served from ./web.");
if (databaseId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(databaseId)) {
  fail("D1 database_id must be a UUID.");
}
if (production && (!databaseId || databaseId === "00000000-0000-0000-0000-000000000000")) {
  fail("Replace the placeholder D1 database_id with the real ID from the dedicated Cloudflare database before deploying or applying remote migrations.");
}
if (/TELEGRAM_BOT_TOKEN|TELEGRAM_WEBHOOK_SECRET|OWNER_TELEGRAM_ID/.test(config)) {
  fail("Secrets must not be placed in wrangler.toml vars; use Cloudflare Worker Secrets.");
}
if (!pkg.scripts?.deploy?.includes("--production") || !pkg.scripts?.["db:remote"]?.includes("--production")) {
  fail("Production deploy and remote migration scripts must run the production preflight.");
}
for (const path of [main, migrationsDir, assetsDir]) {
  try { await access(new URL(`../${path}`, import.meta.url), constants.R_OK); }
  catch { fail(`Required path is missing: ${path}`); }
}
try {
  const ignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
  if (!ignore.split(/\\r?\\n/).includes(".dev.vars")) fail(".dev.vars must be ignored by Git.");
} catch { fail(".gitignore is missing."); }

if (process.exitCode) process.exit(process.exitCode);
console.log(production
  ? "Production preflight passed. D1 ID is configured; secrets still must be set in Cloudflare."
  : "Repository preflight passed. Production deploy remains blocked until the real D1 ID is configured.");
