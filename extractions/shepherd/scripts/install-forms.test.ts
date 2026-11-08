import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readSourceInputs } from "troupe/provenance";
import { PACKAGE_ROOT, troupeRoot } from "./shepherd-definition";
import { FRAMEWORK_ORIGIN, v2Inputs } from "./shepherd-source-v2";

// C16: the v2 identity built from an installed consumer of one scratch
// stage names the same framework bytes under both Bun install forms (1.2.22
// per-file symlinks, 1.4.4 hardlinks), because the framework root is taken
// by realpath. The default Bun always runs; a Bun 1.4.4 executable runs as
// a child only when TROUPE_BUN_144 names it.

setDefaultTimeout(180_000);

const BUN_144 = process.env.TROUPE_BUN_144;
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "install-forms-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// The scratch stage: the bytes this package's own install resolves.
const stage = join(scratch, ".troupe-dist/troupe");
cpSync(troupeRoot(PACKAGE_ROOT), stage, { recursive: true, dereference: true });

const IDENTITY = `
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { troupeRoot } from ${JSON.stringify(join(PACKAGE_ROOT, "scripts/shepherd-definition.ts"))};
import { shepherdStampV2, v2VersionLine } from ${JSON.stringify(join(PACKAGE_ROOT, "scripts/shepherd-source-v2.ts"))};
const consumer = process.cwd();
const root = troupeRoot(consumer);
const installed = join(consumer, "node_modules/troupe/lib/agent-format/compiler.ts");
const stat = lstatSync(installed);
const captured = await shepherdStampV2({ packageRoot: ${JSON.stringify(PACKAGE_ROOT)}, troupeRoot: root }).capture({});
console.log(JSON.stringify({
	bun: Bun.version,
	troupeRoot: root,
	form: stat.isSymbolicLink() ? "symlink" : stat.nlink > 1 ? "hardlink" : "copy",
	installedRealpath: realpathSync(installed),
	framework: captured.provenance.origins.find((o) => o.origin === "framework/troupe"),
	source: captured.manifest.source,
	line: v2VersionLine("shepherd", captured),
}));
`;

interface Identity {
	bun: string;
	troupeRoot: string;
	form: string;
	installedRealpath: string;
	framework: { digest: string; revision: string };
	source: string;
	line: string;
}

/** Install a consumer of the scratch stage with `bun` and build its v2 identity with the same Bun. */
function identityUnder(bun: string, name: string): Identity {
	const consumer = join(scratch, name);
	mkdirSync(consumer, { recursive: true });
	writeFileSync(
		join(consumer, "package.json"),
		JSON.stringify({
			name: "consumer",
			private: true,
			dependencies: { troupe: "file:../.troupe-dist/troupe" },
		}),
	);
	const install = Bun.spawnSync([bun, "install", "--ignore-scripts"], {
		cwd: consumer,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (install.exitCode !== 0) {
		throw new Error(`${bun} install failed:\n${install.stderr.toString()}`);
	}
	writeFileSync(join(consumer, "identity.ts"), IDENTITY);
	const child = Bun.spawnSync([bun, "--no-install", "identity.ts"], {
		cwd: consumer,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, NODE_PATH: join(consumer, "node_modules") },
	});
	if (child.exitCode !== 0) {
		throw new Error(`${bun} identity failed:\n${child.stderr.toString()}`);
	}
	const identity = JSON.parse(child.stdout.toString()) as Identity;
	console.log(
		`${name}: bun ${identity.bun}, ${identity.form} install, framework root ${identity.troupeRoot}, framework ${identity.framework.digest}, source ${identity.source}`,
	);
	return identity;
}

/** The framework origin's digest read straight from the stage. */
const stageDigest = readSourceInputs(
	v2Inputs({ packageRoot: PACKAGE_ROOT, troupeRoot: stage }).find(
		(input) => input.origin === FRAMEWORK_ORIGIN,
	) ??
		(() => {
			throw new Error("no framework origin");
		})(),
).provenance.digest;

if (BUN_144 === undefined) {
	console.log(
		"skip: the Bun 1.4.4 hardlink form needs TROUPE_BUN_144=<path to a Bun 1.4.4 executable>",
	);
}

describe("v2 identity from an installed consumer (C16)", () => {
	let memo: Identity | undefined;
	const underDefault = () => {
		memo ??= identityUnder(process.execPath, "consumer-default");
		return memo;
	};

	test("the default Bun's install names the stage's framework bytes", () => {
		const defaultIdentity = underDefault();
		expect(defaultIdentity.bun).toBe(Bun.version);
		expect(defaultIdentity.framework.digest).toBe(stageDigest);
		if (defaultIdentity.form === "symlink") {
			// Bun 1.2.22: the realpath walks back to the stage itself.
			expect(defaultIdentity.troupeRoot).toBe(stage);
		}
	});

	test.skipIf(BUN_144 === undefined)(
		"Bun 1.4.4's hardlink install gives the same framework digest and source identity",
		() => {
			const hardlinked = identityUnder(resolve(BUN_144 ?? ""), "consumer-144");
			expect(hardlinked.bun).toBe("1.4.4");
			expect(hardlinked.form).toBe("hardlink");
			expect(hardlinked.troupeRoot).toBe(
				join(scratch, "consumer-144/node_modules/troupe"),
			);
			expect(hardlinked.framework.digest).toBe(stageDigest);
			const symlinked = underDefault();
			expect(hardlinked.framework).toEqual(symlinked.framework);
			expect(hardlinked.source).toBe(symlinked.source);
			expect(hardlinked.line).toBe(symlinked.line);
		},
	);
});
