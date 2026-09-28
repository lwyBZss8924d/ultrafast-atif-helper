import { canonical, fail, select, sha256 } from './io.js';
import type { ArtifactRef, Evidence, Format, NativeKey, RecordMetadata, SourceRef } from './types.js';

export const NATIVE_KEYS: NativeKey[] = ['session_id', 'turn_id', 'entry_id', 'parent_entry_id', 'trajectory_id', 'step_id'];
export type ObjectValue = Record<string, unknown>;
export function object(value: unknown): ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
}
export function hasObject(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function id(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null;
}
function stamp(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 128 && /^\d{4}-\d{2}-\d{2}T/.test(value) ? value : null;
}
function kind(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,96}$/.test(value) ? value : 'unknown';
}
export function declaredVersion(value: unknown): string | number | null {
  return (typeof value === 'string' && value.length > 0 && value.length <= 128) ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ? value as string | number : null;
}
export interface Observed { value: string | number; evidence: Evidence; }
export interface Context {
  session?: Observed;
  turn?: Observed;
  version: string | number | null;
}
export function recordId(record: Omit<RecordMetadata, 'record_id'> | RecordMetadata): string {
  const { record_id: _id, ...content } = record as RecordMetadata;
  return 'uaf1:' + sha256(Buffer.from(canonical(content)));
}
function base(source: SourceRef, eventKind: string, timestamp: unknown): RecordMetadata {
  return {
    record_id: '', client: source.format, kind: kind(eventKind), timestamp: stamp(timestamp),
    native: { session_id: null, turn_id: null, entry_id: null, parent_entry_id: null, trajectory_id: null, step_id: null },
    source, identity_evidence: {}, labels: [], text_available: false,
  };
}
function evidence(source: SourceRef, pointer: string): Evidence {
  return { offset: source.offset, length: source.length, sha256: source.sha256, json_pointer: pointer };
}
function fromPointers(value: unknown, pointers: string[]): { value: unknown; pointer: string; present: boolean } {
  for (const pointer of pointers) {
    try { return { value: select(value, pointer), pointer, present: true }; }
    catch { /* A candidate field is absent; never invent it. */ }
  }
  return { value: undefined, pointer: '', present: false };
}
function bind(record: RecordMetadata, key: NativeKey, raw: unknown, pointers: string[], fallback?: Observed): Observed | undefined {
  const found = fromPointers(raw, pointers);
  if (!found.present && fallback) {
    record.native[key] = fallback.value;
    record.identity_evidence[key] = fallback.evidence;
    record.labels.push(key + ':page_context');
    return fallback;
  }
  const valid = key === 'step_id'
    ? typeof found.value === 'number' && Number.isSafeInteger(found.value) && found.value > 0 ? found.value : null
    : id(found.value);
  if (found.present && valid !== null) {
    const observed = { value: valid, evidence: evidence(record.source, found.pointer) };
    record.native[key] = valid;
    record.identity_evidence[key] = observed.evidence;
    return observed;
  }
  record.labels.push(key + ':' + (!found.present ? 'absent' : found.value === null ? 'null' : 'invalid'));
  return undefined;
}
function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(part => {
    const block = object(part);
    if (typeof block.text === 'string') return block.text;
    if (block.type === 'tool_result') return contentText(block.content);
    if (block.type === 'tool_use' || block.type === 'toolCall') return canonical({ tool: block.name ?? null, input: block.input ?? block.arguments ?? null });
    return '';
  }).filter(Boolean).join('\n');
}
export function textOf(value: unknown, format: Format): string {
  const raw = object(value);
  if (format === 'atif') {
    const parts = [contentText(raw.message)];
    if (Array.isArray(raw.tool_calls) && raw.tool_calls.length) parts.push(canonical({ tool_calls: raw.tool_calls }));
    const results = object(raw.observation).results;
    if (Array.isArray(results)) parts.push(...results.map(result => contentText(object(result).content)));
    return parts.filter(Boolean).join('\n');
  }
  if (format === 'codex') {
    const payload = object(raw.payload);
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') return canonical({ tool: payload.name ?? null, input: payload.arguments ?? payload.input ?? null });
    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') return contentText(payload.output);
    return contentText(payload.content) || contentText(payload.message) || contentText(payload.text);
  }
  const message = object(raw.message);
  if (format === 'pi' && message.role === 'toolResult') return contentText(message.content);
  return contentText(message.content) || contentText(raw.content) || contentText(raw.text);
}
export function relationsOf(value: unknown, format: Format): { calls: string[]; results: string[]; protectedText: boolean } {
  const raw = object(value);
  const calls: string[] = [];
  const results: string[] = [];
  let blocks: unknown[] = [];
  let protectedText = false;
  if (format === 'codex') {
    const payload = object(raw.payload);
    if (['function_call', 'custom_tool_call'].includes(String(payload.type))) {
      if (id(payload.call_id)) calls.push(payload.call_id as string);
    } else if (['function_call_output', 'custom_tool_call_output'].includes(String(payload.type))) {
      if (id(payload.call_id)) results.push(payload.call_id as string);
    } else protectedText = textOf(value, format).length > 0;
  } else if (format === 'atif') {
    for (const call of Array.isArray(raw.tool_calls) ? raw.tool_calls : []) {
      const callId = object(call).tool_call_id;
      if (id(callId)) calls.push(callId as string);
    }
    const observation = object(raw.observation);
    for (const result of Array.isArray(observation.results) ? observation.results : []) {
      const callId = object(result).source_call_id;
      if (id(callId)) results.push(callId as string);
    }
    protectedText = contentText(raw.message).length > 0;
  } else {
    const message = object(raw.message);
    blocks = Array.isArray(message.content) ? message.content : Array.isArray(raw.content) ? raw.content : [];
    if (format === 'pi' && message.role === 'toolResult') {
      const callId = message.toolCallId;
      if (id(callId)) results.push(callId as string);
    }
    for (const part of blocks) {
      const block = object(part);
      if (block.type === 'tool_use' && id(block.id)) calls.push(block.id as string);
      if (block.type === 'toolCall' && id(block.id)) calls.push(block.id as string);
      if (block.type === 'tool_result' && id(block.tool_use_id)) results.push(block.tool_use_id as string);
    }
    protectedText = blocks.some(part => {
      const block = object(part);
      return typeof block.text === 'string' && block.text.length > 0;
    }) || (typeof message.content === 'string' && message.content.length > 0);
    if (format === 'pi' && message.role === 'toolResult') protectedText = false;
  }
  return { calls, results, protectedText };
}
function annotate(record: RecordMetadata, raw: unknown): void {
  const relation = relationsOf(raw, record.client);
  if (relation.calls.length) record.labels.push('tool_call');
  if (relation.results.length) record.labels.push('tool_result');
  if (relation.protectedText) record.labels.push('protected_text');
  record.text_available = textOf(raw, record.client).length > 0;
  record.record_id = recordId(record);
}
function atifIdentity(record: RecordMetadata, document: unknown, trajectoryPointer: string, stepPointer?: string): void {
  record.atif = { session_id: null, trajectory_id: null, step_id: null };
  record.atif_identity_evidence = {};
  for (const key of ['session_id', 'trajectory_id', 'step_id'] as const) {
    const pointer = key === 'step_id' ? stepPointer === undefined ? null : stepPointer + '/step_id' : trajectoryPointer + '/' + key;
    if (pointer === null) continue;
    const found = fromPointers(document, [pointer]);
    const valid = key === 'step_id' ? typeof found.value === 'number' && Number.isSafeInteger(found.value) && found.value > 0 ? found.value : null : id(found.value);
    if (valid !== null) {
      if (key === 'step_id') record.atif.step_id = valid as number;
      else record.atif[key] = valid as string;
      record.atif_identity_evidence[key] = evidence(record.source, pointer);
    } else record.labels.push('atif.' + key + ':' + (!found.present ? 'absent' : found.value === null ? 'null' : 'invalid'));
  }
}
export function jsonlRecord(raw: unknown, source: SourceRef, context: Context): RecordMetadata {
  if (!hasObject(raw)) fail('invalid_record', 'Native JSONL entries must be objects');
  const payload = object(raw.payload);
  const message = object(raw.message);
  const record = base(source, source.format === 'codex' ? kind(payload.type ?? raw.type) : kind(raw.type), raw.timestamp);
  if (source.format === 'codex') {
    if (raw.type === 'session_meta') { context.session = undefined; context.turn = undefined; }
    const sessionPointers = raw.type === 'session_meta' ? ['/payload/id'] : ['/session_id', '/payload/session_id'];
    context.session = bind(record, 'session_id', raw, sessionPointers, context.session);
    context.turn = bind(record, 'turn_id', raw, ['/turn_id', '/payload/turn_id'], context.turn);
    bind(record, 'entry_id', raw, raw.type === 'response_item' ? ['/id', '/payload/id'] : ['/id']);
    bind(record, 'parent_entry_id', raw, ['/parent_id']);
    if (payload.role === 'user' || payload.role === 'system' || payload.role === 'developer' || payload.type === 'user_message') record.labels.push('protected_text');
    if (payload.type === 'task_complete' || payload.type === 'turn_aborted') context.turn = undefined;
  } else if (source.format === 'claude') {
    context.session = bind(record, 'session_id', raw, ['/sessionId', '/session_id'], context.session);
    bind(record, 'turn_id', raw, ['/turn_id', '/turnId']);
    bind(record, 'entry_id', raw, ['/uuid']);
    bind(record, 'parent_entry_id', raw, ['/parentUuid']);
    if (message.role === 'system') record.labels.push('protected_text');
  } else {
    if (raw.type === 'session') { context.session = undefined; context.version = declaredVersion(raw.version); }
    record.source.version = context.version;
    context.session = bind(record, 'session_id', raw, raw.type === 'session' ? ['/id'] : ['/sessionId', '/session_id'], context.session);
    bind(record, 'turn_id', raw, ['/turn_id', '/turnId']);
    bind(record, 'entry_id', raw, raw.type === 'session' ? [] : ['/id']);
    bind(record, 'parent_entry_id', raw, ['/parentId']);
    if (message.role === 'user' || message.role === 'system') record.labels.push('protected_text');
  }
  record.labels = [...new Set(record.labels)];
  annotate(record, raw);
  return record;
}
export function atifRecords(document: unknown, source: SourceRef, limit: number): RecordMetadata[] {
  if (!hasObject(document)) fail('invalid_atif', 'ATIF must be a JSON object');
  const records: RecordMetadata[] = [];
  const add = (record: RecordMetadata): void => {
    record.record_id = recordId(record); records.push(record);
    if (records.length > limit) fail('record_budget', 'ATIF expansion exceeds the requested record limit; no partial import was returned');
  };
  const checkpoint = (payload: unknown, pointer: string, version: SourceRef['version'], recordPointer: string,
    trajectoryPointer: string, stepPointer?: string): RecordMetadata => {
    const data = object(payload);
    const recognized = data.schema_version === 'task-turns-checkpoint.v1' && data.event_type === 'task_turns_checkpoint';
    const record = base({ ...source, version, json_pointer: recordPointer },
      recognized ? 'task_turns_checkpoint' : 'opaque_checkpoint_extension', data.observed_at);
    atifIdentity(record, document, trajectoryPointer, stepPointer);
    record.labels.push(recognized ? 'checkpoint_metadata_schema_not_validated' : 'unsupported_checkpoint_extension');
    if (recognized) {
      record.logical = { event_id: id(data.event_id), task_id: id(object(data.task).task_id),
        run_id: id(object(data.logical_run).run_id), project_id: id(object(data.project).project_id) };
      const facets = object(data.facets);
      const sessions = Array.isArray(facets.native_sessions) ? facets.native_sessions : [];
      const primary = sessions.map((entry, index) => ({ entry: object(entry), index }))
        .filter(({ entry }) => Array.isArray(entry.roles) && entry.roles.includes('primary_actor'));
      const provenance = object(data.provenance_ref);
      let validProvenanceUri = false;
      if (typeof provenance.uri === 'string' && provenance.uri.length <= 2048) {
        try { new URL(provenance.uri); validProvenanceUri = true; } catch { /* Unknown locator stays unprojected. */ }
      }
      const hasProvenance = Object.keys(provenance).length === 4 &&
        ['record_id', 'uri', 'json_pointer', 'sha256'].every(key => typeof provenance[key] === 'string') &&
        id(provenance.record_id) !== null && validProvenanceUri && typeof provenance.sha256 === 'string' && /^[0-9a-f]{64}$/.test(provenance.sha256) &&
        typeof provenance.json_pointer === 'string' && /^(?:\/(?:[^~\/]|~[01])*)*$/.test(provenance.json_pointer);
      const actor = primary[0]?.entry;
      const hasActor = actor && id(actor.client) !== null && id(actor.session_ref) !== null &&
        Array.isArray(actor.roles) && actor.roles.length <= 32 && actor.roles.every(role => id(role) !== null);
      if (primary.length === 1 && hasActor && hasProvenance && object(primary[0]!.entry.native_session_id).status === 'observed') {
        const selected = primary[0]!;
        const actorPointer = pointer + '/facets/native_sessions/' + selected.index;
        record.native_actor = { client: selected.entry.client as string, session_ref: selected.entry.session_ref as string,
          roles: [...selected.entry.roles as string[]], provenance_ref: { ...provenance } as unknown as ArtifactRef };
        record.native_actor_evidence = { client: evidence(record.source, actorPointer + '/client'),
          session_ref: evidence(record.source, actorPointer + '/session_ref'), roles: evidence(record.source, actorPointer + '/roles'),
          provenance_ref: evidence(record.source, pointer + '/provenance_ref') };
        record.labels.push('checkpoint_provenance_reference_not_followed');
        bind(record, 'session_id', document, [pointer + '/facets/native_sessions/' + selected.index + '/native_session_id/value']);
        const turns = Array.isArray(facets.native_turns) ? facets.native_turns : [];
        const matching = turns.map((entry, index) => ({ entry: object(entry), index }))
          .filter(({ entry }) => entry.session_ref === selected.entry.session_ref && object(entry.native_turn_id).status === 'observed');
        if (matching.length === 1) bind(record, 'turn_id', document, [pointer + '/facets/native_turns/' + matching[0]!.index + '/native_turn_id/value']);
        else record.labels.push('native_turn_unavailable_or_multiple');
      } else record.labels.push('native_primary_session_unavailable_or_ambiguous');
    }
    return record;
  };
  const extensions = (owner: ObjectValue, pointer: string, version: SourceRef['version'], trajectoryPointer: string, stepPointer?: string): void => {
    const extra = object(owner.extra);
    const container = object(extra.self_harness).task_turns_checkpoint;
    if (Array.isArray(container)) container.forEach((entry, index) =>
      add(checkpoint(entry, pointer + '/extra/self_harness/task_turns_checkpoint/' + index, version,
        pointer + '/extra/self_harness/task_turns_checkpoint/' + index, trajectoryPointer, stepPointer)));
    if (Array.isArray(extra.observed_events)) {
      extra.observed_events.forEach((entry, index) => {
        const event = object(entry);
        if (event.kind !== 'mark') return;
        const markPointer = pointer + '/extra/observed_events/' + index;
        const recognized = event.atof_version === '0.1' && id(event.uuid) !== null && kind(event.name) !== 'unknown';
        const schema = object(event.data_schema);
        const isCheckpoint = recognized && event.name === 'task_turns_checkpoint' &&
          schema.name === 'self_harness.task_turns_checkpoint' && schema.version === '1';
        const record = isCheckpoint ? checkpoint(event.data, markPointer + '/data', version, markPointer, trajectoryPointer, stepPointer) :
          base({ ...source, version, json_pointer: markPointer }, recognized ? 'relay_mark' : 'opaque_relay_mark', event.timestamp);
        if (!isCheckpoint) atifIdentity(record, document, trajectoryPointer, stepPointer);
        record.labels.push(recognized ? 'relay_runtime_ids_are_not_native_session_ids' : 'unsupported_atof_profile');
        if (recognized) record.relay = { event_uuid: id(event.uuid), parent_scope_uuid: id(event.parent_uuid),
          propagation_root_uuid: id(event.propagation_root_uuid), atof_version: '0.1', name: event.name as string };
        add(record);
      });
    }
  };
  const visit = (trajectory: ObjectValue, pointer: string): void => {
    const version = declaredVersion(trajectory.schema_version);
    if (version !== null && version !== 'ATIF-v1.7' && version !== 'ATIF-v1.8') fail('unsupported_version', 'ATIF version is unsupported; inspect or plan without conversion');
    if (!Array.isArray(trajectory.steps)) fail('invalid_atif', 'ATIF steps must be an array');
    const root = base({ ...source, version, json_pointer: pointer }, 'trajectory', trajectory.timestamp);
    atifIdentity(root, document, pointer);
    root.labels.push('structural_normalization_only');
    if (Object.keys(object(trajectory.extra)).length) root.labels.push('opaque_extras_remain_source_retrievable');
    add(root);
    extensions(trajectory, pointer, version, pointer);
    const stepIds = new Set<number>();
    trajectory.steps.forEach((step, index) => {
      if (!hasObject(step) || typeof step.step_id !== 'number' || !Number.isSafeInteger(step.step_id) || step.step_id < 1 || stepIds.has(step.step_id)) fail('invalid_atif', 'ATIF step IDs must be unique positive integers within their trajectory');
      stepIds.add(step.step_id);
      const stepPointer = pointer + '/steps/' + index;
      const record = base({ ...source, version, json_pointer: stepPointer }, 'step', step.timestamp);
      atifIdentity(record, document, pointer, stepPointer);
      if (step.source === 'user' || step.source === 'system') record.labels.push('protected_text');
      annotate(record, step);
      add(record);
      extensions(step, stepPointer, version, pointer, stepPointer);
    });
    if (records.length > limit) fail('record_budget', 'ATIF expansion exceeds the requested record limit; no partial import was returned');
    if (trajectory.subagent_trajectories !== undefined && trajectory.subagent_trajectories !== null) {
      if (!Array.isArray(trajectory.subagent_trajectories)) fail('invalid_atif', 'Embedded trajectories must be an array');
      trajectory.subagent_trajectories.forEach((child, index) => {
        if (!hasObject(child)) fail('invalid_atif', 'Embedded trajectory must be an object');
        visit(child, pointer + '/subagent_trajectories/' + index);
      });
    }
  };
  if (document.schema_version !== 'ATIF-v1.7' && document.schema_version !== 'ATIF-v1.8') fail('unsupported_version', 'ATIF version is absent or unsupported; no default or relabeling is applied');
  visit(document, '');
  return records;
}
