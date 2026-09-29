# Unified provider and recorder configuration

`task-checkpoint.config.v1` is a portable JSON contract shared by the standalone
helper and the combined task-checkpoint-record distribution. Both packages include
the same embedded validator, schema and provider templates. Keep one explicit file
and pass it to either CLI; no sibling checkout or second configuration is needed.

```sh
ultrafast-atif-helper config-init --output "$PWD/task-checkpoint.json"
ultrafast-atif-helper config-check --config "$PWD/task-checkpoint.json"
ultrafast-atif-helper config-schema
# When the recorder is installed, this reads the exact same file:
task-checkpoint-record config check --config "$PWD/task-checkpoint.json"
```

Initialization creates a new mode-0600 file in an existing directory and refuses
replacement. Checking never inspects credentials, starts a service or calls a
model. No default config path or credential file is loaded. The Node launcher does
not load dotenv. An operator may inject the selected API key through a secret
manager or the process environment; never place its value in configuration, shell
arguments, Git, model text or a report.

## Scoring selection

The full template has separate `recorder`, `codex`, `scoring` and optional
`agent_service` sections. The helper
consumes only `scoring` for an explicit prepared-scoring operation. It validates the
other sections so the file remains portable, but never authenticates Codex or starts
the recorder because those sections exist.

`agent_service` sets finite recorder-native policy ceilings: concurrency 2,
workers 2, admitted native turns 3 per round, tools 64, deadline 180 seconds,
rounds 2 and external calls 0. Its data policy defaults to `metadata_only` and
can select host-admitted `prepared_fragments`. Native turn counts do not claim
to count hidden provider retries or internal tool-followup model requests.
This section supplies no credentials and never causes the helper to start Codex.

For the recorder's explicit native service, `agent_service.execution_mode`
defaults to `danger-full-access`; `read-only` is also supported.
`agent_service.runtime_update` defaults to `{ "mode": "latest-stable", "root":
null, "check_interval_ms": 14400000 }`. Its null root selects the recorder state's
`codex-runtime` directory. The recorder qualifies official stable full packages
before adopting them between native work cycles. `mode:"pinned"` retains an
explicit `codex.executable`; a future version needs the optional
`codex.qualification_receipt` path. The helper validates these portable fields but
does not read the runtime receipt, download a runtime, invoke auth or change the
recorder's task state.

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

The default provider is OpenRouter Decisions. To select direct TypeSafe explicitly,
initialize using `--provider typesafe`, or set `provider: "typesafe"`,
`model: "jev-1.13.0"` and `api_key_env: "TYPESAFE_API_KEY"`. Example files for both
providers are included under `config/`. Custom environment variable names are
accepted; inline key values, endpoints, fallback providers and unsupported models
are rejected. The fixed provider profiles own their API routes. `jev-router` is a
text routing model and is not an allowed Decisions profile.
Runtime/profile/preload/routing variables such as `HOME`, `BUN_OPTIONS`,
`NODE_OPTIONS` and `HTTPS_PROXY` cannot be used as credential references.

```sh
ultrafast-atif-helper prepare-score --config "$PWD/task-checkpoint.json" \
  --input "$PWD/prepared-recipe.json" --allow-root "$PWD" \
  --output "$PWD/prepared-packet.json" --json
# Inject only the selected provider key through your process/secret manager.
ultrafast-atif-helper score-prepared --config "$PWD/task-checkpoint.json" \
  --input "$PWD/prepared-packet.json" --allow-root "$PWD" --json
```

Preparation validates separately supplied synthetic or deliberately redacted input
locally. It fills only absent provider/model fields from the selected config and
rejects explicit mismatches. The prepared packet binds both values. Scoring requires
an exact match with the selected config before key lookup or HTTP. A TypeSafe
packet requires an explicitly selected TypeSafe config. A missing key fails without
falling back to another account or provider. The environment is consumed only by
the explicit scoring operation, not by config validation or deterministic ETL.

Bounds may be reduced but not raised above a 20-second deadline, 64-KiB request or
1-MiB response. An explicit scoring deadline flag can further constrain the call;
it cannot enlarge the configured deadline. There is no automatic retry. A
probability is a retention suggestion, not calibrated score quality, a reward or
authorization to delete source records. Local ETL and context-pack never upload
real RAW automatically.

## Shared configuration rules

Unknown fields, duplicate JSON keys, wrong types, unsupported schema versions,
models and providers fail. Files are bounded to 64 KiB; credential-like names,
symlinks and hardlinks are rejected. Errors contain bounded codes and do not echo
configuration values. `config-check` reports resolved non-secret settings and key
variable names, without testing provider access or native login.

Filesystem paths resolve against the selected config file directory, independently
of the invoking cwd. Paths are literal: no `~`, `$VARIABLE` or parent components.
The helper command's executable can be a bare PATH name or a config-relative path;
remaining argv elements remain literal. Scoring has no endpoint or data-source path
field, and accepting a path in another section does not cause the helper to read it.

When installed with the recorder, `recorder.state_dir` and bounded worker settings
feed its explicit state/service commands. `codex.executable`, `codex.home` and role
models feed explicit recorder auth/model APIs. Their defaults are supervisor
`gpt-6-sol`/`medium`, semantic worker `gpt-6-luna`/`medium` and evaluation
`gpt-6-luna`/`high`. Native ChatGPT login and provider API keys stay separate.

For recorder provisioning, follow the
[recorder configuration guide](https://github.com/lwyBZss8924d/task-checkpoint-record/blob/main/docs/configuration.md).
Its `auth plan/setup/login/status --config FILE` front door uses a dedicated
persistent Codex home, never copies credentials and refuses to overwrite an
existing profile. The combined archive includes that guide and CLI locally.
