// mend — one patch tool for every AI edit format (SPEC.md v1).
//
// Usage: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//   --format  unified | search-replace | v4a | json | auto (default)
//   --check   dry-run: same output and exit code, no file written
//   --strict  line matching uses tier 0 only
//   PATCH     path to the patch file, relative to the current directory;
//             when absent, or when it is `-`, the patch is read from stdin.
//
// The tool applies edits in four formats — unified diff (even when the
// stated line numbers are wrong), SEARCH/REPLACE blocks, V4A, and JSON —
// to a tree of text files. An old block is found at the first of three
// matching tiers: exact lines, lines equal after trimming trailing
// spaces/tabs, lines equal after trimming both ends. Edits apply in
// patch order to the tree as earlier edits left it. A failed edit
// changes nothing and the edits after it still run; when any edit
// failed nothing is written and the exit code is 1.
//
// Node 22, standard library only. Deterministic: same exit code, stdout
// and files on every run for the same patch and tree.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['unified', 'search-replace', 'v4a', 'json', 'auto'] as const;
type Format = (typeof FORMATS)[number];

// ---------------------------------------------------------------- errors

class Exit2 extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

class Fail extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

// ---------------------------------------------------------------- helpers

function blank(s: string): boolean {
  return s.trim() === '';
}

// Split a patch into lines: split at \n, remove one trailing \r per line,
// no empty piece after the final \n.
function patchLines(text: string): string[] {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

// A path is safe when it is not empty, does not start with `/`, has no
// `\`, and no segment is empty, `.` or `..`.
function safe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

// Byte order (UTF-8) for sorting output rows.
function byteCmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function rtrim(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

// ---------------------------------------------------------------- file model

interface FileData {
  br: string; // line break: \r\n when the first LF follows a CR, else \n
  lines: string[]; // lines without their break
  final: boolean; // the text ends with a break
}

function splitFile(text: string): FileData {
  if (text === '') return { br: '\n', lines: [], final: false };
  const br = text.includes('\r\n') ? '\r\n' : '\n';
  let final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileData): string {
  if (f.lines.length === 0) return '';
  const body = f.lines.join(f.br);
  return f.final ? body + f.br : body;
}

// ---------------------------------------------------------------- tiered line matching

// Equality of two lines at a matching tier (0 = exact, 1 = trailing
// whitespace ignored, 2 = both ends ignored).
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrim(a) === rtrim(b);
  return trimWs(a) === trimWs(b);
}

// All start positions in `lines` (from `from`) where `old` occurs at `tier`.
function occurrences(lines: string[], old: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  const maxStart = lines.length - old.length;
  for (let i = from; i <= maxStart; i++) {
    let ok = true;
    for (let k = 0; k < old.length; k++) {
      if (!lineEq(lines[i + k]!, old[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

// The first tier (0, then 1, then 2; only 0 when strict) that has an
// occurrence of `old` at or after `from`, with all its positions.
function firstTier(
  lines: string[],
  old: string[],
  strict: boolean,
  from: number,
): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, old, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

// Re-indent one replacement line at tier 2: when the line is not empty
// and not only whitespace and starts with P (the leading whitespace of
// the patch's first old line), that P is replaced by F (the leading
// whitespace of the file's first matched line).
function reindentText(text: string, p: string, f: string): string {
  if (text === '' || text.trim() === '') return text;
  if (!text.startsWith(p)) return text;
  return f + text.slice(p.length);
}

// A line of the replacement text. `ctx` is the index into O when the
// line is a context line (written as the file's own matched line);
// otherwise the line is written as the patch wrote it.
interface NLine {
  text: string;
  ctx: number | null;
}

// Build the replacement lines for an old block O matched at `pos` in
// `fileLines` at `tier`.
function buildReplacement(fileLines: string[], pos: number, o: string[], n: NLine[], tier: number): string[] {
  const p = leadWs(o[0]!);
  const f = leadWs(fileLines[pos]!);
  return n.map((x) => {
    if (x.ctx !== null) return fileLines[pos + x.ctx]!;
    if (tier === 2) return reindentText(x.text, p, f);
    return x.text;
  });
}

// ---------------------------------------------------------------- the tree

interface Move {
  old: string;
  nw: string;
}

class Tree {
  // Original file contents as they were on disk when first read, by path.
  readonly orig = new Map<string, string | null>();
  // Current contents as the edits left them (null = deleted), by path.
  readonly now = new Map<string, string | null>();
  // Successful moves, in order.
  readonly moves: Move[] = [];

  original(p: string): string | null {
    if (this.orig.has(p)) return this.orig.get(p)!;
    try {
      const st = statSync(p);
      const v = st.isFile() ? readFileSync(p, 'utf8') : null;
      this.orig.set(p, v);
      return v;
    } catch {
      this.orig.set(p, null);
      return null;
    }
  }

  get(p: string): string | null {
    if (this.now.has(p)) return this.now.get(p)!;
    const v = this.original(p);
    this.now.set(p, v);
    return v;
  }

  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }
}

type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------- shared edit helpers

// Apply the hunks of a unified section (or, with the same shape, any
// line-based change) to a file. Returns the new file data. Throws Fail
// with `no-match` when a hunk's old block is not found.
function applyHunks(file: FileData, hunks: Hunk[], strict: boolean, path: string): FileData {
  let lines = file.lines.slice();
  let final = file.final;
  let d = 0; // cumulative length change over the hunks applied so far
  for (const h of hunks) {
    const o = h.o;
    const n = h.n;
    if (o.length > 0) {
      const found = firstTier(lines, o, strict, 0);
      if (!found) throw new Fail('no-match', path);
      // The occurrence nearest to A - 1 + d; ties go to the earlier one.
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const pos = best;
      const touchesEnd = pos + o.length === lines.length;
      const repl = buildReplacement(lines, pos, o, n, found.tier);
      lines.splice(pos, o.length, ...repl);
      if (touchesEnd) final = !h.noBreak;
      d += n.length - o.length;
    } else {
      // Empty old block: insert N after the first A + d lines (all of
      // them when the file has fewer).
      const ins = Math.min(h.a + d, lines.length);
      const touchesEnd = ins === lines.length;
      const repl = n.map((x) => x.text);
      lines.splice(ins, 0, ...repl);
      if (touchesEnd) final = !h.noBreak;
      d += n.length;
    }
  }
  return { br: file.br, lines, final };
}

// ---------------------------------------------------------------- unified diff (section 6)

interface Hunk {
  a: number; // old start, 1-based
  o: string[]; // old lines: context + `-` lines
  n: NLine[]; // new lines: context + `+` lines
  noBreak: boolean; // a `\` line follows the hunk's last context or `+` line
  lastPlusNoBreak: boolean; // a `\` line follows the hunk's last `+` line
}

interface UniSection {
  oldPath: string | null; // null = /dev/null
  newPath: string | null; // null = /dev/null
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

// The path from a `--- ` / `+++ ` header line: text after the four
// characters, up to the first tab, surrounding spaces removed;
// `/dev/null` means no file; a leading `a/` or `b/` is removed.
function headerPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const diffGitRe = /^diff --git a\/([^ \t]+) b\/([^ \t]+)[ \t]*$/;

  // Parse one section starting at index s (a `diff --git` line or a
  // `--- ` line followed by `+++ `). Returns the section and the index
  // after it (the next section's start, or the end of the patch).
  function parseSection(s: number): { sec: UniSection; next: number } {
    let pairOld: string | null = null;
    let pairNew: string | null = null;
    let pairSeen = false;
    let diffOld: string | null = null;
    let diffNew: string | null = null;
    let renameOld: string | null = null;
    let renameNew: string | null = null;
    let isCreate = false;
    let isDelete = false;
    const hunks: Hunk[] = [];
    let j = s;
    if (lines[j]!.startsWith('diff --git ')) {
      const m = diffGitRe.exec(lines[j]!);
      if (!m) throw new Exit2(`error: parse ${j + 1}`);
      diffOld = m[1]!;
      diffNew = m[2]!;
      j++;
    }
    // Header: until the first hunk, the next section, or the end.
    let inHeader = true;
    while (inHeader && j < n) {
      const line = lines[j]!;
      if (line.startsWith('@@')) {
        if (!hunkRe.test(line)) throw new Exit2(`error: parse ${j + 1}`);
        inHeader = false;
        break;
      }
      if (line.startsWith('diff --git ')) break;
      if (line.startsWith('--- ')) {
        const next = lines[j + 1];
        if (next === undefined || !next.startsWith('+++ ')) {
          throw new Exit2(`error: parse ${j + 2}`);
        }
        if (pairSeen) break; // a second pair starts a new section
        pairSeen = true;
        pairOld = headerPath(line.slice(4));
        pairNew = headerPath(next.slice(4));
        j += 2;
        continue;
      }
      if (line.startsWith('rename from ')) {
        renameOld = line.slice('rename from '.length).trim();
        j++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        renameNew = line.slice('rename to '.length).trim();
        j++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        isCreate = true;
        j++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        isDelete = true;
        j++;
        continue;
      }
      // index, old mode, new mode, similarity, dissimilarity, Index:
      // and anything else in the header is ignored.
      j++;
    }
    // Hunks.
    while (j < n) {
      const line = lines[j]!;
      if (line.startsWith('@@')) {
        const m = hunkRe.exec(line);
        if (!m) throw new Exit2(`error: parse ${j + 1}`);
        const a = Number(m[1]);
        j++;
        const body: { kind: string; text: string }[] = [];
        while (j < n) {
          const b = lines[j]!;
          if (b.startsWith('diff --git ')) break;
          if (b.startsWith('--- ') && lines[j + 1] !== undefined && lines[j + 1]!.startsWith('+++ ')) break;
          if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
            if (b === '') body.push({ kind: 'ctx', text: '' });
            else if (b.startsWith(' ')) body.push({ kind: 'ctx', text: b.slice(1) });
            else if (b.startsWith('-')) body.push({ kind: 'old', text: b.slice(1) });
            else if (b.startsWith('+')) body.push({ kind: 'new', text: b.slice(1) });
            else body.push({ kind: 'bs', text: b.slice(1) });
            j++;
          } else break;
        }
        // Trailing empty lines are not part of the body.
        while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') {
          body.pop();
        }
        const o: string[] = [];
        const nn: NLine[] = [];
        for (const item of body) {
          if (item.kind === 'ctx') {
            const idx = o.length;
            o.push(item.text);
            nn.push({ text: item.text, ctx: idx });
          } else if (item.kind === 'old') {
            o.push(item.text);
          } else if (item.kind === 'new') {
            nn.push({ text: item.text, ctx: null });
          }
        }
        let noBreak = false;
        let lastPlusNoBreak = false;
        for (let k = body.length - 1; k >= 0; k--) {
          if (body[k]!.kind === 'ctx' || body[k]!.kind === 'new') {
            if (k + 1 < body.length && body[k + 1]!.kind === 'bs') noBreak = true;
            break;
          }
        }
        for (let k = body.length - 1; k >= 0; k--) {
          if (body[k]!.kind === 'new') {
            if (k + 1 < body.length && body[k + 1]!.kind === 'bs') lastPlusNoBreak = true;
            break;
          }
        }
        hunks.push({ a, o, n: nn, noBreak, lastPlusNoBreak });
        continue;
      }
      if (line.startsWith('diff --git ')) break;
      if (line.startsWith('--- ') && lines[j + 1] !== undefined && lines[j + 1]!.startsWith('+++ ')) break;
      // A line between hunks that is neither a hunk nor a section is ignored.
      j++;
    }
    // Resolve the paths: the `--- `/`+++ ` pair names them; otherwise
    // `rename from/to`; otherwise the `diff --git` paths.
    let op: string | null;
    let np: string | null;
    if (pairSeen) {
      op = pairOld;
      np = pairNew;
    } else {
      op = renameOld !== null ? renameOld : diffOld;
      np = renameNew !== null ? renameNew : diffNew;
    }
    if (op === null) isCreate = true;
    if (np === null) isDelete = true;
    return { sec: { oldPath: op, newPath: np, isCreate, isDelete, hunks }, next: j };
  }

  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const { sec, next } = parseSection(i);
      edits.push(uniEdit(sec, strict));
      i = next;
    } else if (line.startsWith('--- ') && lines[i + 1] !== undefined && lines[i + 1]!.startsWith('+++ ')) {
      const { sec, next } = parseSection(i);
      edits.push(uniEdit(sec, strict));
      i = next;
    } else if (line.startsWith('@@')) {
      // A hunk before any section.
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      // Prose outside a section is ignored.
      i++;
    }
  }
  return edits;
}

function uniEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const op = sec.oldPath;
    const np = sec.newPath;
    if (sec.isCreate) {
      if (np === null) return; // degenerate: no file to create
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let lastPlusNoBreak = false;
      for (const h of sec.hunks) {
        let sawPlus = false;
        for (const x of h.n) {
          if (x.ctx === null) {
            plus.push(x.text);
            sawPlus = true;
          }
        }
        if (sawPlus) lastPlusNoBreak = h.lastPlusNoBreak;
      }
      const text = plus.length === 0 ? '' : plus.join('\n') + (lastPlusNoBreak ? '' : '\n');
      tree.set(np, text);
      return;
    }
    if (sec.isDelete) {
      if (op === null) return; // degenerate: no file to delete
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.set(op, null); // the hunks are not read
      return;
    }
    if (op !== null && np !== null && op !== np) {
      // Move.
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const cur = tree.get(op);
      if (cur === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyHunks(splitFile(cur), sec.hunks, strict, op);
      tree.set(np, joinFile(out));
      tree.set(op, null);
      tree.moves.push({ old: op, nw: np });
      return;
    }
    // Change of one path.
    const p = op !== null ? op : np!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const out = applyHunks(splitFile(cur), sec.hunks, strict, p);
    tree.set(p, joinFile(out));
  };
}

// ---------------------------------------------------------------- SEARCH/REPLACE (section 7)

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevEnd = 0; // index after the previous block's `>>>>>>> REPLACE`
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      // The path is the nearest line before the SEARCH line, after the
      // previous block, that is not blank and does not start with three
      // backticks when trimmed.
      let path: string | null = null;
      for (let k = i - 1; k >= prevEnd; k--) {
        const l = lines[k]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
        path = prevPath;
      }
      // Find `=======` then `>>>>>>> REPLACE` after the SEARCH line.
      let eqIdx = -1;
      let j = i + 1;
      while (j < n) {
        const t = lines[j]!.trimEnd();
        if (t === '=======') {
          eqIdx = j;
          break;
        }
        if (t === '>>>>>>> REPLACE') break;
        j++;
      }
      if (eqIdx < 0) throw new Exit2(`error: parse ${searchLine}`);
      let repIdx = -1;
      j = eqIdx + 1;
      while (j < n) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          repIdx = j;
          break;
        }
        j++;
      }
      if (repIdx < 0) throw new Exit2(`error: parse ${searchLine}`);
      const oldLines = lines.slice(i + 1, eqIdx);
      const newLines = lines.slice(eqIdx + 1, repIdx);
      edits.push(srEdit(path, oldLines, newLines, strict));
      prevPath = path;
      prevEnd = repIdx + 1;
      i = repIdx + 1;
    } else {
      i++;
    }
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const file = splitFile(cur);
    const found = firstTier(file.lines, oldLines, strict, 0);
    if (!found) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = found.pos[0]!;
    const nLines: NLine[] = newLines.map((t) => ({ text: t, ctx: null }));
    const repl = buildReplacement(file.lines, pos, oldLines, nLines, found.tier);
    const out = file.lines.slice();
    out.splice(pos, oldLines.length, ...repl);
    tree.set(path, joinFile({ br: file.br, lines: out, final: file.final }));
  };
}

// ---------------------------------------------------------------- V4A (section 8)

interface V4aChunk {
  anchor: string | null; // null = no `@@` line; '' = empty anchor
  eof: boolean;
  body: { kind: string; text: string }[];
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i++;
      const secLines: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (
          l.startsWith('*** Add File: ') ||
          l.startsWith('*** Delete File: ') ||
          l.startsWith('*** Update File: ') ||
          l.trim() === '*** End Patch'
        ) {
          break;
        }
        if (l === '') {
          secLines.push('');
          i++;
          continue;
        }
        if (l.startsWith('+')) {
          secLines.push(l.slice(1));
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (secLines.length > 0 && secLines[secLines.length - 1] === '') secLines.pop();
      edits.push(v4aAddEdit(path, secLines));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last) {
        const l = lines[i]!;
        if (
          l.startsWith('*** Add File: ') ||
          l.startsWith('*** Delete File: ') ||
          l.startsWith('*** Update File: ') ||
          l.trim() === '*** End Patch'
        ) {
          break;
        }
        if (blank(l)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const updateLine = i + 1;
      const path = line.slice('*** Update File: '.length).trim();
      i++;
      // Collect the section's lines until the next section or End Patch.
      const secStart = i;
      const secLines: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (
          l.startsWith('*** Add File: ') ||
          l.startsWith('*** Delete File: ') ||
          l.startsWith('*** Update File: ') ||
          l.trim() === '*** End Patch'
        ) {
          break;
        }
        secLines.push(l);
        i++;
      }
      while (secLines.length > 0 && blank(secLines[secLines.length - 1]!)) secLines.pop();
      // An optional `*** Move to:` as the first line.
      let moveTo: string | null = null;
      if (secLines.length > 0 && secLines[0]!.startsWith('*** Move to: ')) {
        moveTo = secLines[0]!.slice('*** Move to: '.length).trim();
        secLines.shift();
      }
      const chunks = parseV4aChunks(secLines, secStart + (moveTo !== null ? 1 : 0));
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function parseV4aChunks(secLines: string[], baseLineNo: number): V4aChunk[] {
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  for (let k = 0; k < secLines.length; k++) {
    const l = secLines[k]!;
    const lineNo = baseLineNo + k + 1;
    if (l.startsWith('@@')) {
      if (cur) chunks.push(cur);
      cur = { anchor: l.slice(2).trim(), eof: false, body: [] };
      continue;
    }
    if (l === '*** End of File') {
      if (!cur) throw new Exit2(`error: parse ${lineNo}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      continue;
    }
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (!cur) cur = { anchor: null, eof: false, body: [] };
      if (l === '') cur.body.push({ kind: 'ctx', text: '' });
      else if (l.startsWith(' ')) cur.body.push({ kind: 'ctx', text: l.slice(1) });
      else if (l.startsWith('-')) cur.body.push({ kind: 'old', text: l.slice(1) });
      else cur.body.push({ kind: 'new', text: l.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${lineNo}`);
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const file = splitFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      // Anchor: the first line at or after the cursor equal to the anchor
      // at the first tier where one is; the cursor moves past it.
      if (ch.anchor !== null && ch.anchor !== '') {
        const found = firstTier(file.lines, [ch.anchor], strict, cursor);
        if (!found) throw new Fail('no-match', path);
        cursor = found.pos[0]! + 1;
      }
      const o: string[] = [];
      const n: NLine[] = [];
      for (const item of ch.body) {
        if (item.kind === 'ctx') {
          const idx = o.length;
          o.push(item.text);
          n.push({ text: item.text, ctx: idx });
        } else if (item.kind === 'old') {
          o.push(item.text);
        } else if (item.kind === 'new') {
          n.push({ text: item.text, ctx: null });
        }
      }
      if (o.length > 0) {
        const found = firstTier(file.lines, o, strict, cursor);
        if (!found) throw new Fail('no-match', path);
        let pos = found.pos[0]!;
        if (ch.eof) {
          // An end-of-file chunk takes only an occurrence ending at the
          // file's last line.
          const endPos = file.lines.length - o.length;
          if (pos !== endPos) {
            const ok = found.pos.find((p) => p === endPos);
            if (ok === undefined) throw new Fail('no-match', path);
            pos = ok;
          }
        }
        const repl = buildReplacement(file.lines, pos, o, n, found.tier);
        file.lines.splice(pos, o.length, ...repl);
        cursor = pos + repl.length;
      } else {
        // Empty old block: insert at the cursor, or at the end for an
        // end-of-file chunk.
        const ins = ch.eof ? file.lines.length : cursor;
        const repl = n.map((x) => x.text);
        file.lines.splice(ins, 0, ...repl);
        cursor = ins + repl.length;
      }
    }
    const text = joinFile(file);
    if (moveTo !== null) {
      tree.set(moveTo, text);
      tree.set(path, null);
      tree.moves.push({ old: path, nw: moveTo });
    } else {
      tree.set(path, text);
    }
  };
}

// ---------------------------------------------------------------- JSON (section 9)

// JSON Lines: one edit object per line, blank lines ignored. Array form:
// one JSON array of edit objects; any fault is parse at the line where
// the array starts. Either way, a line that does not hold one valid edit
// object is parse at that line.
function jsonEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  const firstLine = lines[first]!;
  // Array form: the patch is one JSON array of edit objects. The array
  // may start on the first non-blank line with the first object on the
  // same line, so the test is whether that line starts with `[`.
  if (firstLine.trimStart().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines.slice(first).join('\n'));
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(parsed)) throw new Exit2(`error: parse ${first + 1}`);
    for (const item of parsed) {
      edits.push(jsonEdit(item, first + 1));
    }
    return edits;
  }
  for (let i = 0; i < lines.length; i++) {
    if (blank(lines[i]!)) continue;
    let item: unknown;
    try {
      item = JSON.parse(lines[i]!);
    } catch {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    edits.push(jsonEdit(item, i + 1));
  }
  return edits;
}

function jsonEdit(item: unknown, lineNo: number): Edit {
  const obj = item as Record<string, unknown>;
  const parseErr = (): never => {
    throw new Exit2(`error: parse ${lineNo}`);
  };
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) parseErr();
  const path = obj.path;
  if (typeof path !== 'string') parseErr();
  const command = obj.command;
  if (typeof command !== 'string') parseErr();
  if (command === 'create') {
    if (typeof obj.file_text !== 'string') parseErr();
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.set(path, obj.file_text as string);
    };
  }
  if (command === 'str_replace') {
    if (typeof obj.old_str !== 'string' || obj.old_str === '') parseErr();
    if (obj.new_str !== undefined && typeof obj.new_str !== 'string') parseErr();
    const newStr = (obj.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      const cur = tree.get(path);
      if (cur === null) throw new Fail('missing', path);
      const isCrlf = cur.includes('\r\n');
      const t = isCrlf ? cur.replace(/\r\n/g, '\n') : cur;
      const oldS = obj.old_str as string;
      let count = 0;
      let at = t.indexOf(oldS);
      while (at >= 0) {
        count++;
        at = t.indexOf(oldS, at + 1);
      }
      if (count === 0) throw new Fail('no-match', path);
      if (count > 1) throw new Fail('ambiguous', path);
      const out = t.replace(oldS, newStr);
      tree.set(path, isCrlf ? out.replace(/\n/g, '\r\n') : out);
    };
  }
  if (command === 'insert') {
    if (!Number.isInteger(obj.insert_line)) parseErr();
    if (typeof obj.new_str !== 'string') parseErr();
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      const cur = tree.get(path);
      if (cur === null) throw new Fail('missing', path);
      const file = splitFile(cur);
      const at = obj.insert_line as number;
      if (at < 0 || at > file.lines.length) throw new Fail('no-match', path);
      const ins = patchLines(obj.new_str as string);
      const out = file.lines.slice();
      out.splice(at, 0, ...ins);
      tree.set(path, joinFile({ br: file.br, lines: out, final: file.final }));
    };
  }
  parseErr();
}

// ---------------------------------------------------------------- format detection (section 4)

function detect(lines: string[]): Format | null {
  let firstNonBlank = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!blank(lines[i]!)) {
      firstNonBlank = i;
      break;
    }
  }
  if (firstNonBlank < 0) return null;
  const first = lines[firstNonBlank]!;
  if (first.trim() === '*** Begin Patch') return 'v4a';
  const trimmedStart = first.trimStart();
  if (trimmedStart.startsWith('[') || trimmedStart.startsWith('{')) return 'json';
  for (const l of lines) {
    if (l.trimEnd() === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith('diff --git ')) return 'unified';
    if (lines[i]!.startsWith('--- ') && lines[i + 1] !== undefined && lines[i + 1]!.startsWith('+++ ')) {
      return 'unified';
    }
  }
  return null;
}

// ---------------------------------------------------------------- output rows

// Build the changed-path rows. A successful move whose old path is gone
// and whose new path is new is one row: `R <old> -> <new>`, sorted by
// the new path. Other changes are `A <path>`, `D <path>` or `M <path>`,
// sorted by path in byte order.
function outputRows(tree: Tree): { key: string; line: string }[] {
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const rows: { key: string; line: string }[] = [];
  const consumed = new Set<string>();
  for (const mv of tree.moves) {
    const oldC = changed.get(mv.old);
    const newC = changed.get(mv.nw);
    if (
      oldC !== undefined &&
      newC !== undefined &&
      oldC.was !== null &&
      oldC.now === null &&
      newC.was === null &&
      newC.now !== null
    ) {
      rows.push({ key: mv.nw, line: `R ${mv.old} -> ${mv.nw}` });
      consumed.add(mv.old);
      consumed.add(mv.nw);
    }
  }
  for (const [p, c] of changed) {
    if (consumed.has(p)) continue;
    if (c.was === null && c.now !== null) rows.push({ key: p, line: `A ${p}` });
    else if (c.was !== null && c.now === null) rows.push({ key: p, line: `D ${p}` });
    else rows.push({ key: p, line: `M ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  return rows;
}

// ---------------------------------------------------------------- main run

function run(args: string[]): { code: number; out: string } {
  let format: Format | null = null;
  let check = false;
  let strict = false;
  let ended = false;
  const pos: string[] = [];
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) throw new Exit2('error: usage');
        const v = a.slice('--format='.length);
        if (!(FORMATS as readonly string[]).includes(v)) throw new Exit2('error: usage');
        format = v as Format;
      } else if (a === '--check') {
        if (check) throw new Exit2('error: usage');
        check = true;
      } else if (a === '--strict') {
        if (strict) throw new Exit2('error: usage');
        strict = true;
      } else {
        throw new Exit2('error: usage');
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) throw new Exit2('error: usage');
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;

  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) throw new Exit2('error: no-patch');
  }
  const lines = patchLines(text);

  let fmt: Format | null = format;
  if (fmt === null || fmt === 'auto') {
    const d = detect(lines);
    if (d === null) throw new Exit2('error: format');
    fmt = d;
  }

  let edits: Edit[];
  if (fmt === 'unified') edits = parseUnified(lines, strict);
  else if (fmt === 'search-replace') edits = parseSearchReplace(lines, strict);
  else if (fmt === 'v4a') edits = parseV4a(lines, strict);
  else edits = jsonEdits(lines);
  if (edits.length === 0) throw new Exit2('error: parse 1');

  const tree = new Tree();
  const fails: Fail[] = [];
  for (const e of edits) {
    try {
      e(tree);
    } catch (err) {
      if (err instanceof Fail) fails.push(err);
      else throw err;
    }
  }

  if (fails.length > 0) {
    const out = fails.map((f) => `error: ${f.code} ${f.path}`).join('\n');
    return { code: 1, out: out + `\nfailed: ${fails.length} of ${edits.length} edits` };
  }

  const rows = outputRows(tree);
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) {
        try {
          rmSync(p);
        } catch {
          // The file was already gone.
        }
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now, 'utf8');
      }
    }
  }
  const summary = rows.length === 1 ? 'ok: 1 file' : `ok: ${rows.length} files`;
  const out = rows.map((r) => r.line).join('\n');
  return { code: 0, out: out === '' ? summary : out + '\n' + summary };
}

async function main(): Promise<void> {
  const env = process.env.MAKEFUN_ENV_URL;
  if (env) {
    try {
      const runner = await import('./runner.ts');
      const result = await runner.runTrial(process.argv.slice(2), env, run);
      process.exitCode = result;
      return;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('server returned')) {
        process.stderr.write(err.message + '\n');
        process.exitCode = 2;
        return;
      }
      throw err;
    }
  }
  try {
    const { code, out } = run(process.argv.slice(2));
    process.exitCode = code;
    writeSync(1, out + '\n');
  } catch (err) {
    if (err instanceof Exit2) {
      process.exitCode = 2;
      writeSync(1, err.line + '\n');
      return;
    }
    throw err;
  }
}

await main();
