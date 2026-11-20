import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const script = new URL("./preflight.mjs", import.meta.url);
const config = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");
const match = config.match(/^database_id\s*=\s*"([^"]+)"/m);
const databaseId = match?.[1];
const isRealId = Boolean(databaseId)
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(databaseId)
  && databaseId !== "00000000-0000-0000-0000-000000000000";

if (!isRealId) {
  console.error("A real, non-placeholder D1 database ID must be configured before this deployment-guard test.");
  process.exit(1);
}

const production = spawnSync(process.execPath, [script.pathname, "--production"], { encoding: "utf8" });
if (production.status !== 0 || !production.stdout.includes("Production preflight passed")) {
  console.error("Production preflight should pass with the configured real D1 database ID.");
  console.error(production.stdout, production.stderr);
  process.exit(1);
}

const ci = spawnSync(process.execPath, [script.pathname, "--ci"], { encoding: "utf8" });
if (ci.status !== 0) {
  console.error("CI preflight should pass with the configured D1 database ID.");
  console.error(ci.stdout, ci.stderr);
  process.exit(1);
}

console.log("Deployment guard test passed: production and CI preflight accept the configured real D1 ID.");
