# ATIF versions and producer compatibility

Keep the source declaration, actual producer capabilities and a consumer's parser
behavior separate. The formal v1.7-to-v1.8 addition is audio content support. The
other differences below are principally NeMo Relay implementation differences,
not permission to rewrite a version string.

Inspected sources: Harbor 0.23.0 at
`a38eb549b5f3c33d16ccd5c51734b0defff8399e`, and NeMo Relay 0.10.0 alpha at
`893c5586592df9c269dd926140c91b0e94b131e8`. These pins describe the comparison;
future releases require capability checks against their own source and fixtures.

| Surface | RFC/Harbor v1.8 and inspected Relay behavior | Consumer policy |
| --- | --- | --- |
| Version | Relay's native exporter declares ATIF-v1.7. | Retain source version; derived metadata has its own schema. |
| Audio | v1.8 adds typed audio. Relay's recognizer supports text/image. | Opaque retention is not typed-audio support; do not fetch media. |
| Root session | Harbor allows absent/null IDs; Relay DTO requires a session string. | Preserve missing states and producer context. |
| Run/document identity | Run session, trajectory document and step ordinal have different scopes. | Keep client-native and ATIF identity objects distinct. |
| External subagents | RFC references can use trajectory_path; Relay DTO omits that field. | Preserve source JSON; typed Relay round trips can lose the reference. |
| Embedded subagents | Documents have their own step sequences and IDs. | Qualify every step by document/trajectory identity. |
| Unknown core fields | Relay Serde DTOs ignore unknown core keys; Harbor forbids undeclared fields. | Do not use typed reserialization as a lossless archival path. |
| Extra fields | Application extensions belong in extra. | Preserve original extras and retain selectors to unknown content. |
| Checkpoint marks | Direct Relay export omits marks; managed export may retain associated events in extra.observed_events. | Index recognizable metadata marks separately from conversation steps. |
| Cached tokens | Relay combines cache-read and cache-write counts; RFC cached_tokens describes reused input. | Retain producer semantics; never silently turn the aggregate into cache-hit counts or rewards. |
| Cost | Relay can estimate cost from its provider metadata. | Preserve measured/estimated/unknown distinctions. |
| Validation | Harbor's unified model can accept v1.7-labelled audio; default scalar coercion also matters. | Structural validity does not prove declared-version semantic support. |
| Context management | A saved checkpoint is not necessarily a real context replacement. | Do not fabricate context_management or a replacement boundary. |

## Forward handling

1. Archive or retain the exact source bytes and their digest/range.
2. Inspect the literal version and explicit producer hints without executing URLs.
3. Select supported metadata capabilities; retain unknowns and omissions.
4. Use source-qualified records for queries and a separate derived context view.
5. Require an explicit migration plan for any version conversion, with transformed
   fields, source semantics, omissions and validation against the selected target.

The v1.8 checkpoint attachment adapter retains its strict target-version check.
For native v1.7 input, use a standalone checkpoint event or a supported metadata
view; an extension namespace does not make the producer a native v1.8 exporter.
The source remains retrievable even if a consumer cannot interpret every field.

References: [pinned ATIF RFC](https://github.com/harbor-framework/harbor/blob/a38eb549b5f3c33d16ccd5c51734b0defff8399e/rfcs/0001-trajectory-format.md),
[Relay ATIF export](https://docs.nvidia.com/nemo/relay/configure-plugins/observability/atif).
