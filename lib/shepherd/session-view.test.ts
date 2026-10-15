import { describe, expect, test } from "bun:test";
import { sessionView } from "./session-view";
import type { Running } from "./sessions";
import type { ListedSession } from "./status-parse";

const DIR = "/w/forge";
const listed = (
	name: string,
	extra: Partial<ListedSession> = {},
): ListedSession => ({
	name,
	line: 9,
	retired: false,
	subagent: false,
	codex: false,
	...extra,
});
const running = (name: string, cwd = DIR): Running => ({
	name,
	cwd,
	status: "idle",
	harness: "claude",
});
const view = (input: Partial<Parameters<typeof sessionView>[0]>) =>
	sessionView({
		listed: [],
		running: [],
		sources: { claude: { available: true } },
		workspace: { dir: DIR, hasChildren: false, prefix: "forge" },
		writer: null,
		updatedName: null,
		...input,
	});

describe("sessionView", () => {
	test("a predecessor listed and another Shepherd running drift both ways, naming both", () => {
		const { drift } = view({
			listed: [listed("forge-1014")],
			running: [running("forge-1015")],
			writer: "forge-1014",
			updatedName: "forge-1014",
		});
		expect(drift).toEqual([
			{
				code: "session-unrecorded",
				name: "forge-1015",
				message:
					"forge-1015 is running here but the record names forge-1014 (checkpoint), forge-1014 (Updated:) and lists forge-1014 (Live sessions)",
			},
			{
				code: "session-gone",
				name: "forge-1014",
				line: 9,
				message:
					"forge-1014 is listed live (CURRENT.md:9) but not running; running Shepherd: forge-1015",
			},
		]);
	});

	test("the successor listed, writing and running gives no drift", () => {
		expect(
			view({
				listed: [listed("forge-1015")],
				running: [running("forge-1015")],
				writer: "forge-1015",
				updatedName: "forge-1015",
			}).drift,
		).toEqual([]);
	});

	test("a running delegate without the prefix is unlisted, not drift", () => {
		const result = view({
			listed: [listed("forge-1015")],
			running: [running("forge-1015"), running("si-x")],
			writer: "forge-1015",
		});
		expect(result.unlisted.map(({ name }) => name)).toEqual(["si-x"]);
		expect(result.drift).toEqual([]);
	});

	test("a Codex name with no Codex source is unchecked, not gone", () => {
		const result = view({
			listed: [listed("forge-1013", { codex: true })],
			writer: "forge-1013",
		});
		expect(result.unchecked.map(({ name }) => name)).toEqual(["forge-1013"]);
		expect(result.gone).toEqual([]);
		expect(result.drift).toEqual([]);
	});
});
