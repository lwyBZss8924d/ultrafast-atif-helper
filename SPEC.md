# ultrafast-atif-helper

Ultrafast-atif-helper is a source-preserving fork of fast-jev-compaction, extended
with bounded local trajectory ETL, exact filtering/retrieval and provenance-aware
context views for side-observability workers. The name is a project name, not a
measured performance claim.

## First release outcome

Expose a JSON CLI and TypeScript functions for Codex, Claude Code, Pi JSONL and
ATIF v1.7/v1.8 inputs. Keep original bytes and source version authoritative. Every
normalized record carries a stable generated record ID, source digest/byte range,
format/version, native identity observations and explicit coverage/omissions.

Preserve unknown ATIF extras. Do not relabel NeMo v1.7 output as native v1.8.
Version inspection and migration planning are separate from actual conversion;
qualified trajectory/step references and any lossy transformation must be explicit.

## Interfaces and boundaries

- `ultrafast-atif-helper` supports bounded ingest/inspect, field-selected query,
  exact source retrieval and context-pack/compaction-view operations.
- Deterministic local extraction and query do not call a model or mutate RAW.
- Tool-call/result pairing, recent constraints and user text remain protected in
  compaction views. A Jev score is a decision input, not proof of safe deletion,
  task success or an RSI reward. Original records remain retrievable.
- Jev transport is explicit. The existing GPTgrep/OpenRouter Decisions front door
  is preferred for supported operations. Live calls require a prepared input
  artifact and declared data class; this iteration permits synthetic/redacted
  samples only and keeps real RAW local.
- Source paths are explicitly selected, bounded regular files. Reject credential
  paths, symlinks/FIFOs and unsafe traversal; detect truncation/rotation and avoid
  treating an incomplete final JSONL record as a completed source window.
- Preserve upstream MIT attribution and history. Legacy native plugin code is an
  upstream reference until separately configured and validated; importing the
  helper does not enable a native compaction hook.

## Acceptance

Retain upstream tests and add discriminating cross-format, version, identity,
pair-preservation, window/filter, budget and path-boundary fixtures. Keep actual
native source checks and synthetic model tests separately labelled. Publish only
portable source/protocols and synthetic fixtures, with private evidence excluded.
