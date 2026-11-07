import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	buildManifest,
	combineSourceInputs,
	framedDigest,
	readSourceInputs,
	type SourceInputDefinition,
	SourceInputError,
	sameSource,
} from "./provenance";

const bytes = (text: string) => new TextEncoder().encode(text);
const V1 = "troupe-shepherd-source-v1";
const V2 = "troupe-agent-source-v2";

let dir: string;
beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "provenance-")));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function put(path: string, text: string, mode?: number) {
	const full = join(dir, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, text);
	if (mode !== undefined) chmodSync(full, mode);
}

function problems(run: () => unknown): string[] {
	try {
		run();
	} catch (error) {
		if (error instanceof SourceInputError) return error.problems;
		throw error;
	}
	throw new Error("expected a SourceInputError");
}

describe("framing under an explicit domain (O23)", () => {
	const files = [
		{ path: "b.txt", content: bytes("two\n") },
		{ path: "a.txt", content: bytes("one") },
	];

	test("the v1 domain keeps its golden digests", () => {
		expect(buildManifest(V1, files).source).toBe(
			"sha256:62977a6741ecee0933377171efd1e9e8874c98f78048126d84b04814bcd6e4eb",
		);
		expect(buildManifest(V1, []).source).toBe(
			"sha256:9fc3a18936290c81c8bc28bfbc8e2c26b5f1eb973afe9a3350e1489374661df9",
		);
		expect(buildManifest(V1, files).entries[0]).not.toHaveProperty(
			"executable",
		);
	});

	test("v2 differs from v1 for the same files", () => {
		expect(buildManifest(V2, files).source).not.toBe(
			buildManifest(V1, files).source,
		);
		expect(buildManifest(V2, files, { modes: true }).source).not.toBe(
			buildManifest(V2, files).source,
		);
	});

	test("framed modes make executable status part of the digest", () => {
		const plain = framedDigest(V2, files, { modes: true });
		const flipped = framedDigest(
			V2,
			[{ ...files[0], executable: true }, files[1]] as typeof files,
			{ modes: true },
		);
		expect(flipped).not.toBe(plain);
		const a = buildManifest(V2, files, { modes: true });
		const b = buildManifest(
			V2,
			[{ ...files[0], executable: true }, files[1]] as typeof files,
			{ modes: true },
		);
		expect(sameSource(a, b)).toBe(false);
		expect(sameSource(a, buildManifest(V2, files, { modes: true }))).toBe(true);
	});
});

describe("explicit input membership (O14, O15)", () => {
	const definition = (
		origin: string,
		root: string,
		extra: Partial<SourceInputDefinition> = {},
	): SourceInputDefinition => ({
		origin,
		root,
		files: ["package.json"],
		trees: [{ dir: "src" }],
		...extra,
	});

	test("equal relative paths in two origins do not collide", () => {
		put("fw/package.json", "{}");
		put("fw/src/a.ts", "same");
		put("pkg/package.json", "{}");
		put("pkg/src/a.ts", "same");
		const combined = combineSourceInputs(V2, [
			readSourceInputs(definition("framework/troupe", join(dir, "fw"))),
			readSourceInputs(definition("package/shepherd", join(dir, "pkg"))),
		]);
		expect(combined.manifest.entries.map((entry) => entry.path)).toEqual([
			"framework/troupe/package.json",
			"framework/troupe/src/a.ts",
			"package/shepherd/package.json",
			"package/shepherd/src/a.ts",
		]);
		expect(combined.origins.map((origin) => origin.origin)).toEqual([
			"framework/troupe",
			"package/shepherd",
		]);
	});

	test("mutating either origin changes the identity", () => {
		put("fw/package.json", "{}");
		put("fw/src/a.ts", "a");
		put("pkg/package.json", "{}");
		put("pkg/src/b.ts", "b");
		const identity = () =>
			combineSourceInputs(V2, [
				readSourceInputs(definition("framework/troupe", join(dir, "fw"))),
				readSourceInputs(definition("package/shepherd", join(dir, "pkg"))),
			]).manifest.source;
		const before = identity();
		put("fw/src/a.ts", "a2");
		const framework = identity();
		expect(framework).not.toBe(before);
		put("pkg/src/b.ts", "b2");
		expect(identity()).not.toBe(framework);
	});

	test("only selected paths bind executable status", () => {
		put("pkg/package.json", "{}");
		put("pkg/src/tool", "#!/bin/sh\n", 0o644);
		put("pkg/src/other", "x", 0o644);
		const read = () =>
			readSourceInputs(
				definition("package/shepherd", join(dir, "pkg"), {
					executables: (path) => path === "src/tool",
				}),
			);
		const before = combineSourceInputs(V2, [read()]).manifest;
		chmodSync(join(dir, "pkg/src/other"), 0o755);
		expect(combineSourceInputs(V2, [read()]).manifest.source).toBe(
			before.source,
		);
		chmodSync(join(dir, "pkg/src/tool"), 0o755);
		const after = combineSourceInputs(V2, [read()]).manifest;
		expect(after.source).not.toBe(before.source);
		expect(
			after.entries.find((entry) => entry.path.endsWith("src/tool"))
				?.executable,
		).toBe(true);
	});

	test("symlinks and nonregular inputs are refused", () => {
		put("pkg/package.json", "{}");
		put("pkg/real.ts", "x");
		mkdirSync(join(dir, "pkg/src"));
		symlinkSync(join(dir, "pkg/real.ts"), join(dir, "pkg/src/link.ts"));
		expect(
			problems(() => readSourceInputs(definition("p", join(dir, "pkg")))),
		).toEqual(["src/link.ts: an input must not be a symlink"]);
		rmSync(join(dir, "pkg/src/link.ts"));
		symlinkSync(join(dir, "pkg/real.ts"), join(dir, "pkg/linked.json"));
		expect(
			problems(() =>
				readSourceInputs(
					definition("p", join(dir, "pkg"), { files: ["linked.json"] }),
				),
			),
		).toEqual(["linked.json: an input must not be a symlink"]);
		mkdirSync(join(dir, "pkg/dirfile"));
		expect(
			problems(() =>
				readSourceInputs(
					definition("p", join(dir, "pkg"), { files: ["dirfile"] }),
				),
			),
		).toEqual(["dirfile: an input must be a regular file"]);
		symlinkSync(join(dir, "pkg/src"), join(dir, "pkg/lsrc"));
		expect(
			problems(() =>
				readSourceInputs(
					definition("p", join(dir, "pkg"), { trees: [{ dir: "lsrc" }] }),
				),
			),
		).toEqual(["lsrc: a symlink at lsrc holds inputs"]);
	});

	test("a missing listed file is an error and an absent tree is empty", () => {
		mkdirSync(join(dir, "pkg"));
		expect(
			problems(() => readSourceInputs(definition("p", join(dir, "pkg")))),
		).toEqual(["package.json: required input is missing"]);
		put("pkg/package.json", "{}");
		expect(readSourceInputs(definition("p", join(dir, "pkg"))).files).toEqual([
			expect.objectContaining({ path: "package.json" }),
		]);
	});

	test("unknown revision metadata stays unknown (O16)", () => {
		put("pkg/package.json", "{}");
		const none = readSourceInputs(definition("p", join(dir, "pkg")));
		expect(none.provenance.revision).toBe("unknown");
		expect(none.provenance.prefix).toBe("unknown");
		const notGit = readSourceInputs(
			definition("p", join(dir, "pkg"), {
				revision: {
					gitRoot: join(dir, "pkg"),
					prefix: "",
					git: () => ({ code: 128, stdout: new Uint8Array(), stderr: "no" }),
				},
			}),
		);
		expect(notGit.provenance.revision).toBe("unknown");
		expect(notGit.provenance.prefix).toBe("");
	});

	test("origin names must be distinct and not nested", () => {
		put("pkg/package.json", "{}");
		const input = readSourceInputs(definition("package", join(dir, "pkg")));
		const nested = { ...input, origin: "package/shepherd" };
		expect(problems(() => combineSourceInputs(V2, [input, input]))).toEqual([
			"package: origin names must be distinct and not nested",
		]);
		expect(
			problems(() => combineSourceInputs(V2, [input, nested]))[0],
		).toContain("not nested");
	});
});
