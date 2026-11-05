/**
 * The part of YAML that frontmatter and config files use.
 *
 * Block maps and sequences by indentation, flow sequences and maps, plain,
 * single- and double-quoted scalars, comments, and `|` and `>` block scalars.
 * Anchors, aliases, tags and multi-document streams are not read: a vault's
 * frontmatter does not use them, and a file that does gets what this can
 * make of it rather than an exception. Plain scalars become booleans, null
 * and numbers by YAML 1.2's core schema; dates stay strings.
 *
 * yagni: a subset parser, because the package has no dependencies and its
 * inputs are frontmatter and small config files. Swap in a full parser if a
 * vault's frontmatter ever needs anchors or complex keys.
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

export function parseYaml(source: string): YamlValue {
  const lines = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  return new Parser(lines).document();
}

/** A top-level map, or an empty one when the text is not a map. */
export function parseYamlMap(source: string): Record<string, YamlValue> {
  const value = parseYaml(source);
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

const indentOf = (line: string): number => line.length - line.replace(/^ +/, '').length;
const isBlank = (line: string): boolean => /^\s*(#.*)?$/.test(line);
const isSeqItem = (content: string): boolean => content === '-' || content.startsWith('- ');

class Parser {
  private i = 0;

  constructor(private readonly lines: string[]) {}

  document(): YamlValue {
    this.skipBlank();
    if (this.i >= this.lines.length) return null;
    return this.block(indentOf(this.lines[this.i]!));
  }

  private skipBlank(): void {
    while (this.i < this.lines.length && isBlank(this.lines[this.i]!)) this.i += 1;
  }

  private block(indent: number): YamlValue {
    this.skipBlank();
    const content = this.lines[this.i]!.slice(indent);
    if (isSeqItem(content)) return this.seq(indent);
    if (splitKey(content)) return this.map(indent);
    this.i += 1;
    return this.inline(content);
  }

  private seq(indent: number): YamlValue[] {
    const out: YamlValue[] = [];
    for (;;) {
      this.skipBlank();
      if (this.i >= this.lines.length) break;
      const line = this.lines[this.i]!;
      if (indentOf(line) !== indent) break;
      const content = line.slice(indent);
      if (!isSeqItem(content)) break;
      const rest = content.slice(1).replace(/^ +/, '');
      const restIndent = indent + (content.length - rest.length);
      if (rest === '' || rest.startsWith('#')) {
        this.i += 1;
        out.push(this.nested(indent));
        continue;
      }
      if (isSeqItem(rest) || (splitKey(rest) && !/^["'[{]/.test(rest))) {
        // `- key: value` or `- - x`: the rest of the line opens a block at its own column.
        this.lines[this.i] = ' '.repeat(restIndent) + rest;
        out.push(this.block(restIndent));
        continue;
      }
      this.i += 1;
      out.push(this.inline(rest));
    }
    return out;
  }

  /** The value of a key or item written on the lines below it. */
  private nested(parentIndent: number): YamlValue {
    this.skipBlank();
    if (this.i >= this.lines.length) return null;
    const line = this.lines[this.i]!;
    const indent = indentOf(line);
    return indent > parentIndent ? this.block(indent) : null;
  }

  private map(indent: number): { [key: string]: YamlValue } {
    const out: { [key: string]: YamlValue } = {};
    for (;;) {
      this.skipBlank();
      if (this.i >= this.lines.length) break;
      const line = this.lines[this.i]!;
      if (indentOf(line) !== indent) break;
      const pair = splitKey(line.slice(indent));
      if (!pair) break;
      this.i += 1;
      const [key, raw] = pair;
      const value = stripComment(raw).trim();
      if (value === '') {
        this.skipBlank();
        if (this.i < this.lines.length) {
          const next = this.lines[this.i]!;
          const nextIndent = indentOf(next);
          if (nextIndent > indent) { out[key] = this.block(nextIndent); continue; }
          // A sequence may sit at the key's own column.
          if (nextIndent === indent && isSeqItem(next.slice(indent))) { out[key] = this.seq(indent); continue; }
        }
        out[key] = null;
        continue;
      }
      if (/^[|>][-+]?\d*$/.test(value)) {
        out[key] = this.blockScalar(value, indent);
        continue;
      }
      out[key] = this.inline(raw);
    }
    return out;
  }

  /** A value on one line, or a flow collection or quoted scalar that runs on. */
  private inline(raw: string): YamlValue {
    let text = raw.trim();
    if (text.startsWith('[') || text.startsWith('{')) {
      text = stripComment(text);
      while (!balanced(text) && this.i < this.lines.length) {
        text += ` ${stripComment(this.lines[this.i]!.trim())}`;
        this.i += 1;
      }
      return parseFlow(text);
    }
    if (text.startsWith('"') && !closedQuote(text)) {
      while (!closedQuote(text) && this.i < this.lines.length) {
        text += ` ${this.lines[this.i]!.trim()}`;
        this.i += 1;
      }
    }
    return scalar(stripComment(text));
  }

  private blockScalar(header: string, indent: number): string {
    const folded = header.startsWith('>');
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
    const collected: string[] = [];
    let blockIndent = -1;
    while (this.i < this.lines.length) {
      const line = this.lines[this.i]!;
      if (line.trim() === '') { collected.push(''); this.i += 1; continue; }
      const lineIndent = indentOf(line);
      if (lineIndent <= indent || (blockIndent >= 0 && lineIndent < blockIndent)) break;
      if (blockIndent < 0) blockIndent = lineIndent;
      collected.push(line.slice(blockIndent));
      this.i += 1;
    }
    let trailing = 0;
    while (collected.length > 0 && collected[collected.length - 1] === '') { collected.pop(); trailing += 1; }
    let text: string;
    if (!folded) text = collected.join('\n');
    else {
      text = '';
      for (let at = 0; at < collected.length; at += 1) {
        const piece = collected[at]!;
        if (at === 0) text = piece;
        else if (piece === '') text += '\n';
        else text += collected[at - 1] === '' || /^\s/.test(piece) ? piece : ` ${piece}`;
      }
    }
    if (collected.length === 0) return '';
    if (chomp === 'strip') return text;
    if (chomp === 'keep') return `${text}\n${'\n'.repeat(trailing)}`;
    return `${text}\n`;
  }
}

/** `key: rest` split at the first `:` that is followed by a space or the end, outside quotes. */
function splitKey(content: string): [string, string] | null {
  if (content === '' || isSeqItem(content) || /^[#[{]/.test(content)) return null;
  let quote: string | null = null;
  for (let at = 0; at < content.length; at += 1) {
    const ch = content[at]!;
    if (quote) {
      if (ch === '\\' && quote === '"') { at += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if ((ch === '"' || ch === "'") && at === 0) { quote = ch; continue; }
    if (ch === '#' && at > 0 && /\s/.test(content[at - 1]!)) return null;
    if (ch === ':' && (at + 1 === content.length || /\s/.test(content[at + 1]!))) {
      const rawKey = content.slice(0, at).trim();
      if (rawKey === '') return null;
      const key = /^["']/.test(rawKey) ? String(scalar(rawKey)) : rawKey;
      return [key, content.slice(at + 1)];
    }
  }
  return null;
}

/** The text before a comment: a `#` at the start or after whitespace, outside quotes. */
function stripComment(text: string): string {
  let quote: string | null = null;
  for (let at = 0; at < text.length; at += 1) {
    const ch = text[at]!;
    if (quote) {
      if (ch === '\\' && quote === '"') { at += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      // A quote only opens a scalar where a scalar can start.
      if (at === 0 || /[\s,[{:]/.test(text[at - 1]!)) quote = ch;
      continue;
    }
    if (ch === '#' && (at === 0 || /\s/.test(text[at - 1]!))) return text.slice(0, at).trimEnd();
  }
  return text;
}

function closedQuote(text: string): boolean {
  for (let at = 1; at < text.length; at += 1) {
    if (text[at] === '\\') { at += 1; continue; }
    if (text[at] === '"') return true;
  }
  return false;
}

function balanced(text: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let at = 0; at < text.length; at += 1) {
    const ch = text[at]!;
    if (quote) {
      if (ch === '\\' && quote === '"') { at += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') depth -= 1;
  }
  return depth <= 0;
}

export function scalar(raw: string): YamlValue {
  const text = raw.trim();
  if (text === '' || text === '~' || /^null$/i.test(text)) return null;
  if (text.startsWith('"')) {
    const end = findClosing(text, '"');
    return unescapeDouble(text.slice(1, end < 0 ? text.length : end));
  }
  if (text.startsWith("'")) {
    const end = findClosing(text, "'");
    return text.slice(1, end < 0 ? text.length : end).replace(/''/g, "'");
  }
  if (/^(true|True|TRUE)$/.test(text)) return true;
  if (/^(false|False|FALSE)$/.test(text)) return false;
  if (/^[-+]?\d+$/.test(text)) {
    const number = Number(text);
    // `007` and integers past 2^53 stay as written.
    return String(number) === text.replace(/^\+/, '') ? number : text;
  }
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+(?:\.\d*)?[eE][-+]?\d+)$/.test(text)) return Number(text);
  return text;
}

function findClosing(text: string, quote: string): number {
  for (let at = 1; at < text.length; at += 1) {
    if (quote === '"' && text[at] === '\\') { at += 1; continue; }
    if (text[at] === quote) {
      if (quote === "'" && text[at + 1] === "'") { at += 1; continue; }
      return at;
    }
  }
  return -1;
}

function unescapeDouble(body: string): string {
  return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, code: string) => {
    if (code.length > 1) return String.fromCharCode(parseInt(code.slice(1), 16));
    switch (code) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '0': return '\0';
      default: return code;
    }
  });
}

/** `[a, "b, c", [d]]` and `{k: v}`, nested. */
function parseFlow(text: string): YamlValue {
  let at = 0;
  const space = () => { while (at < text.length && /\s/.test(text[at]!)) at += 1; };
  const value = (stops: string): YamlValue => {
    space();
    const ch = text[at];
    if (ch === '[') {
      at += 1;
      const out: YamlValue[] = [];
      for (;;) {
        space();
        if (at >= text.length) return out;
        if (text[at] === ']') { at += 1; return out; }
        if (text[at] === ',') { at += 1; continue; }
        out.push(value(',]'));
      }
    }
    if (ch === '{') {
      at += 1;
      const out: { [key: string]: YamlValue } = {};
      for (;;) {
        space();
        if (at >= text.length) return out;
        if (text[at] === '}') { at += 1; return out; }
        if (text[at] === ',') { at += 1; continue; }
        const key = String(value(':,}') ?? '');
        space();
        if (text[at] === ':') { at += 1; out[key] = value(',}'); } else out[key] = null;
      }
    }
    if (ch === '"' || ch === "'") {
      const end = findClosing(text.slice(at), ch);
      const piece = end < 0 ? text.slice(at) : text.slice(at, at + end + 1);
      at += piece.length;
      return scalar(piece);
    }
    const start = at;
    while (at < text.length) {
      const c = text[at]!;
      if (stops.includes(c) && (c !== ':' || at + 1 >= text.length || /[\s,}\]]/.test(text[at + 1]!))) break;
      if ((c === ']' || c === '}') && !stops.includes(c)) break;
      at += 1;
    }
    return scalar(text.slice(start, at));
  };
  return value('');
}
