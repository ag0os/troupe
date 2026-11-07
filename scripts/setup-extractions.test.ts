import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { INVENTORY_FILE, setupExtractions } from "./setup-extractions";

// C6: setup stages Troupe and runs each package's frozen install, records
// the staged inventory, and installs again when a restage changes it. The
// test runs on a disposable copy: a scratch Troupe source (this checkout's
// `lib/` and `package.json`), a scratch stage and a scratch package holding
// the real package's metadata and lockfile, so the committed stage and the
// real package's `node_modules` are never touched while other tests read them.

setDefaultTimeout(120_000);

const repo = resolve(import.meta.dir, "..");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "setup-extractions-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const source = join(scratch, "troupe");
const pkg = join(source, "extractions/shepherd");
cpSync(join(repo, "lib"), join(source, "lib"), { recursive: true });
cpSync(join(repo, "package.json"), join(source, "package.json"));
mkdirSync(pkg, { recursive: true });
for (const file of ["package.json", "bun.lock"]) {
	cpSync(join(repo, "extractions/shepherd", file), join(pkg, file));
}
const INDEX = readFileSync(join(source, "lib/index.ts"), "utf8");
const EXTRA = "lib/agent-format/extra.ts";

const setup = () => setupExtractions({ root: source, packages: [pkg] });
const installed = (path: string) =>
	existsSync(join(pkg, "node_modules/troupe", path));
const recorded = (): string[] =>
	JSON.parse(readFileSync(join(pkg, INVENTORY_FILE), "utf8"));

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
		expect(installed(EXTRA)).toBe(false);
		expect(recorded()).not.toContain(EXTRA);
	});

	test("an installed tree that lost a member is reinstalled", () => {
		rmSync(join(pkg, "node_modules/troupe/lib/entries/cli.ts"));
		const [result] = setup();
		expect(result?.reason).toBe("frozen");
		expect(installed("lib/entries/cli.ts")).toBe(true);
	});
});
