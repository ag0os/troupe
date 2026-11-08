import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	INVENTORY_FILE,
	RESOLUTION_SCRIPT,
	setupExtractions,
} from "./setup-extractions";

// C6: setup stages Troupe and runs each package's frozen install, records
// the staged inventory, and installs again when a restage changes it. The
// test runs on a disposable copy: a scratch Troupe source (this checkout's
// `lib/` and `package.json`), a scratch stage and a scratch package holding
// the real package's metadata, lockfile, tsconfig and resolution guard, so
// the committed stage and the real package's `node_modules` are never
// touched while other tests read them. C8 and C9: setup records where the
// stage's runtime imports resolve under each tool and fails unless every one
// is the package's own locked copy.

setDefaultTimeout(120_000);

const repo = resolve(import.meta.dir, "..");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "setup-extractions-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const source = join(scratch, "troupe");
const pkg = join(source, "extractions/shepherd");
cpSync(join(repo, "lib"), join(source, "lib"), { recursive: true });
cpSync(join(repo, "package.json"), join(source, "package.json"));
mkdirSync(pkg, { recursive: true });
for (const file of [
	"package.json",
	"bun.lock",
	"tsconfig.json",
	RESOLUTION_SCRIPT,
]) {
	mkdirSync(join(pkg, file, ".."), { recursive: true });
	cpSync(join(repo, "extractions/shepherd", file), join(pkg, file));
}
const INDEX = readFileSync(join(source, "lib/index.ts"), "utf8");
const EXTRA = "lib/agent-format/extra.ts";

const setup = () => setupExtractions({ root: source, packages: [pkg] });
/** Whether the installed tree holds an entry at `path`, a dangling link included. */
const present = (path: string) => {
	try {
		lstatSync(join(pkg, "node_modules/troupe", path));
		return true;
	} catch {
		return false;
	}
};
/** Whether the entry is there and reaches a file. */
const installed = (path: string) =>
	present(path) && existsSync(join(pkg, "node_modules/troupe", path));
const recorded = (): string[] =>
	JSON.parse(readFileSync(join(pkg, INVENTORY_FILE), "utf8"));
const RUNTIME = ["typescript", "yaml", "zod"];
const TOOLS = ["build", "runtime", "test", "tsc"];
/** Each runtime dependency's version as the package's bun.lock records it. */
const lockedVersion = (name: string): string => {
	const lock = readFileSync(join(pkg, "bun.lock"), "utf8");
	const match = lock.match(new RegExp(`"${name}": \\["${name}@([^"]+)"`));
	if (!match?.[1]) throw new Error(`bun.lock records no ${name}`);
	return match[1];
};
/** The package's guard run as setup runs it: --no-install and NODE_PATH. */
const guard = () => {
	const child = Bun.spawnSync(
		[process.execPath, "--no-install", RESOLUTION_SCRIPT, "--json"],
		{
			cwd: pkg,
			env: { ...process.env, NODE_PATH: join(pkg, "node_modules") },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const stdout = child.stdout.toString();
	if (!stdout.startsWith("{")) throw new Error(child.stderr.toString());
	return {
		code: child.exitCode,
		...(JSON.parse(stdout) as {
			resolutions: {
				tool: string;
				name: string;
				dir: string;
				version: string;
			}[];
			problems: string[];
		}),
	};
};

describe("setup:extractions (C6)", () => {
	test("a fresh setup stages, installs frozen and records the inventory", () => {
		const [result] = setup();
		expect(result).toMatchObject({ reason: "fresh", relinked: false });
		expect(installed("lib/entries/compiler.ts")).toBe(true);
		expect(recorded()).toContain("lib/entries/compiler.ts");
		expect(
			existsSync(join(source, "extractions/.troupe-dist/troupe/package.json")),
		).toBe(true);
	});

	test("every runtime import of the stage resolves to the package's locked copy under each tool (C8, C9)", () => {
		const [result] = setup();
		const seen = [...(result?.resolutions ?? [])].sort((a, b) =>
			`${a.tool} ${a.name}`.localeCompare(`${b.tool} ${b.name}`),
		);
		expect(seen.map((entry) => `${entry.tool} ${entry.name}`)).toEqual(
			TOOLS.flatMap((tool) => RUNTIME.map((name) => `${tool} ${name}`)),
		);
		for (const entry of seen) {
			expect(entry).toMatchObject({
				dir: realpathSync(join(pkg, "node_modules", entry.name)),
				version: lockedVersion(entry.name),
			});
		}
		expect(
			realpathSync(join(source, "extractions/.troupe-dist/node_modules")),
		).toBe(realpathSync(join(pkg, "node_modules")));
	});

	test("an ancestor node_modules beats NODE_PATH; the guard fails on it and setup's link restores the package's copy (C9)", () => {
		// A decoy zod in the Troupe checkout's own node_modules, an ancestor of the stage.
		const decoy = join(source, "node_modules/zod");
		cpSync(realpathSync(join(pkg, "node_modules/zod")), decoy, {
			recursive: true,
		});
		const meta = JSON.parse(readFileSync(join(decoy, "package.json"), "utf8"));
		writeFileSync(
			join(decoy, "package.json"),
			JSON.stringify({ ...meta, version: "4.0.0-decoy" }),
		);
		try {
			rmSync(join(source, "extractions/.troupe-dist/node_modules"));
			const leaked = guard();
			expect(leaked.code).toBe(1);
			// bun test ignores NODE_PATH, so without the link the stage's typescript is not found at all.
			expect(leaked.problems.join("\n")).toContain("test: the probe failed");
			for (const tool of ["runtime", "build"]) {
				expect(
					leaked.resolutions.find(
						(entry) => entry.tool === tool && entry.name === "zod",
					)?.dir,
				).toBe(realpathSync(decoy));
			}
			expect(leaked.problems.join("\n")).toContain(
				`runtime: zod resolved to ${realpathSync(decoy)}`,
			);
			const [result] = setup();
			expect(
				result?.resolutions.filter((entry) => entry.name === "zod"),
			).toHaveLength(4);
			expect(guard()).toMatchObject({ code: 0, problems: [] });
		} finally {
			rmSync(join(source, "node_modules"), { recursive: true, force: true });
		}
	});

	test("an unchanged restage is a routine frozen install", () => {
		expect(setup()[0]).toMatchObject({ reason: "frozen", relinked: false });
	});

	test("an added member reaches the package; a frozen install relinks it with the lockfile unchanged", () => {
		const lock = readFileSync(join(pkg, "bun.lock"), "utf8");
		writeFileSync(join(source, EXTRA), "export const extra = 1;\n");
		writeFileSync(
			join(source, "lib/index.ts"),
			`${INDEX}export * from "./agent-format/extra";\n`,
		);
		const [result] = setup();
		expect(result).toMatchObject({ reason: "inventory", relinked: false });
		expect(installed(EXTRA)).toBe(true);
		expect(recorded()).toContain(EXTRA);
		expect(readFileSync(join(pkg, "bun.lock"), "utf8")).toBe(lock);
	});

	test("a removed member leaves the package", () => {
		rmSync(join(source, EXTRA));
		writeFileSync(join(source, "lib/index.ts"), INDEX);
		const [result] = setup();
		expect(result).toMatchObject({ reason: "inventory", relinked: false });
		// The entry itself is gone, not left as a dangling link.
		expect(present(EXTRA)).toBe(false);
		expect(recorded()).not.toContain(EXTRA);
	});

	test("an installed tree that lost a member is reinstalled", () => {
		rmSync(join(pkg, "node_modules/troupe/lib/entries/cli.ts"));
		const [result] = setup();
		expect(result?.reason).toBe("frozen");
		expect(installed("lib/entries/cli.ts")).toBe(true);
	});
});
