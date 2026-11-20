// Runs inside the selected terminal's working directory. The message is an argv value, never shell code.
const { spawnSync } = require("node:child_process");
const message = Buffer.from(process.argv[2] || "", "base64").toString("utf8").trim() || "new";
const result = spawnSync("git", ["commit", "-m", message], { stdio: "inherit" });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
