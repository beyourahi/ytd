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
import type { ConcurrencySettings } from "./config.ts";
import type { TranscriptionRequest } from "./transcribe.ts";
import {
	opencodeOnboarding,
	providerGroups,
	providerOf,
	type OpencodeInspection,
	type OpencodeOnboarding,
	type OpencodeProvider
} from "./opencode.ts";

export const SETTINGS_PATH = join(homedir(), ".ytd/config.json");
export interface Settings {
	version: 1;
	selected?: AgentProfile;
	recent: AgentProfile[];
	adapters: Record<string, CustomAdapter>;
}

/**
 * Freebuff was a supported agent until it was removed. Saved files may still name it, so it is
 * recognized before strict validation instead of leaving an install unable to start.
 */
const REMOVED_AGENT = "freebuff";
export const REMOVED_AGENT_ERROR =
	"Freebuff support was removed from ytd. Choose another agent and model: ytd settings, or --agent NAME --model ID.";

/** The one pre-migration copy kept for recovery; written before any settings change. */
export const legacyBackupPath = (path = SETTINGS_PATH) => `${path}.freebuff-backup.json`;

const removedAgentProfile = (value: unknown): boolean => {
	const profile = value as AgentProfile | undefined;
	// A trusted custom wrapper that happens to use this name is unrelated to the removed agent.
	return (
		Boolean(profile) &&
		typeof profile === "object" &&
		!Array.isArray(profile) &&
		profile!.agent === REMOVED_AGENT &&
		!profile!.custom
	);
};

function backupLegacySettings(path: string, original: string): void {
	const backup = legacyBackupPath(path);
	// An interrupted migration leaves the original untouched, so a second copy would be identical.
	if (existsSync(backup)) return;
	const temp = `${backup}.${process.pid}.${crypto.randomUUID()}.tmp`;
	const fd = openSync(temp, "wx", 0o600);
	try {
		writeFileSync(fd, original);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temp, backup);
}

/**
 * Drops the removed agent from the active and recent selections in memory, keeping every other
 * setting intact. Idempotent: once migrated, later loads find nothing to change and write nothing.
 */
function migrateRemovedAgent(config: Settings): boolean {
	const recent = Array.isArray(config.recent) ? config.recent : [];
	if (!removedAgentProfile(config.selected) && !recent.some(removedAgentProfile)) return false;
	if (removedAgentProfile(config.selected)) delete config.selected;
	if (Array.isArray(config.recent))
		config.recent = config.recent.filter((profile) => !removedAgentProfile(profile));
	return true;
}

export function loadSettings(path = SETTINGS_PATH): Settings {
	if (!existsSync(path)) return { version: 1, recent: [], adapters: {} };
	const original = readFileSync(path, "utf8");
	const config = JSON.parse(original) as Settings;
	// Migrated in memory first: an invalid or unsupported file is reported and never rewritten.
	const migrated =
		Boolean(config) &&
		typeof config === "object" &&
		!Array.isArray(config) &&
		migrateRemovedAgent(config);
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
	if (migrated) {
		backupLegacySettings(path, original);
		saveSettings(config, path);
		console.warn(
			`Removed Freebuff from saved agent settings; the previous file is preserved at ${legacyBackupPath(path)}`
		);
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
	fetchConcurrency?: number;
	extractConcurrency?: number;
	fetchPacingMs?: number;
	maxAttempts?: number;
	perf?: boolean;
	verbose?: boolean;
	transcribe?: boolean;
	whisperCommand?: string;
	whisperModel?: string;
}

/** Operational controls for one run. Defaults come from CONCURRENCY and stay conservative. */
export interface RunSettings {
	replaceRouting: boolean;
	concurrency: Partial<ConcurrencySettings>;
	/** Print the measured performance report when the run ends. */
	perf: boolean;
	/** Narrate every video instead of aggregating progress on large runs. */
	verbose: boolean;
	/** Local speech-to-text for captionless videos. Off unless explicitly requested. */
	transcription?: TranscriptionRequest;
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
			const booleans: Record<string, "perf" | "verbose" | "transcribe"> = {
				"--perf": "perf",
				"--verbose": "verbose",
				"--transcribe": "transcribe"
			};
			const boolKey = booleans[flag];
			if (boolKey) {
				if (inline !== undefined) throw new Error(`${flag} does not take a value`);
				if (out[boolKey]) throw new Error(`${flag} was supplied more than once`);
				out[boolKey] = true;
				continue;
			}
			// Numeric and textual flags are mapped separately so each assignment has one type.
			const numeric: Record<
				string,
				| "contextTokens"
				| "timeoutMs"
				| "fetchConcurrency"
				| "extractConcurrency"
				| "fetchPacingMs"
				| "maxAttempts"
			> = {
				"--context-tokens": "contextTokens",
				"--timeout-ms": "timeoutMs",
				"--fetch-concurrency": "fetchConcurrency",
				"--extract-concurrency": "extractConcurrency",
				"--fetch-pacing-ms": "fetchPacingMs",
				"--max-attempts": "maxAttempts"
			};
			const textual: Record<
				string,
				"agent" | "model" | "effort" | "whisperCommand" | "whisperModel"
			> = {
				"--agent": "agent",
				"--model": "model",
				"--effort": "effort",
				"--whisper-command": "whisperCommand",
				"--whisper-model": "whisperModel"
			};
			const ranges: Record<string, [number, number]> = {
				contextTokens: [4096, Number.MAX_SAFE_INTEGER],
				timeoutMs: [1, Number.MAX_SAFE_INTEGER],
				fetchConcurrency: [1, 64],
				extractConcurrency: [1, 32],
				fetchPacingMs: [0, 600_000],
				maxAttempts: [1, 10]
			};
			const numericKey = numeric[flag];
			const textualKey = textual[flag];
			if (!numericKey && !textualKey) throw new Error(`Unknown argument: ${flag}`);
			const value = inline ?? args[++i];
			if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
			const duplicate = (lookup: keyof CliArgs) => out[lookup] !== undefined;
			if (numericKey) {
				if (duplicate(numericKey)) throw new Error(`${flag} was supplied more than once`);
				const [min, max] = ranges[numericKey]!;
				const n = Number(value);
				if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid ${flag}`);
				out[numericKey] = n;
			} else if (textualKey) {
				if (duplicate(textualKey)) throw new Error(`${flag} was supplied more than once`);
				out[textualKey] = value;
			}
		} else if (!out.url && out.command === "run") out.url = arg;
		else throw new Error(`Unexpected argument: ${arg}`);
	}
	return out;
}

export function profileFromArgs(args: CliArgs, settings: Settings): AgentProfile | undefined {
	// A trusted custom wrapper may reuse the removed name.
	if (args.agent === REMOVED_AGENT && !settings.adapters[REMOVED_AGENT])
		throw new Error(REMOVED_AGENT_ERROR);
	const previous = settings.selected;
	const agent = args.agent ?? previous?.agent;
	if (!agent) return undefined;
	if (args.agent && args.agent !== previous?.agent && !args.model)
		throw new Error("Changing agent requires --model (or choose both in ytd settings)");
	const changed = agent !== previous?.agent;
	const model = args.model ?? (!changed ? previous?.model : undefined);
	if (!model) throw new Error("Select a model with --model or ytd settings");
	const custom = settings.adapters[agent];
	const profile: AgentProfile = {
		agent,
		model,
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

// Fallback effort names for harnesses without per-model variants. OpenCode has none: only the
// variants its model metadata lists are offered, because it rejects every other value.
export const EFFORTS: Record<string, string[]> = {
	claude: ["low", "medium", "high", "xhigh", "max"],
	codex: ["none", "minimal", "low", "medium", "high", "xhigh"],
	pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
};

/** Context windows are shown only when the harness reports one. */
const contextHint = (tokens?: number) =>
	tokens === undefined
		? undefined
		: `${
				tokens >= 1_000_000
					? `${Number((tokens / 1_000_000).toFixed(1))}M`
					: `${Math.round(tokens / 1000)}k`
			} context`;

const connectedNames = (providers: OpencodeProvider[]) =>
	providers
		.filter((provider) => provider.connected)
		.map((provider) => provider.name)
		.join(", ");

/** Reads OpenCode's providers; a failed read is reported, never treated as "none connected". */
async function inspectProviders(
	onboarding: OpencodeOnboarding
): Promise<OpencodeProvider[] | undefined> {
	let inspection: OpencodeInspection;
	try {
		inspection = await onboarding.inspect();
	} catch (error) {
		inspection = { standalone: false, error: (error as Error).message };
	}
	if (!inspection.providers) {
		console.log(`OpenCode: ${inspection.error ?? "providers are unavailable"}.`);
		return undefined;
	}
	if (inspection.providers.some((provider) => provider.connected))
		console.log(`OpenCode providers: ${connectedNames(inspection.providers)}.`);
	return inspection.providers;
}

/**
 * Runs OpenCode's own login, which adds or refreshes one provider, then re-reads what OpenCode
 * reports instead of assuming it succeeded. ytd never reads or stores credentials, and nothing is
 * saved until a selection completes.
 */
async function connectProvider(
	onboarding: OpencodeOnboarding
): Promise<OpencodeProvider[] | undefined> {
	let code: number;
	try {
		code = await onboarding.login();
	} catch (error) {
		console.log(`OpenCode: login could not start: ${(error as Error).message}.`);
		code = 1;
	}
	const providers = await inspectProviders(onboarding);
	if (code !== 0)
		console.log(
			"OpenCode: login did not complete; saved settings are unchanged. Connect later with: opencode auth login"
		);
	else if (providers && !providers.some((provider) => provider.connected))
		console.log(
			"OpenCode: login finished without a connected provider; saved settings are unchanged."
		);
	return providers;
}

/** Shows connected providers and, when none is connected, offers OpenCode's own login. */
async function prepareOpencode(
	ui: Picker,
	onboarding: OpencodeOnboarding
): Promise<OpencodeProvider[] | undefined> {
	const providers = await inspectProviders(onboarding);
	if (!providers || providers.some((provider) => provider.connected)) return providers;
	const action = await ui.select(
		"No OpenCode provider is connected",
		[
			{ value: "login", label: "Connect a provider now", hint: "runs opencode auth login" },
			{
				value: "skip",
				label: "Enter a model ID instead",
				hint: "connect later: opencode auth login"
			}
		],
		"login"
	);
	if (action === "login") return connectProvider(onboarding);
	console.log("OpenCode: no provider connected. Connect one with: opencode auth login");
	return providers;
}

async function chooseProfile(
	config: Settings,
	ui: Picker,
	models: typeof discoverModels,
	installed: (name: string) => boolean,
	onboarding: OpencodeOnboarding = opencodeOnboarding
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
						hint: config.adapters[value] ? "trusted wrapper" : "headless"
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
	// OpenCode lists models only for connected providers, so it is prepared before discovery.
	let providers = agent === "opencode" ? await prepareOpencode(ui, onboarding) : undefined;
	let suggestions = await models(agent);
	const recent = config.recent.filter((p) => p.agent === agent);
	const merged = () =>
		new Map<string, ModelSuggestion>(
			[...recent.map((p) => ({ id: p.model, contextTokens: p.contextTokens })), ...suggestions].map(
				(m) => [m.id, m]
			)
		);
	let model: string;
	let offered: ModelSuggestion[];
	for (;;) {
		const unique = merged();
		// Only OpenCode reports many providers for one agent; other pickers stay one flat list.
		const groups = agent === "opencode" ? providerGroups([...unique.values()]) : undefined;
		const initialProvider = providers?.find((provider) => provider.connected)?.id;
		const provider = groups
			? await ui.select(
					"Provider",
					groups.map((group) => {
						const entry = providers?.find((candidate) => candidate.id === group.id);
						return {
							value: group.id,
							label: entry?.name ?? group.id,
							// Connection state only as OpenCode reports it; a listed model is not entitlement.
							hint: [
								`${group.models.length} model${group.models.length === 1 ? "" : "s"}`,
								entry ? (entry.connected ? "connected" : "not connected") : undefined
							]
								.filter(Boolean)
								.join(" · ")
						};
					}),
					groups.some((group) => group.id === initialProvider) ? initialProvider : undefined,
					true
				)
			: undefined;
		const options = [...unique.values()].filter(
			(option) => !provider || providerOf(option.id) === provider
		);
		const savedModel = config.selected?.agent === agent ? config.selected.model : undefined;
		const modelChoice = await ui.select(
			"Model",
			options
				.map((option) => {
					const label =
						option.label ?? suggestions.find((s) => s.id === option.id)?.label ?? option.id;
					return {
						value: option.id,
						label,
						hint: [
							// A display name never hides the exact ID that is saved and searched.
							label === option.id ? undefined : option.id,
							contextHint(option.contextTokens),
							recent.some((p) => p.model === option.id) ? "recent" : undefined,
							option.hint ?? "suggestion; availability depends on your account"
						]
							.filter(Boolean)
							.join(" · ")
					};
				})
				.concat([
					{
						value: "__exact__",
						label: "Enter exact model ID",
						hint: "Any text model supported by this agent and account"
					},
					// A dynamic catalog can change while ytd is open; re-read it without restarting.
					...(agent === "opencode"
						? [
								{
									value: "__connect__",
									label: "Connect another provider",
									hint: "runs opencode auth login to add or refresh one provider"
								},
								{
									value: "__refresh__",
									label: "Refresh model catalog",
									hint: "Re-read providers and models from OpenCode"
								}
							]
						: [])
				]),
			options.some((option) => option.id === savedModel) ? savedModel : undefined,
			true
		);
		if (modelChoice === "__refresh__" || modelChoice === "__connect__") {
			providers =
				modelChoice === "__connect__"
					? await connectProvider(onboarding)
					: await inspectProviders(onboarding);
			suggestions = await models(agent);
			continue;
		}
		offered = [...unique.values()];
		model = modelChoice === "__exact__" ? (await ui.text("Exact model ID")).trim() : modelChoice;
		break;
	}
	// Only variants the model lists are offered; OpenCode rejects everything else at preflight.
	const variants =
		offered.find((m) => m.id === model)?.variants ?? (agent === "opencode" ? [] : undefined);
	// An OpenCode model ID ending in #variant already selects its variant.
	const effortChoice =
		agent === "opencode" && model.includes("#")
			? "__default__"
			: await ui.select(
					"Effort",
					[
						{ value: "__default__", label: "Use configured agent default" },
						...(variants ?? EFFORTS[agent] ?? []).map((value) => ({ value, label: value })),
						{ value: "__exact__", label: "Enter exact effort/variant" }
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
	const contextTokens = previous
		? previous.contextTokens
		: offered.find((m) => m.id === model)?.contextTokens;
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
	"Usage: ytd [youtube-url] [--agent NAME --model ID] [--effort LEVEL]\n       ytd settings | ytd agents add\nAdvanced: --context-tokens N --timeout-ms N --fetch-concurrency N --extract-concurrency N\n          --fetch-pacing-ms N --max-attempts N --perf --verbose\nOptional local transcription (off by default): --transcribe --whisper-command PATH --whisper-model PATH\nNon-interactive runs require a URL and a saved or explicit agent/model.";

export async function resolveCli(
	argv = process.argv.slice(2),
	options: {
		interactive?: boolean;
		path?: string;
		ui?: Picker;
		models?: typeof discoverModels;
		installed?: (name: string) => boolean;
		onboarding?: OpencodeOnboarding;
	} = {}
): Promise<{
	url: string;
	profile: AgentProfile;
	replaceRouting: boolean;
	run: RunSettings;
} | null> {
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
	const onboarding = options.onboarding ?? opencodeOnboarding;
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
	if (args.command === "settings")
		profile = await chooseProfile(config, ui, models, installed, onboarding);
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
			profile = await chooseProfile(config, ui, models, installed, onboarding);
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
	return {
		url: url!.trim(),
		profile,
		replaceRouting,
		run: {
			replaceRouting,
			concurrency: {
				...(args.fetchConcurrency !== undefined ? { fetch: args.fetchConcurrency } : {}),
				...(args.extractConcurrency !== undefined ? { extract: args.extractConcurrency } : {}),
				...(args.fetchPacingMs !== undefined ? { fetchPacingMs: args.fetchPacingMs } : {}),
				...(args.maxAttempts !== undefined ? { maxAttempts: args.maxAttempts } : {})
			},
			perf: args.perf ?? false,
			verbose: args.verbose ?? false,
			transcription: args.transcribe
				? {
						enabled: true,
						...(args.whisperCommand !== undefined ? { command: args.whisperCommand } : {}),
						...(args.whisperModel !== undefined ? { model: args.whisperModel } : {})
					}
				: undefined
		}
	};
}
