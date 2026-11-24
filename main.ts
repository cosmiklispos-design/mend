// main.ts is mend, the CLI SPEC.md specifies (MIT). It does all ten sections of SPEC.md: the command line,
// the output and exit codes, safe paths, format detection, matching lines at three tiers, unified diffs,
// SEARCH/REPLACE blocks, V4A patches, JSON edits, and the all-or-nothing write. Node 22, the standard
// library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** One file's lines, its line break and whether its text ends with one (SPEC.md section 3). */
interface FileState {
  br: '\r\n' | '\n';
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Original path -> current path, for files that existed before the patch and were moved. */
  private readonly moves = new Map<string, string>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** Write (create or change) a file's text. */
  writeFile(p: string, text: string): void {
    if (this.moves.has(p)) this.moves.delete(p);
    this.now.set(p, text);
  }
  /** Delete a file. */
  deleteFile(p: string): void {
    for (const [k, v] of this.moves) {
      if (v === p) {
        this.moves.delete(k);
        break;
      }
    }
    this.now.set(p, null);
  }
  /** Move a file, applying its new text at the new path. */
  moveFile(oldP: string, newP: string, text: string): void {
    let orig = oldP;
    for (const [k, v] of this.moves) {
      if (v === oldP) {
        orig = k;
        this.moves.delete(k);
        break;
      }
    }
    if (this.original(orig) !== null) this.moves.set(orig, newP);
    this.now.set(oldP, null);
    this.now.set(newP, text);
  }
  movePairs(): Array<[string, string]> {
    return [...this.moves.entries()];
  }
  /** Restore the move edges (a failed edit changes nothing, SPEC.md section 10). */
  restoreMoves(pairs: Array<[string, string]>): void {
    this.moves.clear();
    for (const [k, v] of pairs) this.moves.set(k, v);
  }
}

type Edit = (tree: Tree) => void;

/** Compare two paths (or sort keys) as UTF-8 bytes. */
function byteCmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

// ---- Matching (SPEC.md section 5) ----

/** Are two lines equal at the given tier? 0: exact; 1: both trimmed of trailing spaces/tabs; 2: both trimmed of leading and trailing spaces/tabs. */
function lineEq(fileLine: string, patchLine: string, tier: number): boolean {
  if (tier === 0) return fileLine === patchLine;
  if (tier === 1) return fileLine.trimEnd() === patchLine.trimEnd();
  return fileLine.trim() === patchLine.trim();
}

function leadingWS(s: string): string {
  return s.slice(0, s.length - s.trimStart().length);
}

/** Re-indent a new line at tier 2: replace the old lines' leading whitespace with the file's (SPEC.md section 5). */
function reindentLine(text: string, tier: number, fileFirst: string, patchFirst: string): string {
  if (tier !== 2) return text;
  if (text.trim() === '') return text;
  if (text.startsWith(patchFirst)) return fileFirst + text.slice(patchFirst.length);
  return text;
}

/** Every position at which `oldLines` occurs in `lines` at this tier, from `from` onwards; occurrences may overlap. */
function findOccurrences(lines: string[], oldLines: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  const k = oldLines.length;
  for (let i = from; i + k <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (!lineEq(lines[i + j]!, oldLines[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier with at least one occurrence of `oldLines` in `lines` (from `from` onwards). */
function matchTier(lines: string[], oldLines: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = findOccurrences(lines, oldLines, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** A new line of an edit: `ctx` ones are written as the file's own matched line, never the patch's (SPEC.md section 5). */
interface NewLine {
  text: string;
  ctx: boolean;
  /** Index of this context line in O, for a context line; -1 otherwise. */
  oIndex: number;
}

/** Replace `o` at `at` in the file with `n`, taking the tier-2 re-indent from the first matched line. */
function spliceLines(f: FileState, at: number, o: string[], n: NewLine[], tier: number): void {
  const fileFirst = leadingWS(f.lines[at] ?? '');
  const patchFirst = leadingWS(o[0] ?? '');
  const repl = n.map((x) => (x.ctx ? f.lines[at + x.oIndex]! : reindentLine(x.text, tier, fileFirst, patchFirst)));
  f.lines.splice(at, o.length, ...repl);
}

/** Turn hunk/chunk body operations into the old lines and the new lines (context lines carry their index in O). */
interface BodyOp {
  kind: ' ' | '-' | '+';
  text: string;
  /** A `\` line follows this one. */
  bs: boolean;
}
function bodyON(ops: BodyOp[]): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const op of ops) {
    if (op.kind === ' ') {
      n.push({ text: op.text, ctx: true, oIndex: o.length });
      o.push(op.text);
    } else if (op.kind === '-') {
      o.push(op.text);
    } else {
      n.push({ text: op.text, ctx: false, oIndex: -1 });
    }
  }
  return { o, n };
}

/** The `\` line after the last context or `+` line of a hunk: the result ends with no line break then. */
function lastAddedBs(ops: BodyOp[]): boolean {
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i]!;
    if (op.kind === ' ' || op.kind === '+') return op.bs;
  }
  return false;
}

// ---- JSON edits (SPEC.md section 9) ----

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.writeFile(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.writeFile(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.writeFile(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Unified diffs (SPEC.md section 6) ----

interface Section {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Array<{ a: number; ops: BodyOp[] }>;
}

function headerPath(s: string): string {
  const p = s.split('\t')[0]!.trim();
  return p.replace(/^[ab]\//, '');
}

function parseDiffGit(l: string): [string, string] | null {
  const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
  return m ? [m[1]!, m[2]!] : null;
}

function parseUnifiedHeader(lines: string[], i: number, s: Section): number {
  const n = lines.length;
  let pairOld: string | null = null;
  let pairNew: string | null = null;
  let renameOld: string | null = null;
  let renameNew: string | null = null;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('@@')) break;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        pairOld = headerPath(l.slice(4));
        pairNew = headerPath(lines[i + 1]!.slice(4));
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('+++ ')) {
      if (pairNew === null) pairNew = headerPath(l.slice(4));
      i++;
      continue;
    }
    if (l.startsWith('rename from ')) {
      if (renameOld === null) renameOld = l.slice('rename from '.length).trim();
    } else if (l.startsWith('rename to ')) {
      if (renameNew === null) renameNew = l.slice('rename to '.length).trim();
    } else if (l.startsWith('new file mode')) {
      s.newFile = true;
    } else if (l.startsWith('deleted file mode')) {
      s.deletedFile = true;
    }
    i++;
  }
  if (pairOld !== null) s.oldPath = pairOld === '/dev/null' ? null : pairOld;
  else if (renameOld !== null) s.oldPath = renameOld;
  if (pairNew !== null) s.newPath = pairNew === '/dev/null' ? null : pairNew;
  else if (renameNew !== null) s.newPath = renameNew;
  return i;
}

function parseUnifiedHunks(lines: string[], i: number, s: Section): number {
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (!l.startsWith('@@')) break;
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (!m) throw new Exit2(`error: parse ${i + 1}`);
    const hunk: { a: number; ops: BodyOp[] } = { a: Number(m[1]), ops: [] };
    i++;
    while (i < n) {
      const b = lines[i]!;
      if (b.startsWith('diff --git ')) break;
      if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      if (b.startsWith('@@')) break;
      if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
        if (b.startsWith('\\')) {
          if (hunk.ops.length > 0) hunk.ops[hunk.ops.length - 1]!.bs = true;
        } else if (b === '') {
          hunk.ops.push({ kind: ' ', text: '', bs: false });
        } else {
          hunk.ops.push({ kind: b[0] as ' ' | '-' | '+', text: b.slice(1), bs: false });
        }
        i++;
      } else break;
    }
    while (hunk.ops.length > 0) {
      const last = hunk.ops[hunk.ops.length - 1]!;
      if (last.kind === ' ' && last.text === '') hunk.ops.pop();
      else break;
    }
    s.hunks.push(hunk);
  }
  return i;
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  const n = lines.length;
  let current: Section | null = null;
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const g = parseDiffGit(l);
      if (!g) throw new Exit2(`error: parse ${i + 1}`);
      current = { oldPath: g[0], newPath: g[1], newFile: false, deletedFile: false, hunks: [] };
      sections.push(current);
      i++;
      i = parseUnifiedHeader(lines, i, current);
      i = parseUnifiedHunks(lines, i, current);
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      current = { oldPath: null, newPath: null, newFile: false, deletedFile: false, hunks: [] };
      sections.push(current);
      i = parseUnifiedHeader(lines, i, current);
      i = parseUnifiedHunks(lines, i, current);
    } else if (l.startsWith('@@')) {
      if (!current) throw new Exit2(`error: parse ${i + 1}`);
      i = parseUnifiedHunks(lines, i, current);
    } else {
      i++;
    }
  }
  return sections;
}

/** Apply one hunk to a file, honouring the `d` delta (SPEC.md section 6). */
function applyHunk(f: FileState, hunk: { a: number; ops: BodyOp[] }, d: number, strict: boolean, path: string): number {
  const { o, n } = bodyON(hunk.ops);
  if (o.length === 0) {
    let at = hunk.a + d;
    if (at < 0) at = 0;
    if (at > f.lines.length) at = f.lines.length;
    const ins = n.map((x) => x.text);
    f.lines.splice(at, 0, ...ins);
    if (ins.length > 0 && at + ins.length === f.lines.length) f.final = !lastAddedBs(hunk.ops);
    return n.length;
  }
  const m = matchTier(f.lines, o, strict);
  if (!m) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let best = m.occ[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of m.occ) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const toEnd = best + o.length === f.lines.length;
  spliceLines(f, best, o, n, m.tier);
  if (toEnd) f.final = n.length > 0 ? !lastAddedBs(hunk.ops) : true;
  return n.length - o.length;
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  return (tree: Tree) => {
    const oldP = s.oldPath;
    const newP = s.newPath;
    for (const p of [oldP, newP]) {
      if (p !== null && !safe(p)) throw new Fail('unsafe', p);
    }
    if (oldP === null || s.newFile) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of s.hunks) for (const op of h.ops) if (op.kind === '+') plus.push(op.text);
      let lastBs = false;
      for (const h of s.hunks) for (const op of h.ops) if (op.kind === '+') lastBs = op.bs;
      tree.writeFile(newP, plus.length === 0 ? '' : plus.join('\n') + (lastBs ? '' : '\n'));
      return;
    }
    if (newP === null || s.deletedFile) {
      if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
      tree.deleteFile(oldP!);
      return;
    }
    if (oldP !== newP) {
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const f = parseFile(before);
      let d = 0;
      for (const h of s.hunks) d += applyHunk(f, h, d, strict, oldP);
      tree.moveFile(oldP, newP, renderFile(f));
      return;
    }
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    const f = parseFile(before);
    let d = 0;
    for (const h of s.hunks) d += applyHunk(f, h, d, strict, oldP);
    tree.writeFile(oldP, renderFile(f));
  };
}

// ---- SEARCH/REPLACE (SPEC.md section 7) ----

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  const n = lines.length;
  let i = 0;
  let lastEnd = 0;
  let prevPath: string | null = null;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let eq = -1;
    for (let j = s + 1; j < n; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '<<<<<<< SEARCH' || t === '>>>>>>> REPLACE') break;
      if (t === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '<<<<<<< SEARCH') break;
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j >= lastEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${s + 1}`);
    }
    blocks.push({ path, oldLines: lines.slice(s + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    lastEnd = rep + 1;
    i = rep + 1;
  }
  return blocks;
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.writeFile(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const f = parseFile(before);
    const m = matchTier(f.lines, b.oldLines, strict);
    if (!m) throw new Fail('no-match', b.path);
    if (m.occ.length > 1) throw new Fail('ambiguous', b.path);
    const at = m.occ[0]!;
    const n: NewLine[] = b.newLines.map((t) => ({ text: t, ctx: false, oIndex: -1 }));
    spliceLines(f, at, b.oldLines, n, m.tier);
    tree.writeFile(b.path, renderFile(f));
  };
}

// ---- V4A (SPEC.md section 8) ----

interface VChunk {
  anchor: string | null;
  ops: BodyOp[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  /** Add File: the file's lines. */
  lines: string[];
  chunks: VChunk[];
  headerLine: number;
}

function parseV4a(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice('*** Add File: '.length).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice('*** Delete File: '.length).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i + 1;
    i++;
    const raw: number[] = [];
    while (i < last) {
      const x = lines[i]!;
      if (x.startsWith('*** Add File: ') || x.startsWith('*** Delete File: ') || x.startsWith('*** Update File: ')) break;
      raw.push(i);
      i++;
    }
    while (raw.length > 0 && blank(lines[raw[raw.length - 1]!]!)) raw.pop();
    if (kind === 'add') {
      const fl: string[] = [];
      for (const ri of raw) {
        const x = lines[ri]!;
        if (x === '') fl.push('');
        else if (x.startsWith('+')) fl.push(x.slice(1));
        else throw new Exit2(`error: parse ${ri + 1}`);
      }
      sections.push({ kind, path, moveTo: null, lines: fl, chunks: [], headerLine });
    } else if (kind === 'delete') {
      for (const ri of raw) {
        if (!blank(lines[ri]!)) throw new Exit2(`error: parse ${ri + 1}`);
      }
      sections.push({ kind, path, moveTo: null, lines: [], chunks: [], headerLine });
    } else {
      let moveTo: string | null = null;
      let j = 0;
      while (j < raw.length && blank(lines[raw[j]!]!)) j++;
      if (j < raw.length && lines[raw[j]!]!.startsWith('*** Move to: ')) {
        moveTo = lines[raw[j]!]!.slice('*** Move to: '.length).trim();
        j++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const flush = (): void => {
        if (cur) {
          chunks.push(cur);
          cur = null;
        }
      };
      let closed = false;
      for (; j < raw.length; j++) {
        const ri = raw[j]!;
        const x = lines[ri]!;
        if (closed) throw new Exit2(`error: parse ${ri + 1}`);
        if (x === '*** End of File') {
          if (!cur) cur = { anchor: null, ops: [], eof: true };
          else cur.eof = true;
          flush();
          closed = true;
          continue;
        }
        if (x.startsWith('@@')) {
          flush();
          cur = { anchor: x.slice(2).trim(), ops: [], eof: false };
          continue;
        }
        if (x === '' || x.startsWith(' ') || x.startsWith('-') || x.startsWith('+')) {
          if (!cur) cur = { anchor: null, ops: [], eof: false };
          if (x === '') cur.ops.push({ kind: ' ', text: '', bs: false });
          else cur.ops.push({ kind: x[0] as ' ' | '-' | '+', text: x.slice(1), bs: false });
          continue;
        }
        throw new Exit2(`error: parse ${ri + 1}`);
      }
      flush();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      sections.push({ kind, path, moveTo, lines: [], chunks, headerLine });
    }
  }
  return sections;
}

/** Apply one V4A chunk; returns the cursor after the lines it wrote (SPEC.md section 8). */
function applyV4aChunk(f: FileState, c: VChunk, cursor: number, strict: boolean, path: string): number {
  let cur = cursor;
  if (c.anchor !== null) {
    const tiers = strict ? [0] : [0, 1, 2];
    let found = -1;
    for (const t of tiers) {
      for (let i = cur; i < f.lines.length; i++) {
        if (lineEq(f.lines[i]!, c.anchor, t)) {
          found = i;
          break;
        }
      }
      if (found >= 0) break;
    }
    if (found < 0) throw new Fail('no-match', path);
    cur = found + 1;
  }
  const { o, n } = bodyON(c.ops);
  if (o.length === 0) {
    const at = c.eof ? f.lines.length : cur;
    const ins = n.map((x) => x.text);
    f.lines.splice(at, 0, ...ins);
    return at + ins.length;
  }
  const tiers = strict ? [0] : [0, 1, 2];
  let m: { tier: number; occ: number[] } | null = null;
  for (const t of tiers) {
    const occ = findOccurrences(f.lines, o, t, cur).filter((p) => !c.eof || p + o.length === f.lines.length);
    if (occ.length > 0) {
      m = { tier: t, occ };
      break;
    }
  }
  if (!m) throw new Fail('no-match', path);
  const at = m.occ[0]!;
  spliceLines(f, at, o, n, m.tier);
  return at + n.length;
}

function v4aEdit(s: VSection, strict: boolean): Edit {
  return (tree: Tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.writeFile(s.path, s.lines.length === 0 ? '' : s.lines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.deleteFile(s.path);
      return;
    }
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const f = parseFile(before);
    let cursor = 0;
    for (const c of s.chunks) cursor = applyV4aChunk(f, c, cursor, strict, s.path);
    const text = renderFile(f);
    if (s.moveTo !== null) tree.moveFile(s.path, s.moveTo, text);
    else tree.writeFile(s.path, text);
  };
}

// ---- Detection (SPEC.md section 4) ----

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- The run (SPEC.md sections 1, 2 and 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines).map((s) => unifiedEdit(s, strict));
    else if (kind === 'search-replace') edits = parseSearchReplace(lines).map((b) => srEdit(b, strict));
    else edits = parseV4a(lines).map((s) => v4aEdit(s, strict));
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = new Map(tree.movePairs());
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.restoreMoves(beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; line: string }> = [];
  const supD = new Set<string>();
  const supA = new Set<string>();
  for (const [orig, cur] of tree.movePairs()) {
    if (tree.original(orig) !== null && tree.get(orig) === null && tree.get(cur) !== null) {
      rows.push({ key: cur, line: `R ${orig} -> ${cur}` });
      supD.add(orig);
      supA.add(cur);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was !== null && now === null && supD.has(p)) continue;
    if (was === null && now !== null && supA.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  if (!check) {
    for (const [p, v] of tree.now) {
      if (v === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, v);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
