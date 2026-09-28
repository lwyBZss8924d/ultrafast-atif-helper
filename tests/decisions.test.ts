import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { canonical, sha256 } from '../src/helper/io.js';
import { DECISIONS_ENDPOINT, DECISIONS_MODEL, TYPESAFE_ENDPOINT, TYPESAFE_MODEL, DECISIONS_RESPONSE_MAX, DecisionError,
  prepareDecision, scorePrepared, validatePreparedDecision } from '../src/helper/decisions.js';

const recipe = () => ({
  data_class: 'synthetic', model: DECISIONS_MODEL,
  state: { candidate: { tool: 'Read', excerpt: 'Synthetic obsolete scratch output.' } },
  questions: {
    retain_call: { type: 'noul', instructions: 'Does candidate describe a call needed for the synthetic follow-up?',
      criteria: { true: 'The call is needed.', false: 'The call is not needed.' } },
    retain_result: { type: 'noul', instructions: 'Does candidate.excerpt contain information required for the synthetic follow-up?' },
  },
  pair_map: { 'local-pair-only:file:///private/synthetic/source': { keepCall: 'retain_call', keepResult: 'retain_result' } },
});
const response = () => ({
  id: 'synthetic-response', model: DECISIONS_MODEL, provider: 'TypeSafe',
  answers: { retain_call: { type: 'noul', noul: 0 }, retain_result: { type: 'noul', noul: 0.75 } },
  usage: { input_tokens: 10, output_tokens: 4, cost: 0 },
});
const fakeEnv = { OPENROUTER_API_KEY: 'synthetic-test-key' };
const fakeResponse = (value = response()) => new Response(JSON.stringify(value), { status: 200 });

let root: string;
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prepared-decisions-'))); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('local preparation', () => {
  it('prepares stable digests and excludes the local pair map from wire bytes', () => {
    const first = prepareDecision(recipe());
    const second = prepareDecision(recipe());
    expect(canonical(first)).toBe(canonical(second));
    expect(first.request.provider!.allow_fallbacks).toBe(false);
    expect(first.request.model).toBe(DECISIONS_MODEL);
    expect(first.request_sha256).toBe(sha256(Buffer.from(canonical(first.request))));
    expect(canonical(first.request)).not.toContain('private/synthetic');
    expect(first.request).not.toHaveProperty('pair_map');
  });

  it.each(['real_raw', 'local_raw', '', null, false])('rejects disallowed data class %s', dataClass => {
    expect(() => prepareDecision({ ...recipe(), data_class: dataClass })).toThrow(/synthetic or redacted/);
  });

  it('accepts explicit redacted classification without claiming a content audit', () => {
    expect(prepareDecision({ ...recipe(), data_class: 'redacted' }).data_class).toBe('redacted');
  });

  it.each([null, false, 0, '', 'auto'])('rejects invalid explicit provider %s instead of defaulting', provider => {
    expect(() => prepareDecision({ ...recipe(), provider })).toThrow(/Select/);
  });

  it('rejects moving models, extra routing and unbounded requests before any environment access', async () => {
    expect(() => prepareDecision({ ...recipe(), model: 'typesafe/jev-1.13' })).toThrow(/pinned model/);
    expect(() => prepareDecision({ ...recipe(), endpoint: 'https://other.invalid' })).toThrow();
    expect(() => prepareDecision({ ...recipe(), state: 'x'.repeat(65536) })).toThrow(/64 KiB/);
    const env = Object.defineProperty({}, 'OPENROUTER_API_KEY', { get: () => { throw new Error('environment must not be read'); } });
    await expect(scorePrepared({ schema_version: 'invalid' }, { env })).rejects.toMatchObject({ httpAttempts: 0 });
  });

  it('requires complete distinct Noul pair mappings and rejects malformed prepared digests', () => {
    const same = recipe(); same.pair_map['local-pair-only:file:///private/synthetic/source'].keepResult = 'retain_call';
    expect(() => prepareDecision(same)).toThrow(/distinct/);
    const wrongType = recipe(); wrongType.questions.retain_call.type = 'score';
    expect(() => prepareDecision(wrongType)).toThrow(/Noul/);
    const prepared = prepareDecision(recipe()); prepared.request_sha256 = '0'.repeat(64);
    expect(() => validatePreparedDecision(prepared)).toThrow(/changed/);
    const changedClass = prepareDecision(recipe()); changedClass.data_class = 'redacted';
    expect(() => validatePreparedDecision(changedClass)).toThrow(/changed/);
    const changedRouting = prepareDecision(recipe()) as unknown as { request: { provider: { allow_fallbacks: unknown } } };
    changedRouting.request.provider.allow_fallbacks = 0;
    expect(() => validatePreparedDecision(changedRouting)).toThrow(/routing/);
  });
});

describe('one-attempt transport and response validation', () => {
  it('uses the explicit TypeSafe route, bare model and selected key namespace only', async () => {
    const prepared = prepareDecision({ ...recipe(), provider: 'typesafe', model: TYPESAFE_MODEL });
    expect(prepared.request).not.toHaveProperty('provider');
    const env = Object.defineProperty({ TYPESAFE_API_KEY: 'synthetic-typesafe-key' }, 'OPENROUTER_API_KEY',
      { get: () => { throw new Error('wrong credential namespace read'); } });
    const fetcher = vi.fn(async (_url: unknown, _init: unknown) => {
      const value = { model: TYPESAFE_MODEL, answers: response().answers, usage: response().usage };
      return new Response(JSON.stringify(value));
    });
    const result = await scorePrepared(prepared, { env, fetch: fetcher as typeof fetch });
    expect(fetcher.mock.calls[0]![0]).toBe(TYPESAFE_ENDPOINT);
    const wire = JSON.parse((fetcher.mock.calls[0]![1] as RequestInit).body as string);
    const headers = new Headers((fetcher.mock.calls[0]![1] as RequestInit).headers);
    expect(headers.has('HTTP-Referer')).toBe(false);
    expect(headers.has('X-Title')).toBe(false);
    expect(wire.model).toBe(TYPESAFE_MODEL);
    expect(wire).not.toHaveProperty('provider');
    expect(result).toMatchObject({ provider_profile: 'typesafe', response_identity_namespace: 'typesafe',
      model: TYPESAFE_MODEL, provider: null, provider_response_id: null, http_attempts: 1 });
  });

  it('never falls back between provider keys, models or routing shapes', async () => {
    const ts = prepareDecision({ ...recipe(), provider: 'typesafe', model: TYPESAFE_MODEL });
    const fetcher = vi.fn(async () => fakeResponse());
    await expect(scorePrepared(ts, { env: fakeEnv, fetch: fetcher as typeof fetch }))
      .rejects.toMatchObject({ code: 'credential_unavailable', httpAttempts: 0 });
    await expect(scorePrepared(prepareDecision(recipe()), { env: { TYPESAFE_API_KEY: 'synthetic-key' }, fetch: fetcher as typeof fetch }))
      .rejects.toMatchObject({ code: 'credential_unavailable', httpAttempts: 0 });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(scorePrepared(ts, { env: { TYPESAFE_API_KEY: 'synthetic-key' }, fetch: fetcher as typeof fetch }))
      .rejects.toMatchObject({ code: 'invalid_response', httpAttempts: 1 });
    const injected = structuredClone(ts);
    injected.request.provider = { allow_fallbacks: false };
    expect(() => validatePreparedDecision(injected)).toThrow(/routing/);
  });

  it('preserves unavailable TypeSafe model and request identity without manufacturing them', async () => {
    const prepared = prepareDecision({ ...recipe(), provider: 'typesafe', model: TYPESAFE_MODEL });
    const result = await scorePrepared(prepared, { env: { TYPESAFE_API_KEY: 'synthetic-key' },
      fetch: (async () => new Response(JSON.stringify({ answers: response().answers }))) as typeof fetch });
    expect(result).toMatchObject({ requested_model: TYPESAFE_MODEL, model: null,
      model_verification: 'unavailable', provider_response_id: null, response_identity_namespace: 'typesafe' });
    await expect(scorePrepared(prepareDecision(recipe()), { env: fakeEnv,
      fetch: (async () => new Response(JSON.stringify({ answers: response().answers }))) as typeof fetch }))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('honors named key injection and narrowed caps without implicit null defaults', async () => {
    const prepared = prepareDecision(recipe());
    const fetcher = vi.fn(async () => fakeResponse());
    await expect(scorePrepared(prepared, { env: { CUSTOM_JEV_KEY: 'synthetic-key' }, apiKeyEnv: 'CUSTOM_JEV_KEY',
      fetch: fetcher as typeof fetch })).resolves.toHaveProperty('scores');
    const environment = Object.defineProperty({}, 'OPENROUTER_API_KEY', { get: () => { throw new Error('must validate before key access'); } });
    await expect(scorePrepared(prepared, { env: environment, maxRequestBytes: 1, fetch: fetcher as typeof fetch }))
      .rejects.toMatchObject({ code: 'request_budget', httpAttempts: 0 });
    for (const options of [{ env: null }, { fetch: null }, { deadlineMs: null }, { maxResponseBytes: null }, { apiKeyEnv: null }]) {
      await expect(scorePrepared(prepared, options as never)).rejects.toMatchObject({ httpAttempts: 0 });
    }
    await expect(scorePrepared(prepared, { env: fakeEnv, maxResponseBytes: 10, fetch: fetcher as typeof fetch }))
      .rejects.toMatchObject({ code: 'response_budget', httpAttempts: 1 });
  });
  it('emits a validated zero, stable local score map and provider evidence with one request', async () => {
    const fetcher = vi.fn(async (_url: unknown, _init: unknown) => fakeResponse());
    const prepared = prepareDecision(recipe());
    const result = await scorePrepared(prepared, { env: fakeEnv, fetch: fetcher as typeof fetch });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(DECISIONS_ENDPOINT);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('HTTP-Referer')).toBe('https://github.com/lwyBZss8924d/ultrafast-atif-helper');
    expect(headers.get('X-Title')).toBe('Ultrafast ATIF Helper');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.provider.allow_fallbacks).toBe(false);
    expect(body).not.toHaveProperty('pair_map');
    expect(JSON.stringify(body)).not.toContain('private/synthetic');
    expect(result.scores).toEqual({ 'local-pair-only:file:///private/synthetic/source': { keepCall: 0, keepResult: 0.75 } });
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 4, cost: 0 });
    expect(result).toMatchObject({ provider: 'TypeSafe', provider_response_id: 'synthetic-response',
      http_attempts: 1, compaction_applied: false, deletion_authorized: false, calibration: 'not_established' });
    expect(JSON.stringify(result)).not.toContain(fakeEnv.OPENROUTER_API_KEY);
  });

  it('keeps missing usage unavailable, not measured zero', async () => {
    const value = response() as Record<string, unknown>; delete value.usage; delete value.id; delete value.provider;
    const result = await scorePrepared(prepareDecision(recipe()), { env: fakeEnv,
      fetch: (async () => new Response(JSON.stringify(value))) as typeof fetch });
    expect(result.usage).toEqual({ input_tokens: null, output_tokens: null, cost: null });
    expect(result.provider_response_id).toBeNull();
    expect(result.provider).toBeNull();
  });

  it.each([false, null, -0.1, 1.1, '0', NaN])('never converts invalid Noul %s to zero', async bad => {
    const value = response(); (value.answers.retain_call as { noul: unknown }).noul = bad;
    const fetcher = vi.fn(async () => fakeResponse(value));
    await expect(scorePrepared(prepareDecision(recipe()), { env: fakeEnv, fetch: fetcher as typeof fetch }))
      .rejects.toMatchObject({ code: 'invalid_response', httpAttempts: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects wrong/missing/extra answer identities and exact model drift', async () => {
    const variants: Record<string, unknown>[] = [];
    const missing = response() as Record<string, unknown>; missing.answers = { retain_call: { type: 'noul', noul: 0.5 } }; variants.push(missing);
    const extra = response() as Record<string, unknown>; extra.answers = { ...response().answers, extra: { type: 'noul', noul: 0.5 } }; variants.push(extra);
    variants.push({ ...response(), model: 'typesafe/jev-1.13' }, { ...response(), provider: 'other-provider' });
    for (const value of variants) await expect(scorePrepared(prepareDecision(recipe()), { env: fakeEnv,
      fetch: (async () => new Response(JSON.stringify(value))) as typeof fetch })).rejects.toMatchObject({ code: 'invalid_response', httpAttempts: 1 });
  });

  it('checks supplied Noul distributions, confidence and usage scalar types', async () => {
    const good = response() as Record<string, unknown>;
    good.answers = { ...response().answers, retain_call: { type: 'noul', noul: 0, probabilities: { true: 0, false: 1 }, confidence: 0 } };
    await expect(scorePrepared(prepareDecision(recipe()), { env: fakeEnv,
      fetch: (async () => new Response(JSON.stringify(good))) as typeof fetch })).resolves.toHaveProperty('scores');
    for (const answer of [
      { type: 'noul', noul: 0, probabilities: { true: 1, false: 0 } },
      { type: 'noul', noul: 0, probabilities: { true: 0, false: 0 } },
      { type: 'noul', noul: 0, confidence: false },
    ]) await expect(scorePrepared(prepareDecision(recipe()), { env: fakeEnv,
      fetch: (async () => new Response(JSON.stringify({ ...response(), answers: { ...response().answers, retain_call: answer } }))) as typeof fetch })).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(scorePrepared(prepareDecision(recipe()), { env: fakeEnv,
      fetch: (async () => new Response(JSON.stringify({ ...response(), usage: { cost: false } }))) as typeof fetch })).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('rejects duplicate JSON keys and never echoes provider error bodies', async () => {
    const duplicate = JSON.stringify(response()).replace('"noul":0', '"noul":0,"noul":1');
    await expect(scorePrepared(prepareDecision(recipe()), { env: fakeEnv,
      fetch: (async () => new Response(duplicate)) as typeof fetch })).rejects.toMatchObject({ code: 'invalid_response' });
    for (const status of [302, 400, 401, 402, 403, 404, 429, 500, 502, 503, 524, 529]) {
      const fetcher = vi.fn(async () => new Response('DO_NOT_ECHO_PROVIDER_BODY', { status }));
      const failure = await scorePrepared(prepareDecision(recipe()), { env: fakeEnv, fetch: fetcher as typeof fetch }).catch(error => error as DecisionError);
      expect(failure).toBeInstanceOf(DecisionError);
      expect(failure.httpStatus).toBe(status);
      expect(String(failure)).not.toContain('DO_NOT_ECHO');
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('retains status for invalid successful responses and omits invented non-HTTP status', async () => {
    await expect(scorePrepared(prepareDecision(recipe()), { env: fakeEnv,
      fetch: (async () => new Response('invalid JSON', { status: 200 })) as typeof fetch }))
      .rejects.toMatchObject({ code: 'invalid_response', httpStatus: 200, httpAttempts: 1 });
    await expect(scorePrepared(prepareDecision(recipe()), { env: fakeEnv,
      fetch: (async () => { throw new Error('private transport detail'); }) as typeof fetch }))
      .rejects.toMatchObject({ code: 'decision_transport_error', httpStatus: null, httpAttempts: 1 });
    for (const value of [undefined, null, 0, 99, 600, 401.5, '401', false]) {
      expect(new DecisionError('test', 'safe', 1, value).httpStatus).toBeNull();
    }
    expect(new DecisionError('test', 'safe', 0, 401).httpStatus).toBeNull();
  });

  it('enforces response caps and an independent finite deadline without retries', async () => {
    const large = new Response('x'.repeat(DECISIONS_RESPONSE_MAX + 1));
    await expect(scorePrepared(prepareDecision(recipe()), { env: fakeEnv,
      fetch: (async () => large) as typeof fetch })).rejects.toMatchObject({ code: 'response_budget', httpAttempts: 1 });
    const fetcher = vi.fn(async () => new Promise<Response>(() => {}));
    await expect(scorePrepared(prepareDecision(recipe()), { env: fakeEnv,
      fetch: fetcher as typeof fetch, deadlineMs: 10 })).rejects.toMatchObject({ code: 'decision_timeout', httpAttempts: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(scorePrepared(prepareDecision(recipe()), { env: {},
      fetch: fetcher as typeof fetch })).rejects.toMatchObject({ code: 'credential_unavailable', httpAttempts: 0 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('freezes the prepared mapping and request before awaiting the injected transport', async () => {
    const prepared = prepareDecision(recipe());
    const fetcher = vi.fn(async () => {
      prepared.pair_map['local-pair-only:file:///private/synthetic/source']!.keepCall = 'retain_result';
      return fakeResponse();
    });
    const result = await scorePrepared(prepared, { env: fakeEnv, fetch: fetcher as typeof fetch });
    expect(result.scores).toEqual({ 'local-pair-only:file:///private/synthetic/source': { keepCall: 0, keepResult: 0.75 } });
  });
});

describe('public CLI with isolated synthetic environment', () => {
  const run = (script: string, ...args: string[]) => {
    const launcher = path.join(root, 'launcher.mjs');
    fs.writeFileSync(launcher, 'import { main } from ' + JSON.stringify(pathToFileURL(path.resolve('src/helper/cli.ts')).href) + ';\n' + script + '\nawait main();\n');
    return spawnSync(process.execPath, ['--import', 'tsx', launcher, ...args], { cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8', timeout: 3000 });
  };
  it('prepares locally, scores through an injected fake fetch, and never runs compaction', () => {
    const input = path.join(root, 'recipe.json'); fs.writeFileSync(input, JSON.stringify(recipe()));
    const prepared = path.join(root, 'prepared.json');
    const preparation = run('globalThis.fetch = () => { throw new Error("network forbidden"); };',
      'prepare-score', '--input', input, '--allow-root', root, '--output', prepared, '--json');
    expect(preparation.status).toBe(0);
    expect(JSON.parse(preparation.stdout).http_attempts).toBe(0);
    const script = 'process.env.OPENROUTER_API_KEY = "synthetic-test-key"; globalThis.fetch = async () => new Response(' + JSON.stringify(JSON.stringify(response())) + ');';
    const scored = run(script, 'score-prepared', '--input', prepared, '--allow-root', root, '--json');
    expect(scored.status).toBe(0);
    expect(JSON.parse(scored.stdout)).toMatchObject({ http_attempts: 1, model: DECISIONS_MODEL, compaction_applied: false });
    const missing = run('globalThis.fetch = () => { throw new Error("network forbidden"); };',
      'score-prepared', '--input', prepared, '--allow-root', root, '--json');
    expect(missing.status).toBe(1);
    expect(JSON.parse(missing.stderr)).toMatchObject({ code: 'credential_unavailable', http_attempts: 0, model_called: false });
  });

  it('reports attempted-unknown after a failed scoring call and help exposes the exact commands', () => {
    const file = path.join(root, 'prepared.json'); fs.writeFileSync(file, canonical(prepareDecision(recipe())));
    const failed = run('process.env.OPENROUTER_API_KEY = "synthetic-test-key"; globalThis.fetch = async () => { throw new Error("DO_NOT_ECHO"); };',
      'score-prepared', '--input', file, '--allow-root', root, '--json');
    expect(failed.status).toBe(1);
    expect(failed.stderr).not.toContain('DO_NOT_ECHO');
    expect(JSON.parse(failed.stderr)).toMatchObject({ http_attempts: 1, http_status: null, model_called: null, scores_available: false, usage: null });
    const help = run('', '--help');
    expect(help.status).toBe(0);
    expect(JSON.parse(help.stdout).commands['score-prepared']).toContain('--deadline-ms');
  });

  it('reports only bounded HTTP status for a failed CLI attempt without provider body or headers', () => {
    const file = path.join(root, 'prepared.json'); fs.writeFileSync(file, canonical(prepareDecision(recipe())));
    const script = 'process.env.OPENROUTER_API_KEY = "synthetic-test-key"; globalThis.fetch = async () => new Response("DO_NOT_ECHO_BODY", {status:401,headers:{"x-request-id":"DO_NOT_ECHO_HEADER"}});';
    const failed = run(script, 'score-prepared', '--input', file, '--allow-root', root, '--json');
    expect(failed.status).toBe(1);
    expect(JSON.parse(failed.stderr)).toMatchObject({ code: 'provider_http_error', http_status: 401, http_attempts: 1, scores_available: false });
    expect(failed.stderr).not.toContain('DO_NOT_ECHO');
    expect(failed.stderr).not.toContain('synthetic-test-key');
    expect(failed.stdout).toBe('');
  });

  it('uses unified explicit TypeSafe config and rejects cross-profile packets before key lookup', () => {
    const config = path.join(root, 'task-checkpoint.config.json');
    const created = run('', 'config-init', '--output', config, '--provider', 'typesafe', '--json');
    expect(created.status).toBe(0);
    expect(fs.statSync(config).mode & 0o777).toBe(0o600);
    const checked = run('', 'config-check', '--config', config, '--json');
    expect(checked.status).toBe(0);
    expect(JSON.parse(checked.stdout).config.scoring).toMatchObject({ provider: 'typesafe', model: TYPESAFE_MODEL, api_key_env: 'TYPESAFE_API_KEY' });
    const input = path.join(root, 'recipe.json');
    const value: Record<string, unknown> = recipe(); delete value.model;
    fs.writeFileSync(input, JSON.stringify(value));
    const packet = path.join(root, 'typesafe-prepared.json');
    const prepared = run('', 'prepare-score', '--input', input, '--allow-root', root, '--config', config, '--output', packet, '--json');
    expect(prepared.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(packet, 'utf8')).provider).toBe('typesafe');
    const wrong = run('globalThis.fetch = () => { throw new Error("must not call"); };',
      'score-prepared', '--input', packet, '--allow-root', root, '--json');
    expect(wrong.status).toBe(1);
    expect(JSON.parse(wrong.stderr)).toMatchObject({ code: 'config_packet_mismatch', http_attempts: 0 });
    const directResponse = JSON.stringify({ model: TYPESAFE_MODEL, answers: response().answers, usage: response().usage });
    const script = 'process.env.TYPESAFE_API_KEY = "synthetic-typesafe-key"; globalThis.fetch = async (url,init) => { if(url !== ' +
      JSON.stringify(TYPESAFE_ENDPOINT) + ' || "provider" in JSON.parse(init.body)) throw new Error("wrong direct route"); return new Response(' + JSON.stringify(directResponse) + '); };';
    const scored = run(script, 'score-prepared', '--input', packet, '--allow-root', root, '--config', config, '--json');
    expect(scored.status).toBe(0);
    expect(JSON.parse(scored.stdout)).toMatchObject({ provider_profile: 'typesafe', model: TYPESAFE_MODEL, provider_response_id: null });
    const schema = run('', 'config-schema', '--json');
    expect(schema.status).toBe(0);
    expect(JSON.parse(schema.stdout).properties.schema_version.const).toBe('task-checkpoint.config.v1');
    const conflict = run('', 'config-init', '--output', path.join(root, 'new-a.json'),
      '--config', path.join(root, 'new-b.json'), '--json');
    expect(conflict.status).toBe(1);
    expect(fs.existsSync(path.join(root, 'new-a.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'new-b.json'))).toBe(false);
  });
});
