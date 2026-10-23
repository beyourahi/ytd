import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RUN_DIR } from "./config.ts";
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
				...(process.env.OPENCODE_CONFIG ? [process.env.OPENCODE_CONFIG] : [])
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
			opencode: ["--format", "--model", "--pure", "--agent"]
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
		if (profile.agent === "opencode") {
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
		)
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
		if (profile.agent === "codex" && !Array.isArray(profile.routing.mcpServers))
			return failure(
				profile,
				"Codex profile must verify disabled MCP servers before execution",
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
