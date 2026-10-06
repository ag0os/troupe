import { describe, expect, test } from "bun:test";
import type { AgentMode, Backend } from "../agent-format/types";
import { defaultSessionName, launchKind, sessionNameFor } from "./session-name";

const now = new Date(2026, 9, 5, 14, 7);

function naming(
	overrides: Partial<{
		backend: Backend;
		passthrough: string[];
		mode: AgentMode;
		cwd: string;
		requestedName: string;
		sessionPrefix: string;
		hasChildren: boolean;
		takenNames: Set<string>;
	}> = {},
) {
	return sessionNameFor({
		backend: "claude",
		passthrough: [],
		mode: "interactive",
		cwd: "/work/forge",
		now,
		hasChildren: false,
		takenNames: new Set(),
		...overrides,
	});
}

describe("launchKind", () => {
	test("recognizes every Claude resume spelling and long equals form", () => {
		for (const token of [
			"--resume",
			"-r",
			"--continue",
			"-c",
			"--from-pr",
			"--teleport",
			"--resume=id",
			"--continue=id",
			"--from-pr=42",
			"--teleport=task",
		]) {
			expect(launchKind("claude", [token])).toBe("resume");
		}
	});

	test("distinguishes Claude forks and ignores fork-session on its own", () => {
		expect(launchKind("claude", ["--resume", "x", "--fork-session"])).toBe(
			"fork",
		);
		expect(launchKind("claude", ["--fork-session"])).toBe("new");
	});

	test("recognizes Codex subcommands without treating Claude tokens as Codex", () => {
		expect(launchKind("codex", ["resume"])).toBe("resume");
		expect(launchKind("codex", ["fork"])).toBe("fork");
		expect(launchKind("codex", ["-c"])).toBe("new");
	});

	test("stops every scan at the passthrough's own separator", () => {
		expect(launchKind("claude", ["--", "--resume", "notes"])).toBe("new");
		expect(launchKind("codex", ["--", "resume"])).toBe("new");
		expect(naming({ passthrough: ["--", "-n", "tail-name"] })).toMatchObject({
			sessionName: "forge-1005",
		});
	});
});

describe("sessionNameFor", () => {
	test("sets a default Claude name and reports it", () => {
		expect(naming()).toEqual({
			kind: "new",
			sessionName: "forge-1005",
			headerLines: ["- Session name: forge-1005 (set by the launcher)"],
		});
	});

	test("uses a valid requested name and rejects invalid or reserved names", () => {
		expect(naming({ requestedName: "forge-task-7" })).toMatchObject({
			sessionName: "forge-task-7",
		});
		expect(naming({ requestedName: "nohyphen" }).error).toContain(
			"must start with a letter",
		);
		expect(naming({ requestedName: "my-SHEPHERD-7" }).error).toContain(
			"must not contain",
		);
	});

	test("leaves a passthrough Claude name untouched and reports it", () => {
		for (const passthrough of [
			["-n", "forge-1005"],
			["--name", "forge-1005"],
			["--name=forge-1005"],
		]) {
			expect(naming({ passthrough })).toEqual({
				kind: "new",
				headerLines: ["- Session name: forge-1005 (given at launch)"],
			});
		}
	});

	test("rejects names given both ways and names on resumed sessions", () => {
		expect(
			naming({
				requestedName: "forge-1005",
				passthrough: ["--name=other-1005"],
			}).error,
		).toContain("given twice");
		expect(
			naming({ requestedName: "forge-1005", passthrough: ["--resume"] }),
		).toMatchObject({
			kind: "resume",
			error:
				"a resumed session keeps its name; rename it from inside the session",
		});
		expect(
			naming({ passthrough: ["--resume", "x", "-n", "other-1"] }),
		).toMatchObject({
			kind: "resume",
			error:
				"a resumed session keeps its name; rename it from inside the session",
		});
	});

	test("a resume keeps its name while a fork receives a new name", () => {
		expect(naming({ passthrough: ["--resume"] })).toEqual({
			kind: "resume",
			headerLines: ["- Session name: kept from the resumed session"],
		});
		expect(
			naming({ passthrough: ["--resume", "x", "--fork-session"] }),
		).toMatchObject({ kind: "fork", sessionName: "forge-1005" });
		expect(
			naming({
				passthrough: ["--continue", "--fork-session"],
				requestedName: "forked-1005",
			}),
		).toMatchObject({ kind: "fork", sessionName: "forked-1005" });
	});

	test("applies prefix sanitation, reserved prefix, config, and suffix rules", () => {
		expect(defaultSessionName("/work/my project!", now, undefined, false)).toBe(
			"my-project-1005",
		);
		expect(defaultSessionName("/work/123", now, undefined, false)).toBe(
			"ws-123-1005",
		);
		expect(defaultSessionName("/work/shepherds", now, undefined, false)).toBe(
			"ws-1005",
		);
		expect(defaultSessionName("/work/shepherds", now, undefined, true)).toBe(
			"root-1005",
		);
		expect(defaultSessionName("/work/forge", now, "flock", false)).toBe(
			"flock-1005",
		);
		expect(naming({ takenNames: new Set(["forge-1005"]) })).toMatchObject({
			sessionName: "forge-1005b",
		});
		const alphabet = new Set(["forge-1005"]);
		for (let code = 98; code <= 122; code++) {
			alphabet.add(`forge-1005${String.fromCharCode(code)}`);
		}
		expect(naming({ takenNames: alphabet })).toMatchObject({
			sessionName: "forge-1005-1407",
		});
	});

	test("Codex suggests names but never sets them", () => {
		expect(naming({ backend: "codex" })).toEqual({
			kind: "new",
			headerLines: [
				"- Session name: not set (Codex takes no name at launch; suggested: forge-1005, through its rename dialog)",
			],
		});
		expect(
			naming({ backend: "codex", takenNames: new Set(["forge-1005"]) }),
		).toMatchObject({
			headerLines: [
				"- Session name: not set (Codex takes no name at launch; suggested: forge-1005b, through its rename dialog)",
			],
		});
		expect(naming({ backend: "codex", passthrough: ["resume"] })).toEqual({
			kind: "resume",
			headerLines: ["- Session name: kept from the resumed session"],
		});
		expect(naming({ backend: "codex", passthrough: ["fork"] })).toMatchObject({
			kind: "fork",
			headerLines: [
				"- Session name: not set (Codex takes no name at launch; suggested: forge-1005, through its rename dialog)",
			],
		});
		expect(
			naming({ backend: "codex", requestedName: "forge-1005" }).error,
		).toBe(
			"Codex takes no session name at launch; start the session and name it with its rename dialog",
		);
	});

	test("print mode sets no name and adds no header line", () => {
		expect(naming({ mode: "print" })).toEqual({
			kind: "new",
			headerLines: [],
		});
		expect(naming({ mode: "print", requestedName: "invalid" })).toEqual({
			kind: "new",
			headerLines: [],
			error:
				"session name must start with a letter and contain at least one hyphen-separated letters-or-digits segment",
		});
	});
});
