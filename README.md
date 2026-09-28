# Ultrafast ATIF Helper

Inspect, filter and retrieve bounded local agent trajectories with exact source
pointers. Build a smaller derived context view while preserving original history.
This MIT fork of [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
adds a local metadata and retrieval interface for Codex, Claude, Pi and ATIF.
The project name is not a measured speed claim.

## Install and inspect

For a complete record/recall workflow, use the combined
[Task Checkpoint Record release](https://github.com/lwyBZss8924d/task-checkpoint-record/releases).
It contains a pinned helper and installs both CLIs from one archive.
For standalone source development:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
node bin/ultrafast-atif-helper.mjs --help
```

The helper requires Node 18+. The independent release includes source, Skills,
plugin metadata, checksums and a lightweight container. See
[distribution](docs/distribution.md) for artifact and build contracts.

## Configure the selected provider

Use the same `task-checkpoint.config.v1` file with the standalone helper and the
combined recorder package:

```sh
ultrafast-atif-helper config-init --output "$PWD/task-checkpoint.json"
ultrafast-atif-helper config-check --config "$PWD/task-checkpoint.json"
```

Choose `openrouter` (default) with `OPENROUTER_API_KEY`, or explicit `typesafe`
with `TYPESAFE_API_KEY`. The config contains the selected environment-variable
name; inject its value through your process or secret manager. `prepare-score`
locally validates a separately prepared synthetic/redacted recipe. Only an
explicit `score-prepared` call uses the configured provider. The result can feed
a separate local context-pack operation. See [configuration](docs/configuration.md)
and [prepared scoring](docs/scoring.md) for schemas, bounds and model provenance.
The recorder's native ChatGPT login is a separate configuration section and is
never used by helper scoring.

## Local workflow

Choose a source format and an explicit allowed root. Ingest returns bounded
metadata with byte ranges, digests, literal source version and identity evidence.

```sh
ultrafast-atif-helper ingest --input /absolute/local/source.jsonl \
  --format codex --allow-root /absolute/local --offset 0 \
  --limit 100 --max-bytes 1048576 --json
```

Store the result in a private local page. Select the exact fields and records that
answer the next question:

```sh
ultrafast-atif-helper query --input /absolute/local/page.json \
  --allow-root /absolute/local --filters '{"client":"codex"}' \
  --fields /record_id,/native,/source --limit 20 --offset 0 --json
ultrafast-atif-helper retrieve --input /absolute/local/page.json \
  --record-id SELECTED_ID --allow-root /absolute/local --json
```

Retrieval verifies the selected bytes before returning metadata. Explicit
`--include-body` requests bounded redacted text; that redaction does not prove
all sensitive meaning was removed. `--original --output NEW_PATH` is a separate
operation for copying a verified source slice locally.

Retain `next_offset`, pending-tail and omission information. For continuation,
write the returned source-state observation to a file and supply
`--expected-state STATE_JSON`. Offset-only continuation is labelled unverified;
a bounded cursor anchor does not attest a whole history or reconstruct earlier IDs.

`context-pack` assembles a derived view with source mapping. It preserves pinned
constraints and uncertain call/result relationships, and can consume explicit
local retention scores. Equal call IDs from different sessions, turns or ATIF
document scopes are not joined. No deterministic ETL command calls a model or
rewrites its original input. Optional scoring has a separate prepared-input contract.

## Formats and API

ATIF 1.7/1.8 share many shapes, but compatibility includes producer differences:
audio support, optional session IDs, unknown extras, Relay marks and metric
semantics. The helper preserves literal versions and original source pointers;
`plan --target-version ...` does not convert a trajectory. See the source-pinned
[compatibility matrix](docs/atif-compatibility.md).

The TypeScript API is exported from `ultrafast-atif-helper/helper`:
`ingest`, `inspect`, `query`, `retrieve`, `contextPack` and verification utilities.
Use `src/helper/index.ts` and the typed options for the current contract.
Native IDs, ATIF run/step IDs, logical checkpoint identities and Relay scope IDs
remain separate. Missing evidence is explicit.

## Skills and contributions

Read [llms.txt](llms.txt), [AGENTS.md](AGENTS.md), [SPEC.md](SPEC.md) and the
[helper Skill](skills/ultrafast-atif-helper/SKILL.md). Install the Skill with:

```sh
npx skills add lwyBZss8924d/ultrafast-atif-helper --skill ultrafast-atif-helper
```

The plugin supplies this workflow without activating remote compaction. Original
upstream discovery manifests and README are retained under `upstream-reference/`;
its native hook code remains a source reference. Do not load the inactive manifests
as a plugin. The upstream MIT notice is preserved in [LICENSE](LICENSE).

```sh
npm run typecheck
npm test
python3 scripts/distribution/test_package.py
python3 scripts/distribution/package.py check
```

Keep real trajectories and derived datasets local/private; public fixtures are
synthetic. Retention probabilities do not establish safe deletion, task completion
or reward quality. Native activation, authenticated model behavior and publication
have separate evidence from an offline build or source test.
