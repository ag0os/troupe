import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepare } from "../../agents/shepherd";
import { loadAgentDefinition } from "../../scripts/agent-compiler";
import { parseCli } from "../agent-format/cli";
import { previewAgent } from "../agent-format/run";
import { promptWords } from "./compose";
import { fakeToolEnv } from "./test-support";
import { words } from "./text";

test("promptWords counts the system prompt produced by previewAgent", async () => {
	const repo = resolve(import.meta.dir, "../..");
	const workspace = mkdtempSync(join(tmpdir(), "shepherd-compose-"));
	try {
		const state = join(workspace, ".shepherd");
		mkdirSync(join(state, "integrations"), { recursive: true });
		writeFileSync(join(state, "charter.md"), "# Charter\n\nTest workspace.\n");
		writeFileSync(
			join(state, "integrations", "local.md"),
			"# Local module\n\nLocal instructions.\n",
		);

		const agent = await loadAgentDefinition(repo, "agents/shepherd.md");
		const outcome = parseCli(agent.spec, ["--show-prompt"], { cwd: workspace });
		if (outcome.kind !== "run") throw new Error("unexpected help");
		let stdout = "";
		let stderr = "";
		const toolEnv = fakeToolEnv({
			home: join(workspace, "home"),
			cwd: workspace,
			env: {},
		});
		const code = await previewAgent(
			agent.spec,
			{ prepare: (ctx) => prepare(ctx, toolEnv) },
			outcome.invocation,
			{
				stdout: (chunk) => {
					stdout += chunk;
				},
				stderr: (chunk) => {
					stderr += chunk;
				},
				isDirectory: () => true,
			},
		);

		const match =
			/^Backend: \w+\n--- System prompt ---\n([\s\S]*)\n--- Initial prompt ---\n/.exec(
				stdout,
			);
		expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
		expect(match?.[1]).toBeDefined();
		expect(promptWords(workspace, toolEnv.now)).toBe(words(match?.[1] ?? ""));
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("annotated predicate AND/false gates and publication-before-filtering", async () => {
	const { composeFragments } = await import("./compose");
	const { makeTree } = await import("./test-support");
	const t = makeTree({
		"parent/.shepherd/integrations/hidden.md":
			"---\nname: hidden\ntype: domain\ndescription: Hidden\nbudget: 3\napplies-when:\n  has-children: true\n---\ninactive body\n",
		"parent/child/.shepherd/charter.md": "",
		"parent/child/.shepherd/integrations/visible.md":
			"---\nname: visible\ntype: domain\ndescription: Visible\nbudget: 3\napplies-when:\n  has-children: false\n  enclosing-modules: true\n---\nvisible body\n",
	});
	try {
		const parts = composeFragments(
			join(t.root, "parent/child"),
			"claude-cli",
			join(t.root, "parent"),
		);
		expect(parts).toContain("visible body\n");
		expect(parts).not.toContain("inactive body\n");
		expect(parts.at(-1)).toContain("inherited integrations: none");
		expect(parts.at(-1)).toContain("- Gated modules loaded: nested\n");
		expect(parts.join("\n")).not.toContain("applies-when:");
		expect(parts.at(-1)).not.toContain("Module problems:");
	} finally {
		t.cleanup();
	}
});
