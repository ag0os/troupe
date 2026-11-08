#!/usr/bin/env bun
/** O28 and O27: installed-binary previews, fake launches, lifecycle and modules. */
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { installFakeClis, readRecords } from "../lib/agent-format/fake-cli";
import { packageText } from "../lib/shepherd/test-support";
import {
	buildWorkspaces,
	isolatedEnv,
	type Ran,
	repoRoot,
	run,
	scratchDir,
} from "./extraction-continuity";
import {
	assertEqual,
	bundledVersions,
	copyArtifact,
	proofArgs,
	sameObservation,
	saveRun,
} from "./extraction-proof";

export async function proveHarness(
	args: Record<string, string>,
): Promise<void> {
	const shipped = resolve(args.shipped ?? "");
	const candidate = resolve(args.candidate ?? "");
	const parent = scratchDir("shepherd-harness");
	const evidence = resolve(args.evidence ?? join(parent, "evidence"));
	mkdirSync(evidence, { recursive: true });
	const install = join(parent, "install");
	mkdirSync(join(install, "bin"), { recursive: true });
	copyArtifact(
		resolve(dirname(candidate), "../packages"),
		join(install, "packages"),
	);
	const binary = join(install, "bin/shepherd");
	function put(path: string): void {
		copyFileSync(path, binary);
		chmodSync(binary, 0o755);
	}
	const fakes = join(parent, "fakes");
	mkdirSync(fakes);
	installFakeClis(fakes);
	const shims = join(parent, "environment-shims");
	mkdirSync(shims);
	const environmentRecord = join(parent, "child-environment");
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	for (const backend of ["claude", "codex"]) {
		const path = join(shims, backend);
		writeFileSync(
			path,
			`#!/bin/sh\n/usr/bin/env -0 > "$PROOF_ENV_RECORD"\nexec ${quote(join(fakes, backend))} "$@"\n`,
		);
		chmodSync(path, 0o755);
	}
	function childEnvironment(name: string): Record<string, string> {
		const raw = readFileSync(environmentRecord);
		writeFileSync(join(evidence, `${name}.environment`), raw);
		const entries = raw
			.toString()
			.split("\0")
			.filter(Boolean)
			.map((entry) => {
				const at = entry.indexOf("=");
				if (at < 1) throw new Error(`Invalid environment entry: ${entry}`);
				return [entry.slice(0, at), entry.slice(at + 1)] as const;
			});
		const parsed = Object.fromEntries(
			entries.sort(([a], [b]) => a.localeCompare(b)),
		);
		writeFileSync(
			join(evidence, `${name}.environment.json`),
			JSON.stringify(parsed, null, 2),
		);
		return parsed;
	}
	function compareEnvironment(
		a: Record<string, string>,
		b: Record<string, string>,
		backend: string,
		name: string,
	): void {
		// Only Claude's fresh resource path is excepted; the raw values remain in evidence.
		const left = { ...a };
		const right = { ...b };
		if (backend === "claude") {
			delete left.TMPDIR;
			delete right.TMPDIR;
		}
		assertEqual(left, right, `${name} complete child environment`);
	}
	const env = isolatedEnv(parent, {
		PATH: `${join(install, "bin")}:${shims}:${fakes}:${process.env.PATH}`,
		PROOF_ENV_RECORD: environmentRecord,
	});
	const workspaces = buildWorkspaces(
		join(repoRoot(), "agents/__fixtures__/shepherd/workspaces.json"),
		join(parent, "fixtures"),
	);
	const outcomes: Record<string, unknown>[] = [];
	for (const [name, cwd] of workspaces)
		for (const backend of ["claude", "codex"]) {
			const argv = [
				"--backend",
				backend,
				"--show-prompt",
				"triage",
				"my",
				"morning",
			];
			put(shipped);
			const a = run([binary, ...argv], cwd, env);
			put(candidate);
			const b = run([binary, ...argv], cwd, env);
			saveRun(evidence, `preview-${name}-${backend}-shipped`, a);
			saveRun(evidence, `preview-${name}-${backend}-candidate`, b);
			if (!sameObservation(a, b) || a.code !== 0)
				throw new Error(`preview ${name} ${backend} differs`);
			outcomes.push({
				name,
				backend,
				kind: "preview",
				equal: true,
				exit: a.code,
			});
		}
	const cwd = workspaces.get("plain") ?? "";
	const codexHome = join(parent, "codex-home");
	mkdirSync(codexHome);
	mkdirSync(join(env.XDG_CONFIG_HOME ?? "", "shepherd"), { recursive: true });
	writeFileSync(
		join(env.XDG_CONFIG_HOME ?? "", "shepherd/config.json"),
		JSON.stringify({
			codex: { home: codexHome, model: "gpt-proof", effort: "high" },
		}),
	);
	const record = join(parent, "launch.jsonl");
	const cases = [
		{
			name: "claude-naming-allow",
			argv: ["--backend", "claude", "--name", "proof-session", "triage"],
		},
		{
			name: "claude-print",
			argv: ["--backend", "claude", "--print", "triage"],
		},
		{
			name: "claude-stream",
			argv: [
				"--backend",
				"claude",
				"--print",
				"triage",
				"--",
				"--output-format",
				"stream-json",
				"--verbose",
			],
		},
		{
			name: "claude-resume",
			argv: ["--backend", "claude", "triage", "--", "--resume", "proof-thread"],
		},
		{ name: "codex-defaults-home", argv: ["--backend", "codex", "triage"] },
		{ name: "codex-print", argv: ["--backend", "codex", "--print", "triage"] },
		{
			name: "codex-stream",
			argv: ["--backend", "codex", "--print", "triage", "--", "--json"],
		},
		{
			name: "codex-resume",
			argv: ["--backend", "codex", "triage", "--", "resume", "proof-thread"],
		},
	];
	for (const scenario of cases) {
		const runs: Ran[] = [];
		const launched: ReturnType<typeof readRecords> = [];
		const environments: Record<string, string>[] = [];
		for (const [label, path] of [
			["shipped", shipped],
			["candidate", candidate],
		] as const) {
			put(path);
			rmSync(record, { force: true });
			rmSync(environmentRecord, { force: true });
			const result = run([binary, ...scenario.argv], cwd, {
				...env,
				FAKE_RECORD: record,
			});
			saveRun(evidence, `${scenario.name}-${label}`, result);
			runs.push(result);
			const records = readRecords(record);
			assertEqual(records.length, 1, `${scenario.name} backend launches`);
			const r = records[0];
			if (!r) throw new Error("no fake record");
			writeFileSync(
				join(evidence, `${scenario.name}-${label}-launch.json`),
				JSON.stringify(r, null, 2),
			);
			if (r.tmpdir && r.name === "claude" && existsSync(r.tmpdir))
				throw new Error(
					`${scenario.name} temporary resource leaked: ${r.tmpdir}`,
				);
			launched.push(r);
			environments.push(childEnvironment(`${scenario.name}-${label}`));
		}
		if (
			!sameObservation(runs[0] as Ran, runs[1] as Ran) ||
			(runs[0] as Ran).code !== 0
		)
			throw new Error(`${scenario.name} raw output differs`);
		compareEnvironment(
			environments[0] ?? {},
			environments[1] ?? {},
			scenario.name.startsWith("claude") ? "claude" : "codex",
			scenario.name,
		);
		const a = launched[0];
		const b = launched[1];
		if (!a || !b) throw new Error("missing records");
		// All launch argv and the complete child environment are compared exactly. Freshly allocated
		// TMPDIR values are retained verbatim and checked for scope and cleanup separately.
		assertEqual(
			{
				argv: a.argv,
				cwd: a.cwd,
				troupe: a.troupeEnv,
				project: a.claudeProjectDir,
				home: a.codexHome,
			},
			{
				argv: b.argv,
				cwd: b.cwd,
				troupe: b.troupeEnv,
				project: b.claudeProjectDir,
				home: b.codexHome,
			},
			`${scenario.name} launch`,
		);
		if (scenario.name === "claude-naming-allow") {
			if (!a.argv.includes("proof-session"))
				throw new Error("Claude session name absent");
			const settings = JSON.parse(
				a.argv[a.argv.indexOf("--settings") + 1] ?? "{}",
			);
			if (!settings.permissions?.allow?.includes("Read(.shepherd/**)"))
				throw new Error("Claude allow rules absent");
		}
		if (
			scenario.name === "codex-defaults-home" &&
			(!a.argv.includes("gpt-proof") || a.codexHome !== codexHome)
		)
			throw new Error("Codex defaults/home absent");
		if (scenario.name === "codex-resume" && a.argv.includes("gpt-proof"))
			throw new Error("Codex resume lost conversation defaults");
		outcomes.push({
			name: scenario.name,
			kind: "launch",
			argvEqual: true,
			environmentContractEqual: true,
			completeEnvironmentEqual: true,
			rawOutputEqual: true,
			resourcePaths: { shipped: a.tmpdir, candidate: b.tmpdir },
			cleanup: true,
		});
	}
	for (const backend of ["claude", "codex"])
		for (const signal of ["SIGINT", "SIGTERM"] as const) {
			const runs: Ran[] = [];
			const environments: Record<string, string>[] = [];
			for (const [label, path] of [
				["shipped", shipped],
				["candidate", candidate],
			] as const) {
				put(path);
				rmSync(record, { force: true });
				rmSync(environmentRecord, { force: true });
				const pidFile = join(parent, "fake.pid");
				rmSync(pidFile, { force: true });
				const child = Bun.spawn(
					[binary, "--backend", backend, "--print", "triage"],
					{
						cwd,
						env: {
							...env,
							FAKE_RECORD: record,
							FAKE_PID_FILE: pidFile,
							FAKE_SCENARIO: "hang",
						},
						stdout: "pipe",
						stderr: "pipe",
						stdin: "ignore",
					},
				);
				const started = Date.now();
				while (!existsSync(record) || !existsSync(pidFile)) {
					if (Date.now() - started > 10000) {
						child.kill("SIGKILL");
						throw new Error("fake backend never ready");
					}
					await Bun.sleep(10);
				}
				child.kill(signal);
				let timedOut = false;
				const timer = setTimeout(() => {
					timedOut = true;
					child.kill("SIGKILL");
				}, 10000);
				const code = await child.exited;
				clearTimeout(timer);
				if (timedOut) throw new Error("runner failed signal bound");

				const result = {
					argv: [binary, "--backend", backend, "--print", "triage"],
					cwd,
					code,
					stdout: await new Response(child.stdout).text(),
					stderr: await new Response(child.stderr).text(),
				};
				saveRun(evidence, `${backend}-${signal}-${label}`, result);
				runs.push(result);
				environments.push(childEnvironment(`${backend}-${signal}-${label}`));
				const r = readRecords(record)[0];
				writeFileSync(
					join(evidence, `${backend}-${signal}-${label}-launch.json`),
					JSON.stringify(r, null, 2),
				);
				if (r?.tmpdir && backend === "claude" && existsSync(r.tmpdir))
					throw new Error("signal leaked TMPDIR");
				const pid = Number(readFileSync(pidFile, "utf8"));
				let alive = false;
				try {
					process.kill(pid, 0);
					alive = true;
				} catch {}
				if (alive) throw new Error(`backend ${pid} survived ${signal}`);
			}
			compareEnvironment(
				environments[0] ?? {},
				environments[1] ?? {},
				backend,
				`${backend} ${signal}`,
			);
			if (!sameObservation(runs[0] as Ran, runs[1] as Ran))
				throw new Error(`signal ${backend} ${signal} differs`);
			assertEqual(
				(runs[0] as Ran).code,
				signal === "SIGINT" ? 130 : 143,
				`${backend} ${signal} exit`,
			);
			outcomes.push({
				kind: "signal",
				backend,
				signal,
				equal: true,
				cleanup: true,
				completeEnvironmentEqual: true,
			});
		}
	// Through the compiled installation, exercise inherited/local/builtin selection,
	// adjacent package tools/guides, providers, conflicts and invalid packages.
	put(candidate);
	const modules = join(parent, "modules");
	const ws = join(modules, "workspace");
	function write(path: string, text: string, mode?: number): void {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
		if (mode) chmodSync(path, mode);
	}
	const offers =
		"tools:\n  list:\n    description: List notes\n    access: read\nguides:\n  howto:\n    description: Read notes\n";
	function pkg(dir: string, text: string): void {
		write(join(dir, "MODULE.md"), text);
		write(
			join(dir, "tools/list"),
			"#!/bin/sh\nprintf 'package tool ran\\n'\n",
			0o755,
		);
		write(join(dir, "guides/howto.md"), "# Proof guide\n");
	}
	pkg(join(install, "packages/notes"), packageText("notes", offers));
	pkg(join(modules, ".shepherd/packages/mail"), packageText("mail", offers));
	write(join(modules, ".shepherd/charter.md"), "Modules: mail\n");
	write(
		join(ws, ".shepherd/integrations/local.md"),
		"---\nname: local\ntype: domain\ndescription: Local proof\nbudget: 100\napplies-when:\n  charter-declares: local\n---\nLOCAL PROOF BODY\n",
	);
	const provider = (name: string, isDefault = false) =>
		`---\nname: ${name}\ntype: domain\ndescription: Provider proof\nprovides: inbox\n${isDefault ? "default: true\n" : ""}applies-when:\n  charter-declares: inbox\nbudget: 400\ncharter-keys: {}\ncontract: 1\n${offers}---\nPROVIDER ${name}\n`;
	pkg(join(install, "packages/hey"), provider("hey", true));
	pkg(join(install, "packages/gmail"), provider("gmail"));
	pkg(
		join(install, "packages/broken"),
		packageText("broken", offers, undefined, "contract: 2\n"),
	);
	const moduleEnv = { ...env, SHEPHERD_WORKSPACE: ws };
	for (const scenario of [
		{
			name: "selected",
			tokens: "software notes mail local inbox",
			present: [
				"LOCAL PROOF BODY",
				"PROVIDER hey",
				"notes package body.",
				"mail package body.",
			],
			absent: ["PROVIDER gmail"],
			tools: ["notes", "mail", "hey"],
		},
		{
			name: "conflict",
			tokens: "hey gmail",
			present: ["module-slot-conflict"],
			absent: ["PROVIDER hey", "PROVIDER gmail"],
			tools: [],
		},
		{
			name: "invalid",
			tokens: "broken notes",
			present: ["package-contract", "notes package body."],
			absent: ["broken package body."],
			tools: ["notes"],
		},
	]) {
		write(join(ws, ".shepherd/charter.md"), `Modules: ${scenario.tokens}\n`);
		const preview = run(
			[binary, "--backend", "claude", "--show-prompt", "triage"],
			ws,
			moduleEnv,
		);
		saveRun(evidence, `modules-${scenario.name}`, preview);
		if (preview.code !== 0)
			throw new Error(`module preview failed: ${preview.stderr}`);
		const text = preview.stdout + preview.stderr;
		for (const expected of scenario.present)
			if (!text.includes(expected))
				throw new Error(`${scenario.name}: missing ${expected}`);
		for (const excluded of scenario.absent)
			if (text.includes(excluded))
				throw new Error(`${scenario.name}: selected ${excluded}`);
		for (const name of ["notes", "mail", "hey", "gmail", "broken"]) {
			const tool = run([binary, "tool", name, "list"], ws, moduleEnv);
			saveRun(evidence, `modules-${scenario.name}-${name}-tool`, tool);
			const guide = run(
				[binary, "tool", "guide", name, "howto"],
				ws,
				moduleEnv,
			);
			saveRun(evidence, `modules-${scenario.name}-${name}-guide`, guide);
			const selected = scenario.tools.includes(name);
			if ((tool.code === 0) !== selected || (guide.code === 0) !== selected)
				throw new Error(
					`${scenario.name}: tool/guide selection differs for ${name}`,
				);
		}
		if (scenario.name === "selected") {
			for (const argv of [
				["tool", "guide", "software", "build"],
				["tool", "software", "contract", "--help"],
				["tool", "software", "publish-check", "--help"],
			]) {
				const result = run([binary, ...argv], ws, moduleEnv);
				saveRun(evidence, `software-${argv[1]}-${argv[2]}`, result);
				if (result.code !== 0 || result.stdout.length === 0)
					throw new Error(`adjacent software asset failed: ${argv.join(" ")}`);
			}
			if (
				!text.includes("software publish-check") ||
				!text.includes("software build")
			)
				throw new Error(
					"software tools/guides absent from the compiled prompt",
				);
		}

		outcomes.push({ kind: "modules", name: scenario.name, equal: true });
	}
	writeFileSync(
		join(evidence, "harness.json"),
		JSON.stringify(
			{
				bun: Bun.version,
				parent,
				shipped,
				candidate,
				outcomes,
				bundled: {
					shipped: bundledVersions(shipped),
					candidate: bundledVersions(candidate),
				},
				resourceLimit:
					"Fresh Claude TMPDIR names differ and are retained, scoped and cleaned; stable launch argv and the complete child environment compare exactly except Claude TMPDIR. Backend passthrough stream output is compared in print mode; Shepherd's declaration has no stream-mode switch.",
			},
			null,
			2,
		),
	);
	console.log(`PASS harness and modules ${parent}`);
}
if (import.meta.main) {
	try {
		await proveHarness(proofArgs(process.argv.slice(2)));
	} catch (error) {
		console.error(error);
		process.exit(1);
	}
}
