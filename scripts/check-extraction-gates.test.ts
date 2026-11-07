import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	GATES,
	gateCommand,
	PACKAGE_DIR,
	plans,
	SOURCES,
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

	test("package gates run in the package; the root test gate runs every place's test file", () => {
		for (const gate of GATES) {
			expect([gate, gateCommand(gate).cwd]).toEqual([
				gate,
				gate.startsWith("package") ? PACKAGE_DIR : ".",
			]);
		}
		expect(gateCommand("root test").argv.slice(2)).toEqual([
			`./${testFile("root framework")}`,
			`./${testFile("root shepherd")}`,
			`./${testFile("package")}`,
		]);
		expect(gateCommand("package test").argv.slice(2)).toEqual([
			"./lib/shepherd/gate-plant.test.ts",
		]);
	});

	test("the table marks a miss", () => {
		const rendered = table([
			{ plant: "p", gate: "root biome", expected: "fail", exit: 0, ok: false },
		]);
		expect(rendered).toContain("| p | root biome | fail | 0 | MISS |");
	});
});
