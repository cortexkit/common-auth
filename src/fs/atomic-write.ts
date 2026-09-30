import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface AtomicWriteOptions {
	serialize?: (value: unknown) => string;
	beforeRename?: () => Promise<void>;
}

export async function writeJsonAtomic(
	path: string,
	value: unknown,
	options: AtomicWriteOptions = {},
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tempPath = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(
			tempPath,
			options.serialize
				? options.serialize(value)
				: `${JSON.stringify(value, null, 2)}\n`,
			{
				encoding: "utf8",
				mode: 0o600,
			},
		);
		await options.beforeRename?.();
		await rename(tempPath, path);
	} catch (error) {
		// A failed write can leave partial staging bytes just like a failed rename.
		await rm(tempPath, { force: true }).catch(() => {});
		throw error;
	}
}
