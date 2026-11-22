// mend: one patch tool for every AI edit format.
//
// Applies an edit an AI model wrote to a tree of text files. The model may
// write the edit as a unified diff (often with wrong line numbers), as
// SEARCH/REPLACE blocks, in the V4A patch format, or as text-editor tool
// calls in JSON. Every file is changed or nothing is.
//
// This file implements SPEC.md version 1 in full: the command line, output
// and exit codes, safe paths, format detection, three-tier line matching,
// unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON edits, and the
// all-or-nothing write. Node 22 and its standard library alone.
//
// Usage: node main.ts [--format=NAME] [--check] [--strict] [PATCH]

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runTrial } from './runner.ts';

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** Byte order of UTF-8 strings, as the output lines are sorted. */
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Remove trailing spaces and tabs. */
function trimRightWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

/** Leading spaces and tabs of a line. */
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** A parse failure naming a 1-based patch line. */
class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

// ---------------------------------------------------------------------------
// Files, lines and paths (SPEC.md section 3)
// ---------------------------------------------------------------------------

interface FileState {
  lines: string[];
  eol: '\r\n' | '\n';
  endsWithBreak: boolean;
}

/** Split a file's text into its lines, line break and final-break flag. */
function parseFile(text: string): FileState {
  if (text === '') return { lines: [], eol: '\n', endsWithBreak: false };
  const lf = text.indexOf('\n');
  const eol: '\r\n' | '\n' = lf > 0 && text[lf - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(eol);
  let endsWithBreak = false;
  if (text.endsWith(eol)) {
    parts.pop();
    endsWithBreak = true;
  }
  return { lines: parts, eol, endsWithBreak };
}

/** Render a file's state back to its bytes. */
function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.eol) + (f.endsWithBreak ? f.eol : '');
}

/** A deep copy of a file's state, so a failed edit leaves nothing behind. */
function cloneFile(f: FileState): FileState {
  return { lines: [...f.lines], eol: f.eol, endsWithBreak: f.endsWithBreak };
}

/** A patch's lines: split at \n, one trailing \r removed per line, and no
 *  empty piece after a final \n. */
function splitPatchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no \,
 *  and none of its /-separated segments is empty, . or ... */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Matching lines (SPEC.md section 5)
// ---------------------------------------------------------------------------

/** A line normalised at a tier: 0 exact, 1 trailing spaces/tabs removed,
 *  2 leading and trailing spaces/tabs removed. */
function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions at or after `from` where O occurs in the file's lines at a tier.
 *  Occurrences may overlap. */
function findOccurrences(fileLines: string[], oLines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  const k = oLines.length;
  if (k === 0) return out;
  const want = oLines.map((l) => normLine(l, tier));
  for (let i = from; i + k <= fileLines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < k; j += 1) {
      if (normLine(fileLines[i + j], tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** Tiers to try, in order. With --strict only tier 0. */
function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** One line of N: a context line is written as the file's own matched line. */
interface NewLine {
  text: string;
  context: boolean;
  /** Index into O of the context line this one repeats. */
  oIndex: number;
}

/** Build the lines N writes when O matched at `pos` at `tier`.
 *  At tier 2 every other line of N is re-indented from O's first line's
 *  leading whitespace to the file's first matched line's. */
function buildNewLines(
  fileLines: string[],
  pos: number,
  oLines: string[],
  nLines: NewLine[],
  tier: number,
): string[] {
  const out: string[] = [];
  let f = '';
  let p = '';
  if (tier === 2 && oLines.length > 0) {
    f = leadingWs(fileLines[pos] ?? '');
    p = leadingWs(oLines[0]);
  }
  for (const nl of nLines) {
    if (nl.context) {
      out.push(fileLines[pos + nl.oIndex]);
    } else if (tier === 2) {
      const t = nl.text;
      if (t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    } else {
      out.push(nl.text);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The working tree: the directory's files as the edits leave them.
// Nothing is written to disk until every edit has succeeded.
// ---------------------------------------------------------------------------

class WorkTree {
  /** Original raw bytes (null: absent) for every path an edit touched. */
  private before = new Map<string, string | null>();
  /** Current state (null: absent) for every path an edit touched. */
  private current = new Map<string, FileState | null>();
  /** A non-file entry (e.g. a directory) sits at the path on disk. */
  private blocked = new Map<string, boolean>();

  private ensure(path: string): void {
    if (this.before.has(path)) return;
    let raw: string | null = null;
    let isBlocked = false;
    try {
      const st = statSync(path);
      if (st.isFile()) raw = readFileSync(path, 'utf8');
      else isBlocked = true;
    } catch {
      raw = null;
    }
    this.before.set(path, raw);
    this.current.set(path, raw === null ? null : parseFile(raw));
    this.blocked.set(path, isBlocked);
  }

  /** The file exists in the tree as the edits left it. */
  exists(path: string): boolean {
    this.ensure(path);
    return this.current.get(path) !== null || (this.blocked.get(path) ?? false);
  }

  /** A copy of the file's state, or null when it does not exist as a file. */
  clone(path: string): FileState | null {
    this.ensure(path);
    const f = this.current.get(path);
    return f === null || f === undefined ? null : cloneFile(f);
  }

  set(path: string, f: FileState): void {
    this.ensure(path);
    this.current.set(path, f);
  }

  delete(path: string): void {
    this.ensure(path);
    this.current.set(path, null);
  }

  /** The paths an edit touched, with their before and after bytes. */
  touched(): { path: string; before: string | null; after: string | null }[] {
    const out: { path: string; before: string | null; after: string | null }[] = [];
    for (const path of this.before.keys()) {
      const cur = this.current.get(path);
      out.push({ path, before: this.before.get(path) ?? null, after: cur === null || cur === undefined ? null : renderFile(cur) });
    }
    return out;
  }

  /** Write every change to disk. Only called when no edit failed. */
  writeAll(): void {
    for (const { path, before, after } of this.touched()) {
      if (after === before) continue;
      if (after === null) {
        rmSync(path, { force: true });
      } else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, after);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

/** One body line of a hunk or chunk: context (in both O and N), old (O
 *  only), new (N only), or a backslash line (`\ No newline at end of file`). */
type BodyItem =
  | { k: 'ctx'; text: string }
  | { k: 'old'; text: string }
  | { k: 'new'; text: string }
  | { k: 'bs'; text: string };

interface Hunk {
  /** The -A number of the hunk header. */
  a: number;
  items: BodyItem[];
}

interface VChunk {
  /** Null: no anchor. */
  anchor: string | null;
  /** Anchored to the end of the file (`*** End of File`). */
  eof: boolean;
  items: BodyItem[];
}

type Edit =
  | { kind: 'unified'; oldPath: string | null; newPath: string | null; isCreate: boolean; isDelete: boolean; hunks: Hunk[] }
  | { kind: 'search-replace'; path: string; oldLines: string[]; newLines: string[] }
  | { kind: 'v4a-add'; path: string; lines: string[] }
  | { kind: 'v4a-delete'; path: string }
  | { kind: 'v4a-update'; path: string; moveTo: string | null; chunks: VChunk[] }
  | { kind: 'json-create'; path: string; fileText: string }
  | { kind: 'json-str-replace'; path: string; oldStr: string; newStr: string }
  | { kind: 'json-insert'; path: string; insertLine: number; newStr: string };

/** O and N of a hunk or chunk, derived from its body items. */
function splitBody(items: BodyItem[]): { oLines: string[]; nLines: NewLine[] } {
  const oLines: string[] = [];
  const nLines: NewLine[] = [];
  for (const it of items) {
    if (it.k === 'ctx') {
      oLines.push(it.text);
      nLines.push({ text: it.text, context: true, oIndex: oLines.length - 1 });
    } else if (it.k === 'old') {
      oLines.push(it.text);
    } else if (it.k === 'new') {
      nLines.push({ text: it.text, context: false, oIndex: -1 });
    }
  }
  return { oLines, nLines };
}

/** Whether a `\` line follows the hunk's last `+` line. */
function noNewlineAfterLastPlus(items: BodyItem[]): boolean {
  let last = -1;
  for (let i = 0; i < items.length; i += 1) if (items[i].k === 'new') last = i;
  return last >= 0 && last + 1 < items.length && items[last + 1].k === 'bs';
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function noNewlineAfterLastCtxOrPlus(items: BodyItem[]): boolean {
  let last = -1;
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].k === 'ctx' || items[i].k === 'new') last = i;
  }
  return last >= 0 && last + 1 < items.length && items[last + 1].k === 'bs';
}

/** A failure of one edit: its code and the path it concerns. */
interface EditFailure {
  code: string;
  path: string;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

const DIFF_GIT_RE = /^diff --git a\/([^ ]+) b\/([^ ]+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** The path of a `--- ` or `+++ ` line: text after the four characters, up
 *  to the first tab, surrounding spaces removed, a leading a/ or b/ removed.
 *  /dev/null means no file. */
function diffHeaderPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  if (p === '/dev/null') return null;
  return p;
}

/** A rename / diff --git path: surrounding spaces removed, /dev/null means
 *  no file. */
function plainPath(p: string): string | null {
  const t = p.trim();
  if (t === '/dev/null') return null;
  return t;
}

interface Section {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameOld: string | null | undefined;
  renameNew: string | null | undefined;
  diffOld: string | null | undefined;
  diffNew: string | null | undefined;
  hasPair: boolean;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function blankSection(): Section {
  return {
    pairOld: undefined,
    pairNew: undefined,
    renameOld: undefined,
    renameNew: undefined,
    diffOld: undefined,
    diffNew: undefined,
    hasPair: false,
    newFile: false,
    deletedFile: false,
    hunks: [],
  };
}

function sectionToEdit(s: Section): Edit {
  const oldPath = s.pairOld ?? s.renameOld ?? s.diffOld ?? null;
  const newPath = s.pairNew ?? s.renameNew ?? s.diffNew ?? null;
  const isCreate = oldPath === null || s.newFile;
  const isDelete = newPath === null || s.deletedFile;
  return { kind: 'unified', oldPath, newPath, isCreate, isDelete, hunks: s.hunks };
}

/** Collect a hunk body starting at `start`. The body ends at the first
 *  other line, at a `diff --git ` line, at a `--- ` line followed by a
 *  `+++ ` line, or at the end of the patch. Empty lines at the end of a
 *  body are not part of it. */
function collectHunkBody(lines: string[], start: number): { items: BodyItem[]; next: number } {
  const items: BodyItem[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) break;
    if (l === '') {
      items.push({ k: 'ctx', text: '' });
      i += 1;
      continue;
    }
    if (l.startsWith(' ')) {
      items.push({ k: 'ctx', text: l.slice(1) });
      i += 1;
      continue;
    }
    if (l.startsWith('-')) {
      items.push({ k: 'old', text: l.slice(1) });
      i += 1;
      continue;
    }
    if (l.startsWith('+')) {
      items.push({ k: 'new', text: l.slice(1) });
      i += 1;
      continue;
    }
    if (l.startsWith('\\')) {
      items.push({ k: 'bs', text: l.slice(1) });
      i += 1;
      continue;
    }
    break;
  }
  while (items.length > 0) {
    const last = items[items.length - 1];
    if (last.k === 'ctx' && last.text === '') items.pop();
    else break;
  }
  return { items, next: i };
}

function parseUnified(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let cur: Section | null = null;
  /** 'out': between sections; 'header': in a section before its first hunk;
   *  'between': in a section after a hunk. */
  let state: 'out' | 'header' | 'between' = 'out';
  const closeSection = (): void => {
    if (cur !== null) edits.push(sectionToEdit(cur));
    cur = null;
    state = 'out';
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line);
      if (m === null) throw new ParseError(i + 1);
      closeSection();
      cur = blankSection();
      cur.diffOld = plainPath(m[1]);
      cur.diffNew = plainPath(m[2]);
      state = 'header';
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const nextIsPlusPlus = i + 1 < lines.length && lines[i + 1].startsWith('+++ ');
      if (nextIsPlusPlus) {
        if (state === 'header' && cur !== null && !cur.hasPair) {
          cur.pairOld = diffHeaderPath(line);
          cur.pairNew = diffHeaderPath(lines[i + 1]);
          cur.hasPair = true;
          i += 2;
          continue;
        }
        closeSection();
        cur = blankSection();
        cur.pairOld = diffHeaderPath(line);
        cur.pairNew = diffHeaderPath(lines[i + 1]);
        cur.hasPair = true;
        state = 'header';
        i += 2;
        continue;
      }
      if (state === 'header') throw new ParseError(i + 2);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (state === 'out' || cur === null) throw new ParseError(i + 1);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new ParseError(i + 1);
      const body = collectHunkBody(lines, i + 1);
      cur.hunks.push({ a: Number(m[1]), items: body.items });
      state = 'between';
      i = body.next;
      continue;
    }
    if (state === 'header' && cur !== null) {
      if (line.startsWith('rename from ')) {
        cur.renameOld = plainPath(line.slice('rename from '.length));
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameNew = plainPath(line.slice('rename to '.length));
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        i += 1;
        continue;
      }
    }
    i += 1;
  }
  closeSection();
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (trimRightWs(lines[i]) !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (trimRightWs(lines[j]) === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new ParseError(searchLine);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (trimRightWs(lines[j]) === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new ParseError(searchLine);
    let path: string | null = null;
    for (let j = i - 1; j > prevReplaceEnd; j -= 1) {
      const t = lines[j].trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseError(searchLine);
      path = prevPath;
    }
    edits.push({
      kind: 'search-replace',
      path,
      oldLines: lines.slice(i + 1, eq),
      newLines: lines.slice(eq + 1, rep),
    });
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

function parseV4a(lines: string[]): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  if (first === -1) throw new ParseError(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseError(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim() !== '') {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new ParseError(lines.length + 1);

  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');

  let i = first + 1;
  for (;;) {
    while (i < last && lines[i].trim() === '') i += 1;
    if (i >= last) break;
    const line = lines[i];
    if (line.startsWith('*** Add File:')) {
      const path = line.slice('*** Add File:'.length).trim();
      i += 1;
      const secLines: string[] = [];
      while (i < last) {
        const l = lines[i];
        if (isSectionStart(l)) break;
        if (l === '') {
          secLines.push('');
          i += 1;
          continue;
        }
        if (l.startsWith('+')) {
          secLines.push(l.slice(1));
          i += 1;
          continue;
        }
        throw new ParseError(i + 1);
      }
      while (secLines.length > 0 && secLines[secLines.length - 1] === '') secLines.pop();
      edits.push({ kind: 'v4a-add', path, lines: secLines });
      continue;
    }
    if (line.startsWith('*** Delete File:')) {
      const path = line.slice('*** Delete File:'.length).trim();
      edits.push({ kind: 'v4a-delete', path });
      i += 1;
      continue;
    }
    if (line.startsWith('*** Update File:')) {
      const path = line.slice('*** Update File:'.length).trim();
      const updateLine = i + 1;
      i += 1;
      let moveTo: string | null = null;
      let j = i;
      while (j < last && lines[j].trim() === '') j += 1;
      if (j < last && lines[j].startsWith('*** Move to:')) {
        moveTo = lines[j].slice('*** Move to:'.length).trim();
        i = j + 1;
      }
      const chunks: VChunk[] = [];
      let curChunk: VChunk | null = null;
      const flushChunk = (): void => {
        if (curChunk !== null) {
          chunks.push(curChunk);
          curChunk = null;
        }
      };
      while (i < last) {
        const l = lines[i];
        if (isSectionStart(l)) break;
        if (l.startsWith('*** Move to:')) throw new ParseError(i + 1);
        if (trimRightWs(l) === '*** End of File') {
          if (curChunk === null) throw new ParseError(i + 1);
          curChunk.eof = true;
          flushChunk();
          i += 1;
          continue;
        }
        if (l.startsWith('@@')) {
          flushChunk();
          const anchor = l.slice(2).trim();
          curChunk = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
          i += 1;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (curChunk === null) curChunk = { anchor: null, eof: false, items: [] };
          if (l === '') curChunk.items.push({ k: 'ctx', text: '' });
          else if (l.startsWith(' ')) curChunk.items.push({ k: 'ctx', text: l.slice(1) });
          else if (l.startsWith('-')) curChunk.items.push({ k: 'old', text: l.slice(1) });
          else curChunk.items.push({ k: 'new', text: l.slice(1) });
          i += 1;
          continue;
        }
        throw new ParseError(i + 1);
      }
      flushChunk();
      // Blank lines at the end of a section are not part of it.
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1];
        while (lastChunk.items.length > 0) {
          const lastItem = lastChunk.items[lastChunk.items.length - 1];
          if (lastItem.k === 'ctx' && lastItem.text === '') lastChunk.items.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseError(updateLine);
      edits.push({ kind: 'v4a-update', path, moveTo, chunks });
      continue;
    }
    throw new ParseError(i + 1);
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

function jsonEditObject(obj: unknown, lineNo: number): Edit {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new ParseError(lineNo);
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') throw new ParseError(lineNo);
  if (typeof o.command !== 'string') throw new ParseError(lineNo);
  const path = o.path;
  switch (o.command) {
    case 'create': {
      if (typeof o.file_text !== 'string') throw new ParseError(lineNo);
      return { kind: 'json-create', path, fileText: o.file_text };
    }
    case 'str_replace': {
      if (typeof o.old_str !== 'string' || o.old_str === '') throw new ParseError(lineNo);
      if (o.new_str !== undefined && typeof o.new_str !== 'string') throw new ParseError(lineNo);
      return {
        kind: 'json-str-replace',
        path,
        oldStr: o.old_str,
        newStr: o.new_str === undefined ? '' : (o.new_str as string),
      };
    }
    case 'insert': {
      if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) throw new ParseError(lineNo);
      if (typeof o.new_str !== 'string') throw new ParseError(lineNo);
      return { kind: 'json-insert', path, insertLine: o.insert_line, newStr: o.new_str };
    }
    default:
      throw new ParseError(lineNo);
  }
}

function parseJson(text: string, lines: string[]): Edit[] {
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== '') {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx === -1) throw new ParseError(1);
  const firstNonWs = lines[firstIdx].trimStart();
  if (firstNonWs.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ParseError(firstIdx + 1);
    }
    if (!Array.isArray(parsed)) throw new ParseError(firstIdx + 1);
    const edits: Edit[] = [];
    for (const item of parsed) edits.push(jsonEditObject(item, firstIdx + 1));
    if (edits.length === 0) throw new ParseError(1);
    return edits;
  }
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.trim() === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(l);
    } catch {
      throw new ParseError(i + 1);
    }
    edits.push(jsonEditObject(obj, i + 1));
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

// ---------------------------------------------------------------------------
// Detecting the format (SPEC.md section 4)
// ---------------------------------------------------------------------------

type FormatName = 'unified' | 'search-replace' | 'v4a' | 'json';

function detectFormat(lines: string[]): FormatName | null {
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== '') {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx === -1) return null;
  const first = lines[firstIdx];
  if (first.trim() === '*** Begin Patch') return 'v4a';
  const c = first.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  for (const l of lines) {
    if (trimRightWs(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Applying edits (SPEC.md section 10)
// ---------------------------------------------------------------------------

function applyHunks(file: FileState, hunks: Hunk[], strict: boolean, path: string): EditFailure | null {
  let d = 0;
  for (const h of hunks) {
    const { oLines, nLines } = splitBody(h.items);
    if (oLines.length === 0) {
      let idx = h.a + d;
      if (idx < 0) idx = 0;
      if (idx > file.lines.length) idx = file.lines.length;
      const atEnd = idx === file.lines.length;
      const newLines = nLines.map((nl) => nl.text);
      file.lines.splice(idx, 0, ...newLines);
      if (atEnd) file.endsWithBreak = !noNewlineAfterLastPlus(h.items);
      d += newLines.length;
      continue;
    }
    let tier = -1;
    let occ: number[] = [];
    for (const t of tiers(strict)) {
      occ = findOccurrences(file.lines, oLines, t, 0);
      if (occ.length > 0) {
        tier = t;
        break;
      }
    }
    if (tier === -1) return { code: 'no-match', path };
    const target = h.a - 1 + d;
    let best = occ[0];
    let bestDist = Math.abs(occ[0] - target);
    for (const p of occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const pos = best;
    const atEnd = pos + oLines.length === file.lines.length;
    const newLines = buildNewLines(file.lines, pos, oLines, nLines, tier);
    file.lines.splice(pos, oLines.length, ...newLines);
    if (atEnd) file.endsWithBreak = !noNewlineAfterLastCtxOrPlus(h.items);
    d += nLines.length - oLines.length;
  }
  return null;
}

function applyUnified(
  edit: Extract<Edit, { kind: 'unified' }>,
  tree: WorkTree,
  strict: boolean,
): EditFailure | null {
  const paths: string[] = [];
  if (edit.oldPath !== null) paths.push(edit.oldPath);
  if (edit.newPath !== null && edit.newPath !== edit.oldPath) paths.push(edit.newPath);
  for (const p of paths) {
    if (!isSafePath(p)) return { code: 'unsafe', path: p };
  }
  if (edit.isCreate) {
    const np = edit.newPath;
    if (np === null) return null;
    if (tree.exists(np)) return { code: 'exists', path: np };
    const lines: string[] = [];
    let noNL = false;
    for (const h of edit.hunks) {
      let hasPlus = false;
      for (const it of h.items) {
        if (it.k === 'new') {
          lines.push(it.text);
          hasPlus = true;
        }
      }
      if (hasPlus) noNL = noNewlineAfterLastPlus(h.items);
    }
    tree.set(np, { lines, eol: '\n', endsWithBreak: lines.length > 0 && !noNL });
    return null;
  }
  if (edit.isDelete) {
    const op = edit.oldPath;
    if (op === null) return null;
    if (tree.clone(op) === null) return { code: 'missing', path: op };
    tree.delete(op);
    return null;
  }
  const op = edit.oldPath as string;
  const file = tree.clone(op);
  if (file === null) return { code: 'missing', path: op };
  const isMove = edit.newPath !== null && edit.newPath !== op;
  if (isMove && tree.exists(edit.newPath as string)) return { code: 'exists', path: edit.newPath as string };
  const fail = applyHunks(file, edit.hunks, strict, op);
  if (fail !== null) return fail;
  if (isMove) {
    tree.set(edit.newPath as string, file);
    tree.delete(op);
  } else {
    tree.set(op, file);
  }
  return null;
}

function applySearchReplace(
  edit: Extract<Edit, { kind: 'search-replace' }>,
  tree: WorkTree,
  strict: boolean,
): EditFailure | null {
  if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
  if (edit.oldLines.length === 0) {
    if (tree.exists(edit.path)) return { code: 'exists', path: edit.path };
    tree.set(edit.path, { lines: [...edit.newLines], eol: '\n', endsWithBreak: edit.newLines.length > 0 });
    return null;
  }
  const file = tree.clone(edit.path);
  if (file === null) return { code: 'missing', path: edit.path };
  let tier = -1;
  let occ: number[] = [];
  for (const t of tiers(strict)) {
    occ = findOccurrences(file.lines, edit.oldLines, t, 0);
    if (occ.length > 0) {
      tier = t;
      break;
    }
  }
  if (tier === -1) return { code: 'no-match', path: edit.path };
  if (occ.length > 1) return { code: 'ambiguous', path: edit.path };
  const nLines: NewLine[] = edit.newLines.map((text) => ({ text, context: false, oIndex: -1 }));
  const newLines = buildNewLines(file.lines, occ[0], edit.oldLines, nLines, tier);
  file.lines.splice(occ[0], edit.oldLines.length, ...newLines);
  tree.set(edit.path, file);
  return null;
}

function applyV4aAdd(edit: Extract<Edit, { kind: 'v4a-add' }>, tree: WorkTree): EditFailure | null {
  if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
  if (tree.exists(edit.path)) return { code: 'exists', path: edit.path };
  tree.set(edit.path, { lines: [...edit.lines], eol: '\n', endsWithBreak: edit.lines.length > 0 });
  return null;
}

function applyV4aDelete(edit: Extract<Edit, { kind: 'v4a-delete' }>, tree: WorkTree): EditFailure | null {
  if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
  if (tree.clone(edit.path) === null) return { code: 'missing', path: edit.path };
  tree.delete(edit.path);
  return null;
}

/** Apply one V4A chunk. Returns the new cursor, or the failure. */
function applyVChunk(
  file: FileState,
  chunk: VChunk,
  strict: boolean,
  path: string,
  cursor: number,
): number | EditFailure {
  let cur = cursor;
  if (chunk.anchor !== null) {
    const anchor = chunk.anchor;
    let found = -1;
    for (const t of tiers(strict)) {
      for (let i = cur; i < file.lines.length; i += 1) {
        if (normLine(file.lines[i], t) === normLine(anchor, t)) {
          found = i;
          break;
        }
      }
      if (found >= 0) break;
    }
    if (found < 0) return { code: 'no-match', path };
    cur = found + 1;
  }
  const { oLines, nLines } = splitBody(chunk.items);
  if (oLines.length === 0) {
    const idx = chunk.eof ? file.lines.length : cur;
    const newLines = nLines.map((nl) => nl.text);
    file.lines.splice(idx, 0, ...newLines);
    return idx + newLines.length;
  }
  let tier = -1;
  let occ: number[] = [];
  for (const t of tiers(strict)) {
    occ = findOccurrences(file.lines, oLines, t, cur);
    if (chunk.eof) occ = occ.filter((p) => p + oLines.length === file.lines.length);
    if (occ.length > 0) {
      tier = t;
      break;
    }
  }
  if (tier === -1) return { code: 'no-match', path };
  const pos = occ[0];
  const newLines = buildNewLines(file.lines, pos, oLines, nLines, tier);
  file.lines.splice(pos, oLines.length, ...newLines);
  return pos + newLines.length;
}

function applyV4aUpdate(
  edit: Extract<Edit, { kind: 'v4a-update' }>,
  tree: WorkTree,
  strict: boolean,
): EditFailure | null {
  if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
  if (edit.moveTo !== null && !isSafePath(edit.moveTo)) return { code: 'unsafe', path: edit.moveTo };
  const file = tree.clone(edit.path);
  if (file === null) return { code: 'missing', path: edit.path };
  if (edit.moveTo !== null && tree.exists(edit.moveTo)) return { code: 'exists', path: edit.moveTo };
  let cursor = 0;
  for (const chunk of edit.chunks) {
    const r = applyVChunk(file, chunk, strict, edit.path, cursor);
    if (typeof r !== 'number') return r;
    cursor = r;
  }
  if (edit.moveTo !== null) {
    tree.set(edit.moveTo, file);
    tree.delete(edit.path);
  } else {
    tree.set(edit.path, file);
  }
  return null;
}

function countOccurrences(text: string, sub: string): number {
  let count = 0;
  let idx = 0;
  for (;;) {
    const i = text.indexOf(sub, idx);
    if (i < 0) break;
    count += 1;
    idx = i + 1;
  }
  return count;
}

function applyJsonCreate(edit: Extract<Edit, { kind: 'json-create' }>, tree: WorkTree): EditFailure | null {
  if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
  if (tree.exists(edit.path)) return { code: 'exists', path: edit.path };
  tree.set(edit.path, parseFile(edit.fileText));
  return null;
}

function applyJsonStrReplace(
  edit: Extract<Edit, { kind: 'json-str-replace' }>,
  tree: WorkTree,
): EditFailure | null {
  if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
  const file = tree.clone(edit.path);
  if (file === null) return { code: 'missing', path: edit.path };
  const crlf = file.eol === '\r\n';
  let text = renderFile(file);
  let oldStr = edit.oldStr;
  let newStr = edit.newStr;
  if (crlf) {
    text = text.replace(/\r\n/g, '\n');
    oldStr = oldStr.replace(/\r\n/g, '\n');
    newStr = newStr.replace(/\r\n/g, '\n');
  }
  const n = countOccurrences(text, oldStr);
  if (n === 0) return { code: 'no-match', path: edit.path };
  if (n > 1) return { code: 'ambiguous', path: edit.path };
  const at = text.indexOf(oldStr);
  let result = text.slice(0, at) + newStr + text.slice(at + oldStr.length);
  if (crlf) result = result.replace(/\n/g, '\r\n');
  tree.set(edit.path, parseFile(result));
  return null;
}

function applyJsonInsert(edit: Extract<Edit, { kind: 'json-insert' }>, tree: WorkTree): EditFailure | null {
  if (!isSafePath(edit.path)) return { code: 'unsafe', path: edit.path };
  const file = tree.clone(edit.path);
  if (file === null) return { code: 'missing', path: edit.path };
  if (edit.insertLine < 0 || edit.insertLine > file.lines.length) return { code: 'no-match', path: edit.path };
  const newLines = splitPatchLines(edit.newStr);
  file.lines.splice(edit.insertLine, 0, ...newLines);
  tree.set(edit.path, file);
  return null;
}

function applyEdit(edit: Edit, tree: WorkTree, strict: boolean): EditFailure | null {
  switch (edit.kind) {
    case 'unified':
      return applyUnified(edit, tree, strict);
    case 'search-replace':
      return applySearchReplace(edit, tree, strict);
    case 'v4a-add':
      return applyV4aAdd(edit, tree);
    case 'v4a-delete':
      return applyV4aDelete(edit, tree);
    case 'v4a-update':
      return applyV4aUpdate(edit, tree, strict);
    case 'json-create':
      return applyJsonCreate(edit, tree);
    case 'json-str-replace':
      return applyJsonStrReplace(edit, tree);
    case 'json-insert':
      return applyJsonInsert(edit, tree);
  }
}

// ---------------------------------------------------------------------------
// Command line, output and exit codes (SPEC.md sections 1 and 2)
// ---------------------------------------------------------------------------

/** Thrown to stop main() after an exit-2 message has been written. */
class ExitSignal extends Error {}

function failExit2(msg: string): never {
  process.stdout.write(`${msg}\n`);
  process.exitCode = 2;
  throw new ExitSignal();
}

function main(): void {
  const args = process.argv.slice(2);
  let format: string | null = null;
  let check = false;
  let strict = false;
  const positional: string[] = [];
  let endOfOptions = false;
  let usageError = false;
  for (const a of args) {
    if (!endOfOptions && a === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (check) usageError = true;
        check = true;
      } else if (a === '--strict') {
        if (strict) usageError = true;
        strict = true;
      } else if (a.startsWith('--format=')) {
        const v = a.slice('--format='.length);
        if (format !== null) usageError = true;
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') usageError = true;
        format = v;
      } else {
        usageError = true;
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) usageError = true;
  if (usageError) failExit2('error: usage');

  const patchArg = positional.length === 0 ? null : positional[0];
  let patchText: string;
  if (patchArg === null || patchArg === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(patchArg, 'utf8');
    } catch {
      failExit2('error: no-patch');
    }
  }

  const lines = splitPatchLines(patchText);
  let fmt: FormatName;
  if (format === null || format === 'auto') {
    const detected = detectFormat(lines);
    if (detected === null) failExit2('error: format');
    fmt = detected;
  } else {
    fmt = format as FormatName;
  }

  let edits: Edit[];
  try {
    if (fmt === 'unified') edits = parseUnified(lines);
    else if (fmt === 'search-replace') edits = parseSearchReplace(lines);
    else if (fmt === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(patchText, lines);
  } catch (err) {
    if (err instanceof ParseError) failExit2(`error: parse ${err.line}`);
    throw err;
  }

  const tree = new WorkTree();
  const failures: EditFailure[] = [];
  const moves: { oldPath: string; newPath: string }[] = [];
  for (const edit of edits) {
    const f = applyEdit(edit, tree, strict);
    if (f !== null) {
      failures.push(f);
    } else if (
      edit.kind === 'unified' &&
      edit.oldPath !== null &&
      edit.newPath !== null &&
      edit.newPath !== edit.oldPath &&
      !edit.isCreate &&
      !edit.isDelete
    ) {
      moves.push({ oldPath: edit.oldPath, newPath: edit.newPath });
    } else if (edit.kind === 'v4a-update' && edit.moveTo !== null) {
      moves.push({ oldPath: edit.path, newPath: edit.moveTo });
    }
  }

  if (failures.length > 0) {
    let out = '';
    for (const f of failures) out += `error: ${f.code} ${f.path}\n`;
    out += `failed: ${failures.length} of ${edits.length} edits\n`;
    process.stdout.write(out);
    process.exitCode = 1;
    return;
  }

  const touched = tree.touched();
  const beforeMap = new Map<string, string | null>();
  const afterMap = new Map<string, string | null>();
  for (const t of touched) {
    beforeMap.set(t.path, t.before);
    afterMap.set(t.path, t.after);
  }
  const entries: { sortKey: string; line: string }[] = [];
  for (const t of touched) {
    if (t.after === t.before) continue;
    if (t.before === null) entries.push({ sortKey: t.path, line: `A ${t.path}` });
    else if (t.after === null) entries.push({ sortKey: t.path, line: `D ${t.path}` });
    else entries.push({ sortKey: t.path, line: `M ${t.path}` });
  }
  for (const m of moves) {
    const oldBefore = beforeMap.get(m.oldPath);
    const oldAfter = afterMap.get(m.oldPath);
    const newBefore = beforeMap.get(m.newPath);
    const newAfter = afterMap.get(m.newPath);
    if (
      oldBefore !== null &&
      oldBefore !== undefined &&
      oldAfter === null &&
      (newBefore === null || newBefore === undefined) &&
      newAfter !== null &&
      newAfter !== undefined
    ) {
      const di = entries.findIndex((e) => e.line === `D ${m.oldPath}`);
      const ai = entries.findIndex((e) => e.line === `A ${m.newPath}`);
      if (di >= 0 && ai >= 0) {
        entries.splice(Math.max(di, ai), 1);
        entries.splice(Math.min(di, ai), 1);
        entries.push({ sortKey: m.newPath, line: `R ${m.oldPath} -> ${m.newPath}` });
      }
    }
  }
  entries.sort((a, b) => byteCompare(a.sortKey, b.sortKey));
  let out = '';
  for (const e of entries) out += `${e.line}\n`;
  out += entries.length === 1 ? 'ok: 1 file\n' : `ok: ${entries.length} files\n`;
  if (!check) tree.writeAll();
  process.stdout.write(out);
  process.exitCode = 0;
}

// ---------------------------------------------------------------------------
// Trial hand-over: when the trial environment is set, run its checks and post
// what main.ts did, instead of acting as the CLI.
// ---------------------------------------------------------------------------

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  await runTrial(envUrl);
} else {
  try {
    main();
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  }
}
