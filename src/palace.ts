import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { PALACE_DIR, ROOMS, RUN_DIR, type Room } from "./config.ts";
import type { ReducedPrinciple } from "./distill.ts";
import { runCommand } from "./process.ts";
import { createPresenter } from "./ui.ts";

export interface RenderInput {
	room: Room;
	channel: string;
	channelUrl: string;
	dateStr: string;
	idToM: Map<string, number>; // GLOBAL videoId → [Mn] (shared across rooms this run)
	titles: Map<string, string>; // videoId → title
	principles: ReducedPrinciple[]; // structured, room-scoped (theme/principle/ids)
	halalNotes: string[]; // halal-gate notes for this room's principles
}

export function fieldNotesPath(room: Room): string {
	return join(PALACE_DIR, room, "field-notes.md");
}

/** Highest [Mn] / [M-00n] source id present in a field-notes file. */
export function maxMInText(text: string): number {
	let max = 0;
	for (const m of text.matchAll(/\[M-?(\d+)\]/g)) {
		const n = Number.parseInt(m[1], 10);
		if (n > max) max = n;
	}
	return max;
}

/**
 * Source ids are GLOBAL across the palace (the same video cited in content/ and craft/
 * shares one [Mn]), so the next id must be max+1 across every room's field-notes.
 */
export async function globalMaxM(): Promise<number> {
	let max = 0;
	for await (const rel of new Bun.Glob("**/field-notes.md").scan({
		cwd: PALACE_DIR,
		onlyFiles: true
	})) {
		max = Math.max(max, maxMInText(await Bun.file(join(PALACE_DIR, rel)).text()));
	}
	return max;
}

/** Metadata is text, so it cannot introduce field-note citations or Markdown structure. */
function inlineMetadata(value: string): string {
	const entities: Record<string, string> = {
		"&": "&amp;",
		"[": "&#91;",
		"]": "&#93;",
		"<": "&lt;",
		">": "&gt;",
		"`": "&#96;",
		"*": "&#42;"
	};
	return value
		.replace(/\s+/g, " ")
		.replace(/\p{Cc}/gu, "")
		.replace(/[&[\]<>`*]/g, (char) => entities[char]);
}

/** Pure: build ONE room's field-notes section (no file IO) from structured principles.
 *  Groups by theme into lettered sections, cites each bullet with the GLOBAL [Mn], and
 *  emits a Sources-logged block listing only the videos cited in THIS room — palace style. */
export function renderBatch(o: RenderInput): string {
	// ids → "[M51] [M52]" (known ids only, de-duped, sorted by [Mn])
	const cite = (ids: string[]): string =>
		[...new Set(ids)]
			.filter((id) => o.idToM.has(id))
			.map((id) => o.idToM.get(id)!)
			.sort((a, b) => a - b)
			.map((m) => `[M${m}]`)
			.join(" ");

	// group principles by theme, preserving first-seen order
	const order: string[] = [];
	const byTheme = new Map<string, ReducedPrinciple[]>();
	for (const p of o.principles) {
		const theme = p.theme.trim() || "General";
		if (!byTheme.has(theme)) {
			byTheme.set(theme, []);
			order.push(theme);
		}
		byTheme.get(theme)!.push(p);
	}

	const sections = order
		.map((theme, i) => {
			const label = i < 26 ? String.fromCharCode(65 + i) : String(i + 1);
			const bullets = byTheme
				.get(theme)!
				.map((p) => `- ${p.principle.trim()} ${cite(p.ids)}`.trimEnd())
				.join("\n");
			return `## ${label}. ${theme}\n${bullets}`;
		})
		.join("\n\n");

	const halal = o.halalNotes.length
		? o.halalNotes.map((n) => `- ${n.trim()}`).join("\n")
		: "- No halal concerns were recorded.";
	const body = `${sections}\n\n## ⚠️ Halal gate\n${halal}`;

	// videos cited in this room, de-duped, in [Mn] order
	const cited = [...new Set(o.principles.flatMap((p) => p.ids))]
		.filter((id) => o.idToM.has(id))
		.sort((a, b) => o.idToM.get(a)! - o.idToM.get(b)!);

	const sources = cited
		.map(
			(id) =>
				`- **[M${o.idToM.get(id)}]** "${inlineMetadata(o.titles.get(id) ?? id)}" — ${inlineMetadata(o.channel)} · YouTube \`${id}\` · logged ${o.dateStr}`
		)
		.join("\n");

	const mList = cited.map((id) => `M${o.idToM.get(id)}`);
	const tag = mList.length
		? ` (${mList.length <= 5 ? mList.join(", ") : `${mList[0]}–${mList[mList.length - 1]}`})`
		: "";

	return (
		`\n\n# ═══ ${inlineMetadata(o.channel)} → ${o.room} — YouTube ingest${tag} ═══\n` +
		`*Ingested ${o.dateStr} via ytd from ${inlineMetadata(o.channelUrl)}. Deduped across the channel and against existing field-notes; only net-new wisdom logged. Automated halal review can miss concerns; recorded decisions follow.*\n\n` +
		`## Sources logged (this block)\n${sources}\n\n${body.trim()}\n`
	);
}

/** Append-only write with a read-back integrity check (Rahi's zero-tolerance for
 *  collateral edits to his single source of truth). Throws rather than risk a clobber. */
export async function safeAppend(path: string, addition: string): Promise<void> {
	const before = existsSync(path) ? await Bun.file(path).text() : "";
	appendFileSync(path, addition);
	const after = await Bun.file(path).text();
	if (after !== before + addition) {
		throw new Error(`append integrity check FAILED for ${path}; preserved for recovery`);
	}
}

export interface PalaceSnapshot {
	base: string;
	notes: { path: string; text: string }[];
}

export class PalaceBaseChangedError extends Error {}

export interface PublishInput extends Omit<RenderInput, "idToM"> {
	runId: string;
	expectedBase: string;
}

export interface PublicationReceipt {
	room: Room;
	runId: string;
	marker: string;
	commit: string;
	verifiedHead: string;
	idToM: Record<string, number>;
	path: string;
	blockHash: string;
}

export interface PublicationOptions {
	palaceDir?: string;
	syncRoot?: string;
	lockRoot?: string;
	runDir?: string;
	signal?: AbortSignal;
}

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

async function git(root: string, args: string[], signal?: AbortSignal): Promise<string> {
	const result = await runCommand(["git", "-C", root, ...args], { signal });
	if (result.code !== 0 || result.cancelled || result.timedOut || result.overflow) {
		throw new Error(`Palace git ${args[0]} failed: ${result.stderr || result.stdout}`);
	}
	return result.stdout.trimEnd();
}

async function notesAt(
	root: string,
	base: string,
	signal?: AbortSignal
): Promise<PalaceSnapshot["notes"]> {
	const paths = (await git(root, ["ls-tree", "-r", "--name-only", base], signal)).split("\n");
	const notes: PalaceSnapshot["notes"] = [];
	for (const path of paths.filter((p) => /(^|\/)field-notes\.md$/.test(p))) {
		notes.push({ path, text: await git(root, ["show", `${base}:${path}`], signal) });
	}
	return notes;
}

/** Read canonical notes, including rooms outside the four publication targets. */
export async function loadPalaceSnapshot(
	root = PALACE_DIR,
	signal?: AbortSignal
): Promise<PalaceSnapshot> {
	await git(
		root,
		["fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main"],
		signal
	);
	const base = await git(root, ["rev-parse", "refs/remotes/origin/main"], signal);
	return { base, notes: await notesAt(root, base, signal) };
}

/** Existing source assignments must be unambiguous before allocating global IDs. */
export function sourceMappings(texts: string[]): Map<string, number> {
	const mappings = new Map<string, number>();
	const owners = new Map<number, string>();
	for (const text of texts) {
		for (const line of text.split("\n")) {
			const m = line.match(/^\s*-\s*\*\*\[M-?(\d+)\]\*\*.*?YouTube\s+`([A-Za-z0-9_-]{11})`/);
			if (!m) continue;
			const n = Number(m[1]);
			const prior = mappings.get(m[2]);
			if (prior !== undefined && prior !== n) {
				throw new Error(`Conflicting published source IDs for ${m[2]}; notes preserved`);
			}
			if (!Number.isSafeInteger(n) || n < 1 || (owners.has(n) && owners.get(n) !== m[2]))
				throw new Error(`Ambiguous global source ID M${m[1]}; notes preserved`);
			owners.set(n, m[2]);
			mappings.set(m[2], n);
		}
	}
	return mappings;
}

function publicationKey(input: Pick<PublishInput, "runId" | "room" | "channel">): string {
	return `ytd-${digest(JSON.stringify([input.runId, input.room, input.channel]))}`;
}

function publicationBlock(text: string, marker: string): string | undefined {
	const start = text.indexOf(marker);
	const endMarker = marker.replace("<!-- ytd:", "<!-- /ytd:");
	const end = text.indexOf(endMarker, start + marker.length);
	if (start < 0 || end < 0) return undefined;
	if (text.indexOf(marker, start + marker.length) >= 0) {
		throw new Error("Duplicate Palace publication marker; preserved for recovery");
	}
	return text.slice(start, end + endMarker.length);
}

function validatePublicationInput(input: PublishInput): void {
	if (
		!ROOMS.includes(input.room) ||
		!input.runId ||
		!/^[a-f0-9]{40,64}$/.test(input.expectedBase)
	) {
		throw new Error("Invalid Palace publication target or run/base identity");
	}
	if (!input.principles.length) throw new Error("Cannot publish an empty principle batch");
	for (const p of input.principles) {
		if (
			!p.ids.length ||
			p.ids.some((id) => !/^[A-Za-z0-9_-]{11}$/.test(id) || !input.titles.has(id))
		) {
			throw new Error("Publication contains an unknown source citation");
		}
	}
	if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dateStr)) throw new Error("Invalid publication date");
	for (const value of [
		...input.halalNotes,
		...input.principles.flatMap((p) => [p.theme, p.principle])
	]) {
		if (typeof value !== "string" || !value.trim() || /\[M-?\d+\]|\{\{id:|<!--|\p{Cc}/u.test(value))
			throw new Error("Publication text contains unsafe citation, markup, or control characters");
	}
}

async function verifyPublished(
	root: string,
	input: Pick<PublishInput, "runId" | "room" | "channel">,
	expectedHash?: string,
	signal?: AbortSignal
): Promise<PublicationReceipt | null> {
	const { base, notes } = await loadPalaceSnapshot(root, signal);
	const path = `${input.room}/field-notes.md`;
	const key = publicationKey(input);
	const marker = `<!-- ytd:${key} -->`;
	const block = publicationBlock(notes.find((n) => n.path === path)?.text ?? "", marker);
	if (!block) return null;
	const blockHash = digest(block);
	if (expectedHash && blockHash !== expectedHash)
		throw new Error("Remote publication content changed; receipt not accepted");
	if (!block.includes("## ⚠️ Halal gate"))
		throw new Error("Remote publication lacks its halal gate");
	const mappings = sourceMappings([block]);
	if (!mappings.size) throw new Error("Remote publication has no verifiable source mappings");
	for (const n of block.matchAll(/\[M-?(\d+)\]/g)) {
		if (![...mappings.values()].includes(Number(n[1]))) {
			throw new Error("Remote publication has an unresolved citation");
		}
	}
	const commit = await git(
		root,
		["log", "-1", "--format=%H", "--fixed-strings", `--grep=Mind-Palace-Transaction: ${key}`, base],
		signal
	);
	if (!commit) throw new Error("Remote publication marker has no transaction commit");
	const original = publicationBlock(await git(root, ["show", `${commit}:${path}`], signal), marker);
	if (!original || digest(original) !== blockHash)
		throw new Error("Remote publication differs from its committed receipt");
	await git(root, ["merge-base", "--is-ancestor", commit, base], signal);
	const live = (
		await git(root, ["ls-remote", "--exit-code", "origin", "refs/heads/main"], signal)
	).split(/\s+/)[0];
	if (live !== base)
		throw new PalaceBaseChangedError(
			"Remote moved during publication verification; retry to recover receipt"
		);
	return {
		room: input.room,
		runId: input.runId,
		marker,
		commit,
		verifiedHead: base,
		idToM: Object.fromEntries(mappings),
		path,
		blockHash
	};
}

/** Recover a published room after interruption without starting a new transaction. */
export async function recoverPublication(
	input: Pick<PublishInput, "runId" | "room" | "channel">,
	root = PALACE_DIR,
	signal?: AbortSignal
): Promise<PublicationReceipt | null> {
	return verifyPublished(root, input, undefined, signal);
}

/** Revalidate a durable receipt against remote content before using it for recovery. */
export async function verifyPublication(
	receipt: PublicationReceipt,
	channel: string,
	root = PALACE_DIR,
	signal?: AbortSignal
): Promise<PublicationReceipt> {
	const verified = await verifyPublished(root, { ...receipt, channel }, receipt.blockHash, signal);
	if (!verified || verified.commit !== receipt.commit)
		throw new Error("Publication receipt could not be verified remotely");
	return verified;
}

interface TransactionPayload {
	input: Omit<PublishInput, "titles"> & { titles: [string, string][] };
	receiptPath: string;
}

/** Runs only in the approved script's locked, fresh transaction worktree. */
async function appendTransaction(payloadPath: string): Promise<void> {
	if (
		process.env.MIND_PALACE_TRANSACTION !== "1" ||
		!process.env.MIND_PALACE_WORKTREE ||
		realpathSync(process.cwd()) !== realpathSync(process.env.MIND_PALACE_WORKTREE)
	) {
		throw new Error("Palace append must run inside the approved transaction lock");
	}
	const payload = JSON.parse(readFileSync(payloadPath, "utf8")) as TransactionPayload;
	const input = { ...payload.input, titles: new Map(payload.input.titles) };
	validatePublicationInput(input);
	if (process.env.MIND_PALACE_BASE !== input.expectedBase) {
		throw new Error("Palace base changed since deduplication; recompute against current notes");
	}
	const notes = await notesAt(process.cwd(), input.expectedBase);
	const idToM = sourceMappings(notes.map((n) => n.text));
	let max = Math.max(0, ...notes.map((n) => maxMInText(n.text)));
	for (const id of new Set(input.principles.flatMap((p) => p.ids))) {
		if (!idToM.has(id)) idToM.set(id, ++max);
	}
	const key = publicationKey(input);
	const marker = `<!-- ytd:${key} -->`;
	const block = `${marker}\n${renderBatch({ ...input, idToM })}<!-- /ytd:${key} -->`;
	const path = join(process.cwd(), input.room, "field-notes.md");
	mkdirSync(join(process.cwd(), input.room), { recursive: true });
	await safeAppend(path, `\n\n${block}\n`);
	writeFileSync(payload.receiptPath, JSON.stringify({ blockHash: digest(block) }), { mode: 0o600 });
}

/** Publish only this batch; a separate clean clone keeps all foreign local work untouched. */
export async function publishBatch(
	input: PublishInput,
	options: PublicationOptions = {}
): Promise<PublicationReceipt> {
	validatePublicationInput(input);
	const root = options.palaceDir ?? PALACE_DIR;
	options.signal?.throwIfAborted();
	const existing = await verifyPublished(root, input, undefined, options.signal);
	if (existing) return existing;
	const runRoot = options.runDir ?? RUN_DIR;
	mkdirSync(runRoot, { recursive: true });
	const temp = mkdtempSync(join(runRoot, "palace-"));
	const source = join(temp, "source");
	let succeeded = false;
	try {
		const origin = await git(root, ["remote", "get-url", "origin"], options.signal);
		await git(
			root,
			["clone", "--quiet", "--branch", "main", "--single-branch", "--", origin, source],
			options.signal
		);
		if ((await git(source, ["rev-parse", "HEAD"], options.signal)) !== input.expectedBase)
			throw new PalaceBaseChangedError(
				`Palace base changed since deduplication; recovery data: ${temp}`
			);
		const script = join(source, "scripts", "mind-palace-sync");
		const help = await runCommand([script, "help"], { cwd: source, signal: options.signal });
		if (help.code !== 0 || !help.stdout.includes("--require-unchanged-base")) {
			throw new Error("Palace sync prerequisite --require-unchanged-base is unavailable");
		}
		const hooks = await runCommand([script, "install-hooks"], {
			cwd: source,
			signal: options.signal
		});
		if (hooks.code !== 0) throw new Error(`Palace transaction hooks unavailable: ${hooks.stderr}`);
		const receiptPath = join(temp, "prepared.json");
		const payloadPath = join(temp, "input.json");
		writeFileSync(
			payloadPath,
			JSON.stringify({ input: { ...input, titles: [...input.titles] }, receiptPath }),
			{ mode: 0o600 }
		);
		const env = { ...process.env };
		if (options.syncRoot) env.MIND_PALACE_SYNC_ROOT = options.syncRoot;
		if (options.lockRoot) env.MIND_PALACE_LOCK_ROOT = options.lockRoot;
		const result = await runCommand(
			[
				script,
				"run",
				"--require-unchanged-base",
				"--message",
				`docs(field-notes): ingest ${inlineMetadata(input.channel)} → ${input.room}`,
				"--idempotency-key",
				publicationKey(input),
				"--",
				process.execPath,
				import.meta.path,
				"--append-transaction",
				payloadPath
			],
			{ cwd: source, env, signal: options.signal }
		);
		if (result.code !== 0 || result.timedOut || result.cancelled || result.overflow) {
			// Classify races from canonical Git state, never subprocess error prose.
			if (!result.timedOut && !result.cancelled && !result.overflow) {
				const current = await loadPalaceSnapshot(root, options.signal);
				if (current.base !== input.expectedBase)
					throw new PalaceBaseChangedError(
						`Palace base changed during publication; recovery data: ${temp}`
					);
			}
			throw new Error(`Palace publication preserved at ${temp}: ${result.stderr || result.stdout}`);
		}
		const prepared = existsSync(receiptPath)
			? (JSON.parse(readFileSync(receiptPath, "utf8")) as { blockHash: string })
			: undefined;
		const receipt = await verifyPublished(root, input, prepared?.blockHash, options.signal);
		if (!receipt) throw new Error(`Palace remote verification failed; recovery data: ${temp}`);
		succeeded = true;
		return receipt;
	} finally {
		if (succeeded) rmSync(temp, { recursive: true, force: true });
	}
}

if (import.meta.main && process.argv[2] === "--append-transaction") {
	appendTransaction(process.argv[3]).catch((error: unknown) => {
		// This child's stderr is never parsed for meaning — the caller classifies races from
		// canonical Git state, not from error prose — so it is displayed through the same
		// sanitising surface as every other diagnostic instead of reaching the terminal raw.
		createPresenter().fail(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
