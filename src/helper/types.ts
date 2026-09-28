export type Format = 'codex' | 'claude' | 'pi' | 'atif';
export type NativeKey = 'session_id' | 'turn_id' | 'entry_id' | 'parent_entry_id' | 'trajectory_id' | 'step_id';
export interface Evidence {
  offset: number;
  length: number;
  sha256: string;
  json_pointer: string;
}
export interface SourceRef extends Evidence {
  uri: string;
  format: Format;
  version: string | number | null;
}
export interface ArtifactRef { record_id: string; uri: string; json_pointer: string; sha256: string; }
export interface RecordMetadata {
  record_id: string;
  client: Format;
  kind: string;
  timestamp: string | null;
  native: Record<NativeKey, string | number | null>;
  source: SourceRef;
  identity_evidence: Partial<Record<NativeKey, Evidence>>;
  labels: string[];
  text_available: boolean;
  logical?: { event_id: string | null; task_id: string | null; run_id: string | null; project_id: string | null };
  relay?: { event_uuid: string | null; parent_scope_uuid: string | null; propagation_root_uuid: string | null; atof_version: string | null; name: string };
  atif?: { session_id: string | null; trajectory_id: string | null; step_id: number | null };
  atif_identity_evidence?: Partial<Record<'session_id' | 'trajectory_id' | 'step_id', Evidence>>;
  native_actor?: { client: string; session_ref: string; roles: string[]; provenance_ref: ArtifactRef };
  native_actor_evidence?: Record<'client' | 'session_ref' | 'roles' | 'provenance_ref', Evidence>;
}
export interface Page {
  schema_version: 'ultrafast-atif.page.v1';
  records: RecordMetadata[];
  next_offset: number | null;
  eof: boolean;
  incomplete_tail: boolean;
  omissions: string[];
  source_state: {
    dev: string;
    ino: string;
    size: number;
    mtime_ns: string;
    window_start: number;
    window_end: number;
    declared_version: string | number | null;
    cursor_anchor: { offset: number; length: number; sha256: string } | null;
    continuation: 'initial' | 'verified_expected_state' | 'unverified_offset';
  };
}
export interface ReadOptions {
  input: string;
  format: Format;
  allowRoots: readonly string[];
  offset?: number;
  limit?: number;
  maxBytes?: number;
  expectedState?: {
    dev: string; ino: string; size: number;
    cursor_anchor?: { offset: number; length: number; sha256: string } | null;
  };
}
export class HelperError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export const MAX_BYTES = 8 * 1024 * 1024;
export const MAX_RECORDS = 1000;
