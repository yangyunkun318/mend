// mend: one patch tool for every AI edit format (SPEC.md v1).
// Node 22, standard library only; run as `node main.ts [options] [PATCH]`.
// Implements SPEC sections 1-10: CLI, output/exit codes, safe paths, format
// detection, tiered line matching, unified diffs, SEARCH/REPLACE blocks,
// V4A patches, JSON edits, and all-or-nothing writes (with R move lines).
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];
let STRICT = false;

class Exit2 {
  readonly line: string;
  constructor(line: string) { this.line = line; }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) { this.code = code; this.path = path; }
}
interface Move { old: string; new: string; }
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
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try { if (statSync(p).isFile()) v = readFileSync(p, 'utf8'); } catch { v = null; }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null { return this.now.has(p) ? this.now.get(p)! : this.original(p); }
}
type Edit = (tree: Tree, moves: Move[]) => void;

// ---- file lines ----
interface FileInfo { lines: string[]; br: string; final: boolean; }
function fileInfo(text: string): FileInfo {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}
function serialize(info: FileInfo): string {
  if (info.lines.length === 0) return '';
  return info.lines.join(info.br) + (info.final ? info.br : '');
}
const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadOf = (s: string): string => { const m = /^[ \t]*/.exec(s); return m ? m[0] : ''; };
function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}
function findOcc(fileLines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) if (!tierEq(fileLines[i + j]!, o[j]!, tier)) { ok = false; break; }
    if (ok) out.push(i);
  }
  return out;
}
function findTier(fileLines: string[], o: string[]): { tier: number; occ: number[] } | null {
  const tiers = STRICT ? [0] : [0, 1, 2];
  for (const t of tiers) { const occ = findOcc(fileLines, o, t); if (occ.length > 0) return { tier: t, occ }; }
  return null;
}
interface NEntry { text: string; ctx: boolean; }
// Replace O (at pos) by N in fileLines. Context entries in N are taken from
// the file's own matched lines; at tier 2 other N lines are re-indented.
function applyReplace(fileLines: string[], oTexts: string[], oCtx: boolean[], n: NEntry[], pos: number, tier: number): string[] {
  const oCtxIdx: number[] = [];
  for (let j = 0; j < oTexts.length; j++) if (oCtx[j]) oCtxIdx.push(j);
  let ctxPtr = 0;
  const p = oTexts.length > 0 ? leadOf(oTexts[0]!) : '';
  const f = pos < fileLines.length ? leadOf(fileLines[pos]!) : '';
  const out: string[] = [];
  for (const e of n) {
    if (e.ctx) {
      const oj = oCtxIdx[ctxPtr++] ?? 0;
      out.push(fileLines[pos + oj]!);
    } else if (tier === 2 && e.text !== '' && e.text.trim() !== '' && e.text.startsWith(p)) {
      out.push(f + e.text.slice(p.length));
    } else out.push(e.text);
  }
  return [...fileLines.slice(0, pos), ...out, ...fileLines.slice(pos + oTexts.length)];
}
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

// ---- JSON (SPEC section 9, as in the starter) ----
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
      tree.now.set(p, text);
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
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
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
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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
    try { v = JSON.parse(text); } catch { throw new Exit2(`error: parse ${first + 1}`); }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) { const e = jsonEdit(x); if (e === null) throw new Exit2(`error: parse ${first + 1}`); edits.push(e); }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try { e = jsonEdit(JSON.parse(l)); } catch { e = null; }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- shared hunk application (unified) ----
interface BodyEntry { kind: ' ' | '-' | '+' | '\\'; text: string; fromEmpty: boolean; }
function bodyOTN(body: BodyEntry[]): { oTexts: string[]; oCtx: boolean[]; n: NEntry[] } {
  const oTexts: string[] = []; const oCtx: boolean[] = []; const n: NEntry[] = [];
  for (const e of body) {
    if (e.kind === ' ') { oTexts.push(e.text); oCtx.push(true); n.push({ text: e.text, ctx: true }); }
    else if (e.kind === '-') { oTexts.push(e.text); oCtx.push(false); }
    else if (e.kind === '+') { n.push({ text: e.text, ctx: false }); }
  }
  return { oTexts, oCtx, n };
}
function noNewlineFlag(body: BodyEntry[]): boolean {
  let lastCtxPlus = -1;
  for (let i = 0; i < body.length; i++) if (body[i]!.kind === ' ' || body[i]!.kind === '+') lastCtxPlus = i;
  if (lastCtxPlus < 0) return false;
  return body[lastCtxPlus + 1]?.kind === '\\';
}
function applyUnifiedHunks(fileText: string, hunks: { a: number; body: BodyEntry[] }[], failPath: string): string {
  let info = fileInfo(fileText);
  let lines = [...info.lines];
  let final = info.final;
  const br = info.br;
  let d = 0;
  for (const h of hunks) {
    const { oTexts, oCtx, n } = bodyOTN(h.body);
    const flag = noNewlineFlag(h.body);
    if (oTexts.length === 0) {
      const insertPos = Math.min(Math.max(h.a + d, 0), lines.length);
      const atEnd = insertPos === lines.length;
      const texts = n.map((e) => e.text);
      lines.splice(insertPos, 0, ...texts);
      if (atEnd && texts.length > 0) final = !flag;
      d += n.length;
    } else {
      const found = findTier(lines, oTexts);
      if (!found) throw new Fail('no-match', failPath);
      const target = h.a - 1 + d;
      let best = found.occ[0]!; let bestDist = Math.abs(best - target);
      for (const o of found.occ) { const dist = Math.abs(o - target); if (dist < bestDist) { best = o; bestDist = dist; } }
      const pos = best;
      const runsToEnd = pos + oTexts.length === lines.length;
      lines = applyReplace(lines, oTexts, oCtx, n, pos, found.tier);
      if (runsToEnd) final = !flag;
      d += n.length - oTexts.length;
    }
  }
  return serialize({ lines, br, final });
}

// ---- unified diffs (SPEC section 6) ----
function stripPrefix(p: string): string {
  if (p.startsWith('a/')) return p.slice(2);
  if (p.startsWith('b/')) return p.slice(2);
  return p;
}
function headerPath(line: string): string {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  return s.trim();
}
interface Hunk { a: number; body: BodyEntry[]; }
interface Section {
  oldRaw: string | null; newRaw: string | null; // after stripPrefix, null = /dev/null or unnamed
  isCreate: boolean; isDelete: boolean;
  hunks: Hunk[];
}
function parseUnified(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let phase: 'outside' | 'header' | 'after' = 'outside';
  let pairSeen = false;
  const startSection = (s: Section): void => { sections.push(s); cur = s; phase = 'header'; pairSeen = false; };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // diff --git starts a section anywhere (also ends a body)
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/([^ ]+) b\/([^ ]+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      startSection({ oldRaw: m[1]!, newRaw: m[2]!, isCreate: false, isDelete: false, hunks: [] });
      i++; continue;
    }
    // --- / +++ pair
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && phase === 'header' && !pairSeen) {
        cur.oldRaw = headerPath(line) === '/dev/null' ? null : stripPrefix(headerPath(line));
        cur.newRaw = headerPath(lines[i + 1]!) === '/dev/null' ? null : stripPrefix(headerPath(lines[i + 1]!));
        // remember dev/null-ness via sentinel: use null for /dev/null, but need
        // to distinguish "unnamed" from "/dev/null" for create/delete detection.
        // Encode /dev/null as the empty string marker via a side channel below.
        if (headerPath(line) === '/dev/null') cur.oldRaw = '\0null';
        if (headerPath(lines[i + 1]!) === '/dev/null') cur.newRaw = '\0null';
        pairSeen = true;
        i += 2; continue;
      }
      startSection({ oldRaw: null, newRaw: null, isCreate: false, isDelete: false, hunks: [] });
      // fill the pair now
      cur!.oldRaw = headerPath(line) === '/dev/null' ? '\0null' : stripPrefix(headerPath(line));
      cur!.newRaw = headerPath(lines[i + 1]!) === '/dev/null' ? '\0null' : stripPrefix(headerPath(lines[i + 1]!));
      pairSeen = true;
      i += 2; continue;
    }
    if (line.startsWith('--- ') && cur !== null && phase === 'header' && !pairSeen) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?: .*|)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [] };
      cur.hunks.push(hunk);
      phase = 'after';
      i++;
      // collect body
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') { hunk.body.push({ kind: ' ', text: '', fromEmpty: true }); i++; continue; }
        const c = bl[0]!;
        if (c === ' ') { hunk.body.push({ kind: ' ', text: bl.slice(1), fromEmpty: false }); i++; continue; }
        if (c === '-') { hunk.body.push({ kind: '-', text: bl.slice(1), fromEmpty: false }); i++; continue; }
        if (c === '+') { hunk.body.push({ kind: '+', text: bl.slice(1), fromEmpty: false }); i++; continue; }
        if (c === '\\') { hunk.body.push({ kind: '\\', text: bl, fromEmpty: false }); i++; continue; }
        break;
      }
      // trailing empty (blank-line) context entries are not part of the body
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === ' ' && last.text === '' && last.fromEmpty) hunk.body.pop(); else break;
      }
      continue;
    }
    if (cur !== null && phase === 'header') {
      if (line.startsWith('rename from ') && !pairSeen) cur.oldRaw = stripPrefix(line.slice('rename from '.length).trim());
      else if (line.startsWith('rename to ') && !pairSeen) cur.newRaw = stripPrefix(line.slice('rename to '.length).trim());
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      // index / old mode / new mode / similarity / dissimilarity / Index: / anything else: ignored
      i++; continue;
    }
    // outside a body, in a section or not: ignored prose / fences
    i++;
  }
  const edits: Edit[] = [];
  for (const s of sections) {
    const oldNull = s.oldRaw === '\0null';
    const newNull = s.newRaw === '\0null';
    const oldPath = oldNull ? null : s.oldRaw;
    const newPath = newNull ? null : s.newRaw;
    const isCreate = s.isCreate || oldNull;
    const isDelete = s.isDelete || newNull;
    if (isCreate && newPath === null) throw new Exit2('error: parse 1');
    if (isDelete && oldPath === null) throw new Exit2('error: parse 1');
    if (!isCreate && !isDelete && oldPath === null && newPath === null) throw new Exit2('error: parse 1');
    if (isCreate) {
      const np = newPath!;
      edits.push((tree) => {
        if (!safe(np)) throw new Fail('unsafe', np);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const plus: string[] = [];
        for (const h of s.hunks) for (const e of h.body) if (e.kind === '+') plus.push(e.text);
        // last + entry across hunks, followed by a \ line in its hunk?
        let lastFlag = false;
        outer: for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
          const b = s.hunks[hi]!.body;
          for (let k = b.length - 1; k >= 0; k--) {
            if (b[k]!.kind === '+') { lastFlag = b[k + 1]?.kind === '\\'; break outer; }
          }
        }
        tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (lastFlag ? '' : '\n'));
      });
    } else if (isDelete) {
      const op = oldPath!;
      edits.push((tree) => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
      });
    } else if (oldPath !== null && newPath !== null && oldPath !== newPath) {
      const op = oldPath; const np = newPath;
      edits.push((tree, moves) => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (!safe(np)) throw new Fail('unsafe', np);
        const before = tree.get(op);
        if (before === null) throw new Fail('missing', op);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const out = applyUnifiedHunks(before, s.hunks, op);
        tree.now.set(op, null);
        tree.now.set(np, out);
        moves.push({ old: op, new: np });
      });
    } else {
      const p = (oldPath ?? newPath)!;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        const out = applyUnifiedHunks(before, s.hunks, p);
        tree.now.set(p, out);
      });
    }
  }
  return edits;
}

// ---- SEARCH/REPLACE (SPEC section 7) ----
function parseSearchReplace(lines: string[]): Edit[] {
  const searchIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') searchIdx.push(i);
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  for (const s of searchIdx) {
    let eq = -1; let rep = -1;
    for (let i = s + 1; i < lines.length; i++) {
      if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (eq < 0 && lines[i]!.trimEnd() === '=======') eq = i;
      else if (eq >= 0 && lines[i]!.trimEnd() === '>>>>>>> REPLACE') { rep = i; break; }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    // path: nearest non-blank, non-fence line before s, after prevEnd
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim(); break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    prevPath = path; prevEnd = rep;
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const info = fileInfo(before);
      const found = findTier(info.lines, oldLines);
      if (!found) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const n: NEntry[] = newLines.map((t) => ({ text: t, ctx: false }));
      const out = applyReplace(info.lines, oldLines, oldLines.map(() => false), n, found.occ[0]!, found.tier);
      tree.now.set(p, serialize({ lines: out, br: info.br, final: info.final }));
    });
  }
  return edits;
}

// ---- V4A (SPEC section 8) ----
interface VChunk { anchor: string | null; body: BodyEntry[]; eof: boolean; }
interface VSection { kind: 'add' | 'delete' | 'update'; path: string; line: number; lines: string[]; moveTo: string | null; chunks: VChunk[]; }
function parseV4A(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (!blank(lines[i]!)) { last = i; break; }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  const isSectionStart = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) { i++; continue; }
    let kind: VSection['kind'] | null = null; let prefix = '';
    if (line.startsWith('*** Add File: ')) { kind = 'add'; prefix = '*** Add File: '; }
    else if (line.startsWith('*** Delete File: ')) { kind = 'delete'; prefix = '*** Delete File: '; }
    else if (line.startsWith('*** Update File: ')) { kind = 'update'; prefix = '*** Update File: '; }
    else throw new Exit2(`error: parse ${i + 1}`);
    const path = line.slice(prefix.length).trim();
    const sec: VSection = { kind, path, line: i + 1, lines: [], moveTo: null, chunks: [] };
    sections.push(sec);
    i++;
    if (kind === 'add') {
      const raw: { text: string; fromBlank: boolean }[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l === '') { raw.push({ text: '', fromBlank: true }); i++; continue; }
        if (l.startsWith('+')) { raw.push({ text: l.slice(1), fromBlank: false }); i++; continue; }
        if (blank(l)) { raw.push({ text: '', fromBlank: true }); i++; continue; }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (raw.length > 0 && raw[raw.length - 1]!.fromBlank) raw.pop();
      sec.lines = raw.map((r) => r.text);
    } else if (kind === 'delete') {
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (blank(l)) { i++; continue; }
        throw new Exit2(`error: parse ${i + 1}`);
      }
    } else {
      // update: optional Move to as first (non-blank) line
      let j = i;
      while (j < last && blank(lines[j]!)) j++;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        sec.moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        i = j + 1;
      }
      let curChunk: VChunk | null = null;
      const finishChunk = (): void => {
        if (curChunk) {
          while (curChunk.body.length > 0) {
            const e = curChunk.body[curChunk.body.length - 1]!;
            if (e.kind === ' ' && e.text === '' && e.fromEmpty) curChunk.body.pop(); else break;
          }
          sec.chunks.push(curChunk); curChunk = null;
        }
      };
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l.trim() === '*** End of File') {
          if (curChunk) curChunk.eof = true;
          finishChunk();
          i++;
          // End of File ends the section's chunks
          break;
        }
        if (l.startsWith('@@')) {
          finishChunk();
          curChunk = { anchor: l.slice(2).trim(), body: [], eof: false };
          i++; continue;
        }
        if (blank(l)) {
          if (curChunk === null) { i++; continue; }
          curChunk.body.push({ kind: ' ', text: '', fromEmpty: true }); i++; continue;
        }
        const c = l[0]!;
        if (c === ' ' || c === '-' || c === '+') {
          if (curChunk === null) curChunk = { anchor: null, body: [], eof: false };
          curChunk.body.push({ kind: c as ' ' | '-' | '+', text: l.slice(1), fromEmpty: false });
          i++; continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      finishChunk();
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.line}`);
    }
  }
  const edits: Edit[] = [];
  for (const sec of sections) {
    if (sec.kind === 'add') {
      const p = sec.path; const ls = sec.lines;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, ls.length === 0 ? '' : ls.join('\n') + '\n');
      });
    } else if (sec.kind === 'delete') {
      const p = sec.path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      const p = sec.path; const np = sec.moveTo;
      edits.push((tree, moves) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (np !== null && !safe(np)) throw new Fail('unsafe', np);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (np !== null && tree.get(np) !== null) throw new Fail('exists', np);
        const info = fileInfo(before);
        let lines = [...info.lines];
        let cursor = 0;
        for (const ch of sec.chunks) {
          if (ch.anchor !== null && ch.anchor !== '') {
            // find first line at/after cursor equal to anchor, first tier with one
            let foundIdx = -1;
            const tiers = STRICT ? [0] : [0, 1, 2];
            for (const t of tiers) {
              for (let k = cursor; k < lines.length; k++) if (tierEq(lines[k]!, ch.anchor, t)) { foundIdx = k; break; }
              if (foundIdx >= 0) break;
            }
            if (foundIdx < 0) throw new Fail('no-match', p);
            cursor = foundIdx + 1;
          }
          const { oTexts, oCtx, n } = bodyOTN(ch.body);
          if (oTexts.length === 0) {
            const insertPos = ch.eof ? lines.length : cursor;
            const texts = n.map((e) => e.text);
            lines.splice(insertPos, 0, ...texts);
            cursor = insertPos + texts.length;
          } else {
            const found = findTierFrom(lines, oTexts, cursor);
            if (!found) throw new Fail('no-match', p);
            let pos: number;
            if (ch.eof) {
              const eofOcc = found.occ.filter((o) => o + oTexts.length === lines.length);
              if (eofOcc.length === 0) throw new Fail('no-match', p);
              pos = eofOcc[0]!;
            } else pos = found.occ[0]!;
            lines = applyReplace(lines, oTexts, oCtx, n, pos, found.tier);
            cursor = pos + n.length;
          }
        }
        const out = serialize({ lines, br: info.br, final: info.final });
        if (np !== null) { tree.now.set(p, null); tree.now.set(np, out); moves.push({ old: p, new: np }); }
        else tree.now.set(p, out);
      });
    }
  }
  return edits;
}
function findTierFrom(fileLines: string[], o: string[], from: number): { tier: number; occ: number[] } | null {
  const tiers = STRICT ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = findOcc(fileLines, o, t).filter((x) => x >= from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

// ---- CLI (SPEC sections 1, 2, 10) ----
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
  STRICT = strict;
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try { text = readFileSync(file ?? 0, 'utf8'); } catch { if (file !== null) return { code: 2, out: ['error: no-patch'] }; }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else edits = parseV4A(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const moves: Move[] = [];
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try { edit(tree, moves); } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Build output rows, collapsing recorded moves into R lines.
  const changed = new Set<string>();
  for (const p of tree.now.keys()) if (tree.original(p) !== tree.now.get(p)) changed.add(p);
  interface Row { key: string; text: string; }
  const rows: Row[] = [];
  const used = new Set<string>();
  // collapse move chains: follow edges from an original source to final dest
  const edge = new Map<string, string>();
  for (const m of moves) edge.set(m.old, m.new);
  const rPairs: [string, string][] = [];
  for (const m of moves) {
    if (used.has(m.old) || used.has(m.new)) continue;
    // only consider chain starts: old was not itself a move destination
    if ([...moves].some((x) => x.new === m.old)) continue;
    let dest = m.new; const seen = new Set([m.old]);
    while (edge.has(dest) && !seen.has(dest)) { seen.add(dest); dest = edge.get(dest)!; }
    const src = m.old;
    if (tree.original(src) !== null && tree.get(src) === null && tree.original(dest) === null && tree.get(dest) !== null && changed.has(src) && changed.has(dest)) {
      rPairs.push([src, dest]);
      used.add(src); used.add(dest);
      // mark intermediate paths as used too (they are neither in original nor final)
      for (const x of seen) used.add(x);
    }
  }
  for (const [o, n] of rPairs) rows.push({ key: n, text: `R ${o} -> ${n}` });
  for (const p of changed) {
    if (used.has(p)) continue;
    const was = tree.original(p); const now = tree.now.get(p)!;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.text);
  if (!check) {
    // write in a safe order: deletions first, then creations/modifications
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p); const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, now); }
    }
  }
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
