import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { opencodeV2IsolatedEnv, type ModelSuggestion } from "./agents.ts";
import { RUN_DIR } from "./config.ts";
import { runCommand } from "./process.ts";

/**
 * OpenCode onboarding. Providers are read from OpenCode's own auth list, never from YTD state, and
 * account entitlement is never inferred: a connected provider proves an account, not a model quota.
 */
export interface OpencodeProvider {
	id: string;
	/** Display name OpenCode reports for the integration. */
	name: string;
	connected: boolean;
}

export interface OpencodeInspection {
	/** OpenCode 2 runs a private server; only it can list providers and models as JSON. */
	standalone: boolean;
	/** Absent when the state could not be determined; never a guess. */
	providers?: OpencodeProvider[];
	error?: string;
}

export interface OpencodeOnboarding {
	inspect(): Promise<OpencodeInspection>;
	login(): Promise<number>;
}

/**
 * Parses `opencode auth list --format json`. Credential identifiers and labels are dropped: ytd
 * only needs which integrations are connected, and credentials never enter YTD state.
 */
export function parseOpencodeAuth(stdout: string): OpencodeProvider[] {
	const parsed: unknown = JSON.parse(stdout);
	if (!Array.isArray(parsed)) throw new Error("OpenCode provider list is malformed");
	return parsed.map((entry: any) => {
		if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !entry.id.trim())
			throw new Error("OpenCode provider list is malformed");
		if (entry.connections !== undefined && !Array.isArray(entry.connections))
			throw new Error("OpenCode provider connections are malformed");
		return {
			id: entry.id,
			name: typeof entry.name === "string" && entry.name.trim() ? entry.name : entry.id,
			connected: Array.isArray(entry.connections) && entry.connections.length > 0
		};
	});
}

/**
 * Checks the installed version and its connected providers with the same isolated configuration
 * model discovery and execution use. A failure is reported, never treated as "no providers".
 */
export async function inspectOpencode(executable = "opencode"): Promise<OpencodeInspection> {
	mkdirSync(RUN_DIR, { recursive: true });
	const help = await runCommand([executable, "run", "--help"], {
		cwd: RUN_DIR,
		timeoutMs: 15000
	});
	if (help.code !== 0) return { standalone: false, error: "OpenCode installation check failed" };
	const standalone = /--standalone\b/.test(help.stdout);
	if (!standalone)
		return {
			standalone,
			error: "OpenCode 1 is installed; provider detection needs the OpenCode 2 auth list"
		};
	let env: NodeJS.ProcessEnv;
	try {
		env = await opencodeV2IsolatedEnv(executable);
	} catch (error) {
		return { standalone, error: (error as Error).message };
	}
	const list = await runCommand([executable, "auth", "list", "--standalone", "--format", "json"], {
		cwd: RUN_DIR,
		env,
		timeoutMs: 30000
	});
	if (list.code !== 0 || list.overflow || list.cancelled || list.timedOut)
		return { standalone, error: "OpenCode could not list its connected providers" };
	try {
		return { standalone, providers: parseOpencodeAuth(list.stdout) };
	} catch (error) {
		return { standalone, error: (error as Error).message };
	}
}

/**
 * Runs OpenCode's own login in the user's terminal. ytd never reads, captures or stores the
 * credentials it writes; OpenCode keeps them in its own account storage.
 */
export async function opencodeLogin(executable = "opencode"): Promise<number> {
	const env = await opencodeV2IsolatedEnv(executable);
	return new Promise((resolve, reject) => {
		// The terminal delivers Ctrl+C to OpenCode too; ytd stays up to report the cancelled login.
		const ignore = () => {};
		process.on("SIGINT", ignore);
		const settle = () => process.off("SIGINT", ignore);
		const child = spawn(executable, ["auth", "login", "--standalone"], {
			cwd: RUN_DIR,
			env,
			stdio: "inherit"
		});
		child.once("error", (error) => {
			settle();
			reject(error);
		});
		child.once("exit", (code) => {
			settle();
			resolve(code ?? 1);
		});
	});
}

export const opencodeOnboarding: OpencodeOnboarding = {
	inspect: () => inspectOpencode(),
	login: () => opencodeLogin()
};

/** Provider-qualified model IDs group by the exact provider OpenCode reports. */
export const providerOf = (modelId: string): string => modelId.split("/")[0];

/**
 * Groups models by provider only when that split is meaningful and exact; a single provider or an
 * unqualified ID keeps one flat list, so every agent keeps its familiar picker.
 */
export function providerGroups(
	models: ModelSuggestion[]
): { id: string; models: ModelSuggestion[] }[] | undefined {
	if (!models.every((model) => model.id.includes("/") && providerOf(model.id))) return undefined;
	const groups = new Map<string, ModelSuggestion[]>();
	for (const model of models) {
		const provider = providerOf(model.id);
		groups.set(provider, [...(groups.get(provider) ?? []), model]);
	}
	return groups.size > 1
		? [...groups]
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([id, group]) => ({ id, models: group }))
		: undefined;
}
