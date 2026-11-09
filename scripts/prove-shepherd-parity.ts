#!/usr/bin/env bun
/** O29: exact observations on an authorized, read-only workspace snapshot. */
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	linkSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { installFakeClis } from "../lib/agent-format/fake-cli";
import {
	isolatedEnv,
	type Ran,
	repoRoot,
	scratchDir,
} from "./extraction-continuity";
import {
	assertEqual,
	assertOutside,
	copyArtifact,
	proofArgs,
	sameObservation,
	saveRun,
	treeManifest,
} from "./extraction-proof";

export async function observe(
	argv: string[],
	cwd: string,
	env: Record<string, string>,
): Promise<Ran> {
	const child = Bun.spawn(argv, {
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { argv, cwd, code, stdout, stderr };
}

function records(state: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const path of ["CURRENT.md", "journal.md", "checkpoint.json"]) {
		if (existsSync(join(state, path)))
			result[path] = readFileSync(join(state, path)).toString("base64");
	}
	if (existsSync(join(state, "checkpoints")))
		for (const file of readdirSync(join(state, "checkpoints"), {
			withFileTypes: true,
		})) {
			if (file.isFile())
				result[`checkpoints/${file.name}`] = readFileSync(
					join(state, "checkpoints", file.name),
				).toString("base64");
		}
	return result;
}

export function displayedSecond(
	name: string,
	result: Ran,
	state?: Record<string, string>,
): string | undefined {
	if (name === "start")
		return /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[^\n]*)$/m.exec(result.stdout)?.[1];
	if (state?.["checkpoint.json"])
		return JSON.parse(
			Buffer.from(state["checkpoint.json"], "base64").toString(),
		).written;
	return undefined;
}

export function createPairing(options: {
	state: string;
	snapshot: string;
	originalManifest: string[];
	shipped: string;
	candidate: string;
	binary: string;
	workspace: string;
	env: Record<string, string>;
	evidence: string;
	put: (from: string) => void;
	observe: typeof observe;
	pairs: Record<string, unknown>[];
	align?: (alignmentMs: number) => Promise<void>;
}) {
	const {
		state,
		snapshot,
		originalManifest,
		shipped,
		candidate,
		binary,
		workspace,
		env,
		evidence,
		put,
		observe,
		pairs,
	} = options;
	const align =
		options.align ??
		(async (alignmentMs: number) => {
			await Bun.sleep((1000 - (Date.now() % 1000) + alignmentMs) % 1000);
		});
	function restoreRecords(): void {
		for (const path of [
			"CURRENT.md",
			"journal.md",
			"checkpoint.json",
			"checkpoints",
		]) {
			rmSync(join(state, path), { recursive: true, force: true });
			if (existsSync(join(snapshot, path)))
				cpSync(join(snapshot, path), join(state, path), {
					recursive: true,
					preserveTimestamps: true,
				});
		}
		assertEqual(
			treeManifest(state),
			originalManifest,
			"restored entire workspace state",
		);
	}

	async function pair(
		name: string,
		argv: string[],
		applies = false,
	): Promise<Ran> {
		for (let retry = 0; retry < 30; retry++) {
			if (applies) restoreRecords();
			else
				assertEqual(
					treeManifest(state),
					originalManifest,
					"workspace state before pair",
				);
			put(shipped);
			const warmA = await observe([binary, "--version"], workspace, env);
			if (warmA.code !== 0) throw new Error("shipped prewarm failed");
			// Align after restoring, outside the observed command interval.
			const alignmentMs = (15 + retry * 137) % 1000;
			await align(alignmentMs);
			const start = Date.now();
			const a = await observe([binary, ...argv], workspace, env);
			const aEnd = Date.now();
			put(candidate);
			// Version reads no workspace state. Warm the swapped executable while
			// verifying/restoring state, before the candidate's observed command.
			const warmBPending = observe([binary, "--version"], workspace, env);
			const aRecords = applies ? records(state) : undefined;
			const aManifest = applies ? treeManifest(state) : undefined;
			if (applies) restoreRecords();
			else
				assertEqual(
					treeManifest(state),
					originalManifest,
					"read-only command preserved entire workspace state",
				);
			const warmB = await warmBPending;
			if (warmB.code !== 0) throw new Error("candidate prewarm failed");
			const bStart = Date.now();
			const b = await observe([binary, ...argv], workspace, env);
			const end = Date.now();
			if (!applies)
				assertEqual(
					treeManifest(state),
					originalManifest,
					"candidate read-only command preserved entire workspace state",
				);
			saveRun(evidence, `${name}-${retry}-warm-shipped`, warmA);
			saveRun(evidence, `${name}-${retry}-warm-candidate`, warmB);
			saveRun(evidence, `${name}-${retry}-shipped`, a);
			saveRun(evidence, `${name}-${retry}-candidate`, b);
			const bRecords = applies ? records(state) : undefined;
			const aClock = displayedSecond(name, a, aRecords);
			const bClock = displayedSecond(name, b, bRecords);
			if ((name === "start" || applies) && (!aClock || !bClock))
				throw new Error(`${name}: missing displayed clock`);
			const straddled = aClock !== bClock;
			if (applies) {
				writeFileSync(
					join(evidence, `${name}-${retry}-shipped-records.json`),
					JSON.stringify(aRecords, null, 2),
				);
				writeFileSync(
					join(evidence, `${name}-${retry}-candidate-records.json`),
					JSON.stringify(bRecords, null, 2),
				);
			}
			pairs.push({
				name,
				retry,
				alignmentMs,
				argv,
				start,
				aEnd,
				bStart,
				end,
				shippedExit: a.code,
				candidateExit: b.code,
				straddled,
				displayedShipped: aClock ?? null,
				displayedCandidate: bClock ?? null,
				wallIntervalStraddled:
					Math.floor(start / 1000) !== Math.floor(end / 1000),
				stdoutEqual: a.stdout === b.stdout,
				stderrEqual: a.stderr === b.stderr,
			});
			writeFileSync(
				join(evidence, "pairs.json"),
				`${JSON.stringify(pairs, null, 2)}\n`,
			);
			if (straddled) {
				console.log(`discard ${name} retry ${retry}: clock boundary`);
				continue;
			}
			if (!sameObservation(a, b))
				throw new Error(
					`PARITY DIFFERENCE ${name}\nshipped stdout:\n${a.stdout}\nshipped stderr:\n${a.stderr}\ncandidate stdout:\n${b.stdout}\ncandidate stderr:\n${b.stderr}`,
				);
			if (applies) {
				assertEqual(bRecords, aRecords, `${name} resulting record bytes`);
				assertEqual(
					treeManifest(state),
					aManifest,
					`${name} entire resulting state`,
				);
				writeFileSync(
					join(evidence, `${name}-records.json`),
					`${JSON.stringify(aRecords, null, 2)}\n`,
				);
				if (a.code !== 0)
					throw new Error(
						`Checkpoint application did not succeed: ${a.stdout}${a.stderr}`,
					);
			}
			console.log(
				`identical ${name}: exits ${a.code}/${b.code}, retries ${retry}`,
			);
			return a;
		}
		throw new Error(`${name}: exhausted 30 clock retries; acceptance unmet`);
	}

	return pair;
}

export async function proveParity(args: Record<string, string>): Promise<void> {
	const source = realpathSync(args["workspace-source"] ?? "");
	const shipped = realpathSync(args.shipped ?? "");
	const candidate = realpathSync(args.candidate ?? "");
	const parent = scratchDir("shepherd-parity");
	assertOutside(parent, repoRoot());
	const evidence = resolve(args.evidence ?? join(parent, "evidence"));
	mkdirSync(evidence, { recursive: true });
	const snapshot = join(parent, "snapshot");
	// Reject external links without following or reading their targets.
	const originalManifest = treeManifest(join(source, ".shepherd"));
	const links = originalManifest.filter((line) => line.includes(" link "));
	if (links.length)
		throw new Error(
			`Workspace snapshot contains links; authorize a copying policy first: ${links.join("\n")}`,
		);
	cpSync(join(source, ".shepherd"), snapshot, {
		recursive: true,
		preserveTimestamps: true,
	});
	assertEqual(treeManifest(snapshot), originalManifest, "workspace snapshot");
	const workspace = join(parent, "workspace");
	mkdirSync(workspace);
	const state = join(workspace, ".shepherd");
	const install = join(parent, "install");
	mkdirSync(join(install, "bin"), { recursive: true });
	const packages = copyArtifact(
		resolve(dirname(candidate), "../packages"),
		join(install, "packages"),
	);
	const binary = join(install, "bin/shepherd");
	const fakes = join(parent, "fakes");
	mkdirSync(fakes);
	installFakeClis(fakes);
	const env = isolatedEnv(parent, {
		PATH: `${join(install, "bin")}:${fakes}:${process.env.PATH}`,
		SHEPHERD_WORKSPACE: workspace,
		HERDR_ENV: "0",
	});
	function restore(): void {
		rmSync(state, { recursive: true, force: true });
		cpSync(snapshot, state, { recursive: true, preserveTimestamps: true });
	}
	const parked = new Map<string, string>();
	let active: string | undefined;
	for (const [name, path] of [
		["shipped", shipped],
		["candidate", candidate],
	] as const) {
		const target = join(parent, `${name}-binary`);
		copyFileSync(path, target);
		chmodSync(target, 0o755);
		parked.set(path, target);
	}
	function put(from: string): void {
		if (active === from) return;
		rmSync(binary, { force: true });
		linkSync(parked.get(from) ?? "", binary);
		active = from;
	}
	// Keep each copied inode and its parked path stable across turns. Replace
	// only the common slot's hardlink; both processes still report that slot.
	// Prewarming is outside the paired clock.
	for (const from of [shipped, candidate]) {
		put(from);
		const warm = await observe([binary, "--version"], parent, env);
		if (warm.code !== 0) throw new Error("binary prewarm failed");
	}
	restore();
	const pairs: Record<string, unknown>[] = [];
	const pair = createPairing({
		state,
		snapshot,
		originalManifest,
		shipped,
		candidate,
		binary,
		workspace,
		env,
		evidence,
		put,
		observe,
		pairs,
	});
	await pair("start", ["tool", "start"]);
	await pair("check", ["tool", "check"]);
	const dry = await pair("checkpoint-dry", ["tool", "checkpoint"]);
	const token = /^token: (r\d+-[a-f0-9]{12})$/m.exec(dry.stdout)?.[1];
	if (!token)
		throw new Error(`No checkpoint dry-run token: ${dry.stdout}${dry.stderr}`);
	await pair(
		"checkpoint-apply",
		[
			"tool",
			"checkpoint",
			"--apply",
			"--token",
			token,
			"--session",
			"proof-parity",
			"--accept-dropped",
			"Independent installation parity proof on restored scratch state",
		],
		true,
	);
	const doctors = [];
	for (const [name, path] of [
		["shipped", shipped],
		["candidate", candidate],
	] as const) {
		const doctor = await observe(
			[path, "tool", "doctor", "--json"],
			workspace,
			{
				...env,
				PATH: `${dirname(path)}:${fakes}:${process.env.PATH}`,
			},
		);
		saveRun(evidence, `actual-doctor-${name}`, doctor);
		const parsed = JSON.parse(doctor.stdout);
		const base = parsed.checks.find(
			(c: { id: string }) => c.id === "packages:base",
		);
		const marker = parsed.checks.find(
			(c: { id: string }) => c.id === "path:shepherd",
		);
		assertEqual(
			base.subject,
			realpathSync(resolve(dirname(path), "../packages")),
			`${name} actual base`,
		);
		if (base.status !== "ok" || marker.status !== "ok")
			throw new Error(`${name} actual doctor marker/base failed`);
		doctors.push({ name, exit: doctor.code, base, marker });
	}
	assertEqual(
		treeManifest(join(install, "packages")),
		packages,
		"runtime packages unchanged",
	);
	writeFileSync(
		join(evidence, "parity.json"),
		`${JSON.stringify({ bun: Bun.version, parent, source, snapshotManifest: originalManifest, packages, shipped, candidate, pairs, doctors }, null, 2)}\n`,
	);
	console.log(`PASS real-workspace parity: ${parent}`);
}

if (import.meta.main) {
	try {
		const args = proofArgs(process.argv.slice(2));
		if (
			realpathSync(args["workspace-source"] ?? "") !==
			realpathSync(join(homedir(), "shepherds", "forge"))
		)
			throw new Error("Only forge is authorized as a real workspace source");
		await proveParity(args);
	} catch (error) {
		console.error(error);
		process.exit(1);
	}
}
