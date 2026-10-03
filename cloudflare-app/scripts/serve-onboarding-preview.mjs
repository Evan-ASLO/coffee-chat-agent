import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const preview = join(root, ".tutorial-preview");
const receipt = JSON.parse(await readFile(join(preview, "receipt.json"), "utf8"));
const child = spawn(process.execPath, [
	join(root, "node_modules", "wrangler", "bin", "wrangler.js"), "dev",
	"--config", join(preview, "wrangler.jsonc"), "--local", "--ip", "127.0.0.1",
	"--port", String(receipt.port), "--persist-to", receipt.state,
], { cwd: root, stdio: "inherit", env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(preview, "server.log") } });
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
