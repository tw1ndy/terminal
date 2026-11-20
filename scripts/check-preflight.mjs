import { spawnSync } from "node:child_process";

const script = new URL("./preflight.mjs", import.meta.url);
const production = spawnSync(process.execPath, [script.pathname, "--production"], { encoding: "utf8" });
const output = `${production.stdout ?? ""}${production.stderr ?? ""}`;
if (production.status === 0 || !output.includes("Replace the placeholder D1 database_id")) {
  console.error("Production preflight did not block deployment with the placeholder database ID.");
  console.error(output);
  process.exit(1);
}
const ci = spawnSync(process.execPath, [script.pathname, "--ci"], { encoding: "utf8" });
if (ci.status !== 0) {
  console.error("CI preflight should pass with the explicit placeholder UUID.");
  console.error(ci.stdout, ci.stderr);
  process.exit(1);
}
console.log("Deployment guard test passed: production blocked, CI build allowed.");
