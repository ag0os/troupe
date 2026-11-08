import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// B9 (C28): until the package leaves the repository, the root and the
// extracted package resolve each shared runtime dependency to one version,
// so the shipped binary and the package's candidate bundle the same zod,
// yaml and typescript. Every entry counts, nested ones (`troupe/zod`)
// included.

const repo = resolve(import.meta.dir, "..");
const LOCKS = ["bun.lock", "extractions/shepherd/bun.lock"];
const SHARED = ["typescript", "yaml", "zod"];

/** Every version `lock` resolves `name` to, by entry key. */
export function lockedVersions(lock: string, name: string): string[] {
	const entry = new RegExp(`"(?:[^"]+/)?${name}": \\["${name}@([^"]+)"`, "g");
	return [...lock.matchAll(entry)].map((match) => match[1] ?? "");
}

describe("root and package lockfiles agree (B9)", () => {
	test("each shared dependency resolves to one version in both lockfiles", () => {
		for (const name of SHARED) {
			const versions = LOCKS.map((path) =>
				lockedVersions(readFileSync(join(repo, path), "utf8"), name),
			);
			expect({ name, counts: versions.map((each) => each.length > 0) }).toEqual(
				{ name, counts: [true, true] },
			);
			const unique = [...new Set(versions.flat())];
			expect({ name, versions: unique }).toEqual({
				name,
				versions: unique.slice(0, 1),
			});
		}
	});

	test("a nested entry with another version is caught", () => {
		const lock =
			'"zod": ["zod@4.6.5", "", {}],\n"troupe/zod": ["zod@4.6.7", "", {}],\n';
		expect(lockedVersions(lock, "zod")).toEqual(["4.6.5", "4.6.7"]);
	});
});
