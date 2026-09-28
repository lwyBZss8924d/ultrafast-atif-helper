import * as fs from 'node:fs';
import { decideCall } from '../compact.js';
import { boundedInteger, canonical, fail, openSource, parseJson, pathFromUri, readRange, select, sha256, verifyOpen } from './io.js';
import { hasObject, NATIVE_KEYS, object, recordId, relationsOf, textOf } from './normalize.js';
import { MAX_BYTES, MAX_RECORDS } from './types.js';
import type { Evidence, RecordMetadata } from './types.js';

const RECORD_KEYS = ['record_id', 'client', 'kind', 'timestamp', 'native', 'source', 'identity_evidence', 'labels', 'text_available'];
const OPTIONAL_KEYS = ['logical', 'relay', 'atif', 'atif_identity_evidence', 'native_actor', 'native_actor_evidence'];
export function validateRecord(value: unknown): RecordMetadata {
  if (!hasObject(value) || Object.keys(value).some(key => !RECORD_KEYS.includes(key) && !OPTIONAL_KEYS.includes(key) && !['task_id', 'project_id'].includes(key))) fail('invalid_metadata', 'Expected a body-free normalized record');
  if (!RECORD_KEYS.every(key => Object.hasOwn(value, key))) fail('invalid_metadata', 'Normalized record fields are missing');
  const record = value as unknown as RecordMetadata;
  if (!['codex', 'claude', 'pi', 'atif'].includes(record.client) || typeof record.kind !== 'string' ||
      typeof record.text_available !== 'boolean' || !Array.isArray(record.labels) ||
      record.labels.length > 32 || record.labels.some(label => typeof label !== 'string' || label.length > 128) ||
      !hasObject(record.native) || !hasObject(record.source) || !hasObject(record.identity_evidence)) fail('invalid_metadata', 'Invalid normalized metadata shape');
  if (Object.keys(record.native).length !== NATIVE_KEYS.length || NATIVE_KEYS.some(key => !Object.hasOwn(record.native, key))) fail('invalid_metadata', 'Native identity fields do not match the protocol');
  for (const key of NATIVE_KEYS) {
    const item = record.native[key];
    if (item !== null && (key === 'step_id' ? typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1 :
      typeof item !== 'string' || item.length === 0 || item.length > 512)) fail('invalid_metadata', 'Invalid native identity scalar type');
    if (item !== null && !record.identity_evidence[key]) fail('invalid_metadata', 'Native identity lacks bounded source evidence');
  }
  if (Object.keys(record.identity_evidence).some(key => !NATIVE_KEYS.includes(key as typeof NATIVE_KEYS[number]))) fail('invalid_metadata', 'Unknown identity evidence field');
  const range = (item: Evidence): void => {
    if (!hasObject(item) || typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256) || typeof item.json_pointer !== 'string') fail('invalid_metadata', 'Invalid source range digest or selector');
    boundedInteger(item.offset, 0, Number.MAX_SAFE_INTEGER, 'source offset');
    boundedInteger(item.length, 1, MAX_BYTES, 'source length');
  };
  range(record.source);
  for (const item of Object.values(record.identity_evidence)) range(item);
  if (record.source.format !== record.client || typeof record.source.uri !== 'string') fail('invalid_metadata', 'Source format or URI mismatch');
  for (const name of ['logical', 'relay']) {
    if (!Object.hasOwn(value, name)) continue;
    const optional = value[name];
    const keys = name === 'logical' ? ['event_id', 'task_id', 'run_id', 'project_id'] :
      ['event_uuid', 'parent_scope_uuid', 'propagation_root_uuid', 'atof_version', 'name'];
    if (!hasObject(optional) || Object.keys(optional).length !== keys.length || keys.some(key => !Object.hasOwn(optional, key)) ||
        Object.values(optional).some(item => item !== null && (typeof item !== 'string' || item.length === 0 || item.length > 512))) fail('invalid_metadata', 'Invalid optional logical or Relay metadata');
  }
  if (record.atif !== undefined) {
    if (!hasObject(record.atif) || Object.keys(record.atif).sort().join(',') !== 'session_id,step_id,trajectory_id' ||
        !hasObject(record.atif_identity_evidence)) fail('invalid_metadata', 'Invalid ATIF identity namespace');
    for (const key of ['session_id', 'trajectory_id', 'step_id'] as const) {
      const value = record.atif[key];
      if (value !== null && (key === 'step_id' ? typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 :
        typeof value !== 'string' || value.length === 0 || value.length > 512)) fail('invalid_metadata', 'Invalid ATIF identity scalar');
      if (value !== null && !record.atif_identity_evidence[key]) fail('invalid_metadata', 'ATIF identity lacks source evidence');
    }
    for (const [key, item] of Object.entries(record.atif_identity_evidence)) {
      if (!['session_id', 'trajectory_id', 'step_id'].includes(key)) fail('invalid_metadata', 'Unknown ATIF identity evidence field');
      range(item);
    }
  } else if (record.atif_identity_evidence !== undefined) fail('invalid_metadata', 'ATIF evidence has no namespace');
  if (record.native_actor !== undefined) {
    const actor = record.native_actor;
    if (!hasObject(actor) || Object.keys(actor).sort().join(',') !== 'client,provenance_ref,roles,session_ref' ||
        typeof actor.client !== 'string' || actor.client.length === 0 || actor.client.length > 512 ||
        typeof actor.session_ref !== 'string' || actor.session_ref.length === 0 || actor.session_ref.length > 512 ||
        !Array.isArray(actor.roles) || actor.roles.length < 1 || actor.roles.length > 32 ||
        actor.roles.some(role => typeof role !== 'string' || role.length === 0 || role.length > 512) ||
        !actor.roles.includes('primary_actor') || !hasObject(actor.provenance_ref) ||
        Object.keys(actor.provenance_ref).sort().join(',') !== 'json_pointer,record_id,sha256,uri' ||
        !Object.values(actor.provenance_ref).every(value => typeof value === 'string') ||
        !/^[0-9a-f]{64}$/.test(actor.provenance_ref.sha256) || !hasObject(record.native_actor_evidence) ||
        Object.keys(record.native_actor_evidence).sort().join(',') !== 'client,provenance_ref,roles,session_ref') fail('invalid_metadata', 'Native actor requires explicit client, role and provenance');
    for (const item of Object.values(record.native_actor_evidence)) range(item);
  } else if (record.native_actor_evidence !== undefined) fail('invalid_metadata', 'Native actor evidence has no actor');
  if (record.client === 'atif' && Object.values(record.native).some(value => value !== null) && !record.native_actor) fail('invalid_metadata', 'ATIF identities cannot be treated as client-native identities');
  const core = Object.fromEntries([...RECORD_KEYS, ...OPTIONAL_KEYS.filter(key => Object.hasOwn(value, key))].map(key => [key, value[key]])) as unknown as RecordMetadata;
  if (recordId(core) !== record.record_id) fail('metadata_changed', 'Normalized record content does not match its generated identity');
  return record;
}
export function recordsFrom(value: unknown): RecordMetadata[] {
  const data = Array.isArray(value) ? value : hasObject(value) && Array.isArray(value.records) ? value.records : [value];
  if (data.length > MAX_RECORDS) fail('record_budget', 'Metadata record budget exceeded');
  return data.map(validateRecord);
}

const FILTERS = ['record_id', 'client', 'kind', 'task_id', 'project_id', 'source.version',
  'logical.task_id', 'logical.event_id', 'logical.run_id', 'logical.project_id', 'relay.event_uuid',
  'atif.session_id', 'atif.trajectory_id', 'atif.step_id', 'native_actor.client', 'native_client',
  ...NATIVE_KEYS.map(key => 'native.' + key)];
export function query(records: readonly RecordMetadata[], filters: Record<string, unknown>, fields: readonly string[], limit = 100, offset = 0): Record<string, unknown> {
  boundedInteger(limit, 1, MAX_RECORDS, 'limit'); boundedInteger(offset, 0, 100000, 'offset');
  if (records.length > MAX_RECORDS) fail('record_budget', 'Metadata record budget exceeded');
  if (!hasObject(filters)) fail('invalid_filter', 'Filters must be an object');
  for (const [name, value] of Object.entries(filters)) {
    if (!FILTERS.includes(name)) fail('invalid_filter', 'Unknown exact metadata filter');
    if (name === 'native.step_id' || name === 'atif.step_id') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail('invalid_filter', 'Step filter requires a positive integer');
    } else if (name === 'source.version') {
      if (!(value === null || typeof value === 'string' && value.length > 0 ||
            typeof value === 'number' && Number.isSafeInteger(value))) fail('invalid_filter', 'Version filter must preserve a declared scalar type');
    } else if (typeof value !== 'string' || value.length === 0) fail('invalid_filter', 'Identity filters require nonempty strings');
  }
  if (fields.length < 1 || fields.length > 32 || new Set(fields).size !== fields.length ||
      fields.some(field => typeof field !== 'string' || !field.startsWith('/') || field.length > 256)) fail('invalid_fields', 'Select one to thirty-two explicit JSON Pointer fields');
  const seen = new Map<string, string>();
  const selected: RecordMetadata[] = [];
  for (const candidate of records) {
    const record = validateRecord(candidate);
    const encoded = canonical(record);
    if (seen.has(record.record_id)) {
      if (seen.get(record.record_id) !== encoded) fail('metadata_conflict', 'Conflicting normalized metadata identity');
      continue;
    }
    seen.set(record.record_id, encoded);
    if (Object.entries(filters).every(([name, value]) => {
      if (name === 'native_client') return (record.client === 'atif' ? record.native_actor?.client ?? null : record.client) === value;
      try { return canonical(select(record, '/' + name.replace(/\./g, '/'))) === canonical(value); }
      catch { return false; }
    })) selected.push(record);
  }
  const items = selected.slice(offset, offset + limit).map(record =>
    Object.fromEntries(fields.map(field => [field, select(record, field)])));
  return { schema_version: 'ultrafast-atif.query.v1', matched: selected.length, offset, limit,
    next_offset: offset + items.length < selected.length ? offset + items.length : null,
    records: items, sources_opened: false };
}

interface ReadCache { entries: Map<string, { bytes: Buffer; parsed: unknown }>; bytes: number; }
function selectVerified(recordValue: unknown, roots: readonly string[], maxBytes: number,
  cache: ReadCache): { bytes: Buffer; value: unknown } {
  const record = validateRecord(recordValue);
  boundedInteger(maxBytes, 1, MAX_BYTES, 'max-bytes');
  const file = pathFromUri(record.source.uri);
  const source = openSource(file, roots);
  let total = 0;
  const read = (range: Evidence): { bytes: Buffer; parsed: unknown } => {
    const key = canonical([record.source.uri, range.offset, range.length, range.sha256,
      source.stat.dev.toString(), source.stat.ino.toString(), source.stat.mtimeNs.toString(), source.stat.ctimeNs.toString(), source.stat.size.toString()]);
    let item = cache.entries.get(key);
    if (!item) {
      total += range.length;
      if (total > maxBytes || cache.bytes + range.length > MAX_BYTES) fail('byte_budget', 'Source and identity evidence exceed retrieval budget');
      const bytes = readRange(source, range.offset, range.length);
      if (sha256(bytes) !== range.sha256) fail('source_stale', 'Selected source bytes no longer match the recorded digest');
      item = { bytes, parsed: parseJson(bytes) };
      cache.entries.set(key, item);
      cache.bytes += range.length;
    }
    return item;
  };
  try {
    const item = read(record.source);
    for (const [key, range] of Object.entries(record.identity_evidence)) {
      const proof = read(range);
      if (canonical(select(proof.parsed, range.json_pointer)) !== canonical(record.native[key as keyof typeof record.native])) fail('identity_mismatch', 'Native identity does not match its selected source scalar');
    }
    for (const [key, range] of Object.entries(record.atif_identity_evidence ?? {})) {
      const proof = read(range);
      if (canonical(select(proof.parsed, range.json_pointer)) !== canonical(record.atif![key as keyof NonNullable<RecordMetadata['atif']>])) fail('identity_mismatch', 'ATIF identity does not match its exact source scalar');
    }
    for (const [key, range] of Object.entries(record.native_actor_evidence ?? {})) {
      const proof = read(range);
      if (canonical(select(proof.parsed, range.json_pointer)) !== canonical(record.native_actor![key as keyof NonNullable<RecordMetadata['native_actor']>])) fail('identity_mismatch', 'Native actor declaration does not match its exact source value');
    }
    const value = select(item.parsed, record.source.json_pointer);
    verifyOpen(source);
    return { bytes: item.bytes, value };
  } finally { fs.closeSync(source.fd); }
}
export function verifiedSelection(recordValue: unknown, roots: readonly string[], maxBytes = MAX_BYTES): { bytes: Buffer; value: unknown } {
  return selectVerified(recordValue, roots, maxBytes, { entries: new Map(), bytes: 0 });
}
export function redact(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,})\b/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|password|access[_-]?token)\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1[REDACTED]');
}
export function retrieve(record: RecordMetadata, roots: readonly string[], options: { includeBody?: boolean; maxChars?: number; maxBytes?: number } = {}): Record<string, unknown> {
  const selected = verifiedSelection(record, roots, options.maxBytes);
  const result: Record<string, unknown> = { schema_version: 'ultrafast-atif.retrieval.v1', record_id: record.record_id,
    source: record.source, source_verified: true, identity_verified: true,
    identity_verification_scope: 'selected_source_values_only', referenced_provenance_followed: false,
    body_included: options.includeBody === true };
  if (options.includeBody) {
    const max = boundedInteger(options.maxChars ?? 4096, 1, 64000, 'max-chars');
    const text = redact(textOf(selected.value, record.client));
    result.text = text.slice(0, max);
    result.truncated = text.length > max;
    result.redaction = 'bounded_pattern_redaction_not_a_complete_secret_classifier';
  }
  return result;
}

export interface PackOptions {
  allowRoots: readonly string[];
  keepIds?: readonly string[];
  recent?: number;
  scores?: Record<string, { keepCall: number; keepResult: number }>;
  threshold?: number;
  maxChars?: number;
  includeBody?: boolean;
}
export function contextPack(records: readonly RecordMetadata[], options: PackOptions): Record<string, unknown> {
  if (records.length > MAX_RECORDS) fail('record_budget', 'Context view record budget exceeded');
  const recent = boundedInteger(options.recent ?? 6, 0, MAX_RECORDS, 'recent');
  const maxChars = boundedInteger(options.maxChars ?? 64000, 1, MAX_BYTES, 'max-chars');
  const threshold = options.threshold ?? 0.5;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) fail('invalid_score', 'Threshold must be within zero and one');
  if (new Set(records.map(record => record.record_id)).size !== records.length) fail('duplicate_record', 'Context view record identities must be unique');
  const cache: ReadCache = { entries: new Map(), bytes: 0 };
  const rows = records.map((record, index) => {
    const selected = selectVerified(record, options.allowRoots, MAX_BYTES, cache);
    const relation = record.client === 'atif' && record.kind !== 'step'
      ? { calls: [], results: [], protectedText: true } : relationsOf(selected.value, record.client);
    const nativeScopeKnown = record.client === 'atif' || record.native.session_id !== null &&
      (record.client !== 'codex' || record.native.turn_id !== null);
    return { record, relation, text: redact(textOf(selected.value, record.client)), index, nativeScopeKnown,
      pinned: index === 0 || index >= records.length - recent ||
        (options.keepIds ?? []).includes(record.record_id) || record.labels.includes('protected_text') ||
        relation.protectedText };
  });
  const groups = new Map<string, { calls: Set<number>; results: Set<number> }>();
  for (const row of rows) {
    const prefix = row.record.client === 'atif'
      ? canonical(['atif', row.record.source.uri, row.record.source.sha256,
        row.record.source.json_pointer.split('/steps/')[0], row.record.atif?.trajectory_id ?? null])
      : canonical([row.record.client, row.record.source.uri, row.record.native.session_id, row.record.native.turn_id]);
    for (const [ids, side] of [[row.relation.calls, 'calls'], [row.relation.results, 'results']] as const) {
      for (const callId of ids) {
        const key = prefix + ':' + callId;
        const group = groups.get(key) ?? { calls: new Set<number>(), results: new Set<number>() };
        group[side].add(row.index); groups.set(key, group);
      }
    }
  }
  const omitted = new Set<number>();
  const truncate = new Set<number>();
  const omissions: string[] = [];
  const decisions: Record<string, unknown>[] = [];
  const branchDescendsFrom = (resultIndex: number, callIndex: number): boolean => {
    const call = rows[callIndex]!.record;
    if (call.client !== 'claude' && call.client !== 'pi') return true;
    const target = call.native.entry_id;
    let cursor = rows[resultIndex]!.record.native.parent_entry_id;
    if (typeof target !== 'string' || typeof cursor !== 'string') return false;
    const visited = new Set<string>();
    while (typeof cursor === 'string' && !visited.has(cursor)) {
      if (cursor === target) return true;
      visited.add(cursor);
      const parents = rows.filter(row => row.record.client === call.client &&
        row.record.source.uri === call.source.uri &&
        row.record.native.session_id === call.native.session_id &&
        row.record.native.entry_id === cursor);
      if (parents.length !== 1) return false;
      cursor = parents[0]!.record.native.parent_entry_id;
    }
    return false;
  };
  for (const [key, group] of groups) {
    const indices = [...new Set([...group.calls, ...group.results])];
    const complete = group.calls.size === 1 && group.results.size >= 1 &&
      indices.every(index => rows[index]!.nativeScopeKnown) &&
      [...group.results].every(index => branchDescendsFrom(index, [...group.calls][0]!));
    const pinned = !complete || indices.some(index => rows[index]!.pinned ||
      rows[index]!.relation.calls.length + rows[index]!.relation.results.length > 1);
    if (!complete) omissions.push('An unmatched or ambiguous tool pair was preserved; source-window pair coverage is incomplete.');
    const score = options.scores?.[key] ?? { keepCall: 1, keepResult: 1 };
    if (![score.keepCall, score.keepResult].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)) fail('invalid_score', 'Retention inputs must be finite probabilities');
    const decision = decideCall({ id: key, tool: 'source_tool_pair', pinned }, score, { keepThreshold: threshold });
    decisions.push({ pair_id: key, action: decision.action, reason: decision.reason, record_ids: indices.map(index => rows[index]!.record.record_id) });
    if (decision.action === 'drop_call') indices.forEach(index => omitted.add(index));
    if (decision.action === 'drop_result') group.results.forEach(index => truncate.add(index));
  }
  for (const key of Object.keys(options.scores ?? {})) if (!groups.has(key)) fail('invalid_score', 'Retention score refers to an unknown pair');
  const kept = rows.filter(row => !omitted.has(row.index));
  const chars = kept.reduce((sum, row) => sum + (truncate.has(row.index) ? Math.min(300, row.text.length) : row.text.length), 0);
  if (chars > maxChars) fail('protected_budget', 'Selected context exceeds its budget; protected text was not silently dropped');
  return { schema_version: 'ultrafast-atif.context-pack.v1', model_called: false, original_sources_rewritten: false,
    source_records: rows.length, omitted_records: omitted.size, selected_characters: chars,
    pairs_complete: omissions.length === 0, omissions: [...new Set(omissions)], decisions,
    records: kept.map(row => ({ record: row.record, view: truncate.has(row.index) ? 'truncated_head' : 'verbatim',
      ...(options.includeBody ? { text: truncate.has(row.index) ? row.text.slice(0, 300) : row.text } : {}) })),
    body_included: options.includeBody === true };
}
