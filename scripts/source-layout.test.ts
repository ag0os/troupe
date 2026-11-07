import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluationIdentity } from "../evals/shepherd/identity";
import {
	captureProvenance,
	readCommitSource,
	readWorktreeSource,
	ShepherdSourceError,
} from "./shepherd-source";
import { git, initShepherdRepo, writeAt } from "./shepherd-source-fixture";

// O24a: source and evaluation identity take an explicit Git root and
// package prefix. A nested package's identity equals the same files'
// root-layout identity; the root layout is unchanged. Fixtures only.

let dir: string;
let flat: string;
let outer: string;
let nested: string;
const layout = () => ({ gitRoot: outer, prefix: "packages/shepherd" });
const evalFile = { "evals/shepherd/rubric.yaml": "rubric\n" };

beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "source-layout-")));
	flat = join(dir, "flat");
	outer = join(dir, "outer");
	nested = join(outer, "packages/shepherd");
	initShepherdRepo(flat, evalFile);
	initShepherdRepo(nested, evalFile);
	rmSync(join(nested, ".git"), { recursive: true, force: true });
	// Files outside the prefix, including ones the selection would match.
	writeAt(outer, "README.md", "outer\n");
	writeAt(outer, "lib/shepherd/outside.ts", "export {};\n");
	writeAt(outer, "evals/shepherd/outside.yaml", "x\n");
	git(outer, "init", "-q", "-b", "main");
	git(outer, "add", "-A");
	git(outer, "commit", "-q", "-m", "outer");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("explicit Git root and prefix (O24a)", () => {
	test("a nested package's worktree and commit identity equal the root layout's", () => {
		const root = readWorktreeSource(flat);
		const worktree = readWorktreeSource(nested, { layout: layout() });
		expect(worktree).toEqual(root);
		const head = git(outer, "rev-parse", "HEAD").trim();
		expect(readCommitSource(nested, head, { layout: layout() }).source).toBe(
			root.source,
		);
		expect(
			worktree.entries.some((entry) => entry.path.includes("outside")),
		).toBe(false);
	});

	test("capture under a layout is clean and names the outer revision", () => {
		const provenance = captureProvenance(nested, { layout: layout() });
		expect(provenance.revision).toBe(git(outer, "rev-parse", "HEAD").trim());
		expect(provenance.sourceDirty).toBe(false);
		expect(provenance.dirty).toBe(false);
		expect(provenance.manifest.source).toBe(readWorktreeSource(flat).source);
	});

	test("dirty stays repository-wide; sourceDirty follows the package", () => {
		writeAt(outer, "README.md", "changed\n");
		const outside = captureProvenance(nested, { layout: layout() });
		expect(outside.dirty).toBe(true);
		expect(outside.sourceDirty).toBe(false);
		writeAt(nested, "lib/shepherd/tool.ts", "export const tool = 2;\n");
		expect(captureProvenance(nested, { layout: layout() }).sourceDirty).toBe(
			true,
		);
	});

	test("evaluation identity under a layout equals the root layout's", () => {
		const root = evaluationIdentity(flat);
		expect(root.entries.map((entry) => entry.path)).toEqual([
			"evals/shepherd/rubric.yaml",
		]);
		expect(evaluationIdentity(nested, { layout: layout() })).toEqual(root);
	});

	test("the root layout still requires the repository root", () => {
		expect(() => readWorktreeSource(nested)).toThrow(ShepherdSourceError);
		expect(() => evaluationIdentity(nested)).toThrow(ShepherdSourceError);
		expect(
			readWorktreeSource(flat, { layout: { gitRoot: flat, prefix: "" } }),
		).toEqual(readWorktreeSource(flat));
	});

	test("a layout that does not name the package is refused", () => {
		for (const prefix of ["packages", "../x", "packages/./shepherd"]) {
			expect(() =>
				readWorktreeSource(nested, { layout: { gitRoot: outer, prefix } }),
			).toThrow(ShepherdSourceError);
		}
		expect(() =>
			evaluationIdentity(nested, {
				layout: { gitRoot: outer, prefix: "packages" },
			}),
		).toThrow(ShepherdSourceError);
	});
});
