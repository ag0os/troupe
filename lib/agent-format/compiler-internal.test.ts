import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { internalDeviceProbe, publish } from "./compiler";

// O12's same-filesystem clause through the internal device seam, which
// `troupe/compiler` does not export.

let root: string;
const original = internalDeviceProbe.device;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "compiler-internal-")));
});

afterEach(() => {
	internalDeviceProbe.device = original;
	rmSync(root, { recursive: true, force: true });
});

function write(path: string, text: string) {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), text);
}

describe("same-filesystem refusal", () => {
	test("an output directory on another device publishes nothing", async () => {
		write(
			"defs/a.md",
			"---\ndescription: Fixture\nbackends: [claude]\n---\nBody\n",
		);
		write("out/a", "old a");
		write("out/orphan", "stale");
		const outDir = join(root, "out");
		internalDeviceProbe.device = (path) => (path === outDir ? 1 : 2);
		let built = 0;
		const failure = await publish({
			definition: {
				consumerRoot: root,
				declarationRoot: "defs",
				roster: ["a"],
				outDir: "out",
			},
			build: async (request) => {
				built++;
				writeFileSync(request.outFile, "new");
			},
		}).then(
			() => undefined,
			(error) => error as Error,
		);
		expect(failure?.message).toMatch(
			new RegExp(
				`^${root}/\\.troupe-build-\\w+ is not on the same filesystem as ${outDir}; cannot publish by rename$`,
			),
		);
		expect(built).toBe(0);
		expect(readdirSync(outDir).sort()).toEqual(["a", "orphan"]);
		expect(readFileSync(join(outDir, "a"), "utf8")).toBe("old a");
		expect(readFileSync(join(outDir, "orphan"), "utf8")).toBe("stale");
		expect(
			readdirSync(root).filter((name) => name.startsWith(".troupe-build-")),
		).toEqual([]);
	});
});
