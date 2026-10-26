import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { OPENCODE_CONFIG_HOME, RUN_DIR } from "./config.ts";
import { runCommand, type CommandResult } from "./process.ts";

export const BUILT_INS = ["claude", "codex", "pi", "opencode"] as const;
export interface CustomAdapter {
	executable: string;
	args: string[];
	modelEnv?: string;
	effortEnv?: string;
}
export interface RoutingSnapshot {
	fingerprint: string;
	executable: string;
	verified: false;
	mcpServers?: string[];
	/** OpenCode 2 runs a private --standalone server and takes variants as model#variant. */
	protocol?: "opencode-v2";
}
export interface AgentProfile {
	agent: string;
	model: string;
	effort?: string;
	contextTokens?: number;
	timeoutMs?: number;
	custom?: CustomAdapter;
	routing?: RoutingSnapshot;
}
export interface AgentResult {
	ok: boolean;
	text?: string;
	limited?: boolean;
	error?: string;
	kind?:
		| "quota"
		| "auth"
		| "timeout"
		| "cancelled"
		| "protocol"
		| "model"
		| "restriction"
		| "process"
		| "routing";
	requestedModel: string;
	reportedModel?: string;
}

export function validateProfile(value: unknown): value is AgentProfile {
	if (!value || typeof value !== "object") return false;
	const p = value as AgentProfile;
	if (
		typeof p.agent !== "string" ||
		!p.agent.trim() ||
		typeof p.model !== "string" ||
		!p.model.trim()
	)
		return false;
	if (p.effort !== undefined && (typeof p.effort !== "string" || !p.effort.trim())) return false;
	if (
		[p.agent, p.model, p.effort ?? ""].some(
			(field) => /\p{Cc}/u.test(field) || field.startsWith("-")
		)
	)
		return false;
	if (
		p.contextTokens !== undefined &&
		(!Number.isSafeInteger(p.contextTokens) || p.contextTokens < 4096)
	)
		return false;
	if (p.timeoutMs !== undefined && (!Number.isSafeInteger(p.timeoutMs) || p.timeoutMs <= 0))
		return false;
	if (!BUILT_INS.includes(p.agent as (typeof BUILT_INS)[number]) && !p.custom) return false;
	if (p.custom) {
		if (
			typeof p.custom.executable !== "string" ||
			!p.custom.executable.trim() ||
			!Array.isArray(p.custom.args) ||
			!p.custom.args.every((a) => typeof a === "string")
		)
			return false;
		for (const key of [p.custom.modelEnv, p.custom.effortEnv])
			if (key !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return false;
		if (BUILT_INS.includes(p.agent as (typeof BUILT_INS)[number])) return false;
	}
	return true;
}

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function configPaths(agent: string): string[] {
	const home = homedir();
	switch (agent) {
		case "claude":
			return [join(process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "settings.json")];
		case "codex":
			return [
				join(process.env.CODEX_HOME ?? join(home, ".codex"), "config.toml"),
				"/etc/codex/managed_config.toml",
				"/Library/Application Support/Codex/config.toml"
			];
		case "pi":
			return [
				join(process.env.PI_CODING_AGENT_DIR ?? join(home, ".pi/agent"), "settings.json"),
				join(process.env.PI_CODING_AGENT_DIR ?? join(home, ".pi/agent"), "models.json")
			];
		case "opencode":
			return [
				join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "opencode/opencode.json"),
				join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "opencode/opencode.jsonc"),
				...(process.env.OPENCODE_CONFIG ? [process.env.OPENCODE_CONFIG] : []),
				// OpenCode 2 runs load the ytd-owned config home and OPENCODE_CONFIG_DIR instead; only
				// existing files count, so saved fingerprints without them stay valid.
				...[join(OPENCODE_CONFIG_HOME, "opencode"), process.env.OPENCODE_CONFIG_DIR]
					.filter((dir): dir is string => Boolean(dir))
					.flatMap((dir) => [join(dir, "opencode.json"), join(dir, "opencode.jsonc")])
					.filter((path) => existsSync(path))
			];
		default:
			return [];
	}
}

export function routingSnapshot(profile: AgentProfile): RoutingSnapshot {
	const executable = Bun.which(profile.custom?.executable ?? profile.agent, {
		PATH: process.env.PATH
	});
	if (!executable)
		throw new Error(
			`${profile.agent} executable is unavailable; install/configure it separately. No fallback was selected.`
		);
	const actual = realpathSync(executable);
	const files = configPaths(profile.agent).map((path) => [
		path,
		existsSync(path) ? hash(readFileSync(path)) : "missing"
	]);
	const routingEnv = Object.entries(process.env)
		.filter(([key]) =>
			/^(ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_|PI_|OPENCODE_|AWS_|AZURE_|GOOGLE_|VERTEX_|XDG_CONFIG_HOME$)/.test(
				key
			)
		)
		.map(([key, value]) => [key, hash(value ?? "")]);
	const binary = statSync(actual);
	return {
		executable: actual,
		fingerprint: hash(
			JSON.stringify([
				actual,
				binary.size,
				binary.mtimeMs,
				binary.ino,
				files,
				routingEnv,
				profile.custom
			])
		),
		verified: false
	};
}

export const CODEX_DISABLED_FEATURES = [
	// shell_tool gates both exec_command and write_stdin; unified_exec opt-outs are ignored.
	"shell_tool",
	"multi_agent",
	"apps",
	"plugins",
	"hooks",
	"shell_snapshot",
	"browser_use",
	"computer_use",
	"image_generation",
	"code_mode",
	"js_repl",
	"in_app_browser"
];

function codexOverrides(mcpServers: string[] = []): string[] {
	const values = [
		'approval_policy="never"',
		'web_search="disabled"',
		`mcp_servers={${mcpServers.map((name) => `${JSON.stringify(name)}={enabled=false}`).join(",")}}`,
		"tools.view_image=false",
		...CODEX_DISABLED_FEATURES.map((key) => `features.${key}=false`)
	];
	return values.flatMap((value) => ["-c", value]);
}

async function codexMcpServers(
	executable: string,
	overrides: string[]
): Promise<{ name: string; enabled: boolean }[]> {
	// List configured metadata only; never connect servers or expose transport/auth fields.
	const result = await runCommand([executable, ...overrides, "mcp", "list", "--json"], {
		cwd: RUN_DIR,
		timeoutMs: 15000
	});
	if (result.code !== 0 || result.overflow || result.cancelled || result.timedOut)
		throw new Error("Codex MCP configuration could not be inspected safely");
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		throw new Error("Codex MCP configuration is malformed");
	}
	if (
		!Array.isArray(parsed) ||
		!parsed.every(
			(server) =>
				server &&
				typeof server === "object" &&
				typeof server.name === "string" &&
				server.name.length > 0 &&
				typeof server.enabled === "boolean"
		)
	)
		throw new Error("Codex MCP configuration metadata is malformed");
	if (new Set(parsed.map((server) => server.name)).size !== parsed.length)
		throw new Error("Codex MCP configuration contains duplicate names");
	return parsed.map((server) => ({ name: server.name, enabled: server.enabled }));
}

export function commandFor(profile: AgentProfile): { argv: string[]; env?: NodeJS.ProcessEnv } {
	const model = profile.model;
	const effort = profile.effort;
	if (profile.custom) {
		const custom = profile.custom;
		const env = { ...process.env };
		if (custom.modelEnv) env[custom.modelEnv] = model;
		if (custom.effortEnv && effort) env[custom.effortEnv] = effort;
		return {
			argv: [
				custom.executable,
				...custom.args.map((arg) =>
					arg.replaceAll("{model}", model).replaceAll("{effort}", effort ?? "")
				)
			],
			env
		};
	}
	switch (profile.agent) {
		case "claude":
			return {
				argv: [
					"claude",
					"-p",
					"--model",
					model,
					"--output-format",
					"json",
					"--tools",
					"",
					"--strict-mcp-config",
					"--mcp-config",
					'{"mcpServers":{}}',
					"--disable-slash-commands",
					"--no-chrome",
					"--no-session-persistence",
					"--permission-mode",
					"dontAsk",
					"--permission-prompts",
					"none",
					"--settings",
					'{"disableAllHooks":true}',
					...(effort ? ["--effort", effort] : [])
				]
			};
		case "codex":
			return {
				argv: [
					"codex",
					"exec",
					"--json",
					"--ephemeral",
					"--sandbox",
					"read-only",
					"--skip-git-repo-check",
					"--color",
					"never",
					"--model",
					model,
					...codexOverrides(profile.routing?.mcpServers),
					...(effort ? ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
					"-"
				]
			};
		case "pi":
			return {
				argv: [
					"pi",
					"--print",
					"--mode",
					"json",
					"--model",
					model,
					"--no-session",
					"--no-tools",
					"--no-extensions",
					"--no-mcp",
					"--no-skills",
					"--no-prompt-templates",
					"--no-context-files",
					"--offline",
					...(effort ? ["--thinking", effort] : [])
				]
			};
		case "opencode":
			if (profile.routing?.protocol === "opencode-v2")
				return {
					argv: [
						"opencode",
						"run",
						"--standalone",
						"--format",
						"json",
						"--agent",
						"ytd",
						"--model",
						effort ? `${model}#${effort}` : model
					],
					env: opencodeV2Env(profile.routing.mcpServers)
				};
			return {
				argv: [
					"opencode",
					"run",
					"--pure",
					"--agent",
					"ytd",
					"--format",
					"json",
					"--model",
					model,
					...(effort ? ["--variant", effort] : [])
				],
				env: {
					...process.env,
					OPENCODE_CONFIG_CONTENT: JSON.stringify({
						...parseInlineConfig(),
						permission: "deny",
						mcp: Object.fromEntries(
							(profile.routing?.mcpServers ?? []).map((name) => [name, { enabled: false }])
						),
						tools: { "*": false },
						agent: { ytd: { mode: "primary", permission: "deny", tools: { "*": false } } },
						default_agent: "ytd"
					})
				}
			};
		default:
			throw new Error(`Unknown agent: ${profile.agent}`);
	}
}

function parseInlineConfig(): Record<string, unknown> {
	if (!process.env.OPENCODE_CONFIG_CONTENT) return {};
	const parsed: unknown = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("OPENCODE_CONFIG_CONTENT must be a JSON object");
	return parsed as Record<string, unknown>;
}

const DENY_ALL = [{ action: "*", resource: "*", effect: "deny" }];
/** v2 resolves its location from PWD, so pin it to the neutral run directory. */
function opencodeV2Env(mcpServers: string[] = []): NodeJS.ProcessEnv {
	mkdirSync(OPENCODE_CONFIG_HOME, { recursive: true });
	return {
		...process.env,
		PWD: RUN_DIR,
		XDG_CONFIG_HOME: OPENCODE_CONFIG_HOME,
		OPENCODE_CONFIG_CONTENT: JSON.stringify({
			...parseInlineConfig(),
			permissions: DENY_ALL,
			websearch: false,
			// A complete inert entry: partial server entries make OpenCode drop the whole inline config.
			mcp: {
				servers: Object.fromEntries(
					mcpServers.map((name) => [name, { type: "local", command: ["false"], disabled: true }])
				)
			},
			agents: {
				ytd: { mode: "primary", description: "ytd text completion", permissions: DENY_ALL }
			},
			default_agent: "ytd"
		})
	};
}

export const OPENCODE_V2 = { verifyMs: 30_000 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Configured MCP names from every config source. Listing sources starts no MCP server or
 * plugin, so declared plugins are refused here, before any OpenCode server would load them.
 */
async function opencodeV2McpNames(executable: string): Promise<string[]> {
	const result = await runCommand([executable, "api", "--standalone", "GET", "/api/config"], {
		cwd: RUN_DIR,
		env: opencodeV2Env(),
		timeoutMs: 30000
	});
	let sources: unknown;
	try {
		sources = JSON.parse(result.stdout);
	} catch {
		sources = undefined;
	}
	if (result.code !== 0 || !Array.isArray(sources))
		throw new Error("OpenCode configuration sources are unavailable; cannot restrict MCP");
	if (!sources.some((source) => source?.info?.agents?.ytd))
		throw new Error("OpenCode did not load the restricted inline configuration");
	const declared = sources.filter(
		(source) =>
			[source?.info?.plugins, source?.info?.plugin].some(
				(list) => Array.isArray(list) && list.length
			) ||
			(source?.type === "directory" &&
				typeof source.path === "string" &&
				["plugins", "plugin"].some((sub) => {
					try {
						return readdirSync(join(source.path, sub)).length > 0;
					} catch {
						return false;
					}
				}))
	);
	if (declared.length)
		throw new Error(
			`OpenCode configuration declares external plugins (${declared.map((s) => s.path ?? "inline").join(", ")}), which OpenCode 2 cannot disable per run`
		);
	const names = sources.flatMap((source) => Object.keys(source?.info?.mcp?.servers ?? {}));
	return [...new Set(names)].sort();
}

/**
 * Proves isolation on a private server with the exact run configuration, without a model
 * request: the ytd agent denies every action, every MCP server is disabled, and only built-in
 * plugins load (v2 has no switch that disables external plugins).
 */
async function verifyOpencodeV2(
	executable: string,
	mcpServers: string[],
	model: string,
	effort?: string
): Promise<void> {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
	const port = probe.port;
	probe.stop(true);
	const password = crypto.randomUUID();
	const child = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
		cwd: RUN_DIR,
		env: { ...opencodeV2Env(mcpServers), OPENCODE_SERVER_PASSWORD: password },
		stdio: "ignore",
		detached: process.platform !== "win32"
	});
	let exited = false;
	const exit = new Promise<void>((resolve) =>
		child.once("exit", () => {
			exited = true;
			resolve();
		})
	);
	child.on("error", () => {});
	const get = async (path: string): Promise<any[]> => {
		const response = await fetch(
			`http://127.0.0.1:${port}${path}?location%5Bdirectory%5D=${encodeURIComponent(RUN_DIR)}`,
			{
				headers: { authorization: `Basic ${btoa(`opencode:${password}`)}` },
				signal: AbortSignal.timeout(5000)
			}
		);
		const body: any = await response.json();
		if (!response.ok || !Array.isArray(body?.data)) throw new Error(`OpenCode ${path} failed`);
		return body.data;
	};
	const deadline = Date.now() + OPENCODE_V2.verifyMs;
	try {
		let agent: any;
		let state = "";
		let snapshot: { mcp: any[]; plugins: any[]; models: any[] } | undefined;
		// Locations load asynchronously: wait for the ytd agent, then for a stable MCP/plugin view.
		while (Date.now() < deadline) {
			if (exited) throw new Error("OpenCode verification server exited before proving isolation");
			try {
				agent ??= (await get("/api/agent")).find((a) => a?.id === "ytd");
				if (agent) {
					const next = {
						mcp: await get("/api/mcp"),
						plugins: await get("/api/plugin"),
						models: await get("/api/model")
					};
					const serialized = JSON.stringify([next.mcp, next.plugins]);
					// Built-in plugins always load, so an empty list means plugins are still loading.
					if (
						serialized === state &&
						next.plugins.length > 0 &&
						next.mcp.length >= mcpServers.length
					) {
						snapshot = next;
						break;
					}
					state = serialized;
				}
			} catch {
				/* server still starting */
			}
			await sleep(400);
		}
		if (!agent || !snapshot)
			throw new Error("OpenCode could not prove the restricted ytd agent and MCP state in time");
		const rules: unknown = agent.permissions;
		const last = Array.isArray(rules)
			? rules.findLastIndex(
					(r: any) => r?.action === "*" && r?.resource === "*" && r?.effect === "deny"
				)
			: -1;
		// Rules are last-match-wins; a final deny-all with only denials after it denies everything.
		if (last < 0 || (rules as any[]).slice(last).some((r: any) => r?.effect !== "deny"))
			throw new Error("OpenCode could not verify that the ytd agent denies every tool");
		if (snapshot.mcp.some((server) => server?.status?.status !== "disabled"))
			throw new Error("OpenCode could not verify every configured MCP server is disabled");
		const external = snapshot.plugins.filter((plugin) => plugin?.source?.type !== "builtin");
		if (external.length)
			throw new Error(
				`OpenCode loads ${external.length} external plugin(s), which OpenCode 2 cannot disable per run; remove them from its configuration to use it with ytd`
			);
		const listed = snapshot.models.find((m) => `${m?.providerID}/${m?.id}` === model);
		if (!listed) throw new Error(`OpenCode does not offer ${model} in its resolved configuration`);
		const variants = Array.isArray(listed.variants) ? listed.variants.map((v: any) => v?.id) : [];
		if (effort && !variants.includes(effort))
			throw new Error(
				`OpenCode model ${model} has no variant ${effort}${variants.length ? `; choose ${variants.join(", ")}` : ""}`
			);
	} finally {
		const kill = (signal: NodeJS.Signals) => {
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
				else child.kill(signal);
			} catch {
				/* already exited */
			}
		};
		if (!exited) {
			kill("SIGTERM");
			await Promise.race([exit, sleep(2000)]);
			if (!exited) kill("SIGKILL");
		}
	}
}

export async function preflight(profile: AgentProfile): Promise<AgentProfile> {
	if (!validateProfile(profile)) throw new Error("Invalid agent/model settings");
	if (
		profile.custom &&
		!profile.custom.modelEnv &&
		!profile.custom.args.some((arg) => arg.includes("{model}"))
	)
		throw new Error("Custom adapter must pass the selected model through {model} or modelEnv");
	if (
		profile.custom &&
		profile.effort &&
		!profile.custom.effortEnv &&
		!profile.custom.args.some((arg) => arg.includes("{effort}"))
	)
		throw new Error("Custom adapter must pass the selected effort through {effort} or effortEnv");
	const routing = routingSnapshot(profile);
	if (profile.routing && profile.routing.fingerprint !== routing.fingerprint)
		throw new Error(
			"Agent routing configuration changed. Select the profile again to create a replacement run."
		);
	mkdirSync(RUN_DIR, { recursive: true });
	if (!profile.custom) {
		const help = await runCommand(
			[
				routing.executable,
				...(profile.agent === "codex" ? ["exec"] : profile.agent === "opencode" ? ["run"] : []),
				"--help"
			],
			{ cwd: RUN_DIR, timeoutMs: 15000 }
		);
		if (help.code !== 0) throw new Error(`${profile.agent} capability check failed`);
		const opencodeV2 = profile.agent === "opencode" && /--standalone\b/.test(help.stdout);
		const required: Record<string, string[]> = {
			claude: [
				"--tools",
				"--strict-mcp-config",
				"--mcp-config",
				"--settings",
				"--permission-prompts"
			],
			codex: ["--sandbox", "--json", "--ephemeral", "--config"],
			pi: ["--no-tools", "--no-extensions", "--no-mcp", "--no-context-files"],
			opencode: opencodeV2
				? ["--standalone", "--format", "--model", "--agent"]
				: ["--format", "--model", "--pure", "--agent"]
		};
		for (const flag of required[profile.agent])
			if (!(help.stdout + help.stderr).includes(flag))
				throw new Error(
					`${profile.agent} cannot enforce required restrictions: ${flag} is unavailable`
				);
		if (profile.agent === "codex") {
			const configured = await codexMcpServers(routing.executable, codexOverrides());
			routing.mcpServers = configured.map((server) => server.name).sort();
			if (
				profile.routing?.mcpServers &&
				JSON.stringify(profile.routing.mcpServers) !== JSON.stringify(routing.mcpServers)
			)
				throw new Error(
					"Codex MCP configuration changed; select the profile again before continuing"
				);
			const overrides = codexOverrides(routing.mcpServers);
			const isolated = await codexMcpServers(routing.executable, overrides);
			if (
				isolated.some((server) => server.enabled) ||
				JSON.stringify(isolated.map((server) => server.name).sort()) !==
					JSON.stringify(routing.mcpServers)
			)
				throw new Error("Codex could not verify every configured MCP server is disabled");
			const features = await runCommand([routing.executable, ...overrides, "features", "list"], {
				cwd: RUN_DIR,
				timeoutMs: 15000
			});
			if (
				features.code !== 0 ||
				CODEX_DISABLED_FEATURES.some(
					(name) => !new RegExp(`^${name}\\s+.*\\sfalse$`, "m").test(features.stdout)
				)
			)
				throw new Error(
					"Codex could not verify disabled command, network, integration, hook and subagent surfaces"
				);
		}
		if (opencodeV2) {
			if (!/^[^/#]+\/[^#]+(?:#[^#]+)?$/.test(profile.model))
				throw new Error("OpenCode models use provider/model, optionally provider/model#variant");
			if (profile.effort && profile.model.includes("#"))
				throw new Error("Choose the OpenCode variant once: in the model ID or as effort");
			const [model, variant] = profile.model.split("#");
			routing.protocol = "opencode-v2";
			routing.mcpServers = await opencodeV2McpNames(routing.executable);
			if (
				profile.routing?.mcpServers &&
				JSON.stringify(profile.routing.mcpServers) !== JSON.stringify(routing.mcpServers)
			)
				throw new Error(
					"OpenCode MCP configuration changed; select the profile again before continuing"
				);
			await verifyOpencodeV2(
				routing.executable,
				routing.mcpServers,
				model,
				profile.effort ?? variant
			);
		} else if (profile.agent === "opencode") {
			// Config inspection performs no model request; never log the resolved config.
			const config = await runCommand([routing.executable, "--pure", "debug", "config"], {
				cwd: RUN_DIR,
				timeoutMs: 15000
			});
			if (config.code !== 0)
				throw new Error("OpenCode effective configuration is unavailable; cannot restrict MCP");
			const effective = JSON.parse(config.stdout);
			routing.mcpServers = Object.keys(effective.mcp ?? {});
			const restricted = commandFor({ ...profile, routing });
			const check = await runCommand([routing.executable, "--pure", "debug", "config"], {
				cwd: RUN_DIR,
				env: restricted.env,
				timeoutMs: 15000
			});
			if (check.code !== 0) throw new Error("OpenCode rejected the restricted configuration");
			const isolated = JSON.parse(check.stdout);
			const denied = (value: any) =>
				value === "deny" ||
				(value?.["*"] === "deny" && Object.values(value).every((rule) => rule === "deny"));
			if (
				!denied(isolated.permission) ||
				Object.values(isolated.mcp ?? {}).some((server: any) => server.enabled !== false) ||
				!denied(isolated.agent?.ytd?.permission)
			)
				throw new Error("OpenCode could not verify denied tools and disabled MCP servers");
		}
	}
	return { ...profile, routing };
}

function failure(
	profile: AgentProfile,
	error: string,
	kind: AgentResult["kind"] = "protocol"
): AgentResult {
	if (
		/usage.?limit|rate.?limit|quota|limit reached|exceeded your|too many requests|5.hour limit|429/i.test(
			error
		)
	)
		kind = "quota";
	else if (
		/unauthori[sz]ed|auth(?:entication|error)|not logged in|invalid.?api.?key|401|403/i.test(error)
	)
		kind = "auth";
	return { ok: false, error, kind, limited: kind === "quota", requestedModel: profile.model };
}

function reportedMatches(profile: AgentProfile, reported: string): boolean {
	if (reported === profile.model) return true;
	if (profile.agent === "claude" && ["opus", "sonnet", "haiku"].includes(profile.model))
		return reported.startsWith(`claude-${profile.model}-`);
	return profile.agent === "pi" && profile.model === reported.split("/").slice(1).join("/");
}

/** Parse completion envelopes, never classify a successful answer's prose as an error. */
export function parseAgentOutput(profile: AgentProfile, result: CommandResult): AgentResult {
	if (result.cancelled)
		return failure(profile, "Agent call cancelled; progress is saved", "cancelled");
	if (result.timedOut)
		return failure(profile, "Agent call timed out; progress is saved", "timeout");
	if (result.overflow) return failure(profile, "Agent output exceeded capture limit", "process");
	let events: any[] = [];
	try {
		if (!profile.custom) {
			if (profile.agent === "claude") {
				const parsed = JSON.parse(result.stdout);
				events = Array.isArray(parsed) ? parsed : [parsed];
			} else
				events = result.stdout
					.split("\n")
					.filter((line) => line.trim())
					.map((line) => JSON.parse(line));
		}
	} catch {
		return failure(
			profile,
			result.code !== 0
				? result.stderr || `Agent exited ${result.code}`
				: "Malformed agent protocol output"
		);
	}
	if (
		events.some(
			(event) =>
				!event ||
				typeof event !== "object" ||
				Array.isArray(event) ||
				typeof event.type !== "string"
		)
	)
		return failure(profile, "Malformed agent event envelope");
	const errors = events.filter(
		(e) =>
			e?.type === "error" ||
			e?.type === "turn.failed" ||
			e?.is_error ||
			e?.message?.stopReason === "error"
	);
	if (
		errors.some(
			(event) =>
				event.errors !== undefined &&
				(!Array.isArray(event.errors) ||
					!event.errors.every((message: unknown) => typeof message === "string"))
		)
	)
		return failure(profile, "Malformed agent failure messages");
	if (result.code !== 0 || errors.length)
		return failure(
			profile,
			errors.length
				? errors
						.map(
							(e) =>
								[
									e.error?.message,
									e.error?.data?.message,
									e.error?.name,
									Number.isInteger(e.error?.data?.statusCode)
										? String(e.error.data.statusCode)
										: undefined,
									e.error?.type,
									Number.isInteger(e.error?.status) ? String(e.error.status) : undefined,
									e.message?.errorMessage,
									e.result,
									e.error?.code,
									...(e.errors ?? []),
									e.subtype
								]
									.filter((message) => typeof message === "string" && message)
									.join("; ") || "Agent failure"
						)
						.join("; ")
				: result.stderr || `Agent exited ${result.code}`,
			"process"
		);
	if (
		events.some(
			(e) =>
				e?.type === "tool_execution_start" ||
				e?.type === "tool_use" ||
				(e?.item?.type &&
					["command_execution", "mcp_tool_call", "web_search", "collab_tool_call"].includes(
						e.item.type
					)) ||
				e?.permission_denials?.length
		) ||
		// OpenCode 2 auto-rejects permission requests in run mode and reports them on stderr.
		(profile.agent === "opencode" && /permission requested:/.test(result.stderr))
	)
		return failure(
			profile,
			"Harness attempted a tool call despite required restrictions",
			"restriction"
		);
	let text: string | undefined;
	let reported: string | undefined;
	if (profile.custom) text = result.stdout;
	else if (profile.agent === "claude") {
		const end = events.findLast((e) => e?.type === "result");
		if (
			!end ||
			end.is_error !== false ||
			(end.subtype && end.subtype !== "success") ||
			typeof end.result !== "string"
		)
			return failure(profile, "Claude did not emit a successful result completion");
		text = end.result;
		const modelKeys = Object.keys(end.modelUsage ?? {});
		reported =
			typeof end.model === "string" ? end.model : modelKeys.length === 1 ? modelKeys[0] : undefined;
	} else if (profile.agent === "codex") {
		if (!events.some((e) => e?.type === "turn.completed"))
			return failure(profile, "Codex did not emit turn.completed");
		const message = events.findLast(
			(e) => e?.type === "item.completed" && e.item?.type === "agent_message"
		);
		text = message?.item?.text;
		reported = events.findLast((e) => typeof e?.model === "string")?.model;
	} else if (profile.agent === "pi") {
		const end = events.findLast((e) => e?.type === "agent_settled");
		const message = events.findLast(
			(e) => e?.type === "message_end" && e.message?.role === "assistant"
		)?.message;
		if (
			!end ||
			end.aborted !== false ||
			!message ||
			!["stop", "end_turn"].includes(message.stopReason)
		)
			return failure(
				profile,
				message?.errorMessage ?? "Pi did not emit a successful settled assistant response"
			);
		text = Array.isArray(message.content)
			? message.content
					.filter((c: any) => c?.type === "text" && typeof c.text === "string")
					.map((c: any) => c.text)
					.join("")
			: undefined;
		reported =
			typeof message.model === "string"
				? `${message.provider ? `${message.provider}/` : ""}${message.model}`
				: undefined;
	} else if (profile.agent === "opencode") {
		const end = events.findLast((e) => e?.type === "step_finish");
		if (end?.part?.reason !== "stop")
			return failure(profile, "OpenCode did not emit a successful stop completion");
		text = events
			.filter((e) => e?.type === "text" && typeof e.part?.text === "string")
			.map((e) => e.part.text)
			.join("");
		reported = events.findLast((e) => typeof e?.modelID === "string")?.modelID;
	}
	if (typeof text !== "string" || !text.trim())
		return failure(profile, "Agent completed without response text");
	if (reported && !reportedMatches(profile, reported))
		return failure(
			profile,
			`Requested model ${profile.model}, harness reported ${reported}`,
			"model"
		);
	return { ok: true, text, requestedModel: profile.model, reportedModel: reported };
}

export async function agentPrompt(
	prompt: string,
	profile: AgentProfile,
	signal?: AbortSignal
): Promise<AgentResult> {
	try {
		if (!profile.routing)
			return failure(profile, "Agent profile must pass preflight before execution", "restriction");
		if (
			(profile.agent === "codex" || profile.routing.protocol === "opencode-v2") &&
			!Array.isArray(profile.routing.mcpServers)
		)
			return failure(
				profile,
				`${profile.agent} profile must verify disabled MCP servers before execution`,
				"restriction"
			);
		if (routingSnapshot(profile).fingerprint !== profile.routing.fingerprint)
			return failure(
				profile,
				"Agent routing configuration changed; select it again to create a replacement run",
				"routing"
			);
		const command = commandFor(profile);
		command.argv[0] = profile.routing.executable;
		return parseAgentOutput(
			profile,
			await runCommand(command.argv, {
				input: prompt,
				cwd: RUN_DIR,
				env: command.env,
				timeoutMs: profile.timeoutMs,
				signal
			})
		);
	} catch (e) {
		return failure(profile, (e as Error).message, "process");
	}
}

export interface ModelSuggestion {
	id: string;
	contextTokens?: number;
	/** Model-specific reasoning variants, when the harness lists them. */
	variants?: string[];
	hint?: string;
}

/** OpenCode 2 model metadata; a listed model is not proof that this account can use it. */
export function parseOpencodeModels(stdout: string): ModelSuggestion[] {
	const parsed: any = JSON.parse(stdout);
	if (!Array.isArray(parsed?.data)) return [];
	return parsed.data
		.filter(
			(m: any) =>
				typeof m?.providerID === "string" &&
				typeof m.id === "string" &&
				m.enabled !== false &&
				m.capabilities?.input?.includes("text") !== false &&
				m.capabilities?.output?.includes("text") !== false
		)
		.map((m: any) => {
			const variants = Array.isArray(m.variants)
				? m.variants.map((v: any) => v?.id).filter((id: unknown) => typeof id === "string")
				: [];
			const free =
				Array.isArray(m.cost) &&
				m.cost.length > 0 &&
				m.cost.every((c: any) => c?.input === 0 && c?.output === 0);
			return {
				id: `${m.providerID}/${m.id}`,
				...(Number.isSafeInteger(m.limit?.context) && m.limit.context >= 4096
					? { contextTokens: m.limit.context }
					: {}),
				variants,
				hint: [
					free
						? "listed at no cost; free-tier quotas apply"
						: "listed; access depends on your account",
					...(m.status && m.status !== "active" ? [m.status] : [])
				].join(" · ")
			};
		});
}
export async function discoverModels(agent: string): Promise<ModelSuggestion[]> {
	try {
		if (agent === "claude") return ["opus", "sonnet", "haiku"].map((id) => ({ id }));
		if (agent === "codex") {
			const r = await runCommand(["codex", "debug", "models", "--bundled"], { timeoutMs: 15000 });
			if (r.code !== 0) return [];
			const parsed = JSON.parse(r.stdout);
			const models = Array.isArray(parsed) ? parsed : parsed.models;
			return models
				.filter((m: any) => typeof m.slug === "string")
				.map((m: any) => ({
					id: m.slug,
					...(Number.isSafeInteger(m.context_window) ? { contextTokens: m.context_window } : {})
				}));
		}
		if (agent === "pi") {
			const r = await runCommand(
				["pi", "--offline", "--no-extensions", "--no-mcp", "--list-models"],
				{ timeoutMs: 15000 }
			);
			return r.code === 0
				? r.stdout
						.split("\n")
						.slice(1)
						.map((line) => line.trim().split(/\s+/))
						.filter((parts) => parts.length >= 3 && !parts[0].startsWith("─"))
						.map((parts) => ({ id: `${parts[0]}/${parts[1]}` }))
				: [];
		}
		if (agent === "opencode") {
			mkdirSync(RUN_DIR, { recursive: true });
			const help = await runCommand(["opencode", "run", "--help"], {
				cwd: RUN_DIR,
				timeoutMs: 15000
			});
			// OpenCode 2: metadata from a private server, never the shared service or a model request.
			if (/--standalone\b/.test(help.stdout)) {
				const v2 = await runCommand(["opencode", "api", "--standalone", "GET", "/api/model"], {
					cwd: RUN_DIR,
					env: opencodeV2Env(),
					timeoutMs: 30000
				});
				return v2.code === 0 ? parseOpencodeModels(v2.stdout) : [];
			}
			const r = await runCommand(["opencode", "models"], { timeoutMs: 15000 });
			return r.code === 0
				? r.stdout
						.split("\n")
						.filter((id) => /^[\w.-]+\/\S+$/.test(id))
						.map((id) => ({ id }))
				: [];
		}
	} catch {
		/* discovery is a suggestion, never a model fallback */
	}
	return [];
}
