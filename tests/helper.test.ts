import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { compact } from '../src/compact.js';
import { ingest, inspect } from '../src/helper/ingest.js';
import { canonical, parseJson, sha256, writeNew } from '../src/helper/io.js';
import { contextPack, query, recordsFrom, retrieve, verifiedSelection } from '../src/helper/views.js';
import type { Format, RecordMetadata } from '../src/helper/types.js';

let root: string;
const roots = (): string[] => [root];
const write = (name: string, value: unknown): string => {
  const file = path.join(root, name);
  fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  return file;
};
const lines = (rows: unknown[]): string => rows.map(row => JSON.stringify(row) + '\n').join('');
const codex = [
  { timestamp: '2026-01-01T00:00:00Z', type: 'session_meta', payload: { id: 'native-session', cli_version: '0.synthetic' } },
  { timestamp: '2026-01-01T00:00:01Z', type: 'turn_context', payload: { turn_id: 'native-turn' } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Never remove this constraint.' }] } },
];
const atif = (version = 'ATIF-v1.8'): Record<string, unknown> => ({
  schema_version: version, agent: { name: 'synthetic', version: '0' },
  steps: [{ step_id: 1, source: 'system', message: 'Keep the exact constraint.' }],
  extra: { unknown: { false_value: false, zero_value: 0, body: 'OPAQUE_PRIVATE_FIXTURE' } },
});
const read = (file: string, format: Format, options: Record<string, number> = {}) =>
  ingest({ input: file, format, allowRoots: roots(), maxBytes: 1024 * 1024, limit: 100, ...options });
const cli = (...args: string[]) => {
  const launcher = path.join(root, 'cli-launcher.mjs');
  fs.writeFileSync(launcher, 'import { main } from ' + JSON.stringify(pathToFileURL(path.resolve('src/helper/cli.ts')).href) + '; main();');
  return spawnSync(process.execPath, ['--import', 'tsx', launcher, ...args], { encoding: 'utf8', timeout: 2000 });
};

beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atif-helper-'))); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('bounded native ingest', () => {
  it('emits body-free Codex metadata with exact same-page identity evidence', () => {
    const file = write('codex.jsonl', lines(codex));
    const page = read(file, 'codex');
    expect(page.records).toHaveLength(3);
    expect(page.records[2]!.native.session_id).toBe('native-session');
    expect(page.records[2]!.native.turn_id).toBe('native-turn');
    expect(page.records[2]!.identity_evidence.session_id!.offset).toBe(0);
    expect(JSON.stringify(page)).not.toContain('Never remove');
    expect(retrieve(page.records[2]!, roots()).body_included).toBe(false);
    expect(retrieve(page.records[2]!, roots(), { includeBody: true }).text).toContain('Never remove');
    expect(fs.readFileSync(file, 'utf8')).toBe(lines(codex));
  });

  it('does not inherit native context across resumed offsets and changes the projection identity', () => {
    const file = write('codex.jsonl', lines(codex));
    const first = read(file, 'codex');
    const offset = Buffer.byteLength(lines(codex.slice(0, 2)));
    const resumed = read(file, 'codex', { offset });
    expect(resumed.records[0]!.native.session_id).toBeNull();
    expect(resumed.records[0]!.native.turn_id).toBeNull();
    expect(resumed.records[0]!.record_id).not.toBe(first.records[2]!.record_id);
    expect(resumed.omissions.join(' ')).toContain('Resumed');
  });

  it('resets Codex turn context at a new session header', () => {
    const file = write('sessions.jsonl', lines([...codex, { type: 'session_meta', payload: { id: 'other-session' } }]));
    const last = read(file, 'codex').records.at(-1)!;
    expect(last.native.session_id).toBe('other-session');
    expect(last.native.turn_id).toBeNull();
  });

  it('keeps partial tails and enqueue cutoffs pending without advancing', () => {
    const first = JSON.stringify(codex[0]) + '\n';
    const second = JSON.stringify(codex[1]) + '\n';
    const file = write('tail.jsonl', first + second.slice(0, 12));
    const page = read(file, 'codex');
    expect(page.records).toHaveLength(1);
    expect(page.incomplete_tail).toBe(true);
    expect(page.next_offset).toBe(Buffer.byteLength(first));
    fs.appendFileSync(file, second.slice(12));
    const cutoff = read(file, 'codex', { offset: Buffer.byteLength(first), maxBytes: 12 });
    expect(cutoff.records).toHaveLength(0);
    expect(cutoff.incomplete_tail).toBe(true);
    expect(cutoff.eof).toBe(false);
    expect(cutoff.next_offset).toBe(Buffer.byteLength(first));
    expect(read(file, 'codex', { maxBytes: 1 }).incomplete_tail).toBe(true);
    expect(verifiedSelection(page.records[0]!, roots()).bytes.toString()).toBe(first);
  });

  it('pages only at complete record boundaries and rejects invalid cursors/budgets', () => {
    const file = write('codex.jsonl', lines(codex));
    const page = read(file, 'codex', { limit: 1 });
    expect(page.next_offset).toBe(Buffer.byteLength(lines(codex.slice(0, 1))));
    expect(read(file, 'codex', { offset: page.next_offset!, limit: 1 }).records).toHaveLength(1);
    expect(() => read(file, 'codex', { offset: 1 })).toThrow(/newline/);
    expect(() => read(file, 'codex', { offset: 999999 })).toThrow(/Cursor/);
    expect(() => read(file, 'codex', { maxBytes: 0 })).toThrow();
    expect(() => read(file, 'codex', { limit: 0 })).toThrow();
  });

  it('verifies optional resume identity and anchor while marking offset-only continuation unverified', () => {
    const file = write('resume.jsonl', lines(codex));
    const page = read(file, 'codex', { limit: 1 });
    const resumed = ingest({ input: file, format: 'codex', allowRoots: roots(), offset: page.next_offset!,
      expectedState: page.source_state });
    expect(resumed.source_state.continuation).toBe('verified_expected_state');
    expect(resumed.records[0]!.native.session_id).toBeNull();
    expect(read(file, 'codex', { offset: page.next_offset! }).source_state.continuation).toBe('unverified_offset');
    fs.renameSync(file, path.join(root, 'previous.jsonl'));
    fs.writeFileSync(file, lines(codex));
    expect(() => ingest({ input: file, format: 'codex', allowRoots: roots(), offset: page.next_offset!,
      expectedState: page.source_state })).toThrow(/rotated|truncated/);
  });

  it('detects changed cursor-anchor bytes without reading historical identity context', () => {
    const file = write('anchor.jsonl', lines(codex));
    const page = read(file, 'codex', { limit: 1 });
    fs.writeFileSync(file, lines(codex).replace('native-session', 'changed-sessio'));
    expect(() => ingest({ input: file, format: 'codex', allowRoots: roots(), offset: page.next_offset!,
      expectedState: page.source_state })).toThrow(/anchor/);
  });

  it('observes Claude entry/session fields without inventing a native turn', () => {
    const file = write('claude.jsonl', lines([{ type: 'assistant', sessionId: 'claude-session', uuid: 'entry-one',
      parentUuid: 'entry-parent', message: { role: 'assistant', content: [{ type: 'text', text: 'Private response.' }] } }]));
    const record = read(file, 'claude').records[0]!;
    expect(record.native).toMatchObject({ session_id: 'claude-session', turn_id: null, entry_id: 'entry-one', parent_entry_id: 'entry-parent' });
    expect(verifiedSelection(record, roots()).value).toHaveProperty('uuid', 'entry-one');
  });

  it('preserves numeric Pi version, parent IDs and unknown resumed session context', () => {
    const content = [{ type: 'session', version: 3, id: 'pi-session' },
      { type: 'message', id: 'pi-entry', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'Keep this.' }] } }];
    const file = write('pi.jsonl', lines(content));
    const page = read(file, 'pi');
    expect(page.records[1]!.source.version).toBe(3);
    expect(page.records[1]!.native.session_id).toBe('pi-session');
    expect(page.records[1]!.native.turn_id).toBeNull();
    expect(page.records[1]!.labels).toContain('parent_entry_id:null');
    const resumed = read(file, 'pi', { offset: Buffer.byteLength(lines(content.slice(0, 1))) });
    expect(resumed.records[0]!.source.version).toBeNull();
    expect(resumed.records[0]!.native.session_id).toBeNull();
  });

  it('rejects duplicate JSON keys and invalid UTF-8 without echoing bodies', () => {
    expect(() => parseJson('{"id":"one","id":"two"}')).toThrow(/Duplicate/);
    expect(() => parseJson(Buffer.from([0xff]))).toThrow(/UTF-8/);
    expect(() => parseJson('{"n":1e999}')).toThrow(/Non-finite/);
    const file = write('invalid.jsonl', '{"type":"session","id":"PRIVATE_VALUE","id":"other"}\n');
    const result = cli('ingest', '--input', file, '--format', 'pi', '--allow-root', root, '--json');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('PRIVATE_VALUE');
    expect(JSON.parse(result.stderr).code).toBe('duplicate_key');
  });
});

describe('ATIF source preservation and embedded events', () => {
  it.each(['ATIF-v1.7', 'ATIF-v1.8'])('preserves %s and opaque values without requiring invented root IDs', version => {
    const bytes = Buffer.from(JSON.stringify(atif(version), null, 2));
    const file = write('trajectory.json', bytes);
    const page = read(file, 'atif');
    expect(page.records).toHaveLength(2);
    expect(page.records[1]!.atif?.step_id).toBe(1);
    expect(page.records[1]!.native.step_id).toBeNull();
    expect(page.records[1]!.native.session_id).toBeNull();
    expect(page.records[1]!.native.trajectory_id).toBeNull();
    expect(page.records[1]!.source.version).toBe(version);
    expect(JSON.stringify(page)).not.toContain('OPAQUE_PRIVATE_FIXTURE');
    const selected = verifiedSelection(page.records[0]!, roots());
    expect(selected.bytes.equals(bytes)).toBe(true);
    const value = selected.value as { extra: { unknown: { false_value: unknown; zero_value: unknown } } };
    expect(value.extra.unknown.false_value).toBe(false);
    expect(value.extra.unknown.zero_value).toBe(0);
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
  });

  it('plans unknown versions without relabeling and refuses unresumable partial ATIF imports', () => {
    const file = write('future.json', atif('ATIF-v9.0'));
    expect(inspect({ input: file, format: 'atif', allowRoots: roots() })).toMatchObject({
      declared_version: 'ATIF-v9.0', supported_for_ingest: false, converted: false });
    expect(() => read(file, 'atif')).toThrow(/unsupported/);
    const known = write('known.json', atif());
    expect(() => read(known, 'atif', { limit: 1 })).toThrow(/record limit/);
    expect(() => read(known, 'atif', { maxBytes: 1 })).toThrow(/byte budget/);
  });

  it('indexes checkpoint extensions and managed marks while keeping Relay runtime IDs separate', () => {
    const checkpoint = { schema_version: 'task-turns-checkpoint.v1', event_type: 'task_turns_checkpoint',
      event_id: 'logical-event', task: { task_id: 'logical-task' }, logical_run: { run_id: 'logical-run' },
      project: { status: 'not_applicable' },
      provenance_ref: { record_id: 'lineage', uri: 'urn:synthetic:lineage', json_pointer: '', sha256: 'a'.repeat(64) },
      facets: { native_sessions: [{ session_ref: 's', client: 'codex', roles: ['primary_actor'],
        native_session_id: { status: 'observed', value: 'actual-native-session' } }],
      native_turns: [{ session_ref: 's', native_turn_id: { status: 'observed', value: 'actual-native-turn' } }] } };
    const document = atif();
    const extra = document.extra as Record<string, unknown>;
    extra.self_harness = { task_turns_checkpoint: [checkpoint] };
    extra.observed_events = [{ kind: 'mark', atof_version: '0.1', uuid: 'relay-event-uuid',
      parent_uuid: 'relay-scope-uuid', propagation_root_uuid: 'relay-root-uuid', name: 'task_turns_checkpoint',
      data_schema: { name: 'self_harness.task_turns_checkpoint', version: '1' }, data: checkpoint },
      { kind: 'mark', atof_version: '0.1', uuid: 'other-relay-mark', name: 'custom-point', data: { body: 'OPAQUE_MARK_BODY' } }];
    const file = write('managed.json', document);
    const page = read(file, 'atif');
    const events = page.records.filter(record => record.kind === 'task_turns_checkpoint');
    expect(events).toHaveLength(2);
    expect(events[0]!.logical?.task_id).toBe('logical-task');
    expect(events[1]!.native.session_id).toBe('actual-native-session');
    expect(events[1]!.native.turn_id).toBe('actual-native-turn');
    expect(events[1]!.relay?.event_uuid).toBe('relay-event-uuid');
    expect(events[1]!.native_actor?.client).toBe('codex');
    expect(events[1]!.native.entry_id).toBeNull();
    expect(verifiedSelection(events[1]!, roots()).value).toHaveProperty('kind', 'mark');
    expect(page.records.find(record => record.kind === 'relay_mark')!.native.session_id).toBeNull();
    expect(JSON.stringify(page)).not.toContain('OPAQUE_MARK_BODY');
  });

  it('does not equate identical ATIF run IDs and Codex native session IDs', () => {
    const native = read(write('codex.jsonl', lines(codex)), 'codex').records;
    const document = atif();
    document.session_id = 'native-session';
    document.trajectory_id = 'document-one';
    const interchange = read(write('atif.json', document), 'atif').records;
    expect(interchange.every(record => record.native.session_id === null && record.native.trajectory_id === null && record.native.step_id === null)).toBe(true);
    expect(interchange[1]!.atif).toEqual({ session_id: 'native-session', trajectory_id: 'document-one', step_id: 1 });
    const records = [...native, ...interchange];
    expect(query(records, { 'native.session_id': 'native-session' }, ['/client']).matched).toBe(3);
    expect(query(records, { 'atif.session_id': 'native-session' }, ['/client']).matched).toBe(2);
    expect(query(records, { native_client: 'codex' }, ['/client']).matched).toBe(3);
    expect(verifiedSelection(interchange[1]!, roots()).value).toHaveProperty('step_id', 1);
  });

  it('leaves checkpoint native facets unprojected without explicit actor provenance', () => {
    const document = atif();
    (document.extra as Record<string, unknown>).self_harness = { task_turns_checkpoint: [{
      schema_version: 'task-turns-checkpoint.v1', event_type: 'task_turns_checkpoint', event_id: 'logical',
      facets: { native_sessions: [{ client: 'codex', session_ref: 's', roles: ['primary_actor'],
        native_session_id: { status: 'observed', value: 'must-not-project' } }], native_turns: [] },
    }] };
    const record = read(write('unbound.json', document), 'atif').records.find(record => record.kind === 'task_turns_checkpoint')!;
    expect(record.native.session_id).toBeNull();
    expect(record.native_actor).toBeUndefined();
  });
});

describe('exact retrieval and query', () => {
  it('rejects changed source bytes and tampered normalized identity', () => {
    const file = write('source.jsonl', lines(codex));
    const record = read(file, 'codex').records[0]!;
    const altered = structuredClone(record);
    altered.native.session_id = 'forged';
    expect(() => verifiedSelection(altered, roots())).toThrow(/identity/);
    fs.writeFileSync(file, lines(codex).replace('native-session', 'changed-sessio'));
    expect(() => verifiedSelection(record, roots())).toThrow(/digest/);
    fs.truncateSync(file, 1);
    expect(() => verifiedSelection(record, roots())).toThrow(/range/);
  });

  it('refuses symlink/credential/out-of-root sources and FIFO input promptly', () => {
    const file = write('source.jsonl', lines(codex));
    const link = path.join(root, 'alias.jsonl'); fs.symlinkSync(file, link);
    expect(() => read(link, 'codex')).toThrow(/Symlink/);
    const auth = write('auth.json', '{}');
    expect(() => read(auth, 'codex')).toThrow(/Credential/);
    const sub = path.join(root, 'sub'); fs.mkdirSync(sub);
    expect(() => ingest({ input: file, format: 'codex', allowRoots: [sub] })).toThrow(/outside/);
    const fifo = path.join(root, 'events.fifo');
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    const result = cli('ingest', '--input', fifo, '--format', 'codex', '--allow-root', root, '--json');
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).code).toBe('not_regular');
  });

  it('retains exact filter scalar types and explicit field pagination', () => {
    const file = write('source.jsonl', lines(codex));
    const records = read(file, 'codex').records;
    const found = query(records, { 'native.session_id': 'native-session' }, ['/record_id', '/native/turn_id'], 1, 1);
    expect(found.matched).toBe(3);
    expect(found.records).toHaveLength(1);
    expect(found.next_offset).toBe(2);
    for (const value of [null, false, 0, '']) expect(() => query(records, { 'native.session_id': value }, ['/record_id'])).toThrow();
    expect(() => query(records, { unknown: 'value' }, ['/record_id'])).toThrow(/Unknown/);
    expect(() => query(records, {}, [])).toThrow(/Select/);
    expect(() => query(records, {}, ['/record_id'], 0)).toThrow();
    expect(() => recordsFrom({ body: 'raw' })).toThrow(/body-free|fields/);
  });

  it('copies original bytes only to a new local artifact and redacts explicit text views', () => {
    const file = write('source.jsonl', lines([{ type: 'response_item', payload: { type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'Authorization: Bearer synthetic-credential-value' }] } }]));
    const record = read(file, 'codex').records[0]!;
    const selected = verifiedSelection(record, roots());
    const output = path.join(root, 'original-copy.jsonl');
    writeNew(output, roots(), selected.bytes);
    expect(fs.readFileSync(output).equals(fs.readFileSync(file))).toBe(true);
    expect(() => writeNew(file, roots(), Buffer.from('replace'))).toThrow();
    expect(retrieve(record, roots(), { includeBody: true }).text).toBe('Authorization: Bearer [REDACTED]');
  });
});

describe('context views', () => {
  const toolRows = [
    codex[0], codex[1],
    { type: 'response_item', payload: { type: 'function_call', call_id: 'pair-a', name: 'Read', arguments: '{"path":"a"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'pair-a', output: 'x'.repeat(500) } },
    codex[2],
  ];
  it('reuses pure pair decisions while preserving constraints and original bytes', () => {
    const file = write('tools.jsonl', lines(toolRows));
    const records = read(file, 'codex').records;
    const initial = contextPack(records, { allowRoots: roots(), recent: 0 }) as { decisions: { pair_id: string }[] };
    const pair = initial.decisions[0]!.pair_id;
    const packed = contextPack(records, { allowRoots: roots(), recent: 0,
      scores: { [pair]: { keepCall: 0, keepResult: 0 } }, includeBody: true }) as { omitted_records: number; records: { record: RecordMetadata; text: string }[] };
    expect(packed.omitted_records).toBe(2);
    expect(packed.records.some(row => row.text.includes('Never remove'))).toBe(true);
    expect(sha256(fs.readFileSync(file))).toBe(sha256(Buffer.from(lines(toolRows))));
    const protectedPack = contextPack(records, { allowRoots: roots(), recent: 3,
      scores: { [pair]: { keepCall: 0, keepResult: 0 } } });
    expect(protectedPack.omitted_records).toBe(0);
  });

  it('preserves unpaired windows and keeps call when result is truncated', () => {
    const file = write('tools.jsonl', lines(toolRows));
    const records = read(file, 'codex').records;
    expect(contextPack([records[3]!], { allowRoots: roots(), recent: 0 }).pairs_complete).toBe(false);
    const initial = contextPack(records, { allowRoots: roots(), recent: 0 }) as { decisions: { pair_id: string }[] };
    const pair = initial.decisions[0]!.pair_id;
    const result = contextPack(records, { allowRoots: roots(), recent: 0, includeBody: true,
      scores: { [pair]: { keepCall: 1, keepResult: 0 } } }) as { records: { view: string; text: string }[] };
    expect(result.records.filter(row => row.view === 'truncated_head')).toHaveLength(1);
    expect(result.records.find(row => row.view === 'truncated_head')!.text.length).toBe(300);
    expect(() => contextPack(records, { allowRoots: roots(), maxChars: 1 })).toThrow(/protected|budget/i);
  });

  it('upstream compact accepts a deterministic injected asker without transport', async () => {
    let calls = 0;
    const result = await compact([
      { role: 'user', text: 'Keep constraints.', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'call', tool: 'Read', input: { path: 'synthetic' } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'call', text: 'output' }] },
    ], { ask: async (_state, questions) => { calls++; return { answers: Object.fromEntries(Object.keys(questions).map(key => [key, { type: 'noul' as const, noul: 0 }])) }; } },
    { preserveRecentMessages: 0 });
    expect(calls).toBe(1);
    expect(result.messages).toHaveLength(1);
  });

  const dropAllGroups = (records: RecordMetadata[]) => {
    const initial = contextPack(records, { allowRoots: roots(), recent: 0 }) as { decisions: { pair_id: string }[] };
    return contextPack(records, { allowRoots: roots(), recent: 0,
      scores: Object.fromEntries(initial.decisions.map(decision => [decision.pair_id, { keepCall: 0, keepResult: 0 }])) });
  };
  it.each(['session', 'turn'])('does not pair equal call IDs across distinct native %s scopes', boundary => {
    const call = { type: 'response_item', payload: { type: 'function_call', name: 'Read', call_id: 'same-call', arguments: '{}' } };
    const result = { type: 'response_item', payload: { type: 'function_call_output', call_id: 'same-call', output: 'result' } };
    const other = boundary === 'session'
      ? [{ type: 'session_meta', payload: { id: 'other-session' } }, { type: 'turn_context', payload: { turn_id: 'other-turn' } }]
      : [{ type: 'turn_context', payload: { turn_id: 'other-turn' } }];
    const file = write('cross-scope.jsonl', lines([codex[0], codex[1], call, ...other, result]));
    const pack = dropAllGroups(read(file, 'codex').records);
    expect(pack.omitted_records).toBe(0);
    expect(pack.pairs_complete).toBe(false);
  });

  it('does not pair equal call IDs across exact ATIF pointer scopes with duplicate declared IDs', () => {
    const document = atif();
    document.subagent_trajectories = [
      { schema_version: 'ATIF-v1.8', trajectory_id: 'duplicate', steps: [
        { step_id: 1, source: 'agent', message: '', tool_calls: [{ tool_call_id: 'same-call', function_name: 'Read', arguments: {} }] }] },
      { schema_version: 'ATIF-v1.8', trajectory_id: 'duplicate', steps: [
        { step_id: 1, source: 'agent', message: '', observation: { results: [{ source_call_id: 'same-call', content: 'result' }] } }] },
    ];
    const pack = dropAllGroups(read(write('cross-document.json', document), 'atif').records);
    expect(pack.omitted_records).toBe(0);
    expect(pack.pairs_complete).toBe(false);
  });

  it('preserves a Codex pair when its native turn context is unknown', () => {
    const file = write('unknown-turn.jsonl', lines([toolRows[0], ...toolRows.slice(2)]));
    const pack = dropAllGroups(read(file, 'codex').records);
    expect(pack.omitted_records).toBe(0);
    expect(pack.pairs_complete).toBe(false);
  });

  it('uses explicit Claude parent-entry ancestry without inventing a turn ID', () => {
    const rows = [
      { type: 'user', sessionId: 's', uuid: 'user', parentUuid: null, message: { role: 'user', content: 'Keep constraints.' } },
      { type: 'assistant', sessionId: 's', uuid: 'call-entry', parentUuid: 'user', message: { role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-id', name: 'Read', input: {} }] } },
      { type: 'user', sessionId: 's', uuid: 'result-entry', parentUuid: 'call-entry', message: { role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-id', content: 'result' }] } },
    ];
    const valid = dropAllGroups(read(write('linked-branch.jsonl', lines(rows)), 'claude').records);
    expect(valid.omitted_records).toBe(2);
    rows[2]!.parentUuid = 'unrelated-branch';
    const unrelated = dropAllGroups(read(write('other-branch.jsonl', lines(rows)), 'claude').records);
    expect(unrelated.omitted_records).toBe(0);
    expect(unrelated.pairs_complete).toBe(false);
  });
});
