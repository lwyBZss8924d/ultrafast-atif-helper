> Package reference from `docs/scoring.md`. Run repository-relative examples from a selected source or release directory; installed CLI commands use the installed executable.

# Optional prepared-input scoring

Local ingest, inspection, query, retrieval and context-pack commands never call a
model. Scoring is a separate explicit operation on a previously prepared JSON
packet. It does not discover RAW, load source paths in the packet, extract
transcript bodies, apply compaction or authorize deletion.

Only caller-declared `synthetic` and `redacted` inputs are accepted. This
classification is an **attestation by the caller**, not an automatic redaction or
privacy check. Inspect and freeze the exact outgoing state and questions before
admission. Keep real RAW, private locator mappings and unredacted histories local.

## Provider profiles

| Explicit profile | Fixed endpoint | Fixed requested model | Default environment reference |
| --- | --- | --- | --- |
| `openrouter`, the default | `https://openrouter.ai/api/alpha/decisions` | `typesafe/jev-1.13-20260917` | `OPENROUTER_API_KEY` |
| `typesafe`, explicit selection only | `https://api.typesafe.ai/v1/systemone` | `jev-1.13.0` | `TYPESAFE_API_KEY` |

OpenRouter requests contain `provider.allow_fallbacks=false`. Direct TypeSafe
requests contain only `model`, `state` and `questions`; OpenRouter routing fields
are not sent to that API. There is no model, provider, key-name or endpoint
fallback. Changing a provider creates a different prepared packet.

Only OpenRouter receives fixed public application-attribution headers:
`HTTP-Referer: https://github.com/lwyBZss8924d/ultrafast-atif-helper` and
`X-Title: Ultrafast ATIF Helper`. No session/private identifiers are included.
The request digest covers canonical JSON body bytes, not HTTP headers or
credentials. Attribution is an observability feature, not an established remedy
for any earlier provider failure.

The OpenRouter contract follows the official
[Decisions API reference](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request)
and its Decisions Skill `parseRequest` / `decide` HTTP shapes; the inspected
helper-library SHA-256 was
`d6aad5cd482eb8f6029fa5b66f167a4eda70a5ab03012a1139df5876bb485692`.
This package specializes those shapes to bounded Noul retention questions and
does not include the SDK or catalog/compare workflows. Direct TypeSafe uses its
[System One contract](https://docs.typesafe.ai/api),
[versioned model](https://docs.typesafe.ai/models), and
[environment-variable convention](https://docs.typesafe.ai/sdk/python/api/constants).

## One shared configuration

The helper and recorder use `task-checkpoint.config.v1`. Configuration contains
environment **names**, not credentials, and cannot override provider endpoints.
The scoring section is:

```json
{
  "schema_version": "task-checkpoint.config.v1",
  "scoring": {
    "provider": "openrouter",
    "model": "typesafe/jev-1.13-20260917",
    "api_key_env": "OPENROUTER_API_KEY",
    "limits": {
      "deadline_ms": 20000,
      "max_request_bytes": 65536,
      "max_response_bytes": 1048576
    }
  }
}
```

```sh
ultrafast-atif-helper config-init --output /absolute/work/config.json --json
ultrafast-atif-helper config-check --config /absolute/work/config.json --json
ultrafast-atif-helper config-schema --json

# Select the direct API explicitly in a separate new configuration file.
ultrafast-atif-helper config-init \
  --output /absolute/work/typesafe-config.json --provider typesafe --json
```

`config-init` creates a new owner-only file; it does not overwrite one.
`--config` is accepted as an exclusive output-path alias for that command;
supplying both output flags fails.
`config-check` resolves literal relative paths against the selected config
directory, reads no environment values, performs no login and starts no service.
See [configuration](configuration.md) for the recorder and Codex sections.

The CLI defaults to OpenRouter when `--config` is absent. With a selected config,
preparation fills only absent recipe provider/model fields and rejects explicit
mismatches. Scoring requires the prepared provider/model to match the selected
configuration. A direct TypeSafe packet therefore requires the direct-provider
configuration on the CLI. The programmatic API can select TypeSafe explicitly
in its recipe without loading a configuration file.

## Prepare a small synthetic recipe

The recipe carries a caller-owned state, typed Noul questions and a local pair
map. There must be exactly two distinct questions per pair, at most 32 pairs /
64 questions, with every question mapped once. Questions ask independent
judgments; their IDs are correlation keys, so instructions must carry the actual
meaning and refer to the supplied state.

```json
{
  "data_class": "synthetic",
  "provider": "openrouter",
  "model": "typesafe/jev-1.13-20260917",
  "state": {
    "candidate": {
      "tool": "Read",
      "excerpt": "Synthetic obsolete scratch output."
    }
  },
  "questions": {
    "retain_call": {
      "type": "noul",
      "instructions": "Does candidate describe a call needed for the synthetic follow-up?",
      "criteria": {
        "true": "The call is needed.",
        "false": "The call is not needed."
      }
    },
    "retain_result": {
      "type": "noul",
      "instructions": "Does candidate.excerpt contain information required for the synthetic follow-up?"
    }
  },
  "pair_map": {
    "local-pair-1": {
      "keepCall": "retain_call",
      "keepResult": "retain_result"
    }
  }
}
```

```sh
ultrafast-atif-helper prepare-score \
  --input /absolute/work/recipe.json \
  --allow-root /absolute/work \
  --config /absolute/work/config.json \
  --output /absolute/work/prepared.json --json
```

Preparation performs no HTTP request or credential lookup. It stores
`ultrafast-atif.prepared-decision.v1` with the explicit provider, data class,
canonical request, local pair map and SHA-256 bindings for the wire bytes, pair
map and whole logical packet. The local pair map is **excluded from the HTTP
body**. These digests detect changed preparation; they are not signatures,
privacy attestations or authorization decisions.

Do not substitute a moving model alias, add routing fields, or edit a prepared
packet in place. Prepare a new packet after an intentional recipe/config change.
The manifest is capped at 128 KiB; actual request bytes are capped at 64 KiB.
Byte limits are not token counts or billing estimates.

## Make one explicit attempt

Use a trusted environment or secret-injection mechanism to supply only the
selected credential variable. The helper never accepts a key in an argument or
configuration file and never searches credential files.

```sh
ultrafast-atif-helper score-prepared \
  --input /absolute/work/prepared.json \
  --allow-root /absolute/work \
  --config /absolute/work/config.json \
  --deadline-ms 20000 --json
```

The packet and configured limits are validated before the selected environment
entry is read. One HTTP attempt goes to the selected fixed HTTPS endpoint.
Redirects fail; there is no retry, split, provider fallback or alternate model.
The deadline is at most 20 seconds, response bytes at most 1 MiB, and configured
limits can be smaller. `--deadline-ms` may narrow the configured limit, never
widen it.

Returned answer IDs must exactly match the prepared questions. Every answer
must be a Noul with a finite numeric value in [0,1]; booleans, missing answers,
wrong types and out-of-range values fail. Duplicate JSON keys fail. Supplied
confidence must be a probability. This narrow profile accepts optional Noul
distributions only with literal `true`/`false` keys, a bounded sum and agreement
with the Noul value.

OpenRouter must return the exact requested canonical model. Direct TypeSafe
also rejects a present wrong model, but an absent/null observed model remains
`model:null` with `model_verification:"unavailable"`. It is never replaced with
the requested value. Missing provider/request IDs and usage remain null; measured
zero stays numeric zero. `provider_profile` and `response_identity_namespace`
distinguish the two APIs, rather than manufacturing OpenRouter generation
semantics for direct TypeSafe.

The result contains:

- `scores` keyed by the unchanged local pair IDs, each with `keepCall` and
  `keepResult`.
- Requested model, observed model status, returned provider/request ID when
  present, available input/output usage and cost, and adapter elapsed time.
- Prepared packet, request, pair-map and exact response digests/byte counts.
- Explicit `compaction_applied:false`, `deletion_authorized:false` and
  `calibration:"not_established"`.

On a failed attempted call the CLI exits nonzero, reports one HTTP attempt and
an unknown outcome/usage, and emits no score defaults. Error messages never
include the key, request state, provider body or arbitrary transport exception.
Do not treat an HTTP request attempt as proof that a model completed.
Scoring errors retain `http_status` only when an actual integer status in
100–599 was observed; otherwise it is null. A 200 response with invalid contents
can therefore be distinguished from a 401/429/503 response or a transport failure.
No response body or request-ID header is copied into these error diagnostics.

## Programmatic composition

```typescript
import {
  prepareDecision, scorePrepared, contextPack,
} from "ultrafast-atif-helper/helper";

const prepared = prepareDecision(recipe); // pure; no file/config/environment reads
const result = await scorePrepared(prepared, {
  apiKeyEnv: "OPENROUTER_API_KEY",
  deadlineMs: 20000,
  maxRequestBytes: 65536,
  maxResponseBytes: 1048576,
});

// A separately authorized local operation may use result.scores.
// Pair IDs must already map to the locally verified record set.
const view = contextPack(records, {
  allowRoots,
  scores: result.scores,
});
```

The scorer does not call `contextPack` itself. Existing context-view constraints,
pair scopes, ancestry, protected records and source verification still apply.
Do not treat a probability as proof that evidence is safe to remove, that a task
succeeded, or that an RSI reward was earned.

Tests inject a fake fetch function and a synthetic environment map; neither
provider nor the real credential environment is accessed. Direct TypeSafe
coverage is source-contract/mock acceptance only. A small live synthetic
OpenRouter probe, when separately admitted and receipted, does not calibrate
thresholds or establish real-history compaction quality.

```sh
npx --no-install vitest run tests/decisions.test.ts
npm run typecheck
```
