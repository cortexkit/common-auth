import { afterEach, beforeEach, expect, test, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "../fixtures/scratch.js";
import { writeJsonAtomic } from "../../src/fs/index.js";
import { acquireRefreshFileLock } from "../../src/fs/refresh-file-lock.js";

let dir: string;
let target: string;
beforeEach(async () => {
	dir = await makeTempDir();
	target = join(dir, "state.json");
});
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

test("atomic writer defaults to pretty JSON with newline and private mode", async () => {
	const value = { nested: { answer: 42 } };
	await writeJsonAtomic(target, value);
	const bytes = await fs.readFile(target, "utf8");
	expect(bytes).toBe(`${JSON.stringify(value, null, 2)}\n`);
	expect(JSON.parse(bytes)).toEqual(value);
	expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
});

test("atomic writer supports compact serialization", async () => {
	await writeJsonAtomic(target, { answer: 42 }, { serialize: JSON.stringify });
	expect(await fs.readFile(target, "utf8")).toBe('{"answer":42}');
});

test("beforeRename runs after staging and before commit", async () => {
	await fs.writeFile(target, "old");
	let called = false;
	await writeJsonAtomic(
		target,
		{ answer: 42 },
		{
			beforeRename: async () => {
				called = true;
				expect(await fs.readFile(target, "utf8")).toBe("old");
				const staging = (await fs.readdir(dir)).filter((name) =>
					name.endsWith(".tmp"),
				);
				expect(staging).toHaveLength(1);
				expect(await fs.readFile(join(dir, staging[0]!), "utf8")).toBe(
					'{\n  "answer": 42\n}\n',
				);
			},
		},
	);
	expect(called).toBe(true);
	expect(await fs.readdir(dir)).toEqual(["state.json"]);
});

for (const phase of ["write", "rename"] as const) {
	test(`atomic writer cleans staging after ${phase} failure`, async () => {
		await fs.writeFile(target, "old");
		const failure = new Error("injected failure");
		const originalWrite = fs.writeFile;
		const spy =
			phase === "write"
				? spyOn(fs, "writeFile").mockImplementation(
						async (...args: Parameters<typeof fs.writeFile>) => {
							await originalWrite(args[0], "partial");
							throw failure;
						},
					)
				: spyOn(fs, "rename").mockRejectedValue(failure);
		try {
			await expect(writeJsonAtomic(target, { answer: 42 })).rejects.toBe(
				failure,
			);
		} finally {
			spy.mockRestore();
		}
		expect(await fs.readFile(target, "utf8")).toBe("old");
		expect(await fs.readdir(dir)).toEqual(["state.json"]);
	});
}

test("a lease expiring after the pre-rename fence can overwrite a successor", async () => {
	let clock = 100;
	const options = {
		path: target,
		name: "demo",
		ttlMs: 1000,
		now: () => clock,
		renew: false,
	};
	const first = await acquireRefreshFileLock(options);
	let afterSuccessor = "";
	try {
		await writeJsonAtomic(
			target,
			{ writer: "A" },
			{
				beforeRename: async () => {
					await first!.assertOwned();
					clock = 1101;
					const second = await acquireRefreshFileLock(options);
					expect(second).not.toBeNull();
					try {
						await writeJsonAtomic(target, { writer: "B" });
					} finally {
						await second?.release();
					}
					afterSuccessor = await fs.readFile(target, "utf8");
				},
			},
		);
		expect(afterSuccessor).toBe('{\n  "writer": "B"\n}\n');
		expect(await fs.readFile(target, "utf8")).toBe('{\n  "writer": "A"\n}\n');
	} finally {
		await first?.release();
	}
});
