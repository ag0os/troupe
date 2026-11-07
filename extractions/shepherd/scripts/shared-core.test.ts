import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { PACKAGE_ROOT, troupeRoot } from "./shepherd-definition";

// O20: composition (lib/shepherd/compose.ts) and charter checking
// (lib/shepherd/check-charter.ts) both text-import the package's own
// system-prompts/shepherd/core.md. A mutation of core.md in a scratch copy
// of the package changes both a composed prompt and a charter check, with
// no Troupe change, and the bundled binary carries the mutated core. Fake
// workspace, HOME and XDG_CONFIG_HOME only; fake backends first on PATH.

setDefaultTimeout(180_000);

const CORE = "system-prompts/shepherd/core.md";
const CONSUMERS = ["lib/shepherd/compose.ts", "lib/shepherd/check-charter.ts"];
const sha = (bytes: string | Buffer) =>
	createHash("sha256").update(bytes).digest("hex");

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "shared-core-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// The scratch copy: package sources without node_modules or bin, sharing
// the package's installed dependencies through a node_modules link.
const copy = join(scratch, "shepherd");
cpSync(PACKAGE_ROOT, copy, {
	recursive: true,
	filter: (source) => {
		const first = relative(PACKAGE_ROOT, source).split("/")[0];
		return first !== "node_modules" && first !== "bin";
	},
});
symlinkSync(join(PACKAGE_ROOT, "node_modules"), join(copy, "node_modules"));

const home = join(scratch, "home");
const xdg = join(scratch, "xdg");
const workspace = join(scratch, "workspace");
const fakes = join(scratch, "fakes");
for (const dir of [home, xdg, join(workspace, ".shepherd"), fakes]) {
	mkdirSync(dir, { recursive: true });
}
writeFileSync(
	join(workspace, ".shepherd/charter.md"),
	"# Charter\n\nShared core fixture.\n",
);
for (const name of ["claude", "codex"]) {
	writeFileSync(join(fakes, name), "#!/bin/sh\nexit 97\n");
	chmodSync(join(fakes, name), 0o755);
}
const env = {
	...process.env,
	HOME: home,
	XDG_CONFIG_HOME: xdg,
	SHEPHERD_WORKSPACE: workspace,
	PATH: `${fakes}:${process.env.PATH}`,
	NODE_PATH: join(copy, "node_modules"),
	NO_COLOR: "1",
};

/** A paragraph of more than 20 words that core.md does not hold. */
const SENTINEL =
	"Shared core sentinel: every scratch Shepherd reads this exact paragraph from its own core file, so composition and charter checking change together without any Troupe change.";

// Run in the copy as a child, so each run loads core.md afresh.
const PROBE = `
import { createHash } from "node:crypto";
import { join } from "node:path";
import { charterFindings } from "./lib/shepherd/check-charter";
import { composeSession } from "./lib/shepherd/compose";
const [workspace, ...charters] = process.argv.slice(2);
const { fragments } = composeSession(workspace, "claude", undefined, [], new Date(0));
const core = fragments[0] ?? "";
console.log(JSON.stringify({
	core: createHash("sha256").update(core).digest("hex"),
	composedSentinel: core.includes(${JSON.stringify(SENTINEL)}),
	restatements: charters.map((charter) =>
		charterFindings({ candidates: [], children: [], published: false, charter }, join(workspace, ".shepherd"))
			.filter((finding) => finding.code === "charter-module-restatement")
			.map((finding) => finding.message)),
}));
`;
writeFileSync(join(copy, "core-probe.ts"), PROBE);

interface Probe {
	core: string;
	composedSentinel: boolean;
	restatements: string[][];
}

function probe(charters: string[]): Probe {
	const child = Bun.spawnSync(
		[process.execPath, "--no-install", "core-probe.ts", workspace, ...charters],
		{ cwd: copy, env, stdout: "pipe", stderr: "pipe" },
	);
	if (child.exitCode !== 0) throw new Error(child.stderr.toString());
	return JSON.parse(child.stdout.toString());
}

/** The first core paragraph of more than 20 words, as a charter would restate it. */
const coreParagraph =
	readFileSync(join(copy, CORE), "utf8")
		.split(/\n\s*\n/)
		.find((block) => !block.startsWith("#") && block.split(/\s+/).length > 25)
		?.trim() ?? "";

describe("one moved core feeds composition and charter checking (O20)", () => {
	const stageBefore = sha(
		readFileSync(join(troupeRoot(PACKAGE_ROOT), "lib/index.ts")),
	);
	let before: Probe | undefined;

	test("both consumers text-import the package's own core.md", () => {
		for (const consumer of CONSUMERS) {
			const text = readFileSync(join(copy, consumer), "utf8");
			const specifier =
				/import coreDoc from "([^"]+)" with \{\s*type: "text",?\s*\}/.exec(
					text,
				)?.[1];
			expect([consumer, specifier]).toEqual([
				consumer,
				relative(dirname(join(copy, consumer)), join(copy, CORE)),
			]);
		}
	});

	test("before mutation: composition reads core.md's exact bytes and charter checking matches its text", () => {
		before = probe([coreParagraph, SENTINEL]);
		expect(coreParagraph.length).toBeGreaterThan(0);
		expect(before.core).toBe(sha(readFileSync(join(copy, CORE))));
		expect(before.composedSentinel).toBe(false);
		expect(before.restatements[0]?.join("\n")).toMatch(
			/possible repeated rule: core:\d+/,
		);
		expect(before.restatements[1]).toEqual([]);
	});

	test("a package-local mutation of core.md changes both, with no Troupe change", () => {
		appendFileSync(join(copy, CORE), `\n${SENTINEL}\n`);
		const after = probe([coreParagraph, SENTINEL]);
		expect(after.core).toBe(sha(readFileSync(join(copy, CORE))));
		expect(after.core).not.toBe(before?.core);
		expect(after.composedSentinel).toBe(true);
		expect(after.restatements[1]?.join("\n")).toMatch(
			/possible repeated rule: core:\d+/,
		);
		expect(
			sha(readFileSync(join(troupeRoot(PACKAGE_ROOT), "lib/index.ts"))),
		).toBe(stageBefore);
	});

	test("the bundled binary carries the mutated core, with core.md gone", () => {
		const build = Bun.spawnSync(
			[process.execPath, "--no-install", "scripts/build.ts", "shepherd"],
			{ cwd: copy, env, stdout: "pipe", stderr: "pipe" },
		);
		expect({
			code: build.exitCode,
			stderr: build.exitCode === 0 ? "" : build.stderr.toString(),
		}).toEqual({ code: 0, stderr: "" });
		rmSync(join(copy, CORE));
		const shown = Bun.spawnSync(
			[
				resolve(copy, "bin/shepherd"),
				"--backend",
				"claude",
				"--show-prompt",
				"triage",
			],
			{ cwd: workspace, env, stdout: "pipe", stderr: "pipe" },
		);
		expect(shown.exitCode).toBe(0);
		expect(shown.stdout.toString()).toContain(SENTINEL);
	});
});
