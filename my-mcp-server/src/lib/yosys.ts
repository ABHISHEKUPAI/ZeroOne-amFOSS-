/**
 * The single chokepoint for every Yosys invocation.
 *
 * Nothing else in this codebase may import '@yowasp/yosys' directly: a non-zero exit throws
 * `Exit`, and that error still carries the virtual filesystem and the log. Catching it here —
 * once — is what makes a *failed* run a usable result instead of a crash, which is the whole
 * basis of the agent repair loop.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Tree = { [name: string]: Tree | string | Uint8Array };

export interface YosysResult {
  /** true iff Yosys exited 0 */
  ok: boolean;
  code: number;
  /** stdout+stderr interleaved, in order */
  log: string;
  /** virtual FS after the run — populated even when ok === false */
  files: Tree;
  /** wall-clock ms */
  elapsedMs: number;
}

type Command = (args?: string[], files?: Tree, options?: unknown) => Promise<Tree>;

let yosysMod: { runYosys: Command; Exit: new () => Error } | null = null;

/**
 * ~54MB of WASM. Importing at module scope blows up server startup, so it is loaded on first
 * use and cached. Concurrent callers share one in-flight import.
 */
let loading: Promise<{ runYosys: Command; Exit: new () => Error }> | null = null;
async function load() {
  if (yosysMod) return yosysMod;
  if (!loading) {
    loading = (async () => {
      const mod = (await import('@yowasp/yosys')) as unknown as {
        runYosys: Command;
        Exit: new () => Error;
      };
      yosysMod = mod;
      return mod;
    })();
  }
  return loading;
}

/** Warm the WASM ahead of first tool call so the demo's first invocation isn't the slow one. */
export async function preloadYosys(): Promise<void> {
  await load();
}

export function isYosysLoaded(): boolean {
  return yosysMod !== null;
}

/**
 * Run a Yosys script against an in-memory file tree.
 *
 * @param script  Yosys commands, newline separated (passed via -p)
 * @param files   virtual FS contents, e.g. { 'top.v': src }
 */
export async function runYosysScript(script: string, files: Tree = {}): Promise<YosysResult> {
  const { runYosys, Exit } = await load();

  const chunks: string[] = [];
  const dec = new TextDecoder();
  const sink = (b: Uint8Array | null) => {
    if (b) chunks.push(dec.decode(b));
  };

  const started = Date.now();
  try {
    const out = await runYosys(['-p', script.trim()], files, {
      stdout: sink,
      stderr: sink,
      decodeASCII: false,
    });
    return { ok: true, code: 0, log: chunks.join(''), files: out, elapsedMs: Date.now() - started };
  } catch (e) {
    if (e instanceof Exit) {
      // The payload we actually want. `files` survives the failure.
      const ex = e as Error & { code: number; files: Tree };
      return {
        ok: false,
        code: ex.code,
        log: chunks.join(''),
        files: ex.files ?? {},
        elapsedMs: Date.now() - started,
      };
    }
    throw e;
  }
}

/** Read a text file out of a returned tree, tolerating Uint8Array vs string. */
export function readTreeFile(files: Tree, name: string): string | null {
  const v = files[name];
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return new TextDecoder().decode(v);
  return null;
}

/**
 * Yosys emits its banner and pass logs to the same stream as `-json` output, so the JSON has to be
 * carved out. Scans for the last balanced top-level {...}, ignoring braces inside strings.
 */
export function extractLastJson(log: string): unknown | null {
  for (let start = log.indexOf('{'); start !== -1; start = log.indexOf('{', start + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < log.length; i++) {
      const c = log[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(log.slice(start, i + 1));
          } catch {
            break; // not valid JSON from here; try the next '{'
          }
        }
      }
    }
  }
  return null;
}

// --- sky130 liberty ------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
let libCache: Uint8Array | null = null;

/**
 * The vendored sky130 liberty (13MB, 428 cells with real `area`). Cached after first read —
 * it is passed into the virtual FS on every area run.
 */
export async function sky130Lib(): Promise<Uint8Array> {
  if (libCache) return libCache;
  // dist/lib/yosys.js -> ../../assets/sky130.lib
  const candidates = [
    join(here, '..', '..', 'assets', 'sky130.lib'),
    join(here, '..', '..', '..', 'assets', 'sky130.lib'),
  ];
  for (const p of candidates) {
    try {
      libCache = new Uint8Array(await readFile(p));
      return libCache;
    } catch {
      /* try next */
    }
  }
  throw new Error(
    `sky130.lib not found (looked in: ${candidates.join(', ')}). It is vendored into assets/ — do not fetch at runtime.`,
  );
}

export const LIB_NAME = 'sky130.lib';
