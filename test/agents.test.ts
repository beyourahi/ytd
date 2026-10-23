import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	agentPrompt,
	CODEX_DISABLED_FEATURES,
	commandFor,
	parseAgentOutput,
	preflight,
	routingSnapshot,
	type AgentProfile
} from "../src/agents.ts";
import { runCommand, type CommandResult } from "../src/process.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const commandResult = (stdout: string, code = 0, stderr = ""): CommandResult => ({
	stdout,
	stderr,
	code,
	cancelled: false,
	timedOut: false,
	overflow: false
});
const profile = (agent: string): AgentProfile => ({ agent, model: "test-model" });
const protocols: Record<string, unknown[]> = {
	claude: [
		{
			type: "result",
			subtype: "success",
			is_error: false,
			result: "answer: usage limit",
			model: "test-model"
		}
	],
	codex: [
		{ type: "thread.started" },
		{ type: "item.completed", item: { type: "agent_message", text: "answer: usage limit" } },
		{ type: "turn.completed" }
	],
	pi: [
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "answer: usage limit" }],
				stopReason: "stop",
				model: "test-model"
			}
		},
		{ type: "agent_end", willRetry: false },
		{ type: "agent_settled", aborted: false }
	],
	opencode: [
		{ type: "text", part: { text: "answer: usage limit" } },
		{ type: "step_finish", part: { reason: "stop" } }
	]
};
const encoded = (agent: string, events = protocols[agent]) =>
	agent === "claude" ? JSON.stringify(events) : events.map((e) => JSON.stringify(e)).join("\n");

describe("completion protocols", () => {
	for (const agent of Object.keys(protocols)) {
		test(`${agent}: requires completion, successful exit and valid output`, () => {
			const p = profile(agent);
			const success = parseAgentOutput(p, commandResult(encoded(agent)));
			expect(success.ok).toBe(true);
			expect(success.limited).toBeUndefined();
			expect(success.text).toContain("usage limit");
			expect(parseAgentOutput(p, commandResult(encoded(agent), 9)).ok).toBe(false);
			expect(parseAgentOutput(p, commandResult("not json")).ok).toBe(false);
			expect(parseAgentOutput(p, commandResult(encoded(agent, []))).ok).toBe(false);
		});
	}
	test("quota and auth are classified from failures only", () => {
		expect(
			parseAgentOutput(
				profile("codex"),
				commandResult('{"type":"turn.failed","error":{"message":"rate limit 429"}}')
			).kind
		).toBe("quota");
		expect(
			parseAgentOutput(
				profile("claude"),
				commandResult('{"type":"result","is_error":true,"result":"authentication required"}')
			).kind
		).toBe("auth");
		expect(parseAgentOutput(profile("pi"), commandResult("", 1, "401 unauthorized")).kind).toBe(
			"auth"
		);
	});
	test("Claude failure errors arrays classify quota/auth; malformed messages fail safely", () => {
		for (const [errors, kind] of [
			[["Rate limit reached"], "quota"],
			[["Authentication required"], "auth"],
			[{ message: "quota" }, "protocol"],
			[[42], "protocol"]
		] as const) {
			const result = parseAgentOutput(
				profile("claude"),
				commandResult(
					JSON.stringify({
						type: "result",
						is_error: true,
						subtype: "error_during_execution",
						errors
					})
				)
			);
			expect(result.ok).toBe(false);
			expect(result.kind).toBe(kind);
		}
		for (const raw of ["null", "42", '"text"', '[{"type":42}]'])
			expect(parseAgentOutput(profile("claude"), commandResult(raw)).kind).toBe("protocol");
	});
	test("OpenCode nested error envelopes classify quota and provider authentication", () => {
		for (const [error, kind] of [
			[{ name: "APIError", data: { message: "Rate limit reached", statusCode: 429 } }, "quota"],
			[{ name: "ProviderAuthError", data: { message: "Credentials unavailable" } }, "auth"],
			[{ name: "APIError", data: { statusCode: 401 } }, "auth"],
			[{ name: "APIError", data: { message: { raw: "untrusted" } } }, "process"]
		] as const) {
			const result = parseAgentOutput(
				profile("opencode"),
				commandResult(JSON.stringify({ type: "error", error }))
			);
			expect(result.kind).toBe(kind);
			expect(result.ok).toBe(false);
			expect(result.limited).toBe(kind === "quota");
		}
	});
	test("reported model mismatch and attempted tools fail closed", () => {
		expect(
			parseAgentOutput(
				profile("claude"),
				commandResult('{"type":"result","is_error":false,"result":"answer","model":"other"}')
			).kind
		).toBe("model");
		expect(
			parseAgentOutput(
				profile("codex"),
				commandResult(
					encoded("codex", [
						...protocols.codex,
						{ type: "item.completed", item: { type: "command_execution" } }
					])
				)
			).kind
		).toBe("restriction");
		expect(
			parseAgentOutput(profile("pi"), commandResult(encoded("pi", protocols.pi.slice(0, -1)))).ok
		).toBe(false);
	});
	test("Claude aliases retain requested and reported identities separately", () => {
		const result = parseAgentOutput(
			{ agent: "claude", model: "opus" },
			commandResult(
				'{"type":"result","is_error":false,"result":"answer","modelUsage":{"claude-opus-4-6":{}}}'
			)
		);
		expect(result).toMatchObject({
			ok: true,
			requestedModel: "opus",
			reportedModel: "claude-opus-4-6"
		});
	});
});

describe("subprocess lifecycle", () => {
	test("drains large stderr concurrently with stdout and stdin", async () => {
		const r = await runCommand(
			[
				process.execPath,
				"-e",
				'process.stderr.write("x".repeat(2_000_000));console.log("ok");process.stdin.resume()'
			],
			{ input: "p".repeat(2_000_000), timeoutMs: 5000 }
		);
		expect(r.code).toBe(0);
		expect(r.stdout.trim()).toBe("ok");
		expect(r.stderr.length).toBe(2_000_000);
	});
	test("timeout, cancellation and output overflow are distinct failures", async () => {
		const command = [process.execPath, "-e", "setInterval(()=>{},1000)"];
		expect((await runCommand(command, { timeoutMs: 50 })).timedOut).toBe(true);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 50);
		expect((await runCommand(command, { signal: controller.signal })).cancelled).toBe(true);
		expect(
			(
				await runCommand([process.execPath, "-e", 'console.log("x".repeat(50000))'], {
					maxOutputBytes: 100
				})
			).overflow
		).toBe(true);
		expect((await runCommand(["/does-not-exist-ytd"])).code).toBe(-1);
	});
});

test("fake built-in harnesses enforce capabilities and return their supported protocols", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ytd-agents-"));
	dirs.push(dir);
	const oldPath = process.env.PATH;
	const oldOutput = process.env.YTD_TEST_OUTPUT;
	try {
		process.env.PATH = `${dir}:${oldPath}`;
		for (const agent of Object.keys(protocols)) {
			const script = join(dir, agent);
			writeFileSync(
				script,
				`#!${process.execPath}
const args=process.argv.slice(2);
if(args.includes("--help")) console.log(${JSON.stringify("--tools --strict-mcp-config --mcp-config --settings --permission-prompts --sandbox --json --ephemeral --config --no-tools --no-extensions --no-mcp --no-context-files --format --model --pure --agent")});
else if(args.includes("features")) console.log(${JSON.stringify(CODEX_DISABLED_FEATURES.map((n) => `${n} stable false`).join("\n"))});
else if(args.includes("mcp")) {
 if(process.env.YTD_TEST_MCP_MALFORMED) console.log('[{"name":42}]');
 else {
  const table=args.find(arg=>arg.startsWith("mcp_servers="));
  const config=table ? Bun.TOML.parse(table).mcp_servers : {};
  console.log(JSON.stringify(["plain","server.with.dot",'quoted"name'].map(name=>({name,enabled:process.env.YTD_TEST_MCP_IGNORES ? true : config[name]?.enabled!==false}))));
 }
}
else if(args.includes("config")){let p=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT||"{}");console.log(JSON.stringify({...p,mcp:p.mcp||{}}))}
else{process.stdin.resume();process.stdin.on("end",()=>console.log(process.env.YTD_TEST_OUTPUT))}
`
			);
			chmodSync(script, 0o700);
			process.env.YTD_TEST_OUTPUT = encoded(agent);
			expect(routingSnapshot(profile(agent)).executable).toBe(realpathSync(script));
			const selected = await preflight(profile(agent));
			expect(selected.routing?.executable).toBe(realpathSync(script));
			if (agent === "codex") {
				expect(selected.routing?.mcpServers).toEqual(["plain", 'quoted"name', "server.with.dot"]);
				const table = commandFor(selected).argv.find((arg) => arg.startsWith("mcp_servers="))!;
				expect(Bun.TOML.parse(table)).toEqual({
					mcp_servers: {
						plain: { enabled: false },
						'quoted"name': { enabled: false },
						"server.with.dot": { enabled: false }
					}
				});
				try {
					process.env.YTD_TEST_MCP_IGNORES = "1";
					await expect(preflight(profile("codex"))).rejects.toThrow(
						"every configured MCP server is disabled"
					);
					delete process.env.YTD_TEST_MCP_IGNORES;
					process.env.YTD_TEST_MCP_MALFORMED = "1";
					await expect(preflight(profile("codex"))).rejects.toThrow("metadata is malformed");
				} finally {
					delete process.env.YTD_TEST_MCP_IGNORES;
					delete process.env.YTD_TEST_MCP_MALFORMED;
				}
			}
			const result = await agentPrompt("source", selected);
			expect(result.error ?? result.ok).toBe(true);
			expect(result.text).toBe("answer: usage limit");
			writeFileSync(script, "#!/does-not-exist\n");
			expect((await agentPrompt("source", selected)).kind).toBe("routing");
		}
		writeFileSync(join(dir, "pi"), `#!${process.execPath}\nconsole.log("old unsupported CLI");\n`);
		await expect(preflight(profile("pi"))).rejects.toThrow("required restrictions");
	} finally {
		process.env.PATH = oldPath;
		if (oldOutput === undefined) delete process.env.YTD_TEST_OUTPUT;
		else process.env.YTD_TEST_OUTPUT = oldOutput;
	}
});

test("custom executable/argv never becomes a shell command and passes model/effort explicitly", async () => {
	const selected = await preflight({
		agent: "wrapper",
		model: "literal $(touch /never)",
		effort: "high",
		custom: {
			executable: process.execPath,
			args: ["-e", 'console.log(process.env.YTD_MODEL+"/"+process.env.YTD_EFFORT)'],
			modelEnv: "YTD_MODEL",
			effortEnv: "YTD_EFFORT"
		}
	});
	expect((await agentPrompt("input", selected)).text?.trim()).toBe("literal $(touch /never)/high");
	await expect(
		preflight({
			agent: "wrapper",
			model: "test",
			custom: { executable: process.execPath, args: [] }
		})
	).rejects.toThrow("must pass the selected model");
	const codex = commandFor(profile("codex")).argv;
	expect(codex).toContain("read-only");
	expect(codex).toContain("mcp_servers={}");
	expect(codex).toContain('web_search="disabled"');
	expect(codex).toContain("features.shell_tool=false");
});
