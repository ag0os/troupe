#!/usr/bin/env bun
/** O29: exact observations on an authorized, read-only workspace snapshot. */
import {
	chmodSync,
	copyFileSync,
	cpSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { installFakeClis } from "../lib/agent-format/fake-cli";
import {
	isolatedEnv,
	type Ran,
	repoRoot,
	run,
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

function records(state: string): Record<string, string> {
	const files: Record<string, string> = {};
	for (const row of treeManifest(state)) {
		const path = row.split(" ")[0] ?? "";
		if (path.endsWith("/")) continue;
		// All state bytes are bound by the manifest; checkpoint records are retained verbatim too.
		if (
			path === "CURRENT.md" ||
			path === "journal.md" ||
			path === "checkpoint.json" ||
			path.startsWith("checkpoints/")
		)
			files[path] = readFileSync(join(state, path)).toString("base64");
	}
	return files;
}

export async function proveParity(args: Record<string, string>): Promise<void> {
	const source = realpathSync(args["workspace-source"] ?? "");
	if (source !== "/Users/cosmos/shepherds/forge")
		throw new Error("Only forge is authorized as a real workspace source");
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
	});
	function restore(): void {
		rmSync(state, { recursive: true, force: true });
		cpSync(snapshot, state, { recursive: true, preserveTimestamps: true });
	}
	function put(from: string): void {
		copyFileSync(from, binary);
		chmodSync(binary, 0o755);
	}
	const pairs: Record<string, unknown>[] = [];
	async function pair(
		name: string,
		argv: string[],
		applies = false,
	): Promise<Ran> {
		for (let retry = 0; retry < 30; retry++) {
			// Start early in a second, to give both unmodified clocks the same displayed second.
			const wait = 1000 - (Date.now() % 1000) + 15;
			await Bun.sleep(wait);
			restore();
			put(shipped);
			const start = Date.now();
			const a = run([binary, ...argv], workspace, env);
			const aEnd = Date.now();
			const aRecords = applies ? records(state) : undefined;
			const aManifest = applies ? treeManifest(state) : undefined;
			restore();
			put(candidate);
			const bStart = Date.now();
			const b = run([binary, ...argv], workspace, env);
			const end = Date.now();
			saveRun(evidence, `${name}-${retry}-shipped`, a);
			saveRun(evidence, `${name}-${retry}-candidate`, b);
			const straddled = Math.floor(start / 1000) !== Math.floor(end / 1000);
			pairs.push({
				name,
				retry,
				argv,
				start,
				aEnd,
				bStart,
				end,
				shippedExit: a.code,
				candidateExit: b.code,
				straddled,
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
				assertEqual(records(state), aRecords, `${name} resulting record bytes`);
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
		const doctor = run([path, "tool", "doctor", "--json"], workspace, {
			...env,
			PATH: `${dirname(path)}:${fakes}:${process.env.PATH}`,
		});
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
		await proveParity(proofArgs(process.argv.slice(2)));
	} catch (error) {
		console.error(error);
		process.exit(1);
	}
}
