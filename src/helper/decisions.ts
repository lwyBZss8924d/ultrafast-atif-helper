/**
 * Optional, explicit Noul retention scoring. No SDK, catalog lookup or import-time I/O.
 *
 * Request/answer shapes follow OpenRouter's official Decisions Skill API reference
 * and its parseRequest/decide HTTP contract (inspected lib SHA-256:
 * d6aad5cd482eb8f6029fa5b66f167a4eda70a5ab03012a1139df5876bb485692).
 * This application profile adds fixed routing, immutable preparation, strict bounds,
 * local-only pair mappings and response validation; it does not vendor the SDK.
 */
import { canonical, parseJson, sha256 } from './io.js';
import { HelperError } from './types.js';

export const DECISIONS_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
export const DECISIONS_MODEL = 'typesafe/jev-1.13-20260917';
export const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const TYPESAFE_MODEL = 'jev-1.13.0';
export type DecisionProvider = 'openrouter' | 'typesafe';
export const DECISION_PROFILES = {
  openrouter: { endpoint: DECISIONS_ENDPOINT, model: DECISIONS_MODEL, apiKeyEnv: 'OPENROUTER_API_KEY' },
  typesafe: { endpoint: TYPESAFE_ENDPOINT, model: TYPESAFE_MODEL, apiKeyEnv: 'TYPESAFE_API_KEY' },
} as const;
export const DECISIONS_REQUEST_MAX = 64 * 1024;
export const DECISIONS_PREPARED_MAX = 128 * 1024;
export const DECISIONS_RESPONSE_MAX = 1024 * 1024;
export const DECISIONS_DEADLINE_MAX = 20_000;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Description = string | Json[] | { [key: string]: Json };
export interface NoulQuestion { type: 'noul'; instructions: Description; criteria?: { true: Description; false: Description }; }
export interface PairQuestions { keepCall: string; keepResult: string; }
interface WireRequest {
  model: string;
  state: Description;
  questions: Record<string, NoulQuestion>;
  provider?: { allow_fallbacks: false };
}
export interface PreparedDecision {
  schema_version: 'ultrafast-atif.prepared-decision.v1';
  provider: DecisionProvider;
  data_class: 'synthetic' | 'redacted';
  request: WireRequest;
  pair_map: Record<string, PairQuestions>;
  request_sha256: string;
  request_bytes: number;
  pair_map_sha256: string;
  packet_sha256: string;
}
export class DecisionError extends HelperError {
  readonly httpStatus: number | null;
  constructor(code: string, message: string, readonly httpAttempts: 0 | 1 = 0, status?: unknown) {
    super(code, message);
    this.httpStatus = httpAttempts === 1 && typeof status === 'number' && Number.isInteger(status) &&
      status >= 100 && status <= 599 ? status : null;
  }
}
function reject(code: string, message: string, attempts: 0 | 1 = 0, status?: unknown): never { throw new DecisionError(code, message, attempts, status); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function jsonValue(value: unknown, depth = 0): value is Json {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => jsonValue(item, depth + 1));
  return record(value) && Object.values(value).every(item => jsonValue(item, depth + 1));
}
function description(value: unknown): value is Description {
  return jsonValue(value) && (typeof value === 'string' || Array.isArray(value) || record(value));
}
function identifier(value: unknown, maximum = 128): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}
function bytes(value: unknown): Buffer { return Buffer.from(canonical(value)); }
function snapshot<T>(value: T): T {
  try { return parseJson(bytes(value)) as T; }
  catch { return reject('invalid_preparation', 'Prepared scoring data must be bounded ordinary JSON'); }
}
function packetFields(provider: DecisionProvider, dataClass: PreparedDecision['data_class'], request: WireRequest, pairs: Record<string, PairQuestions>): PreparedDecision {
  const requestBytes = bytes(request);
  if (requestBytes.length > DECISIONS_REQUEST_MAX) reject('request_budget', 'Decisions request exceeds 64 KiB');
  const result: PreparedDecision = {
    schema_version: 'ultrafast-atif.prepared-decision.v1', provider, data_class: dataClass,
    request, pair_map: pairs, request_sha256: sha256(requestBytes), request_bytes: requestBytes.length,
    pair_map_sha256: sha256(bytes(pairs)),
    packet_sha256: sha256(bytes({ provider, data_class: dataClass, request, pair_map: pairs })),
  };
  if (bytes(result).length > DECISIONS_PREPARED_MAX) reject('preparation_budget', 'Prepared scoring packet exceeds 128 KiB');
  return result;
}

/** Prepare only supplied JSON. It never reads a source path, URI, environment or credential. */
export function prepareDecision(input: unknown): PreparedDecision {
  if (!record(input) || !exactKeys(input, ['data_class', 'model', 'state', 'questions', 'pair_map'], ['provider'])) reject('invalid_preparation', 'Recipe requires data_class, model, state, questions, pair_map and optional provider');
  const provider = input.provider === undefined ? 'openrouter' : input.provider;
  if (provider !== 'openrouter' && provider !== 'typesafe') reject('provider_profile', 'Select openrouter or typesafe explicitly; no fallback is available');
  const profile = DECISION_PROFILES[provider];
  if (input.data_class !== 'synthetic' && input.data_class !== 'redacted') reject('data_class', 'Only explicitly synthetic or redacted scoring inputs are allowed');
  if (input.model !== profile.model) reject('model_pin', 'Scoring requires the exact supported provider-pinned model');
  if (!description(input.state) || !record(input.questions)) reject('invalid_request', 'State and typed questions do not match the Decisions contract');
  const ids = Object.keys(input.questions);
  if (ids.length < 2 || ids.length > 64 || ids.some(key => !identifier(key))) reject('question_budget', 'Use two to sixty-four bounded question IDs');
  for (const question of Object.values(input.questions)) {
    if (!record(question) || !exactKeys(question, ['type', 'instructions'], ['criteria']) ||
        question.type !== 'noul' || !description(question.instructions)) reject('invalid_question', 'This scoring profile accepts typed Noul questions only');
    if (question.criteria !== undefined && (!record(question.criteria) ||
        !exactKeys(question.criteria, ['true', 'false']) ||
        !description(question.criteria.true) || !description(question.criteria.false))) reject('invalid_question', 'Noul criteria must contain exactly true and false descriptions');
  }
  if (!record(input.pair_map)) reject('invalid_pair_map', 'A local pair map is required');
  const pairs = Object.entries(input.pair_map);
  if (pairs.length < 1 || pairs.length > 32) reject('invalid_pair_map', 'Use one to thirty-two local pairs');
  const referenced = new Set<string>();
  for (const [pairId, mapping] of pairs) {
    if (!identifier(pairId, 4096) || !record(mapping) || !exactKeys(mapping, ['keepCall', 'keepResult']) ||
        !identifier(mapping.keepCall) || !identifier(mapping.keepResult) || mapping.keepCall === mapping.keepResult) reject('invalid_pair_map', 'Each local pair requires distinct bounded keepCall and keepResult question IDs');
    for (const questionId of [mapping.keepCall, mapping.keepResult]) {
      if (!Object.hasOwn(input.questions, questionId) || referenced.has(questionId)) reject('invalid_pair_map', 'Pair mappings must reference each question exactly once');
      referenced.add(questionId);
    }
  }
  if (referenced.size !== ids.length) reject('invalid_pair_map', 'Every prepared question must belong to exactly one local pair');
  const request = snapshot<WireRequest>({ model: profile.model, state: input.state,
    questions: input.questions as unknown as Record<string, NoulQuestion>,
    ...(provider === 'openrouter' ? { provider: { allow_fallbacks: false as const } } : {}) });
  return packetFields(provider, input.data_class, request, snapshot(input.pair_map as Record<string, PairQuestions>));
}

export function validatePreparedDecision(value: unknown): PreparedDecision {
  if (!record(value) || !exactKeys(value, ['schema_version', 'provider', 'data_class', 'request', 'pair_map',
    'request_sha256', 'request_bytes', 'pair_map_sha256', 'packet_sha256']) ||
    value.schema_version !== 'ultrafast-atif.prepared-decision.v1' || !record(value.request) ||
    (value.provider !== 'openrouter' && value.provider !== 'typesafe') ||
    !exactKeys(value.request, value.provider === 'openrouter' ? ['model', 'state', 'questions', 'provider'] : ['model', 'state', 'questions']) ||
    (value.provider === 'openrouter' && (!record(value.request.provider) ||
      !exactKeys(value.request.provider, ['allow_fallbacks']) || value.request.provider.allow_fallbacks !== false))) reject('invalid_preparation', 'Invalid prepared scoring envelope or routing policy');
  const prepared = prepareDecision({ provider: value.provider, data_class: value.data_class, model: value.request.model,
    state: value.request.state, questions: value.request.questions, pair_map: value.pair_map });
  if (canonical(prepared) !== canonical(value)) reject('preparation_changed', 'Prepared scoring bytes, mapping or digests changed');
  return prepared;
}
function probability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
interface Answer { type: 'noul'; noul: number; confidence?: number; probabilities?: { true: number; false: number }; }
function responseValues(raw: unknown, expected: WireRequest, profile: DecisionProvider): {
  answers: Record<string, Answer>; id: string | null; provider: string | null;
  model: string | null;
  usage: { input_tokens: number | null; output_tokens: number | null; cost: number | null };
} {
  if (!record(raw) || !record(raw.answers)) reject('invalid_response', 'Returned answer object does not match the prepared request', 1);
  const observedModel = raw.model === undefined || raw.model === null ? null : raw.model;
  if (observedModel !== expected.model && !(profile === 'typesafe' && observedModel === null)) reject('invalid_response', 'Returned model does not match the prepared request', 1);
  const expectedIds = Object.keys(expected.questions).sort();
  if (canonical(Object.keys(raw.answers).sort()) !== canonical(expectedIds)) reject('invalid_response', 'Returned answer IDs do not exactly match the prepared questions', 1);
  const answers: [string, Answer][] = [];
  for (const id of expectedIds) {
    const answer = raw.answers[id];
    if (!record(answer) || !exactKeys(answer, ['type', 'noul'], ['confidence', 'probabilities']) ||
        answer.type !== 'noul' || !probability(answer.noul)) reject('invalid_response', 'Noul answer type or probability is invalid', 1);
    const parsed: Answer = { type: 'noul', noul: answer.noul };
    if (Object.hasOwn(answer, 'confidence')) {
      if (!probability(answer.confidence)) reject('invalid_response', 'Supplied answer confidence is invalid', 1);
      parsed.confidence = answer.confidence;
    }
    if (Object.hasOwn(answer, 'probabilities')) {
      const distribution = answer.probabilities;
      if (!record(distribution) || !exactKeys(distribution, ['true', 'false']) ||
          !probability(distribution.true) || !probability(distribution.false) ||
          Math.abs(distribution.true + distribution.false - 1) > 0.02 ||
          Math.abs(distribution.true - answer.noul) > 0.02) reject('invalid_response', 'Supplied Noul distribution is invalid or inconsistent', 1);
      parsed.probabilities = { true: distribution.true, false: distribution.false };
    }
    answers.push([id, parsed]);
  }
  if (raw.id !== undefined && raw.id !== null && !identifier(raw.id, 256)) reject('invalid_response', 'Provider response identity is invalid', 1);
  if (raw.provider !== undefined && raw.provider !== null && raw.provider !== 'TypeSafe') reject('invalid_response', 'Response provider differs from the inspected pinned-model profile', 1);
  if (raw.usage !== undefined && raw.usage !== null && !record(raw.usage)) reject('invalid_response', 'Usage must be an object or unavailable', 1);
  const usage: Record<string, unknown> = record(raw.usage) ? raw.usage : {};
  const output = { input_tokens: null, output_tokens: null, cost: null } as { input_tokens: number | null; output_tokens: number | null; cost: number | null };
  for (const key of ['input_tokens', 'output_tokens', 'cost'] as const) {
    const value = usage[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 ||
        (key !== 'cost' && !Number.isSafeInteger(value))) reject('invalid_response', 'Supplied token usage or cost is invalid', 1);
    output[key] = value;
  }
  return { answers: Object.fromEntries(answers), model: observedModel as string | null,
    id: raw.id as string | null | undefined ?? null,
    provider: raw.provider as string | null | undefined ?? null, usage: output };
}
async function boundedResponse(response: Response, signal: AbortSignal, maximum: number): Promise<Buffer> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    void response.body?.cancel().catch(() => {});
    reject('response_budget', 'Provider response exceeds the bounded length contract', 1);
  }
  if (!response.body) reject('invalid_response', 'Provider returned no response body', 1);
  const reader = response.body.getReader();
  const cancel = (): void => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const parts: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) { cancel(); reject('response_budget', 'Provider response exceeds its configured byte limit', 1); }
      parts.push(Buffer.from(next.value));
    }
    return Buffer.concat(parts);
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}
export interface DecisionOptions {
  /** Test injection avoids inspecting the caller's real environment. Only this named entry is read. */
  env?: Readonly<Record<string, string | undefined>>;
  apiKeyEnv?: string;
  fetch?: typeof fetch;
  deadlineMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
}
export interface DecisionResult {
  schema_version: 'ultrafast-atif.decision-result.v1';
  data_class: PreparedDecision['data_class'];
  status: 'valid_response';
  http_attempts: 1;
  model_called: true;
  provider_profile: DecisionProvider;
  endpoint: string;
  requested_model: string;
  model: string | null;
  model_verification: 'unavailable' | 'exact_match';
  provider: string | null;
  response_identity_namespace: DecisionProvider;
  provider_response_id: string | null;
  usage: { input_tokens: number | null; output_tokens: number | null; cost: number | null };
  latency_ms: number;
  scores: Record<string, { keepCall: number; keepResult: number }>;
  answers: Record<string, Answer>;
  evidence: { packet_sha256: string; request_sha256: string; request_bytes: number;
    pair_map_sha256: string; response_sha256: string; response_bytes: number };
  source_paths_loaded: false;
  compaction_applied: false;
  deletion_authorized: false;
  calibration: 'not_established';
}

/** One explicit HTTP attempt. This never invokes contextPack or changes any source. */
export async function scorePrepared(value: unknown, options: DecisionOptions = {}): Promise<DecisionResult> {
  const prepared = validatePreparedDecision(value);
  if (options === null || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(key => !['env', 'apiKeyEnv', 'fetch', 'deadlineMs', 'maxRequestBytes', 'maxResponseBytes'].includes(key)) ||
      (options.env !== undefined && (options.env === null || typeof options.env !== 'object' || Array.isArray(options.env))) ||
      (options.fetch !== undefined && typeof options.fetch !== 'function')) reject('invalid_options', 'Scoring options must use the explicit supported provider interface');
  const profile = DECISION_PROFILES[prepared.provider];
  const deadline = options.deadlineMs === undefined ? DECISIONS_DEADLINE_MAX : options.deadlineMs;
  if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > DECISIONS_DEADLINE_MAX) reject('invalid_deadline', 'Scoring deadline must be an integer from one to twenty thousand milliseconds');
  const requestLimit = options.maxRequestBytes === undefined ? DECISIONS_REQUEST_MAX : options.maxRequestBytes;
  const responseLimit = options.maxResponseBytes === undefined ? DECISIONS_RESPONSE_MAX : options.maxResponseBytes;
  if (!Number.isSafeInteger(requestLimit) || requestLimit < 1 || requestLimit > DECISIONS_REQUEST_MAX ||
      !Number.isSafeInteger(responseLimit) || responseLimit < 1 || responseLimit > DECISIONS_RESPONSE_MAX) reject('invalid_limit', 'Scoring byte limits exceed the supported hard bounds');
  if (prepared.request_bytes > requestLimit) reject('request_budget', 'Prepared request exceeds the configured byte limit');
  const keyName = options.apiKeyEnv === undefined ? profile.apiKeyEnv : options.apiKeyEnv;
  if (typeof keyName !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(keyName)) reject('invalid_key_reference', 'API key configuration must name one uppercase environment variable');
  const key = (options.env === undefined ? process.env : options.env)[keyName];
  if (typeof key !== 'string' || key.length === 0 || key.length > 8192 || !/^[\x21-\x7e]+$/.test(key)) reject('credential_unavailable', 'Selected API-key environment variable is unavailable or invalid; no request was attempted');
  const transport = options.fetch === undefined ? globalThis.fetch : options.fetch;
  if (typeof transport !== 'function') reject('transport_unavailable', 'A supported fetch transport is unavailable');
  const wire = bytes(prepared.request);
  const controller = new AbortController();
  const started = performance.now();
  let attempts: 0 | 1 = 0;
  let observedHttpStatus: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlineFailure = new Promise<never>((_resolve, rejectPromise) => {
    timer = setTimeout(() => {
      rejectPromise(new DecisionError('decision_timeout', 'Scoring deadline exceeded; usage is unknown and no retry was attempted', attempts, observedHttpStatus));
      controller.abort();
    }, deadline);
  });
  const execute = async (): Promise<DecisionResult> => {
    attempts = 1;
    const response = await transport(profile.endpoint, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json',
        ...(prepared.provider === 'openrouter' ? {
          'HTTP-Referer': 'https://github.com/lwyBZss8924d/ultrafast-atif-helper',
          'X-Title': 'Ultrafast ATIF Helper',
        } : {}) }, body: wire.toString('utf8'),
    });
    observedHttpStatus = typeof response.status === 'number' && Number.isInteger(response.status) &&
      response.status >= 100 && response.status <= 599 ? response.status : null;
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      reject('provider_http_error', 'Provider rejected the single scoring attempt; no fallback or retry was attempted', 1, observedHttpStatus);
    }
    const responseBytes = await boundedResponse(response, controller.signal, responseLimit);
    let raw: unknown;
    try { raw = parseJson(responseBytes); }
    catch { reject('invalid_response', 'Provider response is invalid JSON, UTF-8 or has duplicate keys', 1); }
    const validated = responseValues(raw, prepared.request, prepared.provider);
    const scores = Object.fromEntries(Object.keys(prepared.pair_map).sort().map(pairId => {
      const mapping = prepared.pair_map[pairId]!;
      return [pairId, { keepCall: validated.answers[mapping.keepCall]!.noul,
        keepResult: validated.answers[mapping.keepResult]!.noul }];
    }));
    if (performance.now() - started >= deadline) reject('decision_timeout', 'Scoring deadline exceeded; usage is unknown and no retry was attempted', 1);
    return { schema_version: 'ultrafast-atif.decision-result.v1', data_class: prepared.data_class,
      status: 'valid_response', http_attempts: 1, model_called: true, provider_profile: prepared.provider, endpoint: profile.endpoint,
      requested_model: prepared.request.model, model: validated.model,
      model_verification: validated.model === null ? 'unavailable' : 'exact_match', provider: validated.provider,
      response_identity_namespace: prepared.provider,
      provider_response_id: validated.id, usage: validated.usage, latency_ms: Math.max(0, Math.round(performance.now() - started)),
      scores, answers: validated.answers,
      evidence: { packet_sha256: prepared.packet_sha256, request_sha256: prepared.request_sha256,
        request_bytes: prepared.request_bytes, pair_map_sha256: prepared.pair_map_sha256,
        response_sha256: sha256(responseBytes), response_bytes: responseBytes.length },
      source_paths_loaded: false, compaction_applied: false, deletion_authorized: false,
      calibration: 'not_established' };
  };
  try { return await Promise.race([execute(), deadlineFailure]); }
  catch (error) {
    if (error instanceof DecisionError) throw new DecisionError(error.code, error.message, error.httpAttempts, error.httpStatus ?? observedHttpStatus);
    return reject('decision_transport_error', 'Scoring transport failed; usage is unknown and no retry was attempted', attempts, observedHttpStatus);
  } finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
}
