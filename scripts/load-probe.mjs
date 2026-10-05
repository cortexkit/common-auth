import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { performance } from "node:perf_hooks";

// Run on a dedicated test host: the workers deliberately saturate its CPUs.
const [file, name, runsArg = "20", workersArg = String(2 * availableParallelism())] = process.argv.slice(2);
if (!file || !name) throw new Error("usage: load-probe.mjs FILE TEST_NAME [RUNS] [WORKERS]");
const runs = Number(runsArg);
const count = Number(workersArg);
if (!Number.isInteger(runs) || runs < 1 || !Number.isInteger(count) || count < 0) {
	throw new Error("RUNS must be positive and WORKERS must be non-negative integers");
}
const workers = Array.from({ length: count }, () => spawn(process.execPath, ["-e", "for (;;) { Math.sqrt(Math.random()); }"], { stdio: "ignore" }));
const stop = () => { for (const worker of workers) worker.kill("SIGKILL"); };
process.on("SIGINT", () => { stop(); process.exit(130); });
process.on("SIGTERM", () => { stop(); process.exit(143); });
console.log(JSON.stringify({ runtime: process.version, executable: process.execPath, file, name, runs, workers: count }));
let failures = 0;
try {
	for (let run = 1; run <= runs; run++) {
		const start = performance.now();
		const child = spawn(process.env.TEST_BUN ?? process.execPath, ["test", file, "--test-name-pattern", name], { stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
		const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
		if (code !== 0) failures++;
		console.log(JSON.stringify({ run, code, durationMs: Math.round(performance.now() - start), output }));
	}
} finally { stop(); }
console.log(JSON.stringify({ passes: runs - failures, failures, runs, workers: count }));
process.exitCode = failures ? 1 : 0;
