import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	detected,
	GATES,
	gateCommand,
	PACKAGE_DIR,
	plans,
	SENTINEL,
	SOURCES,
	TEST_FILTER,
	table,
	testFile,
} from "./check-extraction-gates";

// O25: the gate check's planning logic. The full run (a disposable copy,
// nine plants and every gate) is `bun scripts/check-extraction-gates.ts`.

const repo = resolve(import.meta.dir, "..");

describe("check-extraction-gates plans (O25)", () => {
	test("each of the three kinds is planted once in each of the three places", () => {
		expect(
			plans()
				.map((plant) => `${plant.place} ${plant.kind}`)
				.sort(),
		).toEqual(
			["root framework", "root shepherd", "package"]
				.flatMap((place) =>
					["type", "lint", "test"].map((kind) => `${place} ${kind}`),
				)
				.sort(),
		);
	});

	test("root plants are gated by root gates; package plants by the package's and the root sweep's", () => {
		const gates = Object.fromEntries(
			plans().map((plant) => [`${plant.place} ${plant.kind}`, plant.gates]),
		);
		expect(gates).toEqual({
			"root framework type": ["root typecheck"],
			"root framework lint": ["root biome"],
			"root framework test": ["root test"],
			"root shepherd type": ["root typecheck"],
			"root shepherd lint": ["root biome"],
			"root shepherd test": ["root test"],
			"package type": ["root typecheck", "package typecheck"],
			"package lint": ["root biome", "package biome"],
			"package test": ["root test", "package test"],
		});
		expect(new Set(plans().flatMap((plant) => plant.gates))).toEqual(
			new Set(GATES),
		);
	});

	test("type and lint plants append to existing sources; test plants create new files", () => {
		for (const plant of plans()) {
			expect([plant.file, existsSync(join(repo, plant.file))]).toEqual([
				plant.file,
				!plant.creates,
			]);
			if (plant.kind === "test") expect(plant.file).toEndWith(".test.ts");
			else expect(plant.file).toBe(SOURCES[plant.place]);
		}
		const text = (kind: string) =>
			plans().find((plant) => plant.kind === kind)?.text ?? "";
		expect(text("type")).toContain(': number = "');
		expect(text("lint")).toContain("debugger;");
		expect(text("test")).toContain("toBe(2)");
	});

	test("package gates run in the package; the test gates find plants by discovery", () => {
		for (const gate of GATES) {
			expect([gate, gateCommand(gate).cwd]).toEqual([
				gate,
				gate.startsWith("package") ? PACKAGE_DIR : ".",
			]);
		}
		for (const gate of ["root test", "package test"] as const) {
			expect(gateCommand(gate).argv.slice(1)).toEqual(["test", TEST_FILTER]);
		}
		for (const place of ["root framework", "root shepherd", "package"] as const)
			expect(testFile(place)).toEndWith(`/${TEST_FILTER}.test.ts`);
	});

	test("a bare filter that matches no test file fails", () => {
		const dir = mkdtempSync(join(tmpdir(), "gate-filter-"));
		try {
			writeFileSync(join(dir, "package.json"), "{}");
			const result = spawnSync(process.execPath, ["test", TEST_FILTER], {
				cwd: dir,
				encoding: "utf8",
			});
			expect(result.status).not.toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("detection needs the plant's path from the gate's directory and the sentinel failure", () => {
		const plant = plans().find(
			(each) => each.place === "package" && each.kind === "test",
		);
		if (plant === undefined) throw new Error("no package test plant");
		expect(plant.text).toContain(SENTINEL);
		const fail = (path: string, name: string) =>
			`bun test\n\n${path}:\nerror: expect(received).toBe(expected)\n(fail) ${name} [1ms]\n 1 fail\n`;
		expect(detected(plant, "root test", fail(plant.file, SENTINEL))).toBeTrue();
		expect(
			detected(
				plant,
				"package test",
				fail("lib/shepherd/gate-plant.test.ts", SENTINEL),
			),
		).toBeTrue();
		// An unrelated failure, or the sentinel from another path, is not detection.
		expect(
			detected(plant, "root test", fail(plant.file, "something else")),
		).toBeFalse();
		expect(
			detected(
				plant,
				"root test",
				fail("lib/shepherd/gate-plant.test.ts", SENTINEL),
			),
		).toBeFalse();
	});

	test("the table marks a miss", () => {
		const rendered = table([
			{ plant: "p", gate: "root biome", expected: "fail", exit: 0, ok: false },
		]);
		expect(rendered).toContain("| p | root biome | fail | 0 | MISS |");
	});
});
