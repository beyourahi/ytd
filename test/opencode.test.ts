import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	inspectOpencode,
	opencodeLogin,
	parseOpencodeAuth,
	providerGroups
} from "../src/opencode.ts";
import { OPENCODE_CONFIG_HOME, RUN_DIR } from "../src/config.ts";
import { runCommand } from "../src/process.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fake OpenCode CLI: no server, no credentials and no model request. */
function fakeOpencode(record = join(mkdtempSync(join(tmpdir(), "ytd-oc-")), "record.json")) {
	const dir = mkdtempSync(join(tmpdir(), "ytd-open-"));
	dirs.push(dir);
	const path = join(dir, "opencode");
	writeFileSync(
		path,
		`#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2), env = process.env;
const write = (value) => writeFileSync(${JSON.stringify(record)}, JSON.stringify(value));
const seen = () => ({ args, pwd: env.PWD, xdg: env.XDG_CONFIG_HOME, config: JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}") });
if (args[0] === "run" && args.includes("--help"))
  console.log(env.FAKE_HELP ?? "--standalone --format --model --agent");
else if (args[0] === "api" && args.at(-1) === "/api/config")
  // Config sources as OpenCode 2.1.4 lists them: a user MCP server plus ytd's inline config.
  console.log(JSON.stringify([
    { type: "document", path: "/cfg/opencode.json", info: { mcp: { servers: { user: { type: "local", command: ["x"] } } }, ...(env.FAKE_PLUGIN ? { plugins: ["pkg"] } : {}) } },
    { type: "document", info: JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}") }
  ]));
else if (args[0] === "auth" && args[1] === "list") {
  if (env.FAKE_AUTH_FAIL) process.exit(2);
  write(seen());
  console.log(env.FAKE_AUTH_STATE ?? "[]");
} else if (args[0] === "auth" && args[1] === "login") {
  write(seen());
  process.exit(Number(env.FAKE_LOGIN_CODE ?? 0));
} else process.exit(1);
`
	);
	chmodSync(path, 0o755);
	return { path, record };
}

test("connected, disconnected and malformed provider states are distinguished", () => {
	const auth = JSON.stringify([
		{
			id: "opencode",
			name: "OpenCode Console",
			connections: [{ type: "credential", id: "cred_secret", label: "Personal", method: "oauth" }]
		},
		{ id: "opencode-go", name: "OpenCode Go", connections: [] }
	]);
	const providers = parseOpencodeAuth(auth);
	expect(providers).toEqual([
		{ id: "opencode", name: "OpenCode Console", connected: true },
		{ id: "opencode-go", name: "OpenCode Go", connected: false }
	]);
	// Credential identifiers and labels never leave the parser.
	expect(JSON.stringify(providers)).not.toContain("cred_secret");
	expect(JSON.stringify(providers)).not.toContain("Personal");
	expect(parseOpencodeAuth("[]")).toEqual([]);
	expect(parseOpencodeAuth(JSON.stringify([{ id: "x" }]))).toEqual([
		{ id: "x", name: "x", connected: false }
	]);
	for (const malformed of [
		"{}",
		"null",
		JSON.stringify([{ name: "no id", connections: [] }]),
		JSON.stringify([{ id: "x", connections: "yes" }]),
		JSON.stringify([null]),
		"not json"
	])
		expect(() => parseOpencodeAuth(malformed)).toThrow();
});

test("inspection rejects an OpenCode 1 install and reports unavailable auth safely", async () => {
	const fake = fakeOpencode();
	process.env.FAKE_HELP = "--format --model --agent";
	try {
		expect(await inspectOpencode(fake.path)).toEqual({
			standalone: false,
			error: "OpenCode 1 is installed; provider detection needs the OpenCode 2 auth list"
		});
		delete process.env.FAKE_HELP;
		process.env.FAKE_AUTH_FAIL = "1";
		expect(await inspectOpencode(fake.path)).toMatchObject({
			standalone: true,
			error: "OpenCode could not list its connected providers"
		});
		delete process.env.FAKE_AUTH_FAIL;
		process.env.FAKE_AUTH_STATE = JSON.stringify([{ id: "opencode", connections: [] }]);
		expect(await inspectOpencode(fake.path)).toEqual({
			standalone: true,
			providers: [{ id: "opencode", name: "opencode", connected: false }]
		});
		process.env.FAKE_AUTH_STATE = JSON.stringify({ not: "a list" });
		expect(await inspectOpencode(fake.path)).toMatchObject({
			standalone: true,
			error: "OpenCode provider list is malformed"
		});
	} finally {
		for (const key of ["FAKE_HELP", "FAKE_AUTH_FAIL", "FAKE_AUTH_STATE"]) delete process.env[key];
	}
});

test("inspection and guided login use the same isolated configuration as execution", async () => {
	const fake = fakeOpencode();
	try {
		process.env.FAKE_AUTH_STATE = "[]";
		await inspectOpencode(fake.path);
		const inspected = JSON.parse(readFileSync(fake.record, "utf8"));
		expect(inspected.args).toEqual(["auth", "list", "--standalone", "--format", "json"]);
		expect(inspected.xdg).toBe(OPENCODE_CONFIG_HOME);
		expect(inspected.pwd).toBe(RUN_DIR);
		// Same restrictions as execution: deny-all ytd agent and every configured MCP server disabled.
		expect(inspected.config.default_agent).toBe("ytd");
		expect(inspected.config.mcp.servers.user).toMatchObject({ disabled: true });

		expect(await opencodeLogin(fake.path)).toBe(0);
		const loggedIn = JSON.parse(readFileSync(fake.record, "utf8"));
		// ytd starts OpenCode's own login and never reads or stores its credentials.
		expect(loggedIn.args).toEqual(["auth", "login", "--standalone"]);
		expect(loggedIn.xdg).toBe(OPENCODE_CONFIG_HOME);
		expect(loggedIn.pwd).toBe(RUN_DIR);
		expect(loggedIn.config.mcp.servers.user).toMatchObject({ disabled: true });
		process.env.FAKE_LOGIN_CODE = "130";
		expect(await opencodeLogin(fake.path)).toBe(130);
	} finally {
		delete process.env.FAKE_AUTH_STATE;
		delete process.env.FAKE_LOGIN_CODE;
	}
});

test("declared plugins stop inspection and login before any private server starts", async () => {
	const fake = fakeOpencode();
	process.env.FAKE_PLUGIN = "1";
	try {
		expect(await inspectOpencode(fake.path)).toMatchObject({
			standalone: true,
			error: expect.stringContaining("external plugins")
		});
		await expect(opencodeLogin(fake.path)).rejects.toThrow("external plugins");
		expect(existsSync(fake.record)).toBe(false);
	} finally {
		delete process.env.FAKE_PLUGIN;
	}
});

test("a fresh install without ~/.ytd can inspect providers and start login", async () => {
	const fake = fakeOpencode();
	const home = mkdtempSync(join(tmpdir(), "ytd-home-"));
	dirs.push(home);
	const script = join(home, "probe.ts");
	writeFileSync(
		script,
		`import { inspectOpencode, opencodeLogin } from ${JSON.stringify(join(import.meta.dir, "../src/opencode.ts"))};
console.log(JSON.stringify({ inspected: await inspectOpencode(${JSON.stringify(fake.path)}), login: await opencodeLogin(${JSON.stringify(fake.path)}) }));`
	);
	const result = await runCommand([process.execPath, script], {
		env: { ...process.env, HOME: home, FAKE_AUTH_STATE: "[]" },
		timeoutMs: 30_000
	});
	expect(result.stderr).toBe("");
	expect(JSON.parse(result.stdout)).toEqual({
		inspected: { standalone: true, providers: [] },
		login: 0
	});
	expect(existsSync(join(home, ".ytd", "run"))).toBe(true);
});

test("models group by provider only for exact, multi-provider catalogs", () => {
	expect(
		providerGroups([
			{ id: "opencode-go/kimi-k3" },
			{ id: "opencode/flint-40b-free" },
			{ id: "opencode-go/glm-5.3" }
		])
	).toEqual([
		{ id: "opencode", models: [{ id: "opencode/flint-40b-free" }] },
		{ id: "opencode-go", models: [{ id: "opencode-go/kimi-k3" }, { id: "opencode-go/glm-5.3" }] }
	]);
	expect(providerGroups([{ id: "opencode/only" }])).toBeUndefined();
	expect(providerGroups([])).toBeUndefined();
	// Unqualified IDs keep a flat list, so other agents' pickers never change shape.
	expect(providerGroups([{ id: "opus" }, { id: "opencode/only" }])).toBeUndefined();
});
