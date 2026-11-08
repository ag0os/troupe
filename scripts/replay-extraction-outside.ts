#!/usr/bin/env bun
/** O27: replay the identical staged artifact outside every checkout. */
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	isolatedEnv,
	repoRoot,
	run,
	scratchDir,
} from "./extraction-continuity";
import {
	assertCommittedPackage,
	assertEqual,
	assertOutside,
	bundledVersions,
	checkoutDenial,
	committedRevision,
	copyArtifact,
	copyPackage,
	digest,
	proofArgs,
	saveRun,
	treeManifest,
} from "./extraction-proof";

export async function replay(args: Record<string, string>): Promise<void> {
	const repo = repoRoot();
	const troupeRevision = committedRevision(repo);
	const parent = args.parent
		? realpathSync(args.parent)
		: scratchDir("shepherd-outside");
	const evidence = resolve(args.evidence ?? join(parent, "evidence"));
	mkdirSync(evidence, { recursive: true });
	const bun = realpathSync(args.bun ?? process.execPath);
	const version = run([bun, "--version"], parent).stdout.trim();
	console.log(`# bun ${version}; driver ${Bun.version}\nparent ${parent}`);
	const ancestors = assertOutside(parent, repo);
	const pkg = join(parent, "shepherd");
	const stage = join(parent, ".troupe-dist/troupe");
	if (!args.resume && (existsSync(pkg) || existsSync(stage)))
		throw new Error("Replay destinations must be fresh");
	const packageTree = args.resume
		? assertCommittedPackage(repo, "extractions/shepherd", pkg, true)
		: copyPackage(repo, "extractions/shepherd", pkg);
	const artifact = args.resume
		? treeManifest(stage)
		: copyArtifact(join(repo, "extractions/.troupe-dist/troupe"), stage);
	assertEqual(
		artifact,
		treeManifest(join(repo, "extractions/.troupe-dist/troupe")),
		"same staged artifact on continuation",
	);
	const paths = join(parent, "proof-bin");
	mkdirSync(paths, { recursive: true });
	if (!existsSync(join(paths, "bun"))) symlinkSync(bun, join(paths, "bun"));
	const env = isolatedEnv(parent, {
		NODE_PATH: join(pkg, "node_modules"),
		PATH: `${paths}:${process.env.PATH}`,
		BUN_INSTALL_AUTO: "disable",
	});
	const deny = checkoutDenial(repo);
	const records: { name: string; code: number | null }[] = [];
	function step(name: string, argv: string[], cwd = pkg, expected = 0): string {
		const saved = join(evidence, `${name}.json`);
		if (
			args.resume &&
			existsSync(saved) &&
			JSON.parse(readFileSync(saved, "utf8")).code !== expected
		) {
			for (const ext of ["json", "stdout", "stderr"]) {
				const failed = join(evidence, `${name}.${ext}`);
				writeFileSync(
					join(evidence, `${name}-failed-${Date.now()}.${ext}`),
					readFileSync(failed),
				);
			}
		}
		if (
			args.resume &&
			existsSync(saved) &&
			JSON.parse(readFileSync(saved, "utf8")).code === expected
		) {
			const previous = JSON.parse(readFileSync(saved, "utf8"));
			assertEqual(previous.argv, [...deny, ...argv], `${name} resumed command`);
			assertEqual(previous.cwd, cwd, `${name} resumed cwd`);
			assertEqual(previous.code, expected, `${name} resumed exit`);
			assertEqual(previous.bun, Bun.version, `${name} resumed driver Bun`);
			assertEqual(
				previous.stdout,
				readFileSync(join(evidence, `${name}.stdout`), "utf8"),
				`${name} raw stdout`,
			);
			assertEqual(
				previous.stderr,
				readFileSync(join(evidence, `${name}.stderr`), "utf8"),
				`${name} raw stderr`,
			);
			console.log(`reusing verified ${name}`);
			records.push({ name, code: previous.code });
			return previous.stdout;
		}
		console.log(`running ${name}`);
		const result = run([...deny, ...argv], cwd, env);
		saveRun(evidence, name, result);
		records.push({ name, code: result.code });
		if (result.code !== expected)
			throw new Error(
				`${name} exit ${result.code}, expected ${expected}:\n${result.stdout}${result.stderr}`,
			);
		return result.stdout;
	}
	// Prove denial is active, not merely a declared profile.
	step(
		"checkout-denied",
		[
			bun,
			"--no-install",
			"-e",
			`try { require("node:fs").readFileSync(${JSON.stringify(join(repo, "package.json"))}); process.exit(2); } catch(e) { if(e.code!=="EPERM" && e.code!=="EACCES") throw e; console.log(e.code); }`,
		],
		parent,
	);
	step("install", [bun, "install", "--frozen-lockfile"]);
	if (existsSync(join(stage, "node_modules")))
		throw new Error("stage must not hold node_modules");
	if (!existsSync(join(dirname(stage), "node_modules")))
		symlinkSync(
			"../shepherd/node_modules",
			join(dirname(stage), "node_modules"),
		);
	const assumptions = [
		"one consumer",
		"no node_modules in the stage",
		"Bun 1.2.22 per-file links (1.4.4 hardlinks also replayed separately)",
		"typescript, yaml, zod are the complete staged runtime set",
	];
	const stageMetadata = JSON.parse(
		readFileSync(join(stage, "package.json"), "utf8"),
	);
	assertEqual(
		Object.keys(stageMetadata.dependencies).sort(),
		["typescript", "yaml", "zod"],
		"stage runtime set",
	);
	const probe = `
import { writeFileSync,readFileSync,realpathSync } from "node:fs";
import { dirname,join } from "node:path";
import { generateEntry,loadAgentDefinition } from "troupe/compiler";
import { shepherdDefinition,PACKAGE_ROOT,troupeRoot } from "./scripts/shepherd-definition";
const def=shepherdDefinition();
const agent=await loadAgentDefinition(def,"agents/shepherd.md");
const entry=generateEntry(agent);
writeFileSync(${JSON.stringify(join(parent, "generated-entry.ts"))},entry);
const lock=JSON.parse(readFileSync("bun.lock","utf8").replace(/,(\\s*[}\\]])/g,"$1"));
const runtime=["typescript","yaml","zod"].map(name=>{
 const file=realpathSync(Bun.resolveSync(name,troupeRoot()));
 let dir=dirname(file);
 while(true) { try { if(JSON.parse(readFileSync(join(dir,"package.json"),"utf8")).name===name) break; } catch {} if(dir===dirname(dir)) throw new Error("no package directory: "+file); dir=dirname(dir); }
 const version=JSON.parse(readFileSync(join(dir,"package.json"),"utf8")).version;
 const expected=lock.packages[name][0].slice(name.length+1);
 if(dir!==realpathSync(join(PACKAGE_ROOT,"node_modules",name))||version!==expected) throw new Error(name+" resolves outside locked consumer: "+file);
 return {name,file,dir,version};
});
console.log(JSON.stringify(runtime,null,2));
`;
	// Probe lives in ignored node_modules so it cannot alter package identity.
	const driver = join(pkg, "node_modules/.outside-entry.ts");
	// Imports relative to the package from this nested location.
	writeFileSync(
		driver,
		probe.replace(
			'"./scripts/shepherd-definition"',
			'"../scripts/shepherd-definition"',
		),
	);
	const runtime = JSON.parse(
		step("runtime-resolution", [bun, "--no-install", driver]),
	);
	// Bare-copy eval identity must refuse before any Git initialization.
	const bare = args.resume
		? JSON.parse(readFileSync(join(evidence, "eval-bare.json"), "utf8"))
		: run(
				[
					...deny,
					bun,
					"--no-install",
					"evals/shepherd/run.ts",
					"--check",
					"--scratch",
					join(parent, "eval-bare"),
				],
				pkg,
				env,
			);
	saveRun(evidence, "eval-bare", bare);
	if (
		bare.code === 0 ||
		!`${bare.stdout}${bare.stderr}`.includes("require a Git root")
	)
		throw new Error("bare outside eval did not refuse Git identity");
	step("git-init", ["git", "init", "--quiet"]);
	step("git-add", ["git", "add", "."]);
	step("git-commit", [
		"git",
		"-c",
		"user.name=Extraction proof",
		"-c",
		"user.email=proof@example.invalid",
		"-c",
		"core.hooksPath=/dev/null",
		"commit",
		"--quiet",
		"-m",
		"Snapshot outside package",
	]);
	step("stage-resolution", [
		bun,
		"--no-install",
		"test",
		"./scripts/stage-resolution.test.ts",
	]);
	step("typecheck", [bun, "--no-install", "run", "typecheck"]);
	step("biome", [bun, "--no-install", "run", "check"]);
	step("tests", [bun, "--no-install", "test"]);
	mkdirSync(join(parent, "eval-own-repo"), { recursive: true });
	step("eval-own-repo", [
		bun,
		"--no-install",
		"evals/shepherd/run.ts",
		"--check",
		"--scratch",
		join(parent, "eval-own-repo"),
	]);
	step("build", [bun, "--no-install", "run", "compile", "--", "shepherd"]);
	assertEqual(readdirSync(join(pkg, "bin")), ["shepherd"], "one agent binary");
	const binary = join(pkg, "bin/shepherd");
	const entry = readFileSync(join(parent, "generated-entry.ts"));
	const bytes = readFileSync(binary);
	if (entry.includes(repo) || bytes.includes(repo))
		throw new Error("entry or binary names original checkout");
	assertEqual(
		treeManifest(stage),
		artifact,
		"stage unchanged after gates and build",
	);
	const actualEnv = { ...env, PATH: `${join(pkg, "bin")}:${env.PATH}` };
	const doctor = run(
		[...deny, binary, "tool", "doctor", "--json"],
		parent,
		actualEnv,
	);
	saveRun(evidence, "doctor-complete", doctor);
	const parsed = JSON.parse(doctor.stdout);
	const base = parsed.checks.find(
		(c: { id: string }) => c.id === "packages:base",
	);
	const marker = parsed.checks.find(
		(c: { id: string }) => c.id === "path:shepherd",
	);
	if (
		base?.status !== "ok" ||
		base.subject !== join(pkg, "packages") ||
		marker?.status !== "ok"
	)
		throw new Error("complete doctor marker/base mismatch");
	const bareInstall = join(parent, "binary-only");
	mkdirSync(join(bareInstall, "bin"), { recursive: true });
	copyArtifactFile(binary, join(bareInstall, "bin/shepherd"));
	const binaryOnly = run(
		[...deny, join(bareInstall, "bin/shepherd"), "tool", "doctor", "--json"],
		parent,
		{ ...env, PATH: `${join(bareInstall, "bin")}:${env.PATH}` },
	);
	saveRun(evidence, "doctor-binary-only", binaryOnly);
	if (
		JSON.parse(binaryOnly.stdout).checks.find(
			(c: { id: string }) => c.id === "packages:base",
		)?.status !== "gap"
	)
		throw new Error("binary-only doctor did not detect missing packages");
	step("version", [binary, "--version"]);
	assertEqual(
		committedRevision(repo),
		troupeRevision,
		"driving HEAD remained stable",
	);
	assertCommittedPackage(repo, "extractions/shepherd", pkg, true);
	const report = {
		troupeRevision,
		packageTree,
		packageTreeDigest: digest(packageTree.join("\n")),
		continued: Boolean(args.resume),
		bun: version,
		driverBun: Bun.version,
		parent,
		pkg,
		binary,
		ancestors,
		checkoutDenied: repo,
		assumptions,
		artifactDigest: digest(artifact.join("\n")),
		artifact,
		runtime,
		entryNamesStage: entry.includes(stage),
		binaryNamesStage: bytes.includes(stage),
		entryNamesCheckout: false,
		binaryNamesCheckout: false,
		bundled: bundledVersions(binary),
		compilerDependencies: runtime.filter((r: { name: string }) =>
			["zod", "typescript"].includes(r.name),
		),
		records,
	};
	writeFileSync(
		join(evidence, "replay.json"),
		`${JSON.stringify(report, null, 2)}\n`,
	);
	console.log(`PASS outside replay ${binary}`);
}

import { chmodSync, copyFileSync, statSync } from "node:fs";

function copyArtifactFile(from: string, to: string): void {
	copyFileSync(from, to);
	chmodSync(to, statSync(from).mode & 0o777);
}

if (import.meta.main) {
	try {
		await replay(proofArgs(process.argv.slice(2)));
	} catch (error) {
		console.error(error);
		process.exit(1);
	}
}
