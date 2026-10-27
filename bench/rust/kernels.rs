// Rust comparison kernels for the two genuinely CPU-bound local operations in ytd.
//
// Built with `rustc -O` by bench/run.ts and driven over stdin/stdout, so the measurement
// includes the process start and the pipe that a real helper would pay. Both kernels print a
// count and a rolling FNV-1a hash of their result, and the TypeScript side computes the same
// hash over its own result: a timing only counts when the two hashes agree, so a faster kernel
// that produces different text is reported as a failed comparison rather than a win.
//
// Only `std` is used on purpose. A helper that needs its own dependency tree has a maintenance
// cost that the benchmark has to earn back, and the packaged tool would carry it forever.

use std::io::{self, Read, Write};

/// Same rolling hash as the TypeScript side: 64-bit FNV-1a over bytes.
struct Fnv(u64);

impl Fnv {
    fn new() -> Self {
        Fnv(0xcbf2_9ce4_8422_2325)
    }

    fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 ^= *byte as u64;
            self.0 = self.0.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }

    fn write_separator(&mut self) {
        self.write(b"\n");
    }
}

/// Lowercase a character exactly as the TypeScript normaliser does for the characters that
/// actually appear in candidate principles: ASCII plus the simple Unicode lowercase mapping.
fn lower(c: char) -> char {
    let mut out = c.to_lowercase();
    let first = out.next().unwrap_or(c);
    // Multi-character lowercase mappings (İ, ẞ) are treated as their first character, which is
    // what a byte-oriented normaliser does; the comparison only ever sees ASCII in practice.
    first
}

fn is_alphanumeric(c: char) -> bool {
    c.is_alphanumeric()
}

/// Normalise one line the same way `normalisePrinciple` does: lowercase, collapse everything
/// that is not a letter or digit into single spaces, trim.
fn normalise(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut pending_space = false;
    for c in line.chars() {
        let c = lower(c);
        if is_alphanumeric(c) {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            out.push(c);
        } else {
            pending_space = true;
        }
    }
    out
}

/// Scan a json3 caption track for `"utf8"` string values.
///
/// This is a targeted scanner, not a general JSON parser: the input shape is fixed by YouTube's
/// caption format, and the point of the comparison is the cost of extracting text from it.
fn json3_text(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len() / 4);
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'"' {
            let key_start = i + 1;
            let mut j = key_start;
            while j < bytes.len() && bytes[j] != b'"' {
                j += 1;
            }
            let key = &input[key_start..j];
            i = j + 1;
            // Skip whitespace, expect ':', then a string value.
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            if i >= bytes.len() || bytes[i] != b':' {
                continue;
            }
            i += 1;
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            if i >= bytes.len() || bytes[i] != b'"' {
                continue;
            }
            let value_start = i + 1;
            let mut k = value_start;
            while k < bytes.len() && bytes[k] != b'"' {
                if bytes[k] == b'\\' {
                    k += 1;
                }
                k += 1;
            }
            if key == "utf8" {
                // The comparison hashes the concatenation of segment values exactly as the
                // TypeScript side does, so event spacing is not part of the operands.
                out.push_str(&input[value_start..k.min(input.len())]);
            }
            i = k + 1;
        } else {
            i += 1;
        }
    }
    out
}

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).expect("read stdin");
    let mut hash = Fnv::new();
    let mut count: usize = 0;
    match mode.as_str() {
        "normalize" => {
            for line in input.lines() {
                if line.trim().is_empty() {
                    continue;
                }
                let key = normalise(line);
                if key.is_empty() {
                    continue;
                }
                count += 1;
                hash.write(key.as_bytes());
                hash.write_separator();
            }
        }
        "json3" => {
            let text = json3_text(&input);
            count = text.len();
            hash.write(text.as_bytes());
        }
        other => {
            eprintln!("unknown mode: {other}");
            std::process::exit(2);
        }
    }
    let stdout = io::stdout();
    let mut out = stdout.lock();
    writeln!(out, "{count} {:016x}", hash.0).expect("write stdout");
}
