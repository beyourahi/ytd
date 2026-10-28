/**
 * A minimal terminal screen, for asserting what an operator actually sees.
 *
 * The PTY tests assert the byte stream, and a byte stream cannot say whether a cursor move and an
 * erase left the screen readable. That is exactly the gap this closes: a live region that erases
 * from the wrong row removes printed output and leaves stale lines behind while every individual
 * byte it wrote was correct, so only the resulting screen can tell the difference.
 *
 * Only what the presenter and the region emit is modelled: printable text, CR, LF, backspace, the
 * cursor moves (`A`/`B`/`C`/`D`/`G`), the two erases (`J`/`K`) and SGR, which occupies no cell.
 * Cells hold a character and a wide character occupies two columns, so a line a real terminal
 * would wrap is wrapped here too — which is how a mis-measured width becomes a visible failure
 * rather than a quietly correct-looking byte stream.
 *
 * The width rule is deliberately written out again rather than imported from `src/text.ts`: a
 * verifier that measured the frame with the frame's own ruler could not detect a wrong ruler. It
 * agrees with the renderer on policy (East Asian wide and fullwidth are two columns, combining
 * marks and joiners are none, ambiguous symbols are one), not by sharing code.
 */

const ESC = 27;

/** Columns one code point occupies, by the same policy a terminal uses. */
function cellWidth(code: number): number {
	if (code < 0x0300) return 1;
	const zero = [
		[0x0300, 0x036f],
		[0x0483, 0x0489],
		[0x0591, 0x05bd],
		[0x0610, 0x061a],
		[0x064b, 0x065f],
		[0x0e31, 0x0e3a],
		[0x0e47, 0x0e4e],
		[0x1ab0, 0x1aff],
		[0x1dc0, 0x1dff],
		[0x200b, 0x200f],
		[0x202a, 0x202e],
		[0x2060, 0x2064],
		[0x20d0, 0x20f0],
		[0xfe00, 0xfe0f],
		[0xfe20, 0xfe2f],
		[0xfeff, 0xfeff],
		[0xe0100, 0xe01ef]
	];
	for (const [from, to] of zero) if (code >= from! && code <= to!) return 0;
	const wide = [
		[0x1100, 0x115f],
		[0x2e80, 0x303e],
		[0x3041, 0x33ff],
		[0x3400, 0x4dbf],
		[0x4e00, 0x9fff],
		[0xa000, 0xa4cf],
		[0xa960, 0xa97f],
		[0xac00, 0xd7a3],
		[0xf900, 0xfaff],
		[0xfe10, 0xfe19],
		[0xfe30, 0xfe6f],
		[0xff00, 0xff60],
		[0xffe0, 0xffe6],
		[0x16fe0, 0x16fe4],
		[0x17000, 0x18cff],
		[0x1b000, 0x1b2ff],
		[0x1f004, 0x1f004],
		[0x1f0cf, 0x1f0cf],
		[0x1f18e, 0x1f18e],
		[0x1f191, 0x1f19a],
		[0x1f200, 0x1f320],
		[0x1f300, 0x1f64f],
		[0x1f680, 0x1f6ff],
		[0x1f7e0, 0x1f7eb],
		[0x1f900, 0x1f9ff],
		[0x1fa70, 0x1faff],
		[0x20000, 0x3fffd]
	];
	for (const [from, to] of wide) if (code >= from! && code <= to!) return 2;
	return 1;
}

export interface ScreenSnapshot {
	/** Every row, trailing blanks removed, including rows that ended up empty. */
	rows: string[];
	/** The same rows joined, which is what an operator reads. */
	text: string;
	/** True when any row contains `needle`. */
	has(needle: string): boolean;
	/** The last row that contains `needle`, or the empty string. */
	rowWith(needle: string): string;
	/** The last non-empty row. */
	last: string;
	cursor: { row: number; column: number };
}

/**
 * A terminal's own state, rebuilt from what it was sent.
 *
 * The wrap is deferred, as a real terminal's is: a character written in the last column leaves the
 * cursor there with the wrap pending, and only the next printable character moves it to the next
 * row. A model that wrapped immediately would show a spurious extra line for a frame whose rule
 * fills the width exactly, and would fail a correct renderer.
 */
export class TerminalScreen {
	private readonly grid: string[][];
	private row = 0;
	private column = 0;
	private pendingWrap = false;

	constructor(
		private readonly columns: number,
		private readonly rows: number
	) {
		this.grid = Array.from({ length: rows }, () => Array.from({ length: columns }, () => " "));
	}

	write(chunk: string): void {
		for (let index = 0; index < chunk.length;) {
			const code = chunk.codePointAt(index) ?? 0;
			const span = code > 0xffff ? 2 : 1;
			if (code === ESC) {
				index = this.escape(chunk, index);
				continue;
			}
			if (code === 13) {
				this.column = 0;
				this.pendingWrap = false;
				index += span;
				continue;
			}
			if (code === 10) {
				this.lineFeed();
				index += span;
				continue;
			}
			if (code === 8) {
				this.column = Math.max(0, this.column - 1);
				this.pendingWrap = false;
				index += span;
				continue;
			}
			if (code === 7 || code === 9) {
				index += span;
				continue;
			}
			this.put(String.fromCodePoint(code));
			index += span;
		}
	}

	/** Everything now on the screen, plus where the cursor was left. */
	snapshot(): ScreenSnapshot {
		const rows = this.grid.map((cells) => {
			let text = "";
			for (const cell of cells) text += cell;
			return text.replace(/\s+$/, "");
		});
		return {
			rows,
			text: rows.join("\n"),
			has: (needle) => rows.some((row) => row.includes(needle)),
			rowWith: (needle) =>
				rows
					.slice()
					.reverse()
					.find((row) => row.includes(needle)) ?? "",
			last:
				rows
					.slice()
					.reverse()
					.find((row) => row.length > 0) ?? "",
			cursor: { row: this.row, column: this.column }
		};
	}

	private put(char: string): void {
		const width = cellWidth(char.codePointAt(0) ?? 0);
		// A combining mark belongs to the cell before it, which already counted its column.
		if (width === 0) {
			const at = this.column > 0 ? this.column - 1 : 0;
			this.grid[this.row]![at] = `${this.grid[this.row]![at]}${char}`;
			return;
		}
		if (this.pendingWrap || (width === 2 && this.column >= this.columns - 1)) {
			this.lineFeed();
			this.column = 0;
			this.pendingWrap = false;
		}
		this.grid[this.row]![this.column] = char;
		if (width === 2) this.grid[this.row]![this.column + 1] = "";
		this.column += width;
		if (this.column >= this.columns) {
			this.column = this.columns - 1;
			this.pendingWrap = true;
		}
	}

	private lineFeed(): void {
		this.pendingWrap = false;
		this.row += 1;
		if (this.row < this.rows) return;
		this.grid.shift();
		this.grid.push(Array.from({ length: this.columns }, () => " "));
		this.row = this.rows - 1;
	}

	/** Apply one escape sequence, returning the index of the first byte after it. */
	private escape(chunk: string, at: number): number {
		const next = chunk.charCodeAt(at + 1);
		if (next === 93) {
			// OSC: payload runs to BEL or ST and occupies no cells.
			let index = at + 2;
			while (index < chunk.length && chunk.charCodeAt(index) !== 7) {
				if (chunk.charCodeAt(index) === ESC && chunk.charCodeAt(index + 1) === 92) {
					index += 1;
					break;
				}
				index += 1;
			}
			return index + 1;
		}
		if (next !== 91) return at + 1;
		let index = at + 2;
		let params = "";
		while (index < chunk.length) {
			const code = chunk.charCodeAt(index);
			if (code >= 0x40 && code <= 0x7e) break;
			params += chunk[index];
			index += 1;
		}
		this.control(chunk[index] ?? "", params);
		return index + 1;
	}

	private control(final: string, params: string): void {
		const first = Number(params.split(";")[0] ?? "");
		const count = Number.isFinite(first) && first > 0 ? first : 1;
		if (final === "A") this.row = Math.max(0, this.row - count);
		else if (final === "B") this.row = Math.min(this.rows - 1, this.row + count);
		else if (final === "C") this.column = Math.min(this.columns - 1, this.column + count);
		else if (final === "D") this.column = Math.max(0, this.column - count);
		else if (final === "G") this.column = Math.min(this.columns - 1, count - 1);
		else if (final === "H" || final === "f") {
			const parts = params.split(";");
			const row = Number(parts[0] ?? "1");
			const column = Number(parts[1] ?? "1");
			this.row = Math.min(this.rows - 1, Math.max(0, (Number.isFinite(row) ? row : 1) - 1));
			this.column = Math.min(
				this.columns - 1,
				Math.max(0, (Number.isFinite(column) ? column : 1) - 1)
			);
		} else if (final === "J")
			this.eraseDisplay(params.includes("2") ? 2 : params.includes("1") ? 1 : 0);
		else if (final === "K") this.eraseLine(params.includes("2") ? 2 : params.includes("1") ? 1 : 0);
		this.pendingWrap = false;
	}

	private eraseDisplay(mode: 0 | 1 | 2): void {
		const blank = (): string[] => Array.from({ length: this.columns }, () => " ");
		if (mode === 2) {
			for (let row = 0; row < this.rows; row++) this.grid[row] = blank();
			return;
		}
		if (mode === 1) {
			for (let row = 0; row < this.row; row++) this.grid[row] = blank();
			this.eraseLine(1);
			return;
		}
		// From the cursor to the end of the screen, which is the erase a live region uses.
		this.eraseLine(0);
		for (let row = this.row + 1; row < this.rows; row++) this.grid[row] = blank();
	}

	private eraseLine(mode: 0 | 1 | 2): void {
		const cells = this.grid[this.row]!;
		const from = mode === 1 ? 0 : this.column;
		const to = mode === 0 ? this.columns : this.column + 1;
		for (let cell = from; cell < to && cell < this.columns; cell++) cells[cell] = " ";
	}
}
