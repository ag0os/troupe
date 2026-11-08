import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import ts from "typescript";
import { PACKAGE_ROOT, troupeRoot } from "./shepherd-definition";

// O5b: the package's imports stay inside it. Every relative specifier of
// every package TypeScript file (type-only ones included) resolves, by
// realpath, inside the package root; every bare specifier is `node:*`,
// `bun:*`, `bun`, a declared dependency, or `troupe` and a subpath the
// staged Troupe's export map names.

/** TypeScript files Git lists in `root` (tracked plus untracked nonignored). */
function typescriptFiles(root: string): string[] {
	const result = spawnSync(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
		{ cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } },
	);
	if (result.status !== 0) throw new Error(result.stderr.toString());
	return result.stdout
		.toString()
		.split("\0")
		.filter((path) => path.endsWith(".ts"))
		.sort();
}

/**
 * Every module specifier `text` names: import and export declarations
 * (type-only ones included), `import()` calls, `import("x").T` types and
 * type reference directives, read from the TypeScript syntax tree.
 */
export function specifiers(text: string): string[] {
	const source = ts.createSourceFile("file.ts", text, ts.ScriptTarget.Latest);
	const found: string[] = source.typeReferenceDirectives.map(
		(directive) => directive.fileName,
	);
	const visit = (node: ts.Node) => {
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier !== undefined &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			found.push(node.moduleSpecifier.text);
		} else if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments[0] !== undefined &&
			ts.isStringLiteral(node.arguments[0])
		) {
			found.push(node.arguments[0].text);
		} else if (
			ts.isImportTypeNode(node) &&
			ts.isLiteralTypeNode(node.argument) &&
			ts.isStringLiteral(node.argument.literal)
		) {
			found.push(node.argument.literal.text);
		} else if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference) &&
			ts.isStringLiteral(node.moduleReference.expression)
		) {
			found.push(node.moduleReference.expression.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

interface Allowed {
	/** Declared dependency names other than `troupe`. */
	dependencies: string[];
	/** The staged Troupe export map's keys (`.`, `./compiler`, ...). */
	troupeExports: string[];
}

function bareName(specifier: string): string {
	const parts = specifier.split("/");
	return (
		specifier.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1)
	).join("/");
}

/** Every import of the files under `root` that leaves the package or names an undeclared module. */
export function importProblems(
	root: string,
	files: readonly string[],
	allowed: Allowed,
): string[] {
	const real = realpathSync(root);
	const problems: string[] = [];
	for (const file of files) {
		const text = readFileSync(join(root, file), "utf8");
		for (const specifier of specifiers(text)) {
			const where = `${file}: ${JSON.stringify(specifier)}`;
			if (specifier.startsWith(".") || isAbsolute(specifier)) {
				let resolved: string;
				try {
					resolved = realpathSync(
						Bun.resolveSync(specifier, dirname(join(root, file))),
					);
				} catch {
					problems.push(`${where} does not resolve`);
					continue;
				}
				const inside = relative(real, resolved);
				if (inside.startsWith("..") || isAbsolute(inside)) {
					problems.push(`${where} resolves outside the package (${resolved})`);
				}
				continue;
			}
			if (/^(node|bun):/.test(specifier) || specifier === "bun") continue;
			const name = bareName(specifier);
			if (name === "troupe") {
				const subpath = `.${specifier.slice("troupe".length)}`;
				if (!allowed.troupeExports.includes(subpath)) {
					problems.push(`${where} is not in troupe's export map`);
				}
				continue;
			}
			if (!allowed.dependencies.includes(name)) {
				problems.push(`${where} is not a declared dependency`);
			}
		}
	}
	return problems;
}

function allowedFor(root: string): Allowed {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const stage = JSON.parse(
		readFileSync(join(troupeRoot(root), "package.json"), "utf8"),
	);
	return {
		dependencies: [
			...Object.keys(manifest.dependencies ?? {}),
			...Object.keys(manifest.devDependencies ?? {}),
		].filter((name) => name !== "troupe"),
		troupeExports: Object.keys(stage.exports ?? {}),
	};
}

describe("package imports stay inside the package (O5b)", () => {
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "imports-")));
	afterAll(() => rmSync(scratch, { recursive: true, force: true }));

	test("the scanner reads type-only, text and dynamic imports, not strings or regular expressions", () => {
		expect(
			specifiers(
				'import type { A } from "./a";\nimport b from "./b.md" with { type: "text" };\nexport * from "./e";\nconst c = await import("./c");\ntype T = import("./t").T;\nconst probe = `import { d } from "./d";`;\nconst re = /import x from "([^"]+)"/;\n',
			),
		).toEqual(["./a", "./b.md", "./e", "./c", "./t"]);
	});

	test("every package import resolves inside it or names a declared module", () => {
		const files = typescriptFiles(PACKAGE_ROOT);
		expect(files.length).toBeGreaterThan(100);
		expect(
			importProblems(PACKAGE_ROOT, files, allowedFor(PACKAGE_ROOT)),
		).toEqual([]);
	});

	test("a climbing relative import and an unexported troupe path fail", () => {
		const root = join(scratch, "pkg");
		mkdirSync(join(root, "lib"), { recursive: true });
		writeFileSync(join(scratch, "outside.ts"), "export const x = 1;\n");
		writeFileSync(join(root, "lib/inside.ts"), "export const y = 1;\n");
		writeFileSync(
			join(root, "lib/a.ts"),
			[
				'import { y } from "./inside";',
				'import { x } from "../../outside";',
				'import { compile } from "troupe/lib/agent-format/compiler";',
				'import { compileAgent } from "troupe/compiler";',
				'import { parse } from "yaml";',
				'import { other } from "left-pad";',
				'import { join } from "node:path";',
				'import { missing } from "./missing";',
				"",
			].join("\n"),
		);
		expect(
			importProblems(root, ["lib/a.ts"], {
				dependencies: ["yaml"],
				troupeExports: [".", "./compiler"],
			}),
		).toEqual([
			`lib/a.ts: "../../outside" resolves outside the package (${join(scratch, "outside.ts")})`,
			'lib/a.ts: "troupe/lib/agent-format/compiler" is not in troupe\'s export map',
			'lib/a.ts: "left-pad" is not a declared dependency',
			'lib/a.ts: "./missing" does not resolve',
		]);
	});
});
