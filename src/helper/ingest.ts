import * as fs from 'node:fs';
import { boundedInteger, fail, openSource, parseJson, readRange, sha256, verifyOpen } from './io.js';
import { atifRecords, declaredVersion, jsonlRecord, object } from './normalize.js';
import type { Context } from './normalize.js';
import { MAX_BYTES, MAX_RECORDS } from './types.js';
import type { Page, ReadOptions, SourceRef } from './types.js';

export function ingest(options: ReadOptions): Page {
  if (!['codex', 'claude', 'pi', 'atif'].includes(options.format)) fail('unsupported_format', 'Unsupported source format');
  const offset = boundedInteger(options.offset ?? 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
  const limit = boundedInteger(options.limit ?? 100, 1, MAX_RECORDS, 'limit');
  const maxBytes = boundedInteger(options.maxBytes ?? 1024 * 1024, 1, MAX_BYTES, 'max-bytes');
  const source = openSource(options.input, options.allowRoots);
  try {
    if (options.expectedState !== undefined) {
      const expected = options.expectedState;
      if (expected === null || typeof expected !== 'object' || typeof expected.dev !== 'string' ||
          typeof expected.ino !== 'string' || !/^\d{1,40}$/.test(expected.dev) || !/^\d{1,40}$/.test(expected.ino)) fail('invalid_state', 'Expected source state requires bounded device and inode identities');
      boundedInteger(expected.size, 0, Number.MAX_SAFE_INTEGER, 'expected size');
      if (expected.dev !== source.stat.dev.toString() || expected.ino !== source.stat.ino.toString() || source.size < expected.size) fail('source_changed', 'Source was rotated or truncated since the expected state');
      const anchor = expected.cursor_anchor;
      if (anchor !== undefined && anchor !== null) {
        boundedInteger(anchor.offset, 0, Number.MAX_SAFE_INTEGER, 'anchor offset');
        boundedInteger(anchor.length, 1, 256, 'anchor length');
        if (anchor.offset + anchor.length > offset || typeof anchor.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(anchor.sha256)) fail('invalid_state', 'Cursor anchor must precede the selected resume offset');
        if (sha256(readRange(source, anchor.offset, anchor.length)) !== anchor.sha256) fail('source_changed', 'Cursor anchor bytes changed since the expected state');
      }
    }
    if (offset > source.size) fail('source_truncated', 'Cursor exceeds observed file size');
    if (options.format === 'atif' && offset !== 0) fail('invalid_cursor', 'ATIF ingest requires a whole-document offset of zero');
    if (options.format === 'atif' && source.size > maxBytes) fail('byte_budget', 'ATIF document exceeds byte budget');
    if (offset > 0 && readRange(source, offset - 1, 1)[0] !== 10) fail('invalid_cursor', 'JSONL cursor must follow a complete newline');
    const bytes = readRange(source, offset, Math.min(source.size - offset, maxBytes));
    const page: Page = {
      schema_version: 'ultrafast-atif.page.v1', records: [], next_offset: null,
      eof: false, incomplete_tail: false, omissions: [],
      source_state: { dev: source.stat.dev.toString(), ino: source.stat.ino.toString(), size: source.size,
        mtime_ns: source.stat.mtimeNs.toString(), window_start: offset, window_end: offset,
        declared_version: null, cursor_anchor: null,
        continuation: options.expectedState ? 'verified_expected_state' : offset === 0 ? 'initial' : 'unverified_offset' },
    };
    const ref = (start: number, body: Buffer, pointer = ''): SourceRef => ({
      uri: source.uri, format: options.format, version: null, offset: start,
      length: body.length, sha256: sha256(body), json_pointer: pointer,
    });
    if (options.format === 'atif') {
      const document = parseJson(bytes);
      page.source_state.declared_version = declaredVersion(object(document).schema_version);
      page.records = atifRecords(document, ref(0, bytes), limit);
      page.eof = true;
      page.source_state.window_end = source.size;
      page.omissions.push('Structural normalization only; original version, bytes and unknown extras remain authoritative.');
    } else {
      const context: Context = { version: null };
      if (offset > 0) {
        page.omissions.push('Resumed window has no inherited native context; only identities observed within this page are assigned.');
        if (!options.expectedState) page.omissions.push('Offset-only continuation does not verify prior file identity; use expected-state or an independently verified caller lease.');
      }
      let consumed = 0;
      while (consumed < bytes.length && page.records.length < limit) {
        const newline = bytes.indexOf(10, consumed);
        if (newline < 0) break;
        const line = bytes.subarray(consumed, newline + 1);
        if (line.toString('utf8').trim().length === 0) fail('invalid_record', 'Blank JSONL records are unsupported');
        page.records.push(jsonlRecord(parseJson(line), ref(offset + consumed, line), context));
        consumed = newline + 1;
      }
      const physicalEnd = offset + bytes.length === source.size;
      const remainder = consumed < bytes.length;
      page.incomplete_tail = remainder && bytes.indexOf(10, consumed) < 0;
      page.eof = physicalEnd && (consumed === bytes.length || page.incomplete_tail);
      page.next_offset = page.eof && !page.incomplete_tail ? null : offset + consumed;
      page.source_state.window_end = offset + consumed;
      page.source_state.declared_version = context.version;
      if (page.incomplete_tail) page.omissions.push('A JSONL record is incomplete at the selected byte cutoff; no partial record was imported.');
      if (page.records.length === limit && remainder) page.omissions.push('Record limit reached; continue at next_offset.');
      if (!physicalEnd && page.records.length < limit) page.omissions.push('Byte window reached; incomplete trailing bytes were left for the next read.');
    }
    const consumed = page.source_state.window_end - offset;
    if (consumed > 0) {
      const length = Math.min(consumed, 256);
      page.source_state.cursor_anchor = { offset: page.source_state.window_end - length, length,
        sha256: sha256(bytes.subarray(consumed - length, consumed)) };
    }
    verifyOpen(source);
    return page;
  } finally { fs.closeSync(source.fd); }
}

export function inspect(options: ReadOptions): Record<string, unknown> {
  if (!['codex', 'claude', 'pi', 'atif'].includes(options.format)) fail('unsupported_format', 'Unsupported source format');
  const source = openSource(options.input, options.allowRoots);
  try {
    const max = boundedInteger(options.maxBytes ?? 1024 * 1024, 1, MAX_BYTES, 'max-bytes');
    if (source.size > max && options.format === 'atif') fail('byte_budget', 'Whole ATIF inspection exceeds byte budget');
    const bytes = readRange(source, 0, Math.min(source.size, max));
    const firstLine = options.format === 'atif' ? bytes : bytes.subarray(0, Math.max(0, bytes.indexOf(10) + 1));
    if (firstLine.length === 0) fail('incomplete_tail', 'No complete source record is available for inspection');
    const value = object(parseJson(firstLine));
    const version = declaredVersion(options.format === 'atif' ? value.schema_version : value.version ?? value.schema_version);
    const supported = options.format !== 'atif' || version === 'ATIF-v1.7' || version === 'ATIF-v1.8';
    verifyOpen(source);
    return {
      schema_version: 'ultrafast-atif.inspection.v1', format: options.format,
      declared_version: version, supported_for_ingest: supported,
      source_bytes: source.size, inspected_bytes: firstLine.length,
      inspected_sha256: sha256(firstLine),
      unknown_extra_keys: Object.keys(object(value.extra)).slice(0, 32),
      plan: supported ? 'Preserve source version and bytes; normalize a separate metadata view.' :
        'Unsupported or missing version: retain opaque source and prepare an owner-reviewed adapter; no relabel or conversion.',
      converted: false, full_schema_validation: false,
    };
  } finally { fs.closeSync(source.fd); }
}
