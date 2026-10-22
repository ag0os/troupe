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
import { dirname, join } from "node:path";
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
// The refusal for a command the guard cannot read: an expansion where it
// needs a literal, or syntax it cannot place.
const expansion = (what: string) =>
	`Role guard could not read this command: ${what} holds an expansion. Spell the command name and git options literally and run it again; this is not a hooks failure.\n`;
const unplain = (why: string) =>
	`Role guard could not read this command: it holds ${why}. Write it plainly and run it again; this is not a hooks failure.\n`;
const CHECKED = { BUILDER_HOOKS_LOG_CHECKED: "1" };
// Code points, so this file holds no dash for publish-check to find.
const DASH = String.fromCodePoint(0x2d);

let f: Fixture;
beforeAll(() => {
	f = new Fixture();
	f.write("config/deploy.yml", "x\n");
	f.write("app/models/user.rb", "x\n");
	f.write("lib/admin/base.rb", "x\n");
	f.write("src/deploy.yml", "x\n");
	f.write("protected/x", "x\n");
	f.write("vendor/v.rb", "x\n");
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
					"protected/",
					"123",
					"notes.bak",
					"a%b.yml",
					"notes~",
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

	test("the guard wrapper logs when the launcher is gone (B13)", () => {
		const g = new Fixture();
		try {
			const launcher = g.ownPackage();
			g.prepare(g.input());
			renameSync(launcher, `${launcher}-gone`);
			closed(wrapper(g, "guard", commit));
			expect(g.logLines().at(-1)).toMatch(
				/^\d\d:\d\d:\d\d guard launcher - 0ms COULD-NOT-RUN the launcher \S+ is missing or not executable$/,
			);
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

	test.each<[string, string, string]>([
		["git commit 'unclosed", "an unclosed single quote", ""],
		["echo $(git commit", "an unclosed $( or (", ""],
		["cat <<EOF\ngit push\n", "an unterminated heredoc", ""],
		["$GIT commit", "a command name it cannot read", "the command name"],
		[
			'RUN="git commit"; $RUN',
			"a command name it cannot read",
			"the command name",
		],
		[
			'"$PWD/bin/tool" status',
			"a command name it cannot read",
			"the command name",
		],
		[
			`git ${DASH}${DASH}frobnicate commit`,
			`an option git takes that it cannot read: ${DASH}${DASH}frobnicate`,

			"",
		],
		["git $SUB", "an unreadable option to git", "an option to git"],
		[
			`find . ${DASH}newerXY x ${DASH}exec git commit \\;`,
			`a find primary it cannot read: ${DASH}newerXY`,

			"",
		],
	])("refuses what it cannot classify: %s", (command, why, what) => {
		expect(bash(command)).toEqual({
			code: 2,
			stdout: "",
			stderr: what ? expansion(what) : unplain(why),
		});
		expect(f.logLines().at(-1)).toEndWith(
			` COULD-NOT-RUN the command holds ${encode(why, false)}`,
		);
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

	test("the lexical gap: a nested shell's write to an excluded path passes the guard and shows in the excluded diff", () => {
		expect(bash("sh -c 'printf x > config/deploy.yml'")).toEqual({
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

describe("BH-18: shell writes to excluded paths", () => {
	test.each([
		["cat > config/deploy.yml", "config/deploy.yml"],
		["printf x >> config/deploy.yml", "config/deploy.yml"],
		["echo x >| config/deploy.yml", "config/deploy.yml"],
		["echo x &> config/deploy.yml", "config/deploy.yml"],
		["echo x &>> config/deploy.yml", "config/deploy.yml"],
		["echo x 2>config/deploy.yml", "config/deploy.yml"],
		["echo x >& config/deploy.yml", "config/deploy.yml"],
		["cat <> config/deploy.yml", "config/deploy.yml"],
		["echo x | tee config/deploy.yml", "config/deploy.yml"],
		["echo x | tee -a /dev/null config/deploy.yml", "config/deploy.yml"],
		["sed -i '' s/a/b/ config/deploy.yml", "config/deploy.yml"],
		["sed -i.bak s/a/b/ config/deploy.yml", "config/deploy.yml"],
		["sed --in-place -e s/a/b/ config/deploy.yml", "config/deploy.yml"],
		["cp /tmp/x config/deploy.yml", "config/deploy.yml"],
		["cp -t lib/admin /tmp/x", "lib/admin"],
		["cp --target-directory=lib/admin /tmp/x", "lib/admin"],
		["mv config/deploy.yml /tmp/x", "config/deploy.yml"],
		["mv /tmp/x lib/admin/base.rb", "lib/admin/base.rb"],
		["rm -f config/deploy.yml", "config/deploy.yml"],
		["rm -rf lib/admin", "lib/admin"],
		["rmdir lib/admin", "lib/admin"],
		["install -m 644 /tmp/x db/schema.rb", "db/schema.rb"],
		["ln -sf /tmp/x config/deploy.yml", "config/deploy.yml"],
		["touch lib/admin/new.rb", "lib/admin/new.rb"],
		["truncate -s 0 db/schema.rb", "db/schema.rb"],
		["touch app/models/secret_key.rb", "app/models/secret_key.rb"],
		["env A=1 timeout 5 tee config/deploy.yml", "config/deploy.yml"],
		["echo $(cat /tmp/x > config/deploy.yml)", "config/deploy.yml"],
		["(cd /tmp; echo x) > config/deploy.yml", "config/deploy.yml"],
		["echo x > ./CONFIG/Deploy.yml", "config/deploy.yml"],
		["echo x > 'config/deploy.yml'", "config/deploy.yml"],
	])("denies %s", (command, path) => {
		expect(denial(bash(command))).toEqual({
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: excludedReason(path),
		});
	});

	test("an absolute target and the run directory are denied", () => {
		expect(
			denial(bash(`echo x > ${f.repo}/config/deploy.yml`))
				?.permissionDecisionReason,
		).toBe(excludedReason("config/deploy.yml"));
		const counter = join(f.runDir, "stop-s1");
		expect(denial(bash(`rm -f '${counter}'`))?.permissionDecisionReason).toBe(
			excludedReason(counter),
		);
	});

	test("a target resolves a symlink before collapsing ..", () => {
		const g = new Fixture();
		try {
			g.write("a/b/keep", "x\n");
			g.write("a/config/deploy.yml", "x\n");
			symlinkSync(join(g.repo, "a/b"), join(g.repo, "link"));
			g.prepare(g.input({ excluded: ["a/config/deploy.yml"] }));
			const r = g.hook("guard", {
				session_id: "s1",
				tool_name: "Bash",
				tool_input: { command: "echo x > link/../config/deploy.yml" },
			});
			expect(denial(r)?.permissionDecisionReason).toBe(
				excludedReason("a/config/deploy.yml"),
			);
		} finally {
			g.cleanup();
		}
	});

	test("a relative target resolves against the event's cwd", () => {
		const r = f.hook("guard", {
			session_id: "s1",
			cwd: join(f.repo, "config"),
			tool_name: "Bash",
			tool_input: { command: "echo x > deploy.yml" },
		});
		expect(denial(r)?.permissionDecisionReason).toBe(
			excludedReason("config/deploy.yml"),
		);
	});

	test.each([
		"cat config/deploy.yml > /tmp/x",
		"cp config/deploy.yml /tmp/copy",
		"sed -n p config/deploy.yml",
		"cat < config/deploy.yml",
		"echo x > app/models/user.rb",
		"echo x 2>&1",
		"echo x >&2",
		"echo x > /dev/null",
		'echo x > "$TMPDIR/config/deploy.yml"',
		"echo x > ~/config/deploy.yml",
		"echo rm config/deploy.yml",
	])("allows %s", (command) => {
		expect(bash(command)).toEqual({ code: 0, stdout: "", stderr: "" });
	});

	test("history authority does not lift the exclusions; an unreadable command is refused", () => {
		const g = new Fixture();
		try {
			g.prepare(
				g.input({ history_writes: true, excluded: ["config/deploy.yml"] }),
			);
			const run = (command: string) =>
				g.hook("guard", {
					session_id: "s1",
					tool_name: "Bash",
					tool_input: { command },
				});
			expect(denial(run("git commit -m x && cat > config/deploy.yml"))).toEqual(
				{
					hookEventName: "PreToolUse",
					permissionDecision: "deny",
					permissionDecisionReason: excludedReason("config/deploy.yml"),
				},
			);
			expect(run("git commit -m x")).toEqual({
				code: 0,
				stdout: "",
				stderr: "",
			});
			expect(run("$GIT commit")).toEqual({
				code: 2,
				stdout: "",
				stderr: expansion("the command name"),
			});
		} finally {
			g.cleanup();
		}
	});

	test("with history and push authority and no exclusions an unreadable command passes unread, as before", () => {
		const g = new Fixture();
		try {
			g.prepare(g.input({ push_writes: true }));
			expect(
				g.hook("guard", {
					session_id: "s1",
					tool_name: "Bash",
					tool_input: { command: "$GIT commit" },
				}),
			).toEqual({ code: 0, stdout: "", stderr: "" });
			expect(g.logLines().at(-1)).toMatch(
				/ guard Bash bash \d+ms ALLOW history authority; command not read session=s1$/,
			);
		} finally {
			g.cleanup();
		}
	});

	test("the log names a shell write's rule, and an allowed write is not health-checked", () => {
		bash("cat > config/deploy.yml");
		expect(f.logLines().at(-1)).toMatch(
			/ guard Bash bash \d+ms DENY shell write config\/deploy.yml excluded by config\/deploy.yml session=s1$/,
		);
		bash("echo x > app/models/user.rb");
		expect(f.logLines().at(-1)).toMatch(
			/ guard Bash bash \d+ms ALLOW no history write; shell writes not excluded, not health-checked session=s1$/,
		);
		bash("ls");
		expect(f.logLines().at(-1)).toMatch(
			/ guard Bash bash \d+ms ALLOW no history write session=s1$/,
		);
	});
});

describe("BH-19: pushes stay with the host", () => {
	const PUSH =
		"Role guard: pushes and pull requests stay with the host in this run. Commit on your branch; the host pushes after recheck.";
	const run = (g: Fixture, command: string) =>
		g.hook("guard", {
			session_id: "s1",
			tool_name: "Bash",
			tool_input: { command },
		});

	test("history authority commits but does not push unless push_writes is true", () => {
		const g = new Fixture();
		try {
			g.prepare(g.input());
			expect(run(g, "git commit -m x").stdout).toBe("");
			for (const command of [
				"git push origin main",
				"git commit -m x && git -C . push",
			])
				expect(denial(run(g, command))).toEqual({
					hookEventName: "PreToolUse",
					permissionDecision: "deny",
					permissionDecisionReason: PUSH,
				});
			expect(g.logLines().at(-1)).toMatch(
				/ guard Bash bash \d+ms DENY push git push session=s1$/,
			);
		} finally {
			g.cleanup();
		}
	});

	test("with push_writes false an unreadable command is refused, nothing excluded", () => {
		const g = new Fixture();
		try {
			g.prepare(g.input());
			expect(run(g, "$GIT push")).toEqual({
				code: 2,
				stdout: "",
				stderr: expansion("the command name"),
			});
		} finally {
			g.cleanup();
		}
	});

	test("push_writes true allows the push; history off still denies it", () => {
		const g = new Fixture();
		try {
			g.prepare(g.input({ push_writes: true }));
			expect(run(g, "git push origin main")).toEqual({
				code: 0,
				stdout: "",
				stderr: "",
			});
		} finally {
			g.cleanup();
		}
		expect(denial(bash("git push origin main"))?.permissionDecisionReason).toBe(
			HISTORY,
		);
	});
});

describe("BH-18: shell writes, fix round 1", () => {
	const reason = (command: string) =>
		denial(bash(command))?.permissionDecisionReason;

	test.each([
		// B1: a destination directory takes the source's basename.
		["cp src/deploy.yml config/", "config/deploy.yml"],
		["cp src/deploy.yml config", "config/deploy.yml"],
		["mv src/deploy.yml config/", "config/deploy.yml"],
		["install src/deploy.yml config/", "config/deploy.yml"],
		["ln -sf src/deploy.yml config/", "config/deploy.yml"],
		["cp -t config src/deploy.yml", "config/deploy.yml"],
		["cp --target-directory=config src/deploy.yml", "config/deploy.yml"],
		["cp --target-directory config src/deploy.yml", "config/deploy.yml"],
		// B1: an operand holding an exclusion.
		["rm -rf config", "config/deploy.yml"],
		["rm -r ./config/", "config/deploy.yml"],
		["mv config /tmp/x", "config/deploy.yml"],
		["cp -r src/. config/", "config/deploy.yml"],
		["rmdir lib", "lib/admin"],
		// B2: sed -E is a flag.
		["sed -E -i '' s/a/b/ config/deploy.yml", "config/deploy.yml"],
		["sed -E -i.bak s/a/b/ config/deploy.yml", "config/deploy.yml"],
		["sed -nEi s/a/b/ config/deploy.yml", "config/deploy.yml"],
		// B5: a wrapper's directory applies to relative targets.
		["env -C protected touch x", "protected/x"],
		["env --chdir=protected touch x", "protected/x"],
		["env --chdir protected touch x", "protected/x"],
		["sudo -D protected touch x", "protected/x"],
		["env -C src mv deploy.yml ../config/", "config/deploy.yml"],
		// B6: attached option values.
		["cp -tprotected file", "protected"],
		["mv -tprotected file", "protected"],
		["install -tprotected file", "protected"],
		["ln -stprotected src", "protected"],
		["command timeout 5 cp -rtprotected src", "protected"],
		// B10: a number is a file except after >& or <&.
		["echo x > 123", "123"],
		["echo x >> 123", "123"],
		// B11: backup suffixes are writes.
		["sed -i.bak s/a/b/ notes", "notes.bak"],
		["sed --in-place=.bak s/a/b/ notes", "notes.bak"],
		["sed -i .bak s/a/b/ notes", "notes.bak"],
		["mv -S .bak /tmp/x notes", "notes.bak"],
		["cp --suffix=.bak /tmp/x notes", "notes.bak"],
		["cp -b -S .bak /tmp/x notes", "notes.bak"],
		// B15: unlink writes.
		["unlink config/deploy.yml", "config/deploy.yml"],
		// B16: install -d and sed -I.
		["install -d lib/admin/new /tmp/y", "lib/admin/new"],
		["sed -I .bak s/a/b/ config/deploy.yml", "config/deploy.yml"],
		// O5: find -exec targets are read.
		["find . -exec touch protected/x \\;", "protected/x"],
		["find . -name x -exec rm -rf protected \\;", "protected"],
	])("denies %s", (command, path) => {
		expect(reason(command)).toBe(excludedReason(path));
	});

	test("removing a parent of the run directory is denied with its path", () => {
		const parent = dirname(f.runDir);
		expect(reason(`rm -rf '${parent}'`)).toBe(excludedReason(f.runDir));
	});

	test.each([
		"echo x 2>&1",
		"echo x >&2",
		"echo x 3>&-",
		"touch --reference config/deploy.yml app/a.rb",
		"truncate --reference config/deploy.yml -s0 app/a.rb",
		"touch -r config/deploy.yml app/a.rb",
		"touch --date 2020-01-01 app/a.rb",
		"cp config/deploy.yml /tmp/copy",
		"rm -rf tmp/cache",
		"cp -r config /tmp/conf",
		"install -m 644 -o root /tmp/x app/a.rb",
		"find tmp -name '*.tmp' -exec rm {} \\;",
	])("allows %s", (command) => {
		expect(bash(command)).toEqual({ code: 0, stdout: "", stderr: "" });
	});

	test("the log says which shell writes it did not read (B8)", () => {
		for (const command of [
			"cd config && echo x > deploy.yml",
			"pushd config; echo x > deploy.yml",
			'echo x > "$TMPDIR/x"',
			"echo x > ~/x",
			"touch config/$F",
		]) {
			bash(command);
			expect(f.logLines().at(-1)).toMatch(
				/ guard Bash bash \d+ms ALLOW no history write; shell writes not read, not health-checked session=s1$/,
			);
		}
		bash("echo x > app/a.rb");
		expect(f.logLines().at(-1)).toMatch(
			/ ALLOW no history write; shell writes not excluded, not health-checked session=s1$/,
		);
		bash("cd app");
		expect(f.logLines().at(-1)).toMatch(/ ALLOW no history write session=s1$/);
	});

	test("a DENY reason holding % is encoded, and the run directory's line is named (B16)", () => {
		bash("echo x > a%b.yml");
		expect(f.logLines().at(-1)).toMatch(
			/ DENY shell write a%25b.yml excluded by a%25b.yml session=s1$/,
		);
		const counter = join(f.runDir, "stop-s1");
		bash(`rm -f '${counter}'`);
		expect(f.logLines().at(-1)).toEndWith(
			` DENY shell write ${counter} in the run directory session=s1`,
		);
		bash("rm -rf config");
		expect(f.logLines().at(-1)).toMatch(
			/ DENY shell write config contains config\/deploy.yml session=s1$/,
		);
	});

	test("a known target is checked before an unreadable remainder is decided (B4)", () => {
		const g = new Fixture();
		try {
			g.prepare(g.input({ history_writes: true, push_writes: true }));
			const manifest = join(g.runDir, "builder-manifest.json");
			const r = g.hook("guard", {
				session_id: "s1",
				tool_name: "Bash",
				tool_input: { command: `echo x > '${manifest}'; $CMD` },
			});
			expect(denial(r)?.permissionDecisionReason).toBe(
				excludedReason(manifest),
			);
		} finally {
			g.cleanup();
		}
	});

	test("both grants with exclusions still refuse an unreadable command (B16)", () => {
		const g = new Fixture();
		try {
			g.prepare(
				g.input({
					history_writes: true,
					push_writes: true,
					excluded: ["config/deploy.yml"],
				}),
			);
			expect(
				g.hook("guard", {
					session_id: "s1",
					tool_name: "Bash",
					tool_input: { command: "$GIT commit" },
				}),
			).toEqual({ code: 2, stdout: "", stderr: expansion("the command name") });
		} finally {
			g.cleanup();
		}
	});
});

describe("BH-19: pushes, fix round 1", () => {
	const PUSH =
		"Role guard: pushes and pull requests stay with the host in this run. Commit on your branch; the host pushes after recheck.";
	let g: Fixture;
	beforeAll(() => {
		g = new Fixture();
		g.prepare(g.input({ history_writes: true }));
	});
	afterAll(() => g.cleanup());
	const run = (command: string) =>
		g.hook("guard", {
			session_id: "s1",
			tool_name: "Bash",
			tool_input: { command },
		});

	test.each([
		"find . -exec git commit \\; -exec git push \\;",
		"find . -exec git commit {} + -exec git push {} +",
		"git-push origin main",
		"/usr/libexec/git-core/git-push origin main",
		"git send-pack origin HEAD:refs/heads/main",
		"git subtree push --prefix=lib origin main",
		"git -c alias.p=push p origin main",
		"git -c alias.p='push --force' p",
	])("denies %s", (command) => {
		expect(denial(run(command))?.permissionDecisionReason).toBe(PUSH);
	});

	test.each([
		'git checkout "$BRANCH"',
		'git branch "$B"',
		'git switch "$B"',
		'git gc "$X"',
		"git -c alias.s=status s",
		"git subtree split --prefix=lib",
	])("allows %s", (command) => {
		expect(run(command)).toEqual({ code: 0, stdout: "", stderr: "" });
	});

	test("a shell alias in the line is refused", () => {
		expect(run("git -c 'alias.p=!git push' p").code).toBe(2);
	});

	test("history off reads dashed git and the new pushes as history writes (B14, B15)", () => {
		for (const command of [
			"git-commit -m x",
			"git send-pack origin main",
			"git subtree push --prefix=lib origin main",
			"git -c alias.ci=commit ci -m x",
		])
			expect(denial(bash(command))?.permissionDecisionReason).toBe(HISTORY);
	});
});

describe("fix round 2", () => {
	// Built from a code point: Biome rewrites a backslash escape before ;.
	const BS = String.fromCodePoint(0x5c);
	const PUSH =
		"Role guard: pushes and pull requests stay with the host in this run. Commit on your branch; the host pushes after recheck.";
	let g: Fixture;
	beforeAll(() => {
		g = new Fixture();
		g.prepare(g.input({ history_writes: true }));
	});
	afterAll(() => g.cleanup());
	const pushRun = (command: string) =>
		g.hook("guard", {
			session_id: "s1",
			tool_name: "Bash",
			tool_input: { command },
		});
	const reason = (command: string) =>
		denial(bash(command))?.permissionDecisionReason;
	const lastLine = (command: string) => {
		bash(command);
		return f.logLines().at(-1);
	};

	// M1: aliases and configuration the line defines.
	test.each([
		"git -c alias.p=push -c alias.q=p q origin main",
		"git -c alias.P=push P origin main",
		"git -c ALIAS.p=push p origin main",
	])("denies the push %s", (command) => {
		expect(denial(pushRun(command))?.permissionDecisionReason).toBe(PUSH);
	});

	test.each([
		"X=push git --config-env=alias.p=X p origin main",
		"git --config-env alias.p=X p",
		`GIT_CONFIG_PARAMETERS="'alias.p=push'" git p origin main`,
		"GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p",
		"export GIT_CONFIG_PARAMETERS=x; git p",
		"env GIT_CONFIG_COUNT=1 git p",
		"git -c alias.p=p p",
	])("refuses %s", (command) => {
		const r = pushRun(command);
		expect(r.code).toBe(2);
		expect(r.stderr).toStartWith("Role guard could not read this command: ");
	});

	test("history off reads a chained alias as the commit it is", () => {
		expect(reason("git -c alias.a=commit -c alias.b=a b -m x")).toBe(HISTORY);
	});

	// M2: find's {} and -delete touch everything under its paths.
	test.each([
		[`find config -name deploy.yml -exec rm {} ${BS};`, "config/deploy.yml"],
		[
			`find src config -name x -exec cp src/deploy.yml {} ${BS};`,
			"config/deploy.yml",
		],
		[`find . -name deploy.yml -execdir rm {} +`, "config/deploy.yml"],
		["find config -name deploy.yml -delete", "config/deploy.yml"],
		["find -name deploy.yml -delete", "config/deploy.yml"],
	])("denies %s", (command, path) => {
		expect(reason(command)).toBe(excludedReason(path));
	});

	test.each([
		`find tmp -name '*.tmp' -exec rm {} ${BS};`,
		"find tmp -name x -delete",
		"find . -name '*.rb'",
	])("allows %s", (command) => {
		expect(bash(command)).toEqual({ code: 0, stdout: "", stderr: "" });
	});

	test.each([
		`find src -name deploy.yml -exec cp {} app/ ${BS};`,
		"echo src/deploy.yml | xargs -I{} cp {} app/",
		"echo app/a.rb | xargs rm -f",
		"xargs -a list cp -t app",
		"echo x > app/{a,b}.rb",
		"touch app/a.{rb,txt}",
	])("logs %s as not read", (command) => {
		expect(lastLine(command)).toMatch(
			/ ALLOW no history write; shell writes not read, not health-checked session=s1$/,
		);
	});

	// M3: a link names an excluded file's content by another path.
	test.each([
		["ln config/deploy.yml x && echo y > x", "config/deploy.yml"],
		["ln -s config/deploy.yml x && echo y > x", "config/deploy.yml"],
		["ln -s config z && echo y > z/deploy.yml", "config/deploy.yml"],
		["ln -sf ../config/deploy.yml app/d.yml", "config/deploy.yml"],
	])("denies %s", (command, path) => {
		expect(reason(command)).toBe(excludedReason(path));
	});

	// L4: into a directory holding an exclusion, only its named entry counts.
	test.each([
		"ln -s /etc/hosts config/",
		"ln -s src/deploy.yml lib/",
		"cp -r vendor config/",
	])("allows %s", (command) => {
		expect(bash(command)).toEqual({ code: 0, stdout: "", stderr: "" });
	});

	test.each([
		["cp -R src/ config", "config/deploy.yml"],
		["cp -r src/. config/", "config/deploy.yml"],
		["cp -a src/.. config", "config/deploy.yml"],
	])("still denies %s", (command, path) => {
		expect(reason(command)).toBe(excludedReason(path));
	});

	// L1: a glob in the last segment is expanded against the directory.
	test.each([
		["rm -rf config/*", "config/deploy.yml"],
		["rm -rf config/deploy.y*", "config/deploy.yml"],
		["echo x > config/dep*", "config/deploy.yml"],
	])("denies the glob %s", (command, path) => {
		expect(reason(command)).toBe(excludedReason(path));
	});

	test("rm -rf * from the repository is denied; find . with {} too", () => {
		expect(reason("rm -rf *")).toStartWith("Role guard: ");
		expect(reason(`find . -name x -exec rm {} ${BS};`)).toStartWith(
			"Role guard: ",
		);
		expect(bash("cp -r src config/").code).toBe(0);
	});

	test("a glob that matches nothing excluded is read; a deeper glob is not", () => {
		expect(lastLine("rm -f app/models/*.tmp")).toMatch(
			/ ALLOW no history write; shell writes not excluded, not health-checked session=s1$/,
		);
		expect(lastLine("touch */deploy.yml")).toMatch(
			/ ALLOW no history write; shell writes not read, not health-checked session=s1$/,
		);
	});

	// Pins (the review's item 4).
	test("a ** exclusion holds every directory below its prefix", () => {
		expect(reason("rm -rf app/models/x")).toBe(
			excludedReason("app/**/secret_*.rb"),
		);
	});

	test("a wrapper directory holding an expansion leaves its targets unread", () => {
		expect(lastLine('env -C "$D" touch x')).toMatch(
			/ ALLOW no history write; shell writes not read, not health-checked session=s1$/,
		);
	});

	test("-b backs up to <target>~", () => {
		expect(reason("cp -b /tmp/x notes")).toBe(excludedReason("notes~"));
	});

	// L6, L7.
	test.each(["find . -newermt 2020-01-01 -name x", "find . -depth 2 -name x"])(
		"reads the find primary in %s",
		(command) => {
			expect(bash(command)).toEqual({ code: 0, stdout: "", stderr: "" });
		},
	);

	test("a cd after the write leaves it read", () => {
		expect(lastLine("echo x > app/a.rb && cd config")).toMatch(
			/ ALLOW no history write; shell writes not excluded, not health-checked session=s1$/,
		);
	});
});

describe("fix round 3", () => {
	const BS = String.fromCodePoint(0x5c);
	const PUSH =
		"Role guard: pushes and pull requests stay with the host in this run. Commit on your branch; the host pushes after recheck.";
	let g: Fixture;
	beforeAll(() => {
		g = new Fixture();
		g.write(".env", "x\n");
		for (let i = 0; i < 64; i++) g.write(`bulk64/x${i}.tmp`, "x\n");
		for (let i = 0; i < 65; i++) g.write(`bulk65/x${i}.tmp`, "x\n");
		for (let i = 0; i < 5001; i++) g.write(`bulk5001/x${i}`, "");
		g.prepare(g.input({ history_writes: true, excluded: [".env"] }));
	});
	afterAll(() => g.cleanup());
	const run = (command: string) =>
		g.hook("guard", {
			session_id: "s1",
			tool_name: "Bash",
			tool_input: { command },
		});
	const reason = (command: string) =>
		denial(bash(command))?.permissionDecisionReason;
	const lastLine = (command: string) => {
		bash(command);
		return f.logLines().at(-1);
	};
	const chain = (n: number) =>
		`git ${Array.from({ length: n }, (_, k) => `-c alias.a${k}=${k === n - 1 ? "push" : `a${k + 1}`}`).join(" ")} a0 origin main`;

	// 1: an alias never overrides a built-in.
	test.each([
		"git -c alias.p=push -c alias.push=status p origin main",
		"git -c alias.push=status push origin main",
	])("denies the push %s", (command) => {
		expect(denial(run(command))?.permissionDecisionReason).toBe(PUSH);
	});

	// 2: a body git would unquote is refused.
	test.each([
		`git -c 'alias.p="push"' p origin main`,
		`git -c 'alias.p=${BS}push' p origin main`,
	])("refuses %s", (command) => {
		expect(run(command).code).toBe(2);
	});

	// 9: the five-hop boundary.
	test("five aliases are followed; a sixth is refused", () => {
		expect(denial(run(chain(5)))?.permissionDecisionReason).toBe(PUSH);
		expect(run(chain(6)).code).toBe(2);
	});

	// 3: an existing directory destination without a slash.
	test("ln -s into an existing directory resolves the source from it", () => {
		expect(reason("ln -s ../config/deploy.yml app")).toBe(
			excludedReason("config/deploy.yml"),
		);
	});

	// 4: quoting reaches the glob decision.
	test.each([
		["touch 'protected/new*'", "protected/new*"],
		['touch "protected/a?"', "protected/a?"],
		["touch protected/new*", "protected/new*"],
	])("denies %s as a literal", (command, path) => {
		expect(reason(command)).toBe(excludedReason(path));
	});

	test("a quoted glob is a literal path, read", () => {
		expect(lastLine("touch 'config/dep*'")).toMatch(
			/ ALLOW no history write; shell writes not excluded, not health-checked session=s1$/,
		);
	});

	test("a character class is not read", () => {
		expect(lastLine("rm -f app/[[:alpha:]]*.rb")).toMatch(
			/ ALLOW no history write; shell writes not read, not health-checked session=s1$/,
		);
	});

	// 5 and 9: the cap is a refusal; the dotfile rule.
	test("a glob over 64 entries is refused; 64 are read", () => {
		expect(run("rm -f bulk64/*.tmp").code).toBe(0);
		const r = run("rm -f bulk65/*.tmp");
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("a glob over more than 64 entries");
	});

	test("a glob over a directory of more than 5000 entries is refused", () => {
		const r = run("rm -f bulk5001/y*");
		expect(r.code).toBe(2);
		expect(r.stderr).toContain(
			"a glob over a directory of more than 5000 entries",
		);
	});

	test("a glob matches a dotfile only when it starts with a dot", () => {
		expect(run("rm -f *")).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(denial(run("rm -f .e*"))?.permissionDecisionReason).toBe(
			excludedReason(".env"),
		);
	});

	// 6: find's -execdir, wrapper directory, -L and -files0-from.
	test.each([
		[
			`find config -name deploy.yml -execdir rm deploy.yml ${BS};`,
			"config/deploy.yml",
		],
		["env -C config find . -name deploy.yml -delete", "config/deploy.yml"],
	])("denies %s", (command, path) => {
		expect(reason(command)).toBe(excludedReason(path));
	});

	test("a wrapper directory applies to find's roots", () => {
		expect(bash("env -C src find . -name x -delete").code).toBe(0);
		expect(denial(bash("env -C src find . -name x -delete"))).toBeNull();
	});

	test.each([
		"find -L tmp -name x -delete",
		"find tmp -files0-from list -delete",
	])("logs %s as not read", (command) => {
		expect(lastLine(command)).toMatch(
			/ ALLOW no history write; shell writes not read, not health-checked session=s1$/,
		);
	});

	// 7: cp --link and -l protect their source as ln does.
	test.each([
		"cp --link config/deploy.yml x",
		"cp -l config/deploy.yml x",
		"cp -s config/deploy.yml x",
	])("denies %s", (command) => {
		expect(reason(command)).toBe(excludedReason("config/deploy.yml"));
	});

	// 8: the over-denials.
	test("a matched regular file holds nothing", () => {
		f.write("app/models/old.tmp", "x\n");
		expect(bash("rm -f app/models/*.tmp")).toEqual({
			code: 0,
			stdout: "",
			stderr: "",
		});
		expect(bash("rm -f app/models/user.rb").code).toBe(0);
	});

	test.each(["echo GIT_CONFIG_COUNT=1", "printf '%s' GIT_CONFIG_PARAMETERS=x"])(
		"allows %s",
		(command) => {
			expect(bash(command)).toEqual({ code: 0, stdout: "", stderr: "" });
		},
	);

	test("GIT_CONFIG_* is still refused as an assignment, under env and export", () => {
		for (const command of [
			"GIT_CONFIG_COUNT=1 git p",
			"env GIT_CONFIG_COUNT=1 git p",
			"export GIT_CONFIG_PARAMETERS=x; git p",
		])
			expect(run(command).code).toBe(2);
	});
});

describe("fix round 4", () => {
	const BS = String.fromCodePoint(0x5c);
	const reason = (command: string) =>
		denial(bash(command))?.permissionDecisionReason;

	// 1: -execdir keeps the writer's own operands beside find's roots.
	test.each([
		(repo: string) =>
			`find src -name deploy.yml -execdir cp {} ${repo}/config/deploy.yml ${BS};`,
		() =>
			`find src -name deploy.yml -execdir cp {} ../config/deploy.yml ${BS};`,
	])("-execdir denies an excluded destination (%#)", (command) => {
		expect(reason(command(f.repo))).toBe(excludedReason("config/deploy.yml"));
	});

	test("-execdir still makes find's roots trees", () => {
		expect(reason(`find config -name deploy.yml -execdir cp {} x ${BS};`)).toBe(
			excludedReason("config/deploy.yml"),
		);
	});

	test("-execdir reads a relative operand; one climbing with .. is not read", () => {
		bash(`find src -name x -execdir touch y ${BS};`);
		expect(f.logLines().at(-1)).toMatch(
			/ ALLOW no history write; shell writes not excluded, not health-checked session=s1$/,
		);
		bash(`find src -name x -execdir touch ../../y ${BS};`);
		expect(f.logLines().at(-1)).toMatch(
			/ ALLOW no history write; shell writes not read, not health-checked session=s1$/,
		);
	});

	// 2: install -l links as ln does.
	test.each([
		"install -l h config/deploy.yml out",
		"install -lh config/deploy.yml out",
		"install -l s config/deploy.yml out",
	])("denies %s", (command) => {
		expect(reason(command)).toBe(excludedReason("config/deploy.yml"));
	});

	test("install without -l does not protect its source", () => {
		expect(denial(bash("install config/deploy.yml out"))).toBeNull();
	});

	// 3: a directory of exactly 5000 entries is read.
	test("a glob over a directory of exactly 5000 entries is read", () => {
		const g = new Fixture();
		try {
			for (let i = 0; i < 5000; i++) g.write(`bulk5000/x${i}`, "");
			g.prepare(g.input({ history_writes: true, excluded: [".env"] }));
			expect(
				g.hook("guard", {
					session_id: "s1",
					tool_name: "Bash",
					tool_input: { command: "rm -f bulk5000/y*" },
				}),
			).toEqual({ code: 0, stdout: "", stderr: "" });
		} finally {
			g.cleanup();
		}
	});
});

describe("fix round 5", () => {
	// The reason spells what the exclusion matched as the manifest does,
	// whether or not the host's filesystem folds case.
	let g: Fixture;
	beforeAll(() => {
		g = new Fixture();
		g.write("config/deploy.yml", "x\n");
		g.prepare(
			g.input({
				history_writes: true,
				excluded: ["Config/Deploy.yml", "Secrets/", "App/**/Key_*.rb"],
			}),
		);
	});
	afterAll(() => g.cleanup());
	const reason = (input: Record<string, unknown>) => {
		const r = g.hook("guard", { session_id: "s1", ...input });
		return denial(r)?.permissionDecisionReason;
	};

	test.each([
		["echo x > config/deploy.yml", "Config/Deploy.yml"],
		["echo x > ./CONFIG/DEPLOY.YML", "Config/Deploy.yml"],
		["touch secrets/a/B.txt", "Secrets/a/B.txt"],
		["touch app/models/KEY_x.rb", "App/models/KEY_x.rb"],
	])("names %s as %s", (command, path) => {
		expect(reason({ tool_name: "Bash", tool_input: { command } })).toBe(
			excludedReason(path),
		);
	});

	test("an edit is named the same way", () => {
		expect(
			reason({
				tool_name: "Write",
				tool_input: { file_path: join(g.repo, "config/deploy.yml") },
			}),
		).toBe(excludedReason("Config/Deploy.yml"));
	});
});
