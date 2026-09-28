import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HelperError, MAX_BYTES } from './types.js';

export function fail(code: string, message: string): never { throw new HelperError(code, message); }
export function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('invalid_argument', label + ' is outside its integer bounds');
  return value;
}
export function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('invalid_json', 'Non-finite JSON number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>;
    return '{' + Object.keys(object).sort().map(key => JSON.stringify(key) + ':' + canonical(object[key])).join(',') + '}';
  }
  return fail('invalid_json', 'Unsupported JSON value');
}
export function utf8(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return fail('invalid_utf8', 'Source is not valid UTF-8'); }
}

/** JSON.parse supplies values; the scanner rejects duplicate keys and excessive depth first. */
export function parseJson(bytes: Uint8Array | string): unknown {
  const text = typeof bytes === 'string' ? bytes : utf8(bytes);
  let at = 0;
  let nodes = 0;
  const space = (): void => { while (at < text.length && /[ \t\r\n]/.test(text[at]!)) at++; };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const char = text[at++]!;
      if (char === '\\') at++;
      else if (char === '"') return JSON.parse(text.slice(start, at)) as string;
    }
    return fail('invalid_json', 'Unterminated JSON string');
  };
  const value = (depth: number): void => {
    if (depth > 64 || ++nodes > 200000) fail('json_budget', 'JSON nesting or node budget exceeded');
    space();
    if (text[at] === '"') { string(); return; }
    if (text[at] === '{') {
      at++; space();
      const keys = new Set<string>();
      if (text[at] === '}') { at++; return; }
      while (at < text.length) {
        space();
        if (text[at] !== '"') fail('invalid_json', 'Expected JSON object key');
        const key = string();
        if (keys.has(key)) fail('duplicate_key', 'Duplicate JSON object key');
        keys.add(key); space();
        if (text[at++] !== ':') fail('invalid_json', 'Expected JSON key separator');
        value(depth + 1); space();
        const next = text[at++];
        if (next === '}') return;
        if (next !== ',') fail('invalid_json', 'Expected JSON object separator');
      }
    } else if (text[at] === '[') {
      at++; space();
      if (text[at] === ']') { at++; return; }
      while (at < text.length) {
        value(depth + 1); space();
        const next = text[at++];
        if (next === ']') return;
        if (next !== ',') fail('invalid_json', 'Expected JSON array separator');
      }
    } else {
      const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));
      if (!token) fail('invalid_json', 'Invalid JSON value');
      at += token[0].length;
      return;
    }
    fail('invalid_json', 'Incomplete JSON value');
  };
  try {
    value(0); space();
    if (at !== text.length) fail('invalid_json', 'Trailing JSON data');
    const parsed: unknown = JSON.parse(text);
    canonical(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof HelperError) throw error;
    return fail('invalid_json', 'Invalid JSON source');
  }
}

function safeName(file: string): void {
  for (const part of file.split(path.sep)) {
    const name = part.toLowerCase();
    if (['auth.json', '.ssh', '.aws', '.gnupg', 'keychains', 'credentials', 'credentials.json'].includes(name) ||
        name === '.env' || name.startsWith('.env.') ||
        /(^|[._-])(token|secret|password)([._-]|$)/.test(name) ||
        /^(id_rsa|id_ed25519|id_ecdsa)/.test(name) ||
        /\.(pem|key|keychain|keychain-db)$/.test(name)) fail('credential_path', 'Credential-like source paths are forbidden');
  }
}
function noSymlinks(file: string): void {
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) fail('symlink', 'Symlink paths are forbidden');
  }
}
export function safePath(file: string, roots: readonly string[]): string {
  if (!path.isAbsolute(file) || file !== path.resolve(file) || file.startsWith('//') || file.includes('\0')) fail('invalid_path', 'Use an exact absolute canonical path');
  safeName(file);
  if (roots.length === 0 || roots.length > 16) fail('allow_root', 'One to sixteen explicit source roots are required');
  let allowed = false;
  for (const root of roots) {
    if (!path.isAbsolute(root) || root !== path.resolve(root)) fail('allow_root', 'Source roots must be canonical absolute paths');
    noSymlinks(root);
    if (!fs.statSync(root).isDirectory() || fs.realpathSync(root) !== root) fail('allow_root', 'Source root is not a canonical directory');
    const relative = path.relative(root, file);
    if (relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) allowed = true;
  }
  if (!allowed) fail('allow_root', 'Source is outside the explicitly allowed roots');
  noSymlinks(file);
  if (fs.realpathSync(file) !== file) fail('symlink', 'Canonical source path mismatch');
  return file;
}
export interface OpenSource { path: string; uri: string; fd: number; stat: fs.BigIntStats; size: number; }
export function openSource(file: string, roots: readonly string[]): OpenSource {
  safePath(file, roots);
  if (fs.constants.O_NOFOLLOW === undefined || fs.constants.O_NONBLOCK === undefined) fail('unsupported_platform', 'Safe no-follow/nonblocking source access is unavailable');
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile()) fail('not_regular', 'Source must be a regular file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino ||
        stat.size > BigInt(Number.MAX_SAFE_INTEGER) || fs.realpathSync(file) !== file) fail('source_changed', 'Source identity changed before reading');
    return { path: file, uri: pathToFileURL(file).href, fd, stat, size: Number(stat.size) };
  } catch (error) { fs.closeSync(fd); throw error; }
}
export function verifyOpen(source: OpenSource): void {
  const current = fs.lstatSync(source.path, { bigint: true });
  const opened = fs.fstatSync(source.fd, { bigint: true });
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== source.stat.dev ||
      current.ino !== source.stat.ino || opened.size < source.stat.size ||
      (opened.size === source.stat.size && opened.mtimeNs !== source.stat.mtimeNs) ||
      fs.realpathSync(source.path) !== source.path) fail('source_changed', 'Source was replaced, truncated, or changed during reading');
}
export function readRange(source: OpenSource, offset: number, length: number): Buffer {
  boundedInteger(offset, 0, Number.MAX_SAFE_INTEGER, 'offset');
  boundedInteger(length, 0, MAX_BYTES, 'length');
  if (offset + length > source.size) fail('source_truncated', 'Selected byte range exceeds observed source size');
  const bytes = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const amount = fs.readSync(source.fd, bytes, read, length - read, offset + read);
    if (amount === 0) fail('source_changed', 'Source ended inside the selected byte range');
    read += amount;
  }
  return bytes;
}
export function pathFromUri(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'file:' || url.host || url.search || url.hash) fail('invalid_uri', 'Only exact local file URIs are accepted');
    return fileURLToPath(url);
  } catch (error) {
    if (error instanceof HelperError) throw error;
    return fail('invalid_uri', 'Invalid local source URI');
  }
}
export function select(value: unknown, pointer: string): unknown {
  if (pointer.length > 2048 || !/^(?:\/(?:[^~\/]|~[01])*)*$/.test(pointer)) fail('invalid_selector', 'Invalid JSON Pointer');
  let current = value;
  for (const part of pointer ? pointer.slice(1).split('/') : []) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= current.length) fail('missing_selector', 'JSON Pointer does not resolve');
      current = current[Number(key)];
    } else if (typeof current === 'object' && current !== null && Object.hasOwn(current, key)) current = (current as Record<string, unknown>)[key];
    else fail('missing_selector', 'JSON Pointer does not resolve');
  }
  return current;
}
export function readMetadata(file: string, roots: readonly string[], maxBytes = MAX_BYTES): unknown {
  const source = openSource(file, roots);
  try {
    if (source.size > boundedInteger(maxBytes, 1, MAX_BYTES, 'max-bytes')) fail('byte_budget', 'Metadata file exceeds byte budget');
    const value = parseJson(readRange(source, 0, source.size));
    verifyOpen(source);
    return value;
  } finally { fs.closeSync(source.fd); }
}
export function writeNew(file: string, roots: readonly string[], bytes: Uint8Array): void {
  if (!path.isAbsolute(file) || file !== path.resolve(file)) fail('invalid_path', 'Output must be an explicit canonical absolute path');
  if (bytes.length > MAX_BYTES) fail('byte_budget', 'Output exceeds eight MiB');
  safeName(file);
  const parent = path.dirname(file);
  noSymlinks(parent);
  if (!roots.some(root => file.startsWith(root + path.sep)) || fs.realpathSync(parent) !== parent) fail('allow_root', 'Output is outside explicit canonical roots');
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(file, { bigint: true });
    if (!opened.isFile() || !current.isFile() || opened.ino !== current.ino || opened.dev !== current.dev || fs.realpathSync(file) !== file) fail('source_changed', 'Output path changed before writing');
    fs.writeFileSync(fd, bytes);
  } finally { fs.closeSync(fd); }
}
