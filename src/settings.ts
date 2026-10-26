import * as prompts from "@clack/prompts";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	BUILT_INS,
	discoverModels,
	validateProfile,
	type AgentProfile,
	type CustomAdapter,
	type ModelSuggestion
} from "./agents.ts";
import { catalogNote, freebuffModel, LEGACY_HANDOFF_CONTEXT } from "./freebuff.ts";

export const SETTINGS_PATH = join(homedir(), ".ytd/config.json");
export interface Settings {
	version: 1;
	selected?: AgentProfile;
	recent: AgentProfile[];
	adapters: Record<string, CustomAdapter>;
}
export function loadSettings(path = SETTINGS_PATH): Settings {
	if (!existsSync(path)) return { version: 1, recent: [], adapters: {} };
	const config = JSON.parse(readFileSync(path, "utf8")) as Settings;
	if (
		config.version !== 1 ||
		!Array.isArray(config.recent) ||
		!config.recent.every(validateProfile) ||
		(config.selected && !validateProfile(config.selected)) ||
		!config.adapters ||
		typeof config.adapters !== "object" ||
		Array.isArray(config.adapters)
	)
		throw new Error(`Invalid or unsupported settings in ${path}; original file preserved`);
	for (const [agent, custom] of Object.entries(config.adapters))
		if (BUILT_INS.includes(agent as (typeof BUILT_INS)[number]))
			throw new Error(
				`Custom adapter ${agent} conflicts with the built-in ${agent} agent; rename it in ${path}`
			);
		else if (!validateProfile({ agent, model: "validation", custom }))
			throw new Error(`Invalid custom adapter ${agent}; settings preserved`);
	// The first Freebuff release saved a 32k handoff cap; move it to the current catalog value.
	for (const profile of [config.selected, ...config.recent]) {
		const listed = profile?.agent === "freebuff" ? freebuffModel(profile.model) : undefined;
		if (listed?.contextTokens && profile!.contextTokens === LEGACY_HANDOFF_CONTEXT)
			profile!.contextTokens = listed.contextTokens;
	}
	return config;
}
export function saveSettings(config: Settings, path = SETTINGS_PATH): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
	const fd = openSync(temp, "wx", 0o600);
	try {
		writeFileSync(fd, JSON.stringify(config, null, "\t") + "\n");
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temp, path);
}

export interface CliArgs {
	command: "run" | "settings" | "add" | "help";
	url?: string;
	agent?: string;
	model?: string;
	effort?: string;
	contextTokens?: number;
	timeoutMs?: number;
}
export function parseArgs(argv: string[]): CliArgs {
	const out: CliArgs = { command: "run" };
	let args = [...argv];
	if (args[0] === "settings") {
		out.command = "settings";
		args = args.slice(1);
	} else if (args[0] === "agents" && args[1] === "add") {
		out.command = "add";
		args = args.slice(2);
	}
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") {
			out.command = "help";
			continue;
		}
		if (arg.startsWith("--")) {
			const [flag, inline] = arg.split(/=(.*)/s);
			const keys: Record<string, "agent" | "model" | "effort" | "contextTokens" | "timeoutMs"> = {
				"--agent": "agent",
				"--model": "model",
				"--effort": "effort",
				"--context-tokens": "contextTokens",
				"--timeout-ms": "timeoutMs"
			};
			const key = keys[flag];
			if (!key) throw new Error(`Unknown argument: ${flag}`);
			const value = inline ?? args[++i];
			if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
			if (out[key] !== undefined) throw new Error(`${flag} was supplied more than once`);
			if (key === "contextTokens" || key === "timeoutMs") {
				const n = Number(value);
				if (!Number.isSafeInteger(n) || n < (key === "contextTokens" ? 4096 : 1))
					throw new Error(`Invalid ${flag}`);
				out[key] = n;
			} else out[key] = value;
		} else if (!out.url && out.command === "run") out.url = arg;
		else throw new Error(`Unexpected argument: ${arg}`);
	}
	return out;
}

export function profileFromArgs(args: CliArgs, settings: Settings): AgentProfile | undefined {
	const previous = settings.selected;
	const agent = args.agent ?? previous?.agent;
	if (!agent) return undefined;
	if (args.agent && args.agent !== previous?.agent && !args.model)
		throw new Error("Changing agent requires --model (or choose both in ytd settings)");
	const changed = agent !== previous?.agent;
	const model = args.model ?? (!changed ? previous?.model : undefined);
	if (!model) throw new Error("Select a model with --model or ytd settings");
	const custom = settings.adapters[agent];
	const listed = agent === "freebuff" ? freebuffModel(model) : undefined;
	// Freebuff cannot be told an effort, so a choice its picker lacks would mislead the user.
	if (listed && args.effort && !listed.efforts?.includes(args.effort))
		throw new Error(
			`${listed.name} ${listed.efforts?.length ? `offers effort ${listed.efforts.join(", ")}` : "has no effort setting"} in Freebuff`
		);
	const profile: AgentProfile = {
		agent,
		model,
		...(listed?.contextTokens ? { contextTokens: listed.contextTokens } : {}),
		...(!changed && previous?.model === model
			? {
					...(previous.contextTokens ? { contextTokens: previous.contextTokens } : {}),
					timeoutMs: previous.timeoutMs,
					effort: previous.effort
				}
			: {}),
		...(args.effort ? { effort: args.effort } : {}),
		...(args.contextTokens ? { contextTokens: args.contextTokens } : {}),
		...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
		...(custom ? { custom } : {})
	};
	if (!validateProfile(profile)) throw new Error(`Unknown or invalid agent/model: ${agent}`);
	return profile;
}

type Choice = { value: string; label: string; hint?: string; disabled?: boolean };
export interface Picker {
	text(message: string, initial?: string): Promise<string>;
	select(
		message: string,
		choices: Choice[],
		initial?: string,
		searchable?: boolean
	): Promise<string>;
}
export class Cancelled extends Error {
	constructor() {
		super("Cancelled; no ingestion started");
	}
}
function checked<T>(value: T | symbol): T {
	if (prompts.isCancel(value)) throw new Cancelled();
	return value as T;
}
const picker: Picker = {
	async text(message, initial) {
		return checked<string>(
			await prompts.text({
				message,
				initialValue: initial,
				validate: (value) => (!value?.trim() ? "Enter a value" : undefined)
			})
		);
	},
	async select(message, options, initialValue, searchable = false) {
		const maxItems = Math.max(2, Math.min(8, (process.stdout.rows ?? 24) - 8));
		return checked<string>(
			await (searchable
				? prompts.autocomplete({ message, options, initialValue, maxItems })
				: prompts.select({ message, options, initialValue, maxItems }))
		);
	}
};
export const EFFORTS: Record<string, string[]> = {
	claude: ["low", "medium", "high", "xhigh", "max"],
	codex: ["none", "minimal", "low", "medium", "high", "xhigh"],
	pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
	opencode: ["minimal", "low", "medium", "high", "max"]
};
const AGENT_HINTS: Record<string, string> = {
	freebuff: "interactive handoff; no headless mode; login not checked"
};

async function chooseProfile(
	config: Settings,
	ui: Picker,
	models: typeof discoverModels,
	installed: (name: string) => boolean
): Promise<AgentProfile> {
	// Clack draws no hint for disabled rows and may start on one, so name the state in the label
	// and start on an installed agent.
	const agents = [...BUILT_INS, ...Object.keys(config.adapters)]
		.map((value) => {
			const ready = installed(config.adapters[value]?.executable ?? value);
			return ready
				? {
						value,
						label: value,
						hint: AGENT_HINTS[value] ?? (config.adapters[value] ? "trusted wrapper" : "headless")
					}
				: { value, label: `${value} (not installed)`, disabled: true };
		})
		.sort((a, b) => Number(Boolean(a.disabled)) - Number(Boolean(b.disabled)));
	const ready = agents.filter((choice) => !choice.disabled);
	if (!ready.length)
		throw new Error(
			"No installed agents found. Configure one separately or add a trusted wrapper with ytd agents add."
		);
	const saved = ready.find((choice) => choice.value === config.selected?.agent);
	const agent = await ui.select("Agent", agents, (saved ?? ready[0]).value, true);
	if (!ready.some((choice) => choice.value === agent))
		throw new Error(
			agent ? `${agent} is not installed; no agent was selected` : "No installed agent was selected"
		);
	const suggestions = await models(agent);
	const recent = config.recent.filter((p) => p.agent === agent);
	const unique = new Map<string, ModelSuggestion>(
		[...recent.map((p) => ({ id: p.model, contextTokens: p.contextTokens })), ...suggestions].map(
			(m) => [m.id, m]
		)
	);
	const modelChoice = await ui.select(
		agent === "freebuff" ? `Model · ${catalogNote()}` : "Model",
		[...unique.values()]
			.map((m) => ({
				value: m.id,
				label: m.label ?? suggestions.find((s) => s.id === m.id)?.label ?? m.id,
				hint: recent.some((p) => p.model === m.id)
					? ["recent", suggestions.find((s) => s.id === m.id)?.hint].filter(Boolean).join("; ")
					: (m.hint ?? "suggestion; availability depends on your account")
			}))
			.concat([
				{
					value: "__exact__",
					label: "Enter exact model ID",
					hint: "Any text model supported by this agent and account"
				}
			]),
		config.selected?.agent === agent ? config.selected.model : undefined,
		true
	);
	const model =
		modelChoice === "__exact__" ? (await ui.text("Exact model ID")).trim() : modelChoice;
	const variants = suggestions.find((m) => m.id === model)?.variants;
	// An OpenCode model ID ending in #variant already selects its variant; Freebuff offers
	// effort only for catalog models that list efforts.
	const effortChoice =
		(agent === "opencode" && model.includes("#")) || (agent === "freebuff" && !variants?.length)
			? "__default__"
			: await ui.select(
					"Effort",
					[
						{ value: "__default__", label: "Use configured agent default" },
						...(variants ?? EFFORTS[agent] ?? []).map((value) => ({ value, label: value })),
						// Freebuff catalog efforts are exact; ytd cannot pass Freebuff anything else.
						...(agent === "freebuff" && variants?.length
							? []
							: [{ value: "__exact__", label: "Enter exact effort/variant" }])
					],
					"__default__"
				);
	const effort =
		effortChoice === "__exact__"
			? (await ui.text("Exact effort/variant")).trim()
			: effortChoice === "__default__"
				? undefined
				: effortChoice;
	const previous =
		config.selected?.agent === agent && config.selected.model === model
			? config.selected
			: undefined;
	const contextTokens = previous ? previous.contextTokens : unique.get(model)?.contextTokens;
	const timeoutMs = previous?.timeoutMs;
	const custom = config.adapters[agent];
	return {
		agent,
		model,
		...(effort ? { effort } : {}),
		...(contextTokens ? { contextTokens } : {}),
		...(timeoutMs ? { timeoutMs } : {}),
		...(custom ? { custom } : {})
	};
}

export const USAGE =
	"Usage: ytd [youtube-url] [--agent NAME --model ID] [--effort LEVEL]\n       ytd settings | ytd agents add\nAdvanced: --context-tokens N --timeout-ms N\nNon-interactive runs require a URL and a saved or explicit agent/model.";

export async function resolveCli(
	argv = process.argv.slice(2),
	options: {
		interactive?: boolean;
		path?: string;
		ui?: Picker;
		models?: typeof discoverModels;
		installed?: (name: string) => boolean;
	} = {}
): Promise<{ url: string; profile: AgentProfile; replaceRouting: boolean } | null> {
	const args = parseArgs(argv);
	if (args.command === "help") {
		console.log(USAGE);
		return null;
	}
	const interactive =
		options.interactive ??
		Boolean(process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== "dumb");
	const config = loadSettings(options.path);
	const ui = options.ui ?? picker;
	const models = options.models ?? discoverModels;
	const installed =
		options.installed ?? ((name: string) => Boolean(Bun.which(name, { PATH: process.env.PATH })));
	prompts.updateSettings({
		withGuide: false,
		accessible: Boolean(process.env.NO_COLOR || process.env.TERM === "dumb")
	});
	if (args.command !== "run" && !interactive)
		throw new Error(
			"Settings and adapter setup require an interactive terminal; config.json remains unchanged."
		);
	if (args.command === "add") {
		const name = (await ui.text("Adapter name")).trim();
		if (
			!/^[\w-]+$/.test(name) ||
			BUILT_INS.includes(name as (typeof BUILT_INS)[number]) ||
			config.adapters[name]
		)
			throw new Error("Choose a unique adapter name; existing adapters were preserved");
		const executable = (await ui.text("Trusted executable path (wrapper owns isolation)")).trim();
		if (!installed(executable)) throw new Error("Trusted executable is unavailable");
		const json = await ui.text(
			"Non-secret argument array as JSON; use {model} and {effort}",
			'["--model","{model}"]'
		);
		const argArray: unknown = JSON.parse(json);
		if (!Array.isArray(argArray) || !argArray.every((arg) => typeof arg === "string"))
			throw new Error("Arguments must be a JSON array of strings, never a shell command");
		config.adapters[name] = { executable, args: argArray };
		saveSettings(config, options.path);
		console.log(
			`Added ${name}. The wrapper must read stdin, write its answer to stdout, diagnose on stderr, and exit successfully.`
		);
		return null;
	}
	let profile: AgentProfile | undefined;
	let replaceRouting =
		args.agent !== undefined || args.model !== undefined || args.effort !== undefined;
	const explicit =
		args.agent !== undefined ||
		args.model !== undefined ||
		args.effort !== undefined ||
		args.contextTokens !== undefined ||
		args.timeoutMs !== undefined;
	if (args.command === "settings") profile = await chooseProfile(config, ui, models, installed);
	else {
		try {
			profile = profileFromArgs(args, config);
		} catch (e) {
			if (!interactive || explicit) throw e;
		}
		if (!profile && !interactive)
			throw new Error(
				"No saved agent/model. Supply --agent and --model; no fallback was selected."
			);
		if (interactive && !explicit && profile) {
			const action = await ui.select(
				`${profile.agent} / ${profile.model}${profile.effort ? ` / ${profile.effort}` : ""}`,
				[
					{ value: "run", label: "Run" },
					{ value: "change", label: "Change agent/model" }
				],
				"run"
			);
			if (action === "change") profile = undefined;
		}
		if (!profile) {
			profile = await chooseProfile(config, ui, models, installed);
			replaceRouting = true;
		}
	}
	if (!validateProfile(profile)) throw new Error("Invalid agent/model selection");
	const url =
		args.command === "settings"
			? undefined
			: (args.url ?? (interactive ? await ui.text("YouTube URL") : undefined));
	if (args.command !== "settings" && !url) throw new Error(USAGE);
	if (interactive && !explicit) {
		config.selected = profile;
		config.recent = [
			profile,
			...config.recent.filter(
				(p) => p.agent !== profile.agent || p.model !== profile.model || p.effort !== profile.effort
			)
		].slice(0, 12);
		saveSettings(config, options.path);
	}
	if (args.command === "settings") {
		console.log(`Saved ${profile.agent} / ${profile.model}`);
		return null;
	}
	return { url: url!.trim(), profile, replaceRouting };
}
