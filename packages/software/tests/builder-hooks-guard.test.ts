// builder-hooks guard (BH-5 to BH-7): fails closed, classifies history
// writes lexically, and denies edits to excluded paths and the run directory.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { encode } from "../tools/builder-hooks.d/log";
import { Fixture, spawn, tool } from "./builder-hooks-fixture";

const HISTORY =
	"Role guard: history writes are off for this run; the host holds commits, pushes and pull requests. Leave the change uncommitted; the host commits after recheck.";
const excludedReason = (p: string) =>
	`Role guard: ${p} is excluded from automated change in this repo (auth, data, deploy, or the gate's own definition). Record what you would change there in your report; the host presents it.`;
const cannot = (why: string) =>
	`Role guard could not run: ${why}. The call is refused until the host repairs the hooks.\n`;
// The mark a wrapper sets on a log it checked; the launcher run directly
// writes a fallback line only with it.
const CHECKED = { BUILDER_HOOKS_LOG_CHECKED: "1" };
// Code points, so this file holds no dash for publish-check to find.
const DASH = String.fromCodePoint(0x2d);

let f: Fixture;
beforeAll(() => {
	f = new Fixture();
	f.write("config/deploy.yml", "x\n");
	f.write("app/models/user.rb", "x\n");
	f.write("lib/admin/base.rb", "x\n");
	f.commit("Files");
	expect(
		f.prepare(
			f.input({
				history_writes: false,
				excluded: [
					"config/deploy.yml",
					"lib/admin/",
					"app/**/secret_*.rb",
					"db/schema.rb",
				],
			}),
		).code,
	).toBe(0);
});
afterAll(() => f.cleanup());

const bash = (command: string, env: Record<string, string> = {}) =>
	f.hook(
		"guard",
		{ session_id: "s1", tool_name: "Bash", tool_input: { command } },
		env,
	);
const edit = (tool: string, path: string) =>
	f.hook("guard", {
		session_id: "s1",
		tool_name: tool,
		tool_input:
			tool === "NotebookEdit" ? { notebook_path: path } : { file_path: path },
	});
const denial = (r: { code: number; stdout: string }) =>
	r.code === 0 && r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;

describe("BH-5: guard infrastructure", () => {
	test("a missing or unparseable manifest refuses with exit 2", () => {
		const event = { tool_name: "Bash", tool_input: { command: "ls" } };
		const missing = f.hook("guard", event, {
			SHEPHERD_HOOK_MANIFEST: join(f.root, "none.json"),
		});
		expect(missing.code).toBe(2);
		expect(missing.stdout).toBe("");
		expect(missing.stderr).toStartWith(
			"Role guard could not run: the manifest cannot be read",
		);
		const garbled = join(f.root, "garbled.json");
		writeFileSync(garbled, "{not json");
		expect(
			f.hook("guard", event, { SHEPHERD_HOOK_MANIFEST: garbled }).code,
		).toBe(2);
		const unset = f.run(["guard"], { stdin: JSON.stringify(event) });
		expect(unset).toEqual({
			code: 2,
			stdout: "",
			stderr: cannot("SHEPHERD_HOOK_MANIFEST is not set"),
		});
	});

	test("a manifest whose repository is missing, or whose run directory resolves inside it, refuses", () => {
		const g = new Fixture();
		try {
			g.prepare(g.input());
			const manifest = JSON.parse(readFileSync(g.manifest, "utf8"));
			const event = { tool_name: "Bash", tool_input: { command: "ls" } };
			writeFileSync(
				g.manifest,
				JSON.stringify({ ...manifest, repo: join(g.root, "gone") }),
			);
			const missing = g.hook("guard", event);
			expect(missing.code).toBe(2);
			expect(missing.stderr).toBe(
				cannot(
					`the manifest's repo ${join(g.root, "gone")} is not a directory`,
				),
			);
			writeFileSync(g.manifest, JSON.stringify(manifest));
			mkdirSync(join(g.repo, "inner"));
			renameSync(g.runDir, join(g.root, "moved"));
			writeFileSync(
				join(g.repo, "inner/builder-manifest.json"),
				JSON.stringify(manifest),
			);
			symlinkSync(join(g.repo, "inner"), g.runDir);
			const inside = g.hook("guard", event);
			expect(inside.code).toBe(2);
			expect(inside.stderr).toBe(
				cannot(`the run directory ${g.runDir} resolves inside the repository`),
			);
			expect(existsSync(join(g.repo, "inner/hooks.log"))).toBe(false);
		} finally {
			g.cleanup();
		}
	});

	test("an early failure writes no log into a run directory redirected into the repository", () => {
		const g = new Fixture();
		try {
			g.prepare(g.input());
			const manifest = readFileSync(g.manifest, "utf8");
			mkdirSync(join(g.repo, "inner"));
			renameSync(g.runDir, join(g.root, "moved"));
			writeFileSync(join(g.repo, "inner/builder-manifest.json"), manifest);
			symlinkSync(join(g.repo, "inner"), g.runDir);
			expect(g.hook("guard", "not json").code).toBe(2);
			expect(
				g.run(["guard"], {
					stdin: "{}",
					env: {
						PATH: "/nonexistent",
						SHEPHERD_HOOK_LOG: g.log,
						SHEPHERD_HOOK_MANIFEST: g.manifest,
					},
				}).code,
			).toBe(2);
			expect(existsSync(join(g.repo, "inner/hooks.log"))).toBe(false);
		} finally {
			g.cleanup();
		}
	});

	test("a malformed event refuses with exit 2", () => {
		expect(f.hook("guard", "not json")).toEqual({
			code: 2,
			stdout: "",
			stderr: cannot("the event on stdin is not JSON"),
		});
		expect(f.hook("guard", { tool_name: "Bash" })).toEqual({
			code: 2,
			stdout: "",
			stderr: cannot("the event has no tool_input"),
		});
		expect(f.hook("guard", { tool_name: "Write", tool_input: {} })).toEqual({
			code: 2,
			stdout: "",
			stderr: cannot("the Write call has no path"),
		});
	});

	test("a missing runtime refuses with exit 2", () => {
		const r = f.run(["guard"], {
			stdin: "{}",
			env: {
				PATH: "/nonexistent",
				SHEPHERD_HOOK_LOG: f.log,
				SHEPHERD_HOOK_MANIFEST: f.manifest,
				...CHECKED,
			},
		});
		expect(r.code).toBe(2);
		expect(r.stderr).toBe(
			cannot("bun is not on PATH; this tool requires bun and git"),
		);
		expect(f.logLines().at(-1)).toMatch(
			/ guard launcher - 0ms COULD-NOT-RUN bun is not on PATH/,
		);
	});

	test("the internal deadline refuses with exit 2 when the event never arrives", async () => {
		const child = Bun.spawn([tool, "guard"], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: f.env({
				SHEPHERD_HOOK_MANIFEST: f.manifest,
				SHEPHERD_HOOK_LOG: f.log,
			}),
		});
		const code = await child.exited;
		expect(code).toBe(2);
		expect(await new Response(child.stderr).text()).toBe(
			cannot("the guard did not finish within 200 ms"),
		);
		expect(f.logLines().at(-1)).toContain(
			"COULD-NOT-RUN the guard did not finish within 200 ms",
		);
	});

	test("an unwritable log refuses", () => {
		const g = new Fixture();
		try {
			g.prepare(g.input());
			mkdirSync(g.log);
			const r = g.hook("guard", {
				tool_name: "Bash",
				tool_input: { command: "ls" },
			});
			expect(r.code).toBe(2);
			expect(r.stderr).toStartWith(
				"Role guard could not run: the hook log cannot be written",
			);
		} finally {
			g.cleanup();
		}
	});

	test("the generated entry fails closed on the host side", () => {
		const s = JSON.parse(
			readFileSync(join(f.runDir, "builder-hooks.settings.json"), "utf8"),
		);
		expect(s.hooks.PreToolUse[0].hooks[0].onFailure).toBe("block");
	});
});

describe("BH-5: fallback log destinations", () => {
	const noBun = { PATH: "/usr/bin:/bin" };
	const wrapper = (
		g: Fixture,
		mode: string,
		event: unknown,
		env: Record<string, string> = {},
	) =>
		spawn(["/bin/sh", "-c", `'${join(g.runDir, `${mode}.sh`)}'`], {
			cwd: g.root,
			env: g.env(env),
			input: JSON.stringify(event),
		});
	const commit = {
		session_id: "s1",
		tool_name: "Bash",
		tool_input: { command: "git commit" },
	};
	const edited = (g: Fixture) => ({
		session_id: "s1",
		tool_name: "Edit",
		tool_input: { file_path: join(g.repo, "README.md") },
	});
	const closed = (r: { code: number; stdout: string }) => {
		expect(r.code).toBe(2);
		expect(r.stdout).toBe("");
	};
	const asContext = (r: { code: number; stdout: string }) => {
		expect(r.code).toBe(0);
		expect(
			JSON.parse(r.stdout).hookSpecificOutput.additionalContext,
		).toStartWith("health check could not run on ");
	};

	test("a run directory redirected into the repository gets no fallback line", () => {
		const g = new Fixture();
		try {
			const launcher = g.ownPackage();
			g.prepare(g.input());
			const inner = join(g.repo, "inner");
			renameSync(g.runDir, inner);
			symlinkSync(inner, g.runDir);
			closed(wrapper(g, "guard", commit, noBun));
			renameSync(launcher, `${launcher}-gone`);
			asContext(wrapper(g, "health", edited(g)));
			const stop = wrapper(g, "stop", { session_id: "s1" });
			expect(stop.code).toBe(0);
			expect(stop.stdout).toBe("");
			expect(existsSync(join(inner, "hooks.log"))).toBe(false);
		} finally {
			g.cleanup();
		}
	});

	test("a moved repository behind a symlink gets no fallback line", () => {
		const g = new Fixture();
		try {
			g.prepare(g.input());
			const moved = join(g.root, "repo2");
			renameSync(g.repo, moved);
			symlinkSync(moved, g.repo);
			const inner = join(moved, "inner");
			renameSync(g.runDir, inner);
			symlinkSync(inner, g.runDir);
			closed(wrapper(g, "guard", commit, noBun));
			asContext(wrapper(g, "health", edited(g), noBun));
			closed(g.hook("guard", commit, noBun));
			asContext(g.hook("health", edited(g), noBun));
			expect(existsSync(join(inner, "hooks.log"))).toBe(false);
		} finally {
			g.cleanup();
		}
	});

	test("a malformed manifest that keeps its repo line gets no fallback line", () => {
		const g = new Fixture();
		try {
			g.prepare(g.input());
			writeFileSync(g.manifest, `${readFileSync(g.manifest, "utf8")}{\n`);
			closed(wrapper(g, "guard", commit, noBun));
			asContext(wrapper(g, "health", edited(g), noBun));
			closed(g.hook("guard", commit, noBun));
			asContext(g.hook("health", edited(g), noBun));
			expect(existsSync(g.log)).toBe(false);
		} finally {
			g.cleanup();
		}
	});

	test("a launcher path holding a newline still writes one record per fallback", () => {
		const g = new Fixture();
		try {
			const launcher = g.ownPackage("pk\ng%");
			g.prepare(g.input());
			renameSync(launcher, `${launcher}-gone`);
			asContext(wrapper(g, "health", edited(g)));
			expect(wrapper(g, "stop", { session_id: "s1" }).code).toBe(0);
			const lines = readFileSync(g.log, "utf8").split("\n").filter(Boolean);
			expect(lines).toHaveLength(2);
			for (const line of lines) {
				expect(line).toMatch(
					/^\d\d:\d\d:\d\d (health|stop) launcher - 0ms COULD-NOT-RUN the launcher \S+ is missing or not executable$/,
				);
				expect(line).toContain("pk%0Ag%25/software");
			}
		} finally {
			g.cleanup();
		}
	});

	test("a run directory whose name ends in a newline still gets its fallback line", () => {
		const g = new Fixture();
		try {
			const launcher = g.ownPackage();
			g.runDir = join(g.root, "run\n");
			g.prepare(g.input());
			renameSync(launcher, `${launcher}-gone`);
			asContext(wrapper(g, "health", edited(g)));
			expect(g.logLines()).toHaveLength(1);
			expect(g.logLines()[0]).toContain(
				" health launcher - 0ms COULD-NOT-RUN ",
			);
		} finally {
			g.cleanup();
		}
	});

	// The launcher's own fallback, as it runs: executable, its builder-hooks.d
	// moved, so its reason holds the launcher path. Its record must match
	// log.ts's encoding of the same reason in any locale.
	test.each([
		["pk%\n\tg", "C"],
		["pk%\n\tg", "en_US.UTF-8"],
		["pk\u0085g", "C"],
		["pk\u0085g", "en_US.UTF-8"],
	])(
		"the launcher's own fallback for %j under %s is one record encoded as log.ts encodes",
		(dir, locale) => {
			const g = new Fixture();
			try {
				const launcher = g.ownPackage(dir);
				g.prepare(g.input());
				renameSync(`${launcher}.d`, `${launcher}.d-gone`);
				const env = { LC_ALL: locale };
				closed(wrapper(g, "guard", commit, env));
				const health = wrapper(g, "health", edited(g), env);
				expect(health.code).toBe(0);
				const why = `cannot find builder-hooks.d beside ${launcher}`;
				expect(JSON.parse(health.stdout)).toEqual({
					hookSpecificOutput: {
						hookEventName: "PostToolUse",
						additionalContext: `health check could not run on ${join(g.repo, "README.md")}: ${why}`,
					},
				});
				const lines = readFileSync(g.log, "utf8").split("\n").filter(Boolean);
				expect(lines.map((l) => l.replace(/^\d\d:\d\d:\d\d /, ""))).toEqual(
					["guard", "health"].map(
						(mode) =>
							`${mode} launcher - 0ms COULD-NOT-RUN ${encode(why, false)}`,
					),
				);
			} finally {
				g.cleanup();
			}
		},
	);

	test("the launcher keeps a trailing newline in the run directory it resolves", () => {
		const g = new Fixture();
		try {
			g.runDir = join(g.root, "run\n");
			g.prepare(g.input());
			asContext(wrapper(g, "health", edited(g), noBun));
			expect(g.logLines()).toHaveLength(1);
			expect(g.logLines()[0]).toContain(
				" health launcher - 0ms COULD-NOT-RUN bun is not on PATH",
			);
		} finally {
			g.cleanup();
		}
	});

	test("an absent manifest leaves no log and still answers closed or as context", () => {
		const g = new Fixture();
		try {
			g.prepare(g.input());
			rmSync(g.manifest);
			closed(wrapper(g, "guard", commit));
			asContext(wrapper(g, "health", edited(g)));
			expect(existsSync(g.log)).toBe(false);
		} finally {
			g.cleanup();
		}
	});
});

describe("BH-6: history classification", () => {
	const denied = [
		"git commit -m x",
		"git push origin main",
		"git merge feature",
		"git rebase main",
		"git tag v1",
		"git reset --hard HEAD~1",
		"git cherry-pick abc",
		"git stash drop",
		`git branch ${DASH}D old`,
		`git checkout ${DASH}B feature`,
		`git switch ${DASH}C feature`,
		`git branch ${DASH}f main HEAD`,
		`git branch ${DASH}m old new`,
		"git update-ref refs/heads/x HEAD",
		"git am patch.mbox",
		`git clean ${DASH}fd`,
		"git revert HEAD",
		"git pull origin main",
		"git stash clear",
		`git branch ${DASH}d old`,
		"git reflog expire --all",
		`git gc ${DASH}${DASH}prune=now`,
	];
	test.each(denied)("denies %s", (command) => {
		expect(denial(bash(command))).toEqual({
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: HISTORY,
		});
	});

	test.each([
		"FOO=1 BAR=2 git commit",
		`env ${DASH}i A=1 git commit`,
		"command git commit",
		"exec git push",
		"builtin git commit",
		`time ${DASH}p git commit`,
		"nohup git push",
		`nice ${DASH}n 5 git commit`,
		`sudo ${DASH}u me git commit`,
		`xargs ${DASH}I {} git tag {}`,
		"ls; git commit",
		"ls && git commit",
		"ls || git commit",
		"ls | git commit",
		"ls & git commit",
		"ls\ngit commit",
		"(git commit)",
		"{ git commit; }",
		"echo $(git commit)",
		"echo `git push`",
		'echo "$(git commit)"',
		"cat <(git push)",
		"/usr/bin/git commit",
		"./bin/git commit",
		"\\git commit",
		"g'i't commit",
		`git ${DASH}C sub ${DASH}c user.name=x commit`,
		`git ${DASH}${DASH}git-dir=.git ${DASH}${DASH}work-tree . commit`,
		`git ${DASH}p ${DASH}${DASH}no-pager ${DASH}${DASH}namespace n commit`,
		"git 2>/dev/null commit",
		`command git commit ${DASH}v`,
		`command git push ${DASH}v`,
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell parameter expansion
		"echo ${x:-$(git commit)}",
		"echo $(( $(git commit) + 1 ))",
		`git ${DASH}${DASH}exec-path=/tmp commit`,
		"timeout 5 git commit -m x",
		`timeout ${DASH}s KILL ${DASH}${DASH}preserve-status 5 git push`,
		`caffeinate ${DASH}i git push`,
		`find . ${DASH}exec git commit \\;`,
		`find . ${DASH}execdir git push {} +`,
		`echo "\${x:-'$(git commit)'}"`,
		`find . ${DASH}name '${DASH}exec' ${DASH}o ${DASH}exec git commit \\;`,
		`find . ${DASH}ok git commit \\;`,
		`find . ${DASH}okdir git push \\;`,
		`echo \${x:${DASH}"'$(git commit)'"}`,
		`echo \${x:${DASH}"it's $(git commit) now's"}`,
		`echo \${x:${DASH}"\${y:${DASH}"'$(git commit)'"}"}`,
		`echo \${x:${DASH}"\${y:${DASH}"it's $(git commit) now's"}"}`,
	])("denies through wrappers, separators and substitutions: %s", (command) => {
		expect(denial(bash(command))?.permissionDecision).toBe("deny");
	});

	test.each([
		'echo "git commit"',
		"echo git commit",
		"git status",
		"git diff HEAD",
		"git log --oneline",
		"git add -A",
		"git add app/x.rb",
		"git stash",
		"git stash push -m wip",
		"git stash list",
		`find . ${DASH}name '${DASH}exec' ${DASH}print`,
		"git gc",
		"git reflog",
		`git branch ${DASH}${DASH}list`,
		`git checkout ${DASH}b new`,
		"grep commit file",
		"cat > notes.md <<'EOF'\nthen git push origin main\nit's fine\nEOF\nls",
		"cat <<-EOF\n\tgit commit\n\tEOF",
		`command ${DASH}v git`,
		`command ${DASH}V git`,
		`echo "it's \${x}"`,
		`echo "\${x:${DASH}it's}"`,
		`echo \${x:${DASH}"it's"}`,
	])("allows %s", (command) => {
		const r = bash(command);
		expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
	});

	test.each([
		["git commit 'unclosed", "an unclosed single quote"],
		["echo $(git commit", "an unclosed $( or ("],
		["cat <<EOF\ngit push\n", "an unterminated heredoc"],
		["$GIT commit", "a command name it cannot read"],
		['RUN="git commit"; $RUN', "a command name it cannot read"],
		['"$PWD/bin/tool" status', "a command name it cannot read"],
		[
			`git ${DASH}${DASH}frobnicate commit`,
			`an option git takes that it cannot read: ${DASH}${DASH}frobnicate`,
		],
		["git $SUB", "an unreadable option to git"],
		[
			`find . ${DASH}newerXY x ${DASH}exec git commit \\;`,
			`a find primary it cannot read: ${DASH}newerXY`,
		],
	])("refuses what it cannot classify: %s", (command, why) => {
		expect(bash(command)).toEqual({
			code: 2,
			stdout: "",
			stderr: cannot(`the command holds ${why}`),
		});
	});

	test.each([
		["explicit", { history_writes: true }],
		["default", {}],
	])("%s history authority allows history writes", (_, extra) => {
		const g = new Fixture();
		try {
			g.prepare(g.input(extra));
			const r = g.hook("guard", {
				tool_name: "Bash",
				tool_input: { command: "git commit -m x" },
			});
			expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
		} finally {
			g.cleanup();
		}
	});

	test("the accepted gap: a nested shell string is not interpreted", () => {
		expect(bash("sh -c 'git commit -m x'")).toEqual({
			code: 0,
			stdout: "",
			stderr: "",
		});
	});
});

describe("BH-7: excluded edits", () => {
	test.each(["Edit", "Write", "MultiEdit", "NotebookEdit"])(
		"%s of an excluded path is denied with the exact reason",
		(tool) => {
			expect(denial(edit(tool, "config/deploy.yml"))).toEqual({
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: excludedReason("config/deploy.yml"),
			});
		},
	);

	test("literal, directory, glob, case variants and missing suffixes match", () => {
		for (const path of [
			join(f.repo, "config/deploy.yml"),
			"config/./deploy.yml",
			"app/../config/deploy.yml",
			"CONFIG/Deploy.YML",
			"lib/admin/base.rb",
			"lib/admin/new/deeper.rb",
			"app/models/secret_keys.rb",
			"db/schema.rb",
		])
			expect({
				path,
				d: denial(edit("Write", path))?.permissionDecision,
			}).toEqual({ path, d: "deny" });
	});

	test("symlinks into excluded targets and outside-repo aliases are denied", () => {
		symlinkSync(join(f.repo, "config"), join(f.repo, "cfg"));
		symlinkSync(
			join(f.repo, "config/deploy.yml"),
			join(f.root, "outside-link.yml"),
		);
		symlinkSync(f.repo, join(f.root, "repo-alias"));
		for (const path of [
			"cfg/deploy.yml",
			join(f.root, "outside-link.yml"),
			join(f.root, "repo-alias/lib/admin/x.rb"),
		])
			expect({
				path,
				d: denial(edit("Edit", path))?.permissionDecision,
			}).toEqual({ path, d: "deny" });
	});

	test("the reason names the path relative to the repository", () => {
		const g = new Fixture();
		try {
			g.write("config/secrets.yml", "x\n");
			g.commit("Secrets");
			symlinkSync(join(g.repo, "config"), join(g.repo, "cfg"));
			g.prepare(g.input({ excluded: ["config/secrets.yml"] }));
			for (const path of [
				join(g.repo, "config/secrets.yml"),
				"config/secrets.yml",
				"cfg/secrets.yml",
			]) {
				const r = g.hook("guard", {
					tool_name: "Write",
					tool_input: { file_path: path },
				});
				expect({ path, reason: denial(r)?.permissionDecisionReason }).toEqual({
					path,
					reason: excludedReason("config/secrets.yml"),
				});
			}
		} finally {
			g.cleanup();
		}
	});

	test("resolution walks segments, resolving a symlink before collapsing ..", () => {
		const g = new Fixture();
		try {
			mkdirSync(join(g.repo, "protected/sub"), { recursive: true });
			symlinkSync(join(g.repo, "protected/sub"), join(g.repo, "alias"));
			g.prepare(g.input({ excluded: ["protected/"] }));
			const r = g.hook("guard", {
				tool_name: "Write",
				tool_input: { file_path: "alias/../secret.rb" },
			});
			expect(denial(r)?.permissionDecisionReason).toBe(
				excludedReason("protected/secret.rb"),
			);
		} finally {
			g.cleanup();
		}
	});

	test("a glob exclusion's static prefix is resolved and the rest matched under it", () => {
		const g = new Fixture();
		try {
			const outside = join(g.root, "outside");
			mkdirSync(outside);
			mkdirSync(join(g.repo, "config"));
			symlinkSync(outside, join(g.repo, "linked"));
			symlinkSync(join(g.repo, "config"), join(g.repo, "alias"));
			g.prepare(g.input({ excluded: ["linked/*.rb", "alias/*.rb"] }));
			for (const path of [join(outside, "a.rb"), "config/x.rb"]) {
				const r = g.hook("guard", {
					tool_name: "Write",
					tool_input: { file_path: path },
				});
				expect({ path, d: denial(r)?.permissionDecision }).toEqual({
					path,
					d: "deny",
				});
			}
		} finally {
			g.cleanup();
		}
	});

	test("unexcluded paths, inside and outside the repo, are allowed silently", () => {
		for (const path of [
			"app/models/user.rb",
			"config/other.yml",
			"lib/administrator.rb",
			join(f.root, "elsewhere.txt"),
		])
			expect({ path, r: edit("Write", path) }).toEqual({
				path,
				r: { code: 0, stdout: "", stderr: "" },
			});
	});

	test("the run directory is a fixed guard rule, not an excluded entry", () => {
		const manifest = JSON.parse(readFileSync(f.manifest, "utf8"));
		expect(manifest.excluded).not.toContain(f.runDir);
		for (const path of [
			join(f.runDir, "stop-s1"),
			f.manifest,
			join(f.runDir, "builder-hooks.settings.json"),
		])
			expect(denial(edit("Write", path))?.permissionDecisionReason).toBe(
				excludedReason(path),
			);
	});

	test("the lexical gap: a Bash write to an excluded path passes the guard and shows in the excluded diff", () => {
		expect(bash("printf x > config/deploy.yml")).toEqual({
			code: 0,
			stdout: "",
			stderr: "",
		});
		writeFileSync(join(f.repo, "config/deploy.yml"), "changed by bash\n");
		const r = f.run(["recheck", "--manifest", f.manifest, "--json"]);
		expect(JSON.parse(r.stdout).result.excluded).toEqual(["config/deploy.yml"]);
		f.git("checkout", "--", "config/deploy.yml");
	});

	test("every decision is logged ALLOW or DENY with its session", () => {
		const lines = f.logLines();
		expect(
			lines.some((l) =>
				/ guard Write config\/deploy.yml \d+ms DENY excluded by config\/deploy.yml session=s1$/.test(
					l,
				),
			),
		).toBe(true);
		expect(
			lines.some((l) =>
				/ guard Bash bash \d+ms ALLOW no history write session=s1$/.test(l),
			),
		).toBe(true);
	});

	test("a DENY line names its rule and match", () => {
		bash("git commit -m x");
		expect(f.logLines().at(-1)).toMatch(
			/ guard Bash bash \d+ms DENY history write git commit session=s1$/,
		);
	});
});
