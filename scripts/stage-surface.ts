/**
 * The public surface of each export-map subpath, read with the TypeScript
 * checker: value and type-only exports of every entry. Used by the stage
 * test to generate a consumer that imports every member.
 */
import { join } from "node:path";
import ts from "typescript";

export interface SubpathSurface {
	subpath: string;
	values: string[];
	types: string[];
}

function isTypeOnlyExport(symbol: ts.Symbol): boolean {
	return (symbol.declarations ?? []).some(
		(declaration) =>
			(ts.isExportSpecifier(declaration) &&
				(declaration.isTypeOnly || declaration.parent.parent.isTypeOnly)) ||
			(ts.isExportDeclaration(declaration) && declaration.isTypeOnly),
	);
}

export function readSurface(
	root: string,
	exports: Record<string, string | { types: string }>,
): SubpathSurface[] {
	const entries = Object.entries(exports).filter(
		([, target]) => typeof target === "string",
	) as [string, string][];
	const files = entries.map(([, target]) => join(root, target));
	const program = ts.createProgram(files, {
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		allowImportingTsExtensions: true,
		noEmit: true,
		skipLibCheck: true,
	});
	const checker = program.getTypeChecker();
	return entries.map(([subpath, target]) => {
		const source = program.getSourceFile(join(root, target));
		const module = source && checker.getSymbolAtLocation(source);
		if (!module) throw new Error(`no module symbol for ${target}`);
		const values: string[] = [];
		const types: string[] = [];
		for (const symbol of checker.getExportsOfModule(module)) {
			const resolved =
				symbol.flags & ts.SymbolFlags.Alias
					? checker.getAliasedSymbol(symbol)
					: symbol;
			const value =
				(resolved.flags & ts.SymbolFlags.Value) !== 0 &&
				!isTypeOnlyExport(symbol);
			(value ? values : types).push(symbol.name);
		}
		return {
			subpath: subpath === "." ? "troupe" : `troupe/${subpath.slice(2)}`,
			values: values.sort(),
			types: types.sort(),
		};
	});
}

/** A consumer module importing every member of every subpath. */
export function surfaceModule(surfaces: readonly SubpathSurface[]): string {
	const lines = ['/// <reference types="troupe/text-imports" />'];
	const checks: string[] = [];
	surfaces.forEach((surface, index) => {
		const values = surface.values.map((name) => `${name} as v${index}_${name}`);
		const types = surface.types.map(
			(name) => `type ${name} as t${index}_${name}`,
		);
		lines.push(
			`import { ${[...values, ...types].join(", ")} } from ${JSON.stringify(surface.subpath)};`,
		);
		for (const name of surface.types) {
			lines.push(`export type { t${index}_${name} };`);
		}
		for (const name of surface.values) {
			checks.push(
				`[${JSON.stringify(`${surface.subpath}:${name}`)}, v${index}_${name}]`,
			);
		}
	});
	lines.push(
		`const values: [string, unknown][] = [\n\t${checks.join(",\n\t")},\n];`,
		"const missing = values.filter(([, value]) => value === undefined).map(([name]) => name);",
		'if (missing.length > 0) throw new Error(`undefined exports: ${missing.join(", ")}`);',
		"console.log(JSON.stringify({ defined: values.length }));",
		"",
	);
	return lines.join("\n");
}
