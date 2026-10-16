import {
	accessSync,
	constants,
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	type GuideDeclaration,
	type ModuleProblem,
	parseModule,
	type ToolDeclaration,
} from "./module-format";
import type { ModuleCandidate } from "./module-resolution";
import { STATE_DIR } from "./workspace";

/** A directory of packages (docs/PACKAGES.md), and the layer its modules take. */
export type PackageLocation = { dir: string; layer: "builtin" | "inherited" };

export type PackageRecord = {
	name: string;
	/** Absolute path of the package directory. */
	dir: string;
	contract: number;
	tools: Record<string, ToolDeclaration>;
	guides: Record<string, GuideDeclaration>;
};

export const PACKAGE_NAME = /^[a-z]+(?:-[a-z]+)*$/;

/**
 * Names a package may not take: `shepherd tool <name>` would be a core
 * command, and `shepherd tool guide <name>` a core guide. A hand copy, since
 * importing `tool.ts` here would be a cycle; a test pins it to both.
 */
export const RESERVED_PACKAGE_NAMES = new Set([
	"check",
	"archive",
	"guide",
	"init",
	"doctor",
	"start",
	"journal",
	"checkpoint",
	"unlock",
	"query",
	"charter",
	"memory",
	"tools",
]);

/**
 * The base location: `packages/` in the checkout that holds the running
 * binary (`<bin>/../packages`), or in this repository when run from source.
 * A compiled binary's modules live under `/$bunfs`.
 */
export function baseLocation(
	moduleDir: string = import.meta.dir,
	execPath: string = process.execPath,
): string {
	return moduleDir.startsWith("/$bunfs")
		? resolve(dirname(execPath), "..", "packages")
		: resolve(moduleDir, "..", "..", "packages");
}

/** The locations Shepherd reads (R2 a): the base, then the enclosing workspace's. */
export function packageLocations(
	enclosing: string | undefined,
	base: string = baseLocation(),
): PackageLocation[] {
	return [
		{ dir: base, layer: "builtin" },
		...(enclosing
			? [
					{
						dir: join(enclosing, STATE_DIR, "packages"),
						layer: "inherited" as const,
					},
				]
			: []),
	];
}

/**
 * Every package in `locations`, in location order and then name order. A
 * package with any problem keeps its record, so dispatch and check can name
 * it, but loads no body: its text, tools and guides stay out. The same name
 * in two locations is a problem on both (D3).
 */
export function packageModules(
	locations: readonly PackageLocation[],
	tolerateUnreadable = false,
): ModuleCandidate[] {
	const found = locations.flatMap(({ dir, layer }) => {
		if (!existsSync(dir)) return [];
		let names: string[];
		try {
			names = readdirSync(dir, { withFileTypes: true })
				.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
				.map((entry) => entry.name)
				.sort();
		} catch (error) {
			if (tolerateUnreadable) return [];
			throw error;
		}
		return names.flatMap((name): ModuleCandidate[] => {
			const source = join(dir, name, "MODULE.md");
			if (!existsSync(source)) return [];
			let raw: string;
			try {
				raw = readFileSync(source, "utf8");
			} catch (error) {
				if (tolerateUnreadable) return [];
				throw error;
			}
			const parsed = parseModule(raw, `${name}.md`, { package: true });
			const problems: ModuleProblem[] = [...parsed.problems];
			if (!PACKAGE_NAME.test(name))
				problems.push({
					code: "module-name",
					message: `package name "${name}" must match ${PACKAGE_NAME.source}`,
				});
			else if (RESERVED_PACKAGE_NAMES.has(name))
				problems.push({
					code: "package-name-reserved",
					message: `package name "${name}" is reserved for a core command or guide`,
				});
			const metadata = parsed.metadata;
			const packageDir = join(dir, name);
			return [
				{
					...parsed,
					body: problems.length ? undefined : parsed.body,
					problems,
					name,
					source,
					path: realpathSync(source),
					layer,
					raw,
					package: {
						name,
						dir: packageDir,
						contract: metadata?.contract ?? 0,
						tools: Object.fromEntries(
							Object.entries(metadata?.tools ?? {}).map(([tool, value]) => [
								tool,
								{
									description: value.description,
									access: value.access,
									requires: value.requires ?? [],
									network: value.network ?? false,
								},
							]),
						),
						guides: { ...(metadata?.guides ?? {}) },
					},
				},
			];
		});
	});
	for (const candidate of found) {
		const twins = found.filter(
			(m) => m.package?.name === candidate.package?.name,
		);
		if (twins.length < 2) continue;
		candidate.body = undefined;
		candidate.problems.push({
			code: "package-duplicate",
			message: `package "${candidate.package?.name}" is found in ${twins.length} locations: ${twins.map((m) => m.package?.dir).join(", ")}; none loads`,
		});
	}
	return found;
}

/** A tool file dispatch may run: a regular file with the executable bit. */
export function executable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** The package records of the loadable selected modules, in selection order. */
export function selectedPackages(
	selected: readonly ModuleCandidate[],
): PackageRecord[] {
	return selected.flatMap((m) =>
		m.package && m.body !== undefined ? [m.package] : [],
	);
}
