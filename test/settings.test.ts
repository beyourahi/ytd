import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Manifest } from "../src/manifest.ts";
import {
	Cancelled,
	legacyBackupPath,
	loadSettings,
	parseArgs,
	profileFromArgs,
	resolveCli,
	saveSettings,
	type Picker
} from "../src/settings.ts";

const dirs: string[] = [];
function configPath() {
	const dir = mkdtempSync(join(tmpdir(), "ytd-settings-"));
	dirs.push(dir);
	return join(dir, "config.json");
}
const connectedConsole = [
	{ id: "opencode", name: "OpenCode Console", connected: true },
	{ id: "opencode-go", name: "OpenCode Go", connected: false }
];
/** Onboarding that never touches the installed OpenCode CLI. */
const onboarding = (providers: typeof connectedConsole) => ({
	inspect: async () => ({ standalone: true, providers }),
	login: async () => {
		throw new Error("login must not run here");
	}
});
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("exact model IDs and arguments override saved settings without changing agents silently", () => {
	const settings = {
		version: 1 as const,
		recent: [],
		adapters: {},
		selected: { agent: "claude", model: "opus", effort: "high", contextTokens: 200000 }
	};
	expect(
		profileFromArgs(
			parseArgs([
				"https://youtu.be/abcdefghijk",
				"--agent",
				"codex",
				"--model=私のモデル/α",
				"--effort",
				"xhigh",
				"--context-tokens",
				"12000"
			]),
			settings
		)
	).toEqual({ agent: "codex", model: "私のモデル/α", effort: "xhigh", contextTokens: 12000 });
	expect(() => profileFromArgs(parseArgs(["--agent", "codex"]), settings)).toThrow(
		"requires --model"
	);
	expect(profileFromArgs(parseArgs(["--model", "exact-model"]), settings)).not.toHaveProperty(
		"contextTokens"
	);
	expect(() => parseArgs(["--model"])).toThrow("requires a value");
	expect(() => parseArgs(["--timeout-ms", "0"])).toThrow();
	expect(() => parseArgs(["--model", "a", "--model", "b"])).toThrow();
	expect(() => parseArgs(["--unknown", "x"])).toThrow();
});

test("versioned atomic settings preserve Unicode and reject corrupt files", () => {
	const path = configPath();
	const config = {
		version: 1 as const,
		recent: [{ agent: "pi", model: "provider/モデル" }],
		adapters: {},
		selected: { agent: "pi", model: "provider/モデル" }
	};
	saveSettings(config, path);
	expect(loadSettings(path)).toEqual(config);
	expect(statSync(path).mode & 0o777).toBe(0o600);
	writeFileSync(path, "corrupt");
	expect(() => loadSettings(path)).toThrow();
	expect(readFileSync(path, "utf8")).toBe("corrupt");
});

test("non-interactive runs never call picker or choose a default", async () => {
	const path = configPath();
	const ui: Picker = {
		text: async () => {
			throw new Error("picker opened");
		},
		select: async () => {
			throw new Error("picker opened");
		}
	};
	await expect(
		resolveCli(["https://youtu.be/abcdefghijk"], { path, ui, interactive: false })
	).rejects.toThrow("No saved agent/model");
	const result = await resolveCli(
		["https://youtu.be/abcdefghijk", "--agent", "codex", "--model", "custom/exact"],
		{ path, ui, interactive: false }
	);
	expect(result?.profile.model).toBe("custom/exact");
	await expect(
		resolveCli(["--agent", "codex", "--model", "custom/exact"], { path, ui, interactive: false })
	).rejects.toThrow("Usage:");
	await expect(resolveCli(["settings"], { path, ui, interactive: false })).rejects.toThrow(
		"interactive terminal"
	);
});

test("remembered selection preselects Run and bare ytd asks for URL", async () => {
	const path = configPath();
	saveSettings(
		{ version: 1, selected: { agent: "claude", model: "opus" }, recent: [], adapters: {} },
		path
	);
	const ui: Picker = {
		async select(message, choices, initial) {
			expect(message).toBe("claude / opus");
			expect(initial).toBe("run");
			expect(choices.map((o) => o.label)).toEqual(["Run", "Change agent/model"]);
			return "run";
		},
		async text(message) {
			expect(message).toBe("YouTube URL");
			return "https://youtu.be/abcdefghijk";
		}
	};
	expect((await resolveCli([], { path, interactive: true, ui }))?.profile).toEqual({
		agent: "claude",
		model: "opus",
		contextTokens: undefined,
		timeoutMs: undefined,
		effort: undefined
	});
	expect(loadSettings(path).recent).toHaveLength(1);
});

test("route replacement authorization belongs only to the current explicit selection", async () => {
	const path = configPath();
	const selected = { agent: "codex", model: "same-model", effort: "high", contextTokens: 12000 };
	saveSettings({ version: 1, selected, recent: [selected], adapters: {} }, path);
	const answers = ["change", "codex", "same-model", "high"];
	const result = await resolveCli(["https://youtu.be/abcdefghijk"], {
		path,
		interactive: true,
		installed: (name) => name === "codex",
		models: async () => [{ id: "same-model", contextTokens: 12000 }],
		ui: {
			select: async () => answers.shift()!,
			text: async () => {
				throw new Error("Unexpected text prompt");
			}
		}
	});
	expect(result?.profile).toEqual(selected);
	expect(result?.replaceRouting).toBe(true);
	expect(readFileSync(path, "utf8")).not.toContain("replaceRouting");
	const saved = await resolveCli(["https://youtu.be/abcdefghijk"], { path, interactive: false });
	expect(saved?.replaceRouting).toBe(false);
	for (const args of [
		["--model", "same-model"],
		["--agent", "codex"],
		["--effort", "high"]
	]) {
		const explicit = await resolveCli(["https://youtu.be/abcdefghijk", ...args], {
			path,
			interactive: false
		});
		expect(explicit?.replaceRouting).toBe(true);
	}
	for (const args of [
		["--context-tokens", "12000"],
		["--timeout-ms", "1000"]
	]) {
		const configured = await resolveCli(["https://youtu.be/abcdefghijk", ...args], {
			path,
			interactive: false
		});
		expect(configured?.replaceRouting).toBe(false);
	}
});

test("same-model picker reselection preserves saved limits and resumes its source work", async () => {
	for (const [savedContext, discoveredContext] of [
		[12000, 272000],
		[12000, undefined],
		[undefined, 272000],
		[undefined, undefined]
	]) {
		const path = configPath();
		const selected = {
			agent: "codex",
			model: "same-model",
			effort: "high",
			...(savedContext ? { contextTokens: savedContext } : {}),
			timeoutMs: 123456
		};
		saveSettings({ version: 1, selected, recent: [selected], adapters: {} }, path);
		const manifest = new Manifest("limits", dirname(path));
		const source = "https://youtu.be/abcdefghijk";
		const first = manifest.beginRun({
			profile: { ...selected, routing: { fingerprint: "old" } },
			source,
			videoIds: ["video"]
		});
		const candidate = {
			sourceId: "video",
			principle: "Preserve completed work",
			detail: "Retain saved evidence",
			theme: "Recovery"
		};
		manifest.saveMap("map-complete:video", [candidate], ["video"], true, []);
		const choose = async (model: string) => {
			const answers = ["change", "codex", model, "high"];
			return resolveCli([source], {
				path,
				interactive: true,
				installed: (name) => name === "codex",
				models: async () => [
					{ id: "same-model", contextTokens: discoveredContext },
					{ id: "different-model", contextTokens: 32000 }
				],
				ui: {
					select: async () => answers.shift()!,
					text: async () => {
						throw new Error("Unexpected text prompt");
					}
				}
			});
		};
		try {
			const result = await choose("same-model");
			expect(result?.profile).toEqual(selected);
			expect(
				manifest.beginRun(
					{
						profile: { ...result!.profile, routing: { fingerprint: "new" } },
						source,
						videoIds: ["video"]
					},
					{ replaceRouting: result!.replaceRouting }
				)
			).toEqual({ id: first.id, replaced: false, routingChanged: true });
			expect(manifest.candidates()).toEqual([candidate]);
			expect(manifest.byStatus("distilled")).toHaveLength(1);
			const changed = await choose("different-model");
			expect(changed?.profile).toEqual({
				agent: "codex",
				model: "different-model",
				effort: "high",
				contextTokens: 32000
			});
		} finally {
			manifest.close();
		}
	}
});

test("searchable installed-agent/model picker offers exact entry and persists effort", async () => {
	const path = configPath();
	const calls: string[] = [];
	const ui: Picker = {
		async select(message, choices, _initial, searchable) {
			calls.push(message);
			if (message === "Agent") {
				expect(searchable).toBe(true);
				expect(choices.filter((o) => !o.disabled).map((o) => o.value)).toEqual(["pi"]);
				expect(choices.find((o) => o.value === "claude")).toMatchObject({
					label: "claude (not installed)",
					disabled: true
				});
				// Clack may start on the initial option, so it must be installed.
				expect(_initial).toBe("pi");
				return "pi";
			}
			if (message === "Model") {
				expect(searchable).toBe(true);
				expect(choices.some((o) => o.value === "provider/suggested")).toBe(true);
				return "__exact__";
			}
			return "max";
		},
		async text() {
			return "provider/非常に長いモデル名-αβγ";
		}
	};
	await resolveCli(["settings"], {
		path,
		interactive: true,
		ui,
		installed: (name) => name === "pi",
		models: async () => [{ id: "provider/suggested", contextTokens: 128000 }]
	});
	expect(calls).toEqual(["Agent", "Model", "Effort"]);
	expect(loadSettings(path).selected).toEqual({
		agent: "pi",
		model: "provider/非常に長いモデル名-αβγ",
		effort: "max"
	});
});

test("a fresh configuration starts on installed OpenCode without touching a saved preference", async () => {
	const path = configPath();
	const initials: string[] = [];
	await resolveCli(["settings"], {
		path,
		interactive: true,
		installed: (name) => ["claude", "opencode"].includes(name),
		onboarding: onboarding(connectedConsole),
		models: async () => [{ id: "opencode/free" }],
		ui: {
			select: async (message, _choices, initial) => {
				if (message !== "Agent") return message === "Model" ? "opencode/free" : "__default__";
				initials.push(initial ?? "");
				return "opencode";
			},
			text: async () => ""
		}
	});
	expect(initials).toEqual(["opencode"]);
	expect(loadSettings(path).selected).toEqual({ agent: "opencode", model: "opencode/free" });

	// A saved agent still wins, and the picker starts where the user left off.
	const saved = configPath();
	saveSettings(
		{ version: 1, selected: { agent: "claude", model: "opus" }, recent: [], adapters: {} },
		saved
	);
	const savedInitials: string[] = [];
	await resolveCli(["settings"], {
		path: saved,
		interactive: true,
		installed: (name) => ["claude", "opencode"].includes(name),
		onboarding: onboarding(connectedConsole),
		models: async () => [{ id: "opus" }],
		ui: {
			select: async (message, _choices, initial) => {
				if (message !== "Agent") return message === "Model" ? "opus" : "__default__";
				savedInitials.push(initial ?? "");
				return "claude";
			},
			text: async () => ""
		}
	});
	expect(savedInitials).toEqual(["claude"]);

	// Without OpenCode the same fresh configuration falls back to the installed agent.
	const plain = configPath();
	const plainInitials: string[] = [];
	await resolveCli(["settings"], {
		path: plain,
		interactive: true,
		installed: (name) => name === "pi",
		models: async () => [{ id: "provider/free" }],
		ui: {
			select: async (message, _choices, initial) => {
				if (message !== "Agent") return message === "Model" ? "provider/free" : "__default__";
				plainInitials.push(initial ?? "");
				return "pi";
			},
			text: async () => ""
		}
	});
	expect(plainInitials).toEqual(["pi"]);
});

test("cancellation preserves remembered configuration", async () => {
	const path = configPath();
	saveSettings(
		{ version: 1, selected: { agent: "claude", model: "opus" }, recent: [], adapters: {} },
		path
	);
	const before = readFileSync(path, "utf8");
	const ui: Picker = {
		async select() {
			throw new Cancelled();
		},
		async text() {
			throw new Cancelled();
		}
	};
	await expect(resolveCli([], { path, interactive: true, ui })).rejects.toThrow("Cancelled");
	expect(readFileSync(path, "utf8")).toBe(before);
});

test("picker offers model-specific variants and discovery hints", async () => {
	const path = configPath();
	const ui: Picker = {
		async select(message, choices) {
			if (message === "Agent") return "opencode";
			if (message === "Model") {
				expect(choices.find((o) => o.value === "opencode/free")?.hint).toBe(
					"200k context · listed at no cost; free-tier quotas apply"
				);
				return "opencode/free";
			}
			expect(choices.map((o) => o.value)).toEqual(["__default__", "low", "max", "__exact__"]);
			return "max";
		},
		async text() {
			throw new Error("unused");
		}
	};
	await resolveCli(["settings"], {
		path,
		interactive: true,
		ui,
		installed: (name) => name === "opencode",
		onboarding: {
			inspect: async () => ({ standalone: true, providers: connectedConsole }),
			login: async () => {
				throw new Error("login must not run when a provider is connected");
			}
		},
		models: async () => [
			{
				id: "opencode/free",
				contextTokens: 200000,
				variants: ["low", "max"],
				hint: "listed at no cost; free-tier quotas apply"
			}
		]
	});
	expect(loadSettings(path).selected).toEqual({
		agent: "opencode",
		model: "opencode/free",
		effort: "max",
		contextTokens: 200000
	});
});

test("an OpenCode model ID with #variant skips the effort step", async () => {
	const path = configPath();
	const calls: string[] = [];
	const ui: Picker = {
		async select(message) {
			calls.push(message);
			return message === "Agent" ? "opencode" : "__exact__";
		},
		async text() {
			return "opencode/free#max";
		}
	};
	await resolveCli(["settings"], {
		path,
		interactive: true,
		ui,
		installed: (name) => name === "opencode",
		onboarding: {
			inspect: async () => ({ standalone: true, providers: connectedConsole }),
			login: async () => {
				throw new Error("login must not run when a provider is connected");
			}
		},
		models: async () => [{ id: "opencode/free", variants: ["low", "max"] }]
	});
	expect(calls).toEqual(["Agent", "Model"]);
	expect(loadSettings(path).selected).toEqual({ agent: "opencode", model: "opencode/free#max" });
});

test("legacy Freebuff selections migrate once, keep a backup and preserve everything else", () => {
	const path = configPath();
	const adapter = { executable: "/bin/cat", args: ["--model", "{model}"] };
	const original = {
		version: 1,
		selected: { agent: "freebuff", model: "deepseek-v4.1-flash-10-17", effort: "high" },
		recent: [
			{ agent: "freebuff", model: "gpt-6-luna" },
			{ agent: "claude", model: "opus", effort: "high" },
			// A trusted wrapper may legitimately reuse the name; it is not the removed built-in.
			{ agent: "freebuff", model: "wrapper-model", custom: adapter }
		],
		adapters: { helper: adapter, freebuff: adapter }
	};
	writeFileSync(path, JSON.stringify(original));
	const backup = legacyBackupPath(path);
	const migrated = loadSettings(path);
	expect(migrated.selected).toBeUndefined();
	expect(migrated.recent).toEqual([
		{ agent: "claude", model: "opus", effort: "high" },
		{ agent: "freebuff", model: "wrapper-model", custom: adapter }
	]);
	expect(migrated.adapters).toEqual({ helper: adapter, freebuff: adapter });
	// The original file is preserved byte for byte before anything is rewritten.
	expect(JSON.parse(readFileSync(backup, "utf8"))).toEqual(original);
	// Idempotent: a second load changes nothing and never rewrites the file or the backup.
	const saved = readFileSync(path, "utf8");
	expect(loadSettings(path)).toEqual(migrated);
	expect(readFileSync(path, "utf8")).toBe(saved);
	expect(JSON.parse(readFileSync(backup, "utf8"))).toEqual(original);
});

test("a legacy custom wrapper named Freebuff is never migrated away", () => {
	const path = configPath();
	const adapter = { executable: "/bin/cat", args: [] };
	const custom = { agent: "freebuff", model: "wrapper-model", custom: adapter };
	writeFileSync(
		path,
		JSON.stringify({
			version: 1,
			selected: custom,
			recent: [custom],
			adapters: { freebuff: adapter }
		})
	);
	expect(loadSettings(path).selected).toEqual(custom);
	expect(existsSync(legacyBackupPath(path))).toBe(false);
});

test("obsolete Freebuff arguments fail clearly instead of selecting a removed agent", async () => {
	const path = configPath();
	const settings = { version: 1 as const, recent: [], adapters: {} };
	expect(() =>
		profileFromArgs(parseArgs(["--agent", "freebuff", "--model", "x"]), settings)
	).toThrow("Freebuff support was removed");
	await expect(
		resolveCli(["https://youtu.be/abcdefghijk", "--agent", "freebuff", "--model", "x"], {
			path,
			interactive: false
		})
	).rejects.toThrow("Freebuff support was removed");
	// A saved legacy selection asks for an explicit replacement instead of inventing one.
	writeFileSync(
		path,
		JSON.stringify({
			version: 1,
			selected: { agent: "freebuff", model: "deepseek-v4.1-flash-10-17" },
			recent: [],
			adapters: {}
		})
	);
	await expect(
		resolveCli(["https://youtu.be/abcdefghijk"], { path, interactive: false })
	).rejects.toThrow("No saved agent/model");
});

test("no connected provider offers OpenCode's own login, then re-reads providers and models", async () => {
	const path = configPath();
	const events: string[] = [];
	let connected = false;
	const ui: Picker = {
		async select(message, choices) {
			events.push(message);
			if (message === "Agent") return "opencode";
			if (message === "No OpenCode provider is connected") {
				expect(choices.map((o) => o.value)).toEqual(["login", "skip"]);
				return "login";
			}
			if (message === "Model") return "opencode/free";
			expect(choices.map((o) => o.value)).toEqual(["__default__", "high", "__exact__"]);
			return "high";
		},
		async text() {
			throw new Error("unused");
		}
	};
	await resolveCli(["settings"], {
		path,
		interactive: true,
		ui,
		installed: (name) => name === "opencode",
		onboarding: {
			inspect: async () => ({
				standalone: true,
				providers: [
					{ id: "opencode", name: "OpenCode Console", connected },
					{ id: "opencode-go", name: "OpenCode Go", connected: false }
				]
			}),
			login: async () => {
				events.push("login");
				connected = true;
				return 0;
			}
		},
		models: async () => {
			events.push("models");
			// Models appear only once the provider is connected, like a real OpenCode.
			return connected ? [{ id: "opencode/free", contextTokens: 200000, variants: ["high"] }] : [];
		}
	});
	expect(events).toEqual([
		"Agent",
		"No OpenCode provider is connected",
		"login",
		"models",
		"Model",
		"Effort"
	]);
	expect(loadSettings(path).selected).toEqual({
		agent: "opencode",
		model: "opencode/free",
		effort: "high",
		contextTokens: 200000
	});
});

test("a cancelled or failed OpenCode login never corrupts saved settings", async () => {
	const path = configPath();
	const saved = { agent: "claude", model: "opus" };
	saveSettings({ version: 1, selected: saved, recent: [], adapters: {} }, path);
	const before = readFileSync(path, "utf8");
	const logged: string[] = [];
	const log = console.log;
	console.log = (...args: unknown[]) => void logged.push(args.join(" "));
	try {
		await expect(
			resolveCli(["settings"], {
				path,
				interactive: true,
				installed: (name) => name === "opencode",
				onboarding: {
					inspect: async () => ({
						standalone: true,
						providers: [{ id: "opencode", name: "OpenCode Console", connected: false }]
					}),
					login: async () => 130 // interrupted
				},
				models: async () => [],
				ui: {
					select: async (message) => {
						if (message === "Agent") return "opencode";
						if (message === "No OpenCode provider is connected") return "login";
						throw new Cancelled();
					},
					text: async () => {
						throw new Cancelled();
					}
				}
			})
		).rejects.toThrow("Cancelled");
	} finally {
		console.log = log;
	}
	expect(readFileSync(path, "utf8")).toBe(before);
	expect(existsSync(legacyBackupPath(path))).toBe(false);
	expect(logged.join("\n")).toContain("opencode auth login");
});

test("an unreadable OpenCode auth state still allows an exact model ID", async () => {
	const path = configPath();
	const logged: string[] = [];
	const log = console.log;
	console.log = (...args: unknown[]) => void logged.push(args.join(" "));
	try {
		await resolveCli(["settings"], {
			path,
			interactive: true,
			installed: (name) => name === "opencode",
			onboarding: {
				inspect: async () => ({ standalone: false, error: "OpenCode provider list is malformed" }),
				login: async () => {
					throw new Error("login must not run when detection failed");
				}
			},
			models: async () => [],
			ui: {
				select: async (message) =>
					message === "Agent" ? "opencode" : message === "Model" ? "__exact__" : "__default__",
				text: async () => "opencode/manual-model"
			}
		});
	} finally {
		console.log = log;
	}
	expect(logged.join("\n")).toContain("OpenCode provider list is malformed");
	expect(loadSettings(path).selected).toEqual({
		agent: "opencode",
		model: "opencode/manual-model"
	});
});

test("models split by provider only when OpenCode reports several providers", async () => {
	const path = configPath();
	const events: string[] = [];
	await resolveCli(["settings"], {
		path,
		interactive: true,
		installed: (name) => name === "opencode",
		onboarding: onboarding([
			{ id: "opencode", name: "OpenCode Console", connected: true },
			{ id: "opencode-go", name: "OpenCode Go", connected: true }
		]),
		models: async () => [
			{ id: "opencode/zen-only", contextTokens: 200000 },
			{ id: "opencode-go/go-only", contextTokens: 131072 }
		],
		ui: {
			select: async (message, choices, initial) => {
				events.push(message);
				if (message === "Agent") return "opencode";
				if (message === "Provider") {
					expect(choices.map((o) => [o.value, o.label, o.hint])).toEqual([
						["opencode", "OpenCode Console", "1 model · connected"],
						["opencode-go", "OpenCode Go", "1 model · connected"]
					]);
					// Go and Zen are distinct providers; Go is never folded into the console catalog.
					expect(initial).toBe("opencode");
					return "opencode-go";
				}
				if (message === "Model") {
					expect(choices.map((o) => o.value)).toEqual([
						"opencode-go/go-only",
						"__exact__",
						"__connect__",
						"__refresh__"
					]);
					return "opencode-go/go-only";
				}
				return "__default__";
			},
			text: async () => {
				throw new Error("unused");
			}
		}
	});
	expect(events).toEqual(["Agent", "Provider", "Model", "Effort"]);
	expect(loadSettings(path).selected).toEqual({
		agent: "opencode",
		model: "opencode-go/go-only",
		contextTokens: 131072
	});
});

test("refreshing the OpenCode catalog re-reads models without restarting", async () => {
	const path = configPath();
	let discoveries = 0;
	await resolveCli(["settings"], {
		path,
		interactive: true,
		installed: (name) => name === "opencode",
		onboarding: onboarding([{ id: "opencode", name: "OpenCode Console", connected: true }]),
		models: async () => {
			discoveries++;
			return discoveries === 1
				? [{ id: "opencode/first", variants: ["low"] }]
				: [{ id: "opencode/first", variants: ["low"] }, { id: "opencode/second" }];
		},
		ui: {
			select: async (message, choices) => {
				if (message === "Agent") return "opencode";
				if (message === "Model")
					return choices.some((o) => o.value === "opencode/second")
						? "opencode/second"
						: "__refresh__";
				expect(choices).toEqual([
					{ value: "__default__", label: "Use configured agent default" },
					{ value: "__exact__", label: "Enter exact effort/variant" }
				]);
				return "__default__";
			},
			text: async () => {
				throw new Error("unused");
			}
		}
	});
	expect(discoveries).toBe(2);
	expect(loadSettings(path).selected).toEqual({ agent: "opencode", model: "opencode/second" });
});

test("a user with Zen connected can add Go without leaving ytd; existing auth is untouched", async () => {
	const path = configPath();
	const events: string[] = [];
	let goConnected = false;
	await resolveCli(["settings"], {
		path,
		interactive: true,
		installed: (name) => name === "opencode",
		onboarding: {
			inspect: async () => {
				events.push("inspect");
				return {
					standalone: true,
					providers: [
						{ id: "opencode", name: "OpenCode Console", connected: true },
						{ id: "opencode-go", name: "OpenCode Go", connected: goConnected }
					]
				};
			},
			login: async () => {
				events.push("login");
				goConnected = true;
				return 0;
			}
		},
		models: async () => [
			{ id: "opencode/zen-only", label: "Zen Only", contextTokens: 200000 },
			...(goConnected ? [{ id: "opencode-go/go-only", label: "Go Only" }] : [])
		],
		ui: {
			select: async (message, choices) => {
				events.push(message);
				if (message === "Agent") return "opencode";
				if (message === "Provider") {
					// The refreshed provider list reflects the new connection without a restart.
					expect(choices.map((o) => o.hint)).toEqual([
						"1 model · connected",
						"1 model · connected"
					]);
					return "opencode-go";
				}
				if (message === "Model" && !goConnected) {
					// Readable names keep the exact provider/model ID visible and searchable.
					expect(choices[0]).toEqual({
						value: "opencode/zen-only",
						label: "Zen Only",
						hint: "opencode/zen-only · 200k context · suggestion; availability depends on your account"
					});
					return "__connect__";
				}
				if (message === "Model") return "opencode-go/go-only";
				return "__default__";
			},
			text: async () => {
				throw new Error("unused");
			}
		}
	});
	// A connected provider skips the first-run login prompt; login runs only when asked for.
	expect(events).toEqual([
		"Agent",
		"inspect",
		"Model",
		"login",
		"inspect",
		"Provider",
		"Model",
		"Effort"
	]);
	expect(loadSettings(path).selected).toEqual({ agent: "opencode", model: "opencode-go/go-only" });
});

test("refreshing the OpenCode catalog also re-reads providers", async () => {
	const path = configPath();
	let inspections = 0;
	await resolveCli(["settings"], {
		path,
		interactive: true,
		installed: (name) => name === "opencode",
		onboarding: {
			inspect: async () => {
				inspections++;
				return {
					standalone: true,
					providers: [{ id: "opencode", name: "OpenCode Console", connected: true }]
				};
			},
			login: async () => {
				throw new Error("refresh must not log in");
			}
		},
		models: async () => [{ id: "opencode/first" }],
		ui: {
			select: async (message) => {
				if (message === "Agent") return "opencode";
				if (message === "Model") return inspections < 2 ? "__refresh__" : "opencode/first";
				return "__default__";
			},
			text: async () => {
				throw new Error("unused");
			}
		}
	});
	expect(inspections).toBe(2);
});

test("a failed login from the model picker is reported and keeps the picker usable", async () => {
	const path = configPath();
	const logged: string[] = [];
	const log = console.log;
	console.log = (...args: unknown[]) => void logged.push(args.join(" "));
	let attempts = 0;
	try {
		await resolveCli(["settings"], {
			path,
			interactive: true,
			installed: (name) => name === "opencode",
			onboarding: {
				inspect: async () => ({ standalone: true, providers: connectedConsole }),
				login: async () => {
					throw new Error("spawn opencode ENOENT");
				}
			},
			models: async () => [{ id: "opencode/first" }],
			ui: {
				select: async (message) => {
					if (message === "Agent") return "opencode";
					if (message === "Model") return attempts++ === 0 ? "__connect__" : "opencode/first";
					return "__default__";
				},
				text: async () => {
					throw new Error("unused");
				}
			}
		});
	} finally {
		console.log = log;
	}
	expect(logged.join("\n")).toContain("login could not start: spawn opencode ENOENT");
	expect(logged.join("\n")).toContain("login did not complete");
	expect(loadSettings(path).selected).toEqual({ agent: "opencode", model: "opencode/first" });
});

test("an invalid settings file naming Freebuff is reported and never rewritten", () => {
	const path = configPath();
	for (const invalid of [
		{ version: 2, selected: { agent: "freebuff", model: "m" }, recent: [], adapters: {} },
		{
			version: 1,
			selected: { agent: "freebuff", model: "m" },
			recent: [{ agent: "unknown-agent", model: "m" }],
			adapters: {}
		},
		{ version: 1, selected: { agent: "freebuff", model: "m" }, recent: [], adapters: { pi: {} } }
	]) {
		const original = JSON.stringify(invalid);
		writeFileSync(path, original);
		expect(() => loadSettings(path)).toThrow();
		expect(readFileSync(path, "utf8")).toBe(original);
		expect(existsSync(legacyBackupPath(path))).toBe(false);
	}
});

test("a custom wrapper named freebuff stays selectable from the command line", () => {
	const custom = { executable: "/bin/cat", args: ["--model", "{model}"] };
	const settings = { version: 1 as const, recent: [], adapters: { freebuff: custom } };
	expect(
		profileFromArgs(parseArgs(["--agent", "freebuff", "--model", "wrapper-model"]), settings)
	).toEqual({ agent: "freebuff", model: "wrapper-model", custom });
});
