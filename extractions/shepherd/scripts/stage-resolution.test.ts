import { describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { PACKAGE_ROOT, troupeRoot } from "./shepherd-definition";

// C8 and C9 under the gates: the staged Troupe's runtime imports, resolved
// from the stage's real directory as a bundler or `bun test` resolves them,
// land in this package's own node_modules at the versions its bun.lock
// records. Resolution is asserted, not the link that provides it, so a
// missing stage-parent link (or any other route to another copy) fails
// `bun test`.

const RUNTIME = ["typescript", "yaml", "zod"];

/** The version the package's bun.lock records for `name`. */
function lockedVersion(name: string): string {
	const lock = readFileSync(join(PACKAGE_ROOT, "bun.lock"), "utf8");
	const match = lock.match(
		new RegExp(`\\n {4}"${name}": \\["${name}@([^"]+)"`),
	);
	if (!match?.[1]) throw new Error(`bun.lock records no ${name}`);
	return match[1];
}

/** The directory of the package that holds `entry`. */
function packageDir(entry: string, name: string): string {
	let dir = dirname(entry);
	while (dir !== dirname(dir)) {
		try {
			const manifest = JSON.parse(
				readFileSync(join(dir, "package.json"), "utf8"),
			);
			if (manifest.name === name) return dir;
		} catch {}
		dir = dirname(dir);
	}
	throw new Error(`no package.json named ${name} above ${entry}`);
}

describe("the stage's runtime imports resolve to the package's locked copies (C8, C9)", () => {
	const stage = realpathSync(troupeRoot(PACKAGE_ROOT));
	for (const name of RUNTIME) {
		test(name, () => {
			const entry = realpathSync(Bun.resolveSync(name, stage));
			const dir = packageDir(entry, name);
			const version = JSON.parse(
				readFileSync(join(dir, "package.json"), "utf8"),
			).version;
			expect({ name, dir, version }).toEqual({
				name,
				dir: realpathSync(join(PACKAGE_ROOT, "node_modules", name)),
				version: lockedVersion(name),
			});
		});
	}
});
