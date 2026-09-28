> Package reference from `docs/distribution.md`. Run repository-relative examples from a selected source or release directory; installed CLI commands use the installed executable.

# Distribution and plugin safety

The repository includes a Node CLI/API, self-contained package Skills, a portable
root `plugin.json`, and the supported `.codex-plugin/plugin.json` compatibility
manifest. Both identify `ultrafast-atif-helper` and discover the same `skills/`
directory. The plugin supplies workflows for local inspection and bounded
retrieval; installing it starts no process, daemon, MCP connection or model call.
The CLI has a separate explicit installation step.

This packaging follows [OpenAI's plugin guidance](https://developers.openai.com/plugins/build/plugins).
Build scripts do not edit a personal/global marketplace. Publication to a public
repository is separate from admission to the ChatGPT/Codex public Plugins Directory.

`scripts/distribution/skill-docs.py` projects canonical docs and selected public
configuration templates into the Skill's own `references/` directory. Its source
map binds input/output digests; run `write` after canonical changes and `check`
before packaging. CI copies only the Skill folder away from the repository and
checks every local Markdown link there. Repository-relative examples require a
selected source or release directory; installed CLI commands use the installed tool.

## Upstream compaction references

This project preserves the MIT-licensed `fast-jev-compaction` source and its original
tests. The old root `hooks/hooks.json` and `.claude-plugin` discovery files were moved
unchanged to `upstream-reference/`; `preservation.json` records original paths and
SHA-256 digests. They are inactive historical references, not installation adapters.
`hooks/fast-jev.ts` and its original tests remain source references. Do not point a
native plugin loader at `upstream-reference` or copy its manifests into active paths.

In particular, this new plugin does not activate the old full-conversation remote
compaction behavior. Local ETL and context packs are deterministic unless a caller
explicitly supplies scoring results. An external scorer must use a separately
prepared synthetic/redacted request contract and report its provider/model route.

## Build and release

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run typecheck
npm test
python3 scripts/distribution/test_package.py
python3 scripts/distribution/package.py check
python3 scripts/distribution/package.py archive --output /tmp/ultrafast-atif-artifacts
```

The new output directory contains a deterministic source tarball, a Skills plugin
ZIP and checksums. The explicit allowlist excludes Git/notes, runtime records,
workspaces, credentials and private RAW. Unsafe links, runtime filenames and common
credential markers under an allowed directory fail packaging. Source review is
still required; a marker scan is not a complete privacy proof. The plugin ZIP omits
all inactive upstream discovery files.

CI uses locked dependencies and runs the offline tests and packaging checks without
model credentials. The manually invoked release workflow prepares public artifacts;
an explicit input can attach them to a **draft** release for an existing matching
tag. It does not publish npm packages, install a plugin or change a marketplace.

## Standalone helper container

The lightweight image uses a digest-pinned official Node 22 Bookworm base, builds
TypeScript with locked development dependencies, and copies only built code and
runtime metadata into the final stage. It runs as the non-root `node` user and
defaults to `--help`. No Codex, account credentials or API keys are needed for local
ETL. The primary build context is this repository only; `.dockerignore` is
deny-by-default.

```sh
docker build -t ultrafast-atif-helper:local .
docker run --rm --network none ultrafast-atif-helper:local --help
docker run --rm --network none \
  --mount type=bind,src=/absolute/selected/transcripts,dst=/inputs,readonly \
  ultrafast-atif-helper:local ingest \
  --input /inputs/source.jsonl --allow-root /inputs --format codex --limit 20 --json
```

Mount a separate writable output directory only when explicitly exporting a derived
artifact. Use container-visible paths. Keep original RAW read-only/local, and never
mount an entire account home merely to inspect one transcript. Record image/platform
and source pins for a real container test; a Dockerfile or successful metadata
lookup alone does not prove runtime compatibility.
