import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertOutside,
	copyArtifact,
	sameObservation,
	treeManifest,
} from "./extraction-proof";

const root = mkdtempSync(join(tmpdir(), "proof-helpers-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
describe("outside proof boundaries", () => {
	test("an ancestor dependency, workspace or Git directory refuses the replay", () => {
		for (const name of ["node_modules", ".shepherd", ".git"]) {
			const parent = join(root, name);
			const child = join(parent, "child");
			mkdirSync(child, { recursive: true });
			mkdirSync(join(parent, name));
			expect(() => assertOutside(child, import.meta.dir)).toThrow(
				"prohibited ancestor",
			);
		}
	});
	test("the checkout itself refuses the replay", () =>
		expect(() => assertOutside(import.meta.dir, import.meta.dir)).toThrow(
			"not outside",
		));
	test("artifact copies bind bytes and executable modes", () => {
		const src = join(root, "artifact");
		mkdirSync(src);
		writeFileSync(join(src, "tool"), "same\n");
		chmodSync(join(src, "tool"), 0o755);
		const manifest = copyArtifact(src, join(root, "copy"));
		expect(treeManifest(join(root, "copy"))).toEqual(manifest);
		chmodSync(join(root, "copy/tool"), 0o644);
		expect(treeManifest(join(root, "copy"))).not.toEqual(manifest);
		writeFileSync(join(root, "copy/tool"), "DIFF\n");
		expect(treeManifest(join(root, "copy"))).not.toEqual(manifest);
	});
	test("manifest records links without reading their target", () => {
		const dir = join(root, "links");
		mkdirSync(dir);
		symlinkSync("/not-readable-or-present", join(dir, "link"));
		expect(treeManifest(dir)).toEqual(["link link /not-readable-or-present"]);
	});
	test("raw parity catches paths, clock text, stderr and exit differences", () => {
		const a = {
			argv: ["binary"],
			cwd: root,
			code: 0,
			stdout: "/slot 12:00:00\n",
			stderr: "",
		};
		expect(sameObservation(a, { ...a })).toBe(true);
		for (const b of [
			{ ...a, stdout: "/other 12:00:00\n" },
			{ ...a, stdout: "/slot 12:00:01\n" },
			{ ...a, stderr: "finding\n" },
			{ ...a, code: 1 },
		])
			expect(sameObservation(a, b)).toBe(false);
	});
});
