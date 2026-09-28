import * as fs from 'node:fs';
import { ingest, inspect } from './ingest.js';
import { boundedInteger, canonical, fail, parseJson, readMetadata, sha256, writeNew } from './io.js';
import { hasObject } from './normalize.js';
import { contextPack, query, recordsFrom, retrieve, verifiedSelection } from './views.js';
import { HelperError, MAX_BYTES } from './types.js';
import type { Format, ReadOptions } from './types.js';
import { prepareDecision, validatePreparedDecision, scorePrepared, DecisionError, DECISIONS_PREPARED_MAX } from './decisions.js';
import { ConfigurationError, configSchema, configTemplate, loadConfig, writeConfig, checkConfigReport } from './config.js';
import type { DecisionProvider } from './config.js';

const VALUE_FLAGS = new Set(['input', 'format', 'allow-root', 'offset', 'limit', 'max-bytes', 'fields',
  'filters', 'record-id', 'max-chars', 'output', 'recent', 'keep-id', 'scores', 'target-version', 'expected-state', 'deadline-ms', 'config', 'provider']);
const SWITCHES = new Set(['json', 'include-body', 'original']);
function argumentsOf(args: string[]): { command: string; values: Map<string, string[]>; switches: Set<string> } {
  const command = args.shift() ?? 'help';
  const values = new Map<string, string[]>();
  const switches = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (!flag.startsWith('--')) fail('invalid_argument', 'Only named arguments are accepted');
    const name = flag.slice(2);
    if (SWITCHES.has(name)) { switches.add(name); continue; }
    if (!VALUE_FLAGS.has(name) || index + 1 >= args.length) fail('invalid_argument', 'Unknown or incomplete CLI flag');
    if (values.has(name) && name !== 'allow-root' && name !== 'keep-id') fail('invalid_argument', 'Duplicate CLI flag');
    values.set(name, [...(values.get(name) ?? []), args[++index]!]);
  }
  return { command, values, switches };
}
function output(value: unknown): void {
  const encoded = canonical(value) + '\n';
  if (Buffer.byteLength(encoded) > MAX_BYTES) fail('output_budget', 'JSON output exceeds eight MiB');
  process.stdout.write(encoded);
}
export async function main(argv = process.argv.slice(2)): Promise<void> {
  let scoreCompleted = false;
  try {
    const args = argumentsOf([...argv]);
    if (args.command === '--version' || args.command === 'version') {
      const packageValue = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { name: string; version: string };
      output({ schema_version: 'ultrafast-atif.version.v1', package: packageValue.name, version: packageValue.version, protocol: 'ultrafast-atif.page.v1', model_called: false });
      return;
    }
    if (args.command === '--help' || args.command === 'help') {
      output({ schema_version: 'ultrafast-atif.cli.v1', commands: {
        ingest: 'ingest --input PATH --format codex|claude|pi|atif --allow-root ROOT --offset BYTES --limit N --max-bytes N [--expected-state STATE_JSON] --json',
        inspect: 'inspect --input PATH --format FORMAT --allow-root ROOT --max-bytes N --json',
        plan: 'plan --input PATH --format FORMAT --target-version VERSION --allow-root ROOT --json',
        query: 'query --input METADATA_JSON --allow-root ROOT --filters JSON --fields /record_id,/native --limit N --offset N --json',
        retrieve: 'retrieve --input METADATA_JSON --record-id ID --allow-root ROOT [--include-body --max-chars N | --original --output NEW_PATH] --json',
        'context-pack': 'context-pack --input METADATA_JSON --allow-root ROOT [--scores JSON --keep-id ID --recent N --include-body --max-chars N] --json',
        'config-init': 'config-init --output NEW_CONFIG_JSON [--provider openrouter|typesafe] --json (--config is an exclusive output-path alias)',
        'config-check': 'config-check --config CONFIG_JSON --json',
        'config-schema': 'config-schema --json',
        'prepare-score': 'prepare-score --input SYNTHETIC_OR_REDACTED_RECIPE_JSON --allow-root ROOT --output NEW_PREPARED_JSON [--config CONFIG_JSON] --json',
        'score-prepared': 'score-prepared --input PREPARED_JSON --allow-root ROOT [--config CONFIG_JSON] [--deadline-ms N] --json',
      }, effects: 'Local ETL never calls a model. Config commands inspect no credential values and start no services. prepare-score validates supplied data only; score-prepared performs one explicit request to the selected fixed provider, with no fallback. OpenRouter is the default; TypeSafe requires explicit configuration. Retrieval/context-pack text display and new local original-byte copies remain explicit.' });
      return;
    }
    const get = (name: string, fallback?: string): string => {
      const value = args.values.get(name)?.[0] ?? fallback;
      if (value === undefined || value === '') fail('invalid_argument', 'Missing required CLI argument: ' + name);
      return value;
    };
    const number = (name: string, fallback: number): number => {
      const raw = args.values.get(name)?.[0];
      if (raw !== undefined && !/^(0|[1-9]\d*)$/.test(raw)) fail('invalid_argument', 'Numeric flags require decimal integers');
      return boundedInteger(raw === undefined ? fallback : Number(raw), 0, Number.MAX_SAFE_INTEGER, name);
    };
    const roots = args.values.get('allow-root') ?? [];
    const profileFlags = (allowed: string[]): void => {
      if ([...args.values.keys()].some(key => !allowed.includes(key)) ||
          [...args.switches].some(key => key !== 'json')) fail('invalid_argument', 'Unsupported flag for this command');
    };
    if (args.command === 'config-schema') { profileFlags([]); output(configSchema()); return; }
    if (args.command === 'config-init') {
      profileFlags(['config', 'output', 'provider']);
      if (args.values.has('config') === args.values.has('output')) fail('invalid_argument', 'Select exactly one new config output path');
      const provider = get('provider', 'openrouter');
      if (provider !== 'openrouter' && provider !== 'typesafe') fail('invalid_argument', 'Select openrouter or typesafe');
      writeConfig(get(args.values.has('output') ? 'output' : 'config'), provider as DecisionProvider);
      output({ schema_version: 'task-checkpoint.config-created.v1', provider, model_called: false, credentials_written: false });
      return;
    }
    if (args.command === 'config-check') {
      profileFlags(['config']); output(checkConfigReport(loadConfig(get('config')))); return;
    }
    if (args.command === 'prepare-score' || args.command === 'score-prepared') {
      profileFlags(args.command === 'prepare-score' ? ['input', 'allow-root', 'output', 'config'] : ['input', 'allow-root', 'deadline-ms', 'config']);
      const selection = (args.values.has('config') ? loadConfig(get('config')) : configTemplate()).scoring;
      const input = readMetadata(get('input'), roots, DECISIONS_PREPARED_MAX);
      if (args.command === 'prepare-score') {
        if (!hasObject(input)) fail('invalid_preparation', 'Scoring recipe must be a JSON object');
        if (input.provider !== undefined && input.provider !== selection.provider ||
            input.model !== undefined && input.model !== selection.model) fail('config_packet_mismatch', 'Recipe provider/model differs from the explicitly selected configuration');
        const prepared = prepareDecision({ ...input, provider: selection.provider, model: selection.model });
        if (prepared.request_bytes > selection.limits.max_request_bytes) fail('request_budget', 'Prepared request exceeds configured bytes');
        const data = Buffer.from(canonical(prepared) + '\n');
        writeNew(get('output'), roots, data);
        output({ schema_version: 'ultrafast-atif.scoring-preparation.v1', provider_profile: prepared.provider, data_class: prepared.data_class,
          prepared_file_sha256: sha256(data), packet_sha256: prepared.packet_sha256,
          request_sha256: prepared.request_sha256, request_bytes: prepared.request_bytes,
          pair_map_sha256: prepared.pair_map_sha256, http_attempts: 0, model_called: false });
      } else {
        const prepared = validatePreparedDecision(input);
        if (prepared.provider !== selection.provider || prepared.request.model !== selection.model) fail('config_packet_mismatch', 'Prepared provider/model differs from the explicitly selected configuration');
        const deadline = number('deadline-ms', selection.limits.deadline_ms);
        if (deadline > selection.limits.deadline_ms) fail('invalid_deadline', 'CLI deadline cannot widen the configured limit');
        const result = await scorePrepared(prepared, { deadlineMs: deadline, apiKeyEnv: selection.api_key_env,
          maxRequestBytes: selection.limits.max_request_bytes, maxResponseBytes: selection.limits.max_response_bytes });
        scoreCompleted = true;
        output(result);
      }
      return;
    }
    if (args.values.has('config') || args.values.has('provider')) fail('invalid_argument', 'This helper command does not consume scoring configuration');
    const maxBytes = number('max-bytes', 1024 * 1024);
    const options: ReadOptions = { input: get('input'), format: get('format', 'codex') as Format, allowRoots: roots,
      offset: number('offset', 0), limit: number('limit', 100), maxBytes };
    if (args.values.has('expected-state')) {
      const state = readMetadata(get('expected-state'), roots, 65536);
      if (!hasObject(state)) fail('invalid_state', 'Expected source state must be a JSON object');
      options.expectedState = (hasObject(state.source_state) ? state.source_state : state) as ReadOptions['expectedState'];
    }
    if (['ingest', 'inspect', 'plan'].includes(args.command) && !args.values.has('format')) fail('invalid_argument', 'Source format must be explicit');
    if (args.command === 'ingest') { output(ingest(options)); return; }
    if (args.command === 'inspect' || args.command === 'plan') {
      const result = inspect(options);
      if (args.command === 'plan') { result.target_version = get('target-version'); result.plan_only = true; }
      output(result); return;
    }
    if (!['query', 'retrieve', 'context-pack'].includes(args.command)) fail('invalid_argument', 'Unsupported helper command');
    const records = recordsFrom(readMetadata(options.input, roots, maxBytes));
    if (args.command === 'query') {
      const filters = parseJson(get('filters', '{}'));
      if (!hasObject(filters)) fail('invalid_filter', 'Filters must be a JSON object');
      output(query(records, filters, get('fields').split(','), options.limit, options.offset)); return;
    }
    if (args.command === 'retrieve') {
      const id = get('record-id');
      const matches = records.filter(record => record.record_id === id);
      if (matches.length !== 1) fail('unknown_record', 'Record identity is missing or ambiguous');
      const record = matches[0]!;
      if (args.switches.has('original')) {
        if (args.switches.has('include-body')) fail('invalid_argument', 'Original-byte copying and body display are separate modes');
        const selected = verifiedSelection(record, roots, maxBytes);
        writeNew(get('output'), roots, selected.bytes);
        output({ schema_version: 'ultrafast-atif.original-copy.v1', bytes: selected.bytes.length,
          sha256: sha256(selected.bytes), source_verified: true, body_included: false, scope: 'selected_original_source_range' });
      } else output(retrieve(record, roots, { includeBody: args.switches.has('include-body'), maxBytes, maxChars: number('max-chars', 4096) }));
      return;
    }
    const scores = parseJson(get('scores', '{}'));
    if (!hasObject(scores)) fail('invalid_score', 'Retention inputs must be a JSON object');
    output(contextPack(records, { allowRoots: roots, keepIds: args.values.get('keep-id'), recent: number('recent', 6),
      scores: scores as Record<string, { keepCall: number; keepResult: number }>, includeBody: args.switches.has('include-body'),
      maxChars: number('max-chars', 64000) }));
  } catch (error) {
    const known = error instanceof HelperError || error instanceof ConfigurationError;
    const attempts = error instanceof DecisionError ? error.httpAttempts : scoreCompleted ? 1 : 0;
    process.stderr.write(JSON.stringify({ schema_version: 'ultrafast-atif.error.v1',
      code: known ? error.code : 'io_error', message: error instanceof ConfigurationError ? 'Unified configuration validation failed' : known ? error.message : 'Local file operation failed',
      model_called: scoreCompleted ? true : attempts === 0 ? false : null, http_attempts: attempts,
      http_status: error instanceof DecisionError ? error.httpStatus : null,
      ...(attempts ? { model_call_status: scoreCompleted ? 'valid_response_output_failed' : 'attempted_outcome_unknown',
        usage: null, scores_available: false } : {}) }) + '\n');
    process.exitCode = 1;
  }
}
