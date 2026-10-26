import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	agentPrompt,
	CODEX_DISABLED_FEATURES,
	commandFor,
	discoverModels,
	OPENCODE_V2,
	parseOpencodeModels,
	parseAgentOutput,
	preflight,
	routingSnapshot,
	type AgentProfile
} from "../src/agents.ts";
import { OPENCODE_CONFIG_HOME, RUN_DIR } from "../src/config.ts";
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

describe("OpenCode 2", () => {
	const model = "opencode/deepseek-v4.1-flash-free";
	const models = [
		{
			id: "deepseek-v4.1-flash-free",
			providerID: "opencode",
			enabled: true,
			status: "active",
			capabilities: { input: ["text", "image"], output: ["text"] },
			variants: [{ id: "low" }, { id: "high" }, { id: "max" }],
			cost: [{ input: 0, output: 0 }],
			limit: { context: 200000, output: 32000 }
		},
		{
			id: "paid-plain",
			providerID: "opencode",
			enabled: true,
			status: "beta",
			capabilities: { input: ["text"], output: ["text"] },
			variants: [],
			cost: [{ input: 1, output: 2 }],
			limit: { context: 1000, output: 1 }
		},
		{
			id: "image-only",
			providerID: "opencode",
			enabled: true,
			capabilities: { input: ["text"], output: ["image"] },
			variants: [],
			cost: [],
			limit: { context: 1000, output: 1 }
		}
	];
	const events = [
		{ type: "step_start", timestamp: 1, sessionID: "s", part: { type: "step-start" } },
		{ type: "text", timestamp: 2, sessionID: "s", part: { type: "text", text: "v2 answer" } },
		{ type: "step_finish", timestamp: 3, sessionID: "s", part: { reason: "stop" } }
	];
	// Mirrors OpenCode 2.1.4: config sources, a private authenticated server and run JSON events.
	const fake = (record: string) => `#!${process.execPath}
const args=process.argv.slice(2), env=process.env;
const config=JSON.parse(env.OPENCODE_CONFIG_CONTENT||"{}"), inline=env.YTD_TEST_IGNORE_INLINE?{}:config;
const models=${JSON.stringify(models)};
if(args[0]==="run"&&args.includes("--help")) console.log("--standalone --session --model --agent --format --auto");
else if(args[0]==="models") require("fs").writeFileSync(${JSON.stringify(record)}+".shared-models","used");
else if(args[0]==="api"&&env.YTD_TEST_API_FAIL) process.exit(2);
else if(args[0]==="api"&&args.at(-1)==="/api/config") console.log(JSON.stringify([{type:"document",path:"/cfg/opencode.json",info:{mcp:{servers:{plain:{type:"local",command:["x"]}}},...(env.YTD_TEST_DECLARED_PLUGIN?{plugins:["pkg"]}:{})}},...(env.YTD_TEST_IGNORE_INLINE?[]:[{type:"document",info:config}])]));
else if(args[0]==="api"&&args.at(-1)==="/api/model") console.log(JSON.stringify({location:{},data:models}));
else if(args[0]==="serve"){
 require("fs").writeFileSync(${JSON.stringify(record)}+".serve-pid",String(process.pid));
 if(env.YTD_TEST_SERVE_EXIT) process.exit(3);
 let pluginReads=0;
 Bun.serve({port:Number(args[args.indexOf("--port")+1]),hostname:"127.0.0.1",fetch(req){
  if(req.headers.get("authorization")!=="Basic "+btoa("opencode:"+env.OPENCODE_SERVER_PASSWORD)) return Response.json({},{status:401});
  const agents=[{id:"build",permissions:[{action:"*",resource:"*",effect:"allow"}]}];
  if(inline.agents?.ytd&&!env.YTD_TEST_NO_AGENT) agents.push({id:"ytd",permissions:[{action:"*",resource:"*",effect:"allow"},...(inline.permissions??[]),...inline.agents.ytd.permissions,...(env.YTD_TEST_ALLOW_AFTER?[{action:"shell",resource:"*",effect:"allow"}]:[])]});
  const data={"/api/agent":agents,
   "/api/mcp":["plain"].map(name=>({name,status:{status:inline.mcp?.servers?.[name]?.disabled&&!env.YTD_TEST_MCP_IGNORES?"disabled":"connected"}})),
   // Locations load asynchronously: late plugins arrive after the agent list is ready.
   "/api/plugin":env.YTD_TEST_PLUGIN_LATE&&new URL(req.url).pathname==="/api/plugin"&&++pluginReads<3?[]:[{id:"builtin",source:{type:"builtin"}},...(env.YTD_TEST_PLUGIN||env.YTD_TEST_PLUGIN_LATE?[{source:{type:"local",path:"/p.ts"}}]:[])],
   "/api/model":models}[new URL(req.url).pathname];
  return Response.json({location:{},data});
 }});
}
else{let input="";process.stdin.on("data",d=>input+=d);process.stdin.on("end",()=>{require("fs").writeFileSync(${JSON.stringify(record)},JSON.stringify({args,pwd:env.PWD,xdg:env.XDG_CONFIG_HOME,config,input}));if(env.YTD_TEST_STDERR)console.error(env.YTD_TEST_STDERR);console.log(env.YTD_TEST_OUTPUT)})}
`;
	const withFake = async (run: (record: string) => Promise<void>) => {
		const dir = mkdtempSync(join(tmpdir(), "ytd-opencode2-"));
		dirs.push(dir);
		const record = join(dir, "record.json");
		writeFileSync(join(dir, "opencode"), fake(record));
		chmodSync(join(dir, "opencode"), 0o700);
		const saved = { ...process.env };
		const verifyMs = OPENCODE_V2.verifyMs;
		process.env.PATH = `${dir}:${saved.PATH}`;
		process.env.YTD_TEST_OUTPUT = events.map((e) => JSON.stringify(e)).join("\n");
		OPENCODE_V2.verifyMs = 4000;
		try {
			await run(record);
		} finally {
			OPENCODE_V2.verifyMs = verifyMs;
			for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
			Object.assign(process.env, saved);
		}
	};

	// The private verification server never outlives preflight, whether it passed or failed.
	const expectServerStopped = (record: string) => {
		const pidFile = `${record}.serve-pid`;
		if (!existsSync(pidFile)) return;
		const pid = Number(readFileSync(pidFile, "utf8"));
		rmSync(pidFile);
		expect(() => process.kill(pid, 0)).toThrow();
	};

	test("runs a standalone, verified, deny-all agent with model#variant", async () => {
		await withFake(async (record) => {
			const selected = await preflight({ agent: "opencode", model, effort: "high" });
			expect(selected.routing).toMatchObject({ protocol: "opencode-v2", mcpServers: ["plain"] });
			expect(existsSync(`${record}.serve-pid`)).toBe(true);
			expectServerStopped(record);
			const command = commandFor(selected);
			expect(command.argv).toEqual([
				"opencode",
				"run",
				"--standalone",
				"--format",
				"json",
				"--agent",
				"ytd",
				"--model",
				`${model}#high`
			]);
			expect(command.argv).not.toContain("--auto");
			const result = await agentPrompt("source text", selected);
			expect(result).toMatchObject({ ok: true, text: "v2 answer", requestedModel: model });
			expect(result.reportedModel).toBeUndefined();
			const seen = JSON.parse(readFileSync(record, "utf8"));
			expect(seen.input).toBe("source text");
			expect(seen.pwd).toBe(RUN_DIR);
			expect(seen.xdg).toBe(OPENCODE_CONFIG_HOME);
			expect(seen.config.mcp.servers.plain).toEqual({
				type: "local",
				command: ["false"],
				disabled: true
			});
			expect(seen.config.agents.ytd.permissions).toEqual([
				{ action: "*", resource: "*", effect: "deny" }
			]);
			const variantInModel = await preflight({ agent: "opencode", model: `${model}#max` });
			expect(commandFor(variantInModel).argv.at(-1)).toBe(`${model}#max`);
		});
	});

	test("fails closed when isolation, model or variant cannot be proven", async () => {
		await withFake(async (record) => {
			const cases: [Record<string, string>, Partial<AgentProfile>, string][] = [
				[{ YTD_TEST_IGNORE_INLINE: "1" }, {}, "did not load the restricted inline configuration"],
				[{ YTD_TEST_NO_AGENT: "1" }, {}, "could not prove the restricted ytd agent"],
				[{ YTD_TEST_ALLOW_AFTER: "1" }, {}, "denies every tool"],
				[{ YTD_TEST_MCP_IGNORES: "1" }, {}, "MCP server is disabled"],
				[{ YTD_TEST_PLUGIN: "1" }, {}, "external plugin"],
				[{ YTD_TEST_PLUGIN_LATE: "1" }, {}, "external plugin"],
				[{ YTD_TEST_DECLARED_PLUGIN: "1" }, {}, "declares external plugins"],
				[{ YTD_TEST_SERVE_EXIT: "1" }, {}, "exited before proving isolation"],
				[{}, { effort: "xhigh" }, "has no variant xhigh; choose low, high, max"],
				[{}, { model: "opencode/unlisted" }, "does not offer opencode/unlisted"],
				[{}, { model: `${model}#low`, effort: "high" }, "variant once"],
				[{}, { model: "no-provider" }, "provider/model"]
			];
			for (const [env, overrides, message] of cases) {
				Object.assign(process.env, env);
				try {
					await expect(preflight({ agent: "opencode", model, ...overrides })).rejects.toThrow(
						message
					);
				} finally {
					for (const key of Object.keys(env)) delete process.env[key];
				}
				expectServerStopped(record);
			}
			const selected = await preflight({ agent: "opencode", model });
			await expect(
				preflight({ ...selected, routing: { ...selected.routing!, mcpServers: [] } })
			).rejects.toThrow("MCP configuration changed");
			expect(
				(
					await agentPrompt("x", {
						...selected,
						routing: { ...selected.routing!, mcpServers: undefined }
					})
				).kind
			).toBe("restriction");
		});
	}, 30000);

	test("free-limit errors, rejected permissions and tool events are classified", () => {
		const p = { agent: "opencode", model };
		const limit = parseAgentOutput(
			p,
			commandResult(
				JSON.stringify({
					type: "error",
					timestamp: 1,
					sessionID: "s",
					error: { type: "provider.free-limit", message: "Free usage limit reached.", status: 429 }
				}),
				1
			)
		);
		expect(limit).toMatchObject({ ok: false, kind: "quota", limited: true });
		expect(
			parseAgentOutput(
				p,
				commandResult(
					JSON.stringify({ type: "error", error: { type: "provider.quota", status: 402 } }),
					1
				)
			).kind
		).toBe("quota");
		const encodedEvents = events.map((e) => JSON.stringify(e)).join("\n");
		expect(
			parseAgentOutput(
				p,
				commandResult(encodedEvents, 0, "! permission requested: shell (ls); auto-rejecting")
			).kind
		).toBe("restriction");
		expect(
			parseAgentOutput(
				p,
				commandResult(
					`${encodedEvents}\n${JSON.stringify({ type: "tool_use", part: { tool: "read" } })}`
				)
			).kind
		).toBe("restriction");
		expect(
			parseAgentOutput(
				p,
				commandResult(
					events
						.slice(0, 2)
						.map((e) => JSON.stringify(e))
						.join("\n")
				)
			).ok
		).toBe(false);
	});

	test("discovery reads text models, context windows, variants and cost hints", async () => {
		const parsed = parseOpencodeModels(JSON.stringify({ data: models }));
		expect(parsed).toEqual([
			{
				id: model,
				contextTokens: 200000,
				variants: ["low", "high", "max"],
				hint: "listed at no cost; free-tier quotas apply"
			},
			{
				id: "opencode/paid-plain",
				variants: [],
				hint: "listed; access depends on your account · beta"
			}
		]);
		await withFake(async (record) => {
			expect(await discoverModels("opencode")).toEqual(parsed);
			process.env.YTD_TEST_API_FAIL = "1";
			// A failed private listing never falls back to the shared background service.
			expect(await discoverModels("opencode")).toEqual([]);
			expect(existsSync(`${record}.shared-models`)).toBe(false);
		});
	});
});
