import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Manifest } from "../src/manifest.ts";
import {
	Cancelled,
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
				expect(choices.map((o) => o.value)).toEqual(["pi"]);
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
