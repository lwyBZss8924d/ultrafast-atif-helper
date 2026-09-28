import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_VERSION, configSchema, configTemplate, loadConfig, parseConfig, writeConfig } from "../src/helper/config.js";

const dirs:string[]=[];
const temporary=()=>{const d=mkdtempSync(join(realpathSync(tmpdir()),"atif-config-"));dirs.push(d);return d;};
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
describe("standalone unified config contract",()=>{
  it("ships the exact embedded schema and provider templates",()=>{
    const base=join(dirname(fileURLToPath(import.meta.url)),"../config");
    expect(JSON.parse(readFileSync(join(base,"task-checkpoint.config.schema.json"),"utf8"))).toEqual(configSchema());
    expect(JSON.parse(readFileSync(join(base,"task-checkpoint.example.json"),"utf8"))).toEqual(configTemplate());
    expect(JSON.parse(readFileSync(join(base,"task-checkpoint.typesafe.example.json"),"utf8"))).toEqual(configTemplate("typesafe"));
  });
  it("one explicit config retains recorder/native/provider namespaces",()=>{
    const d=temporary(),file=join(d,"combined.json");writeConfig(file,"typesafe");const config=loadConfig(file);
    expect(config.recorder.state_dir).toBe(join(d,".local/task-checkpoint-record"));
    expect(config.codex.eval).toEqual({model:"gpt-6-luna",effort:"high"});
    expect(config.scoring).toEqual({provider:"typesafe",model:"jev-1.13.0",api_key_env:"TYPESAFE_API_KEY",limits:{deadline_ms:20000,max_request_bytes:65536,max_response_bytes:1048576}});
    expect(()=>writeConfig(file)).toThrow("config_create_new_failed");
  });
  it("rejects duplicate provider fields, credentials, unknown endpoints and cross-provider models",()=>{
    const d=temporary(),file=join(d,"bad.json");writeFileSync(file,'{"schema_version":"task-checkpoint.config.v1","scoring":{"provider":"openrouter","provider":"typesafe"}}');
    expect(()=>loadConfig(file)).toThrow("config_duplicate_key");
    expect(()=>parseConfig({schema_version:CONFIG_VERSION,scoring:{api_key:"do-not-echo"}},d)).toThrow("config_unknown_field");
    expect(()=>parseConfig({schema_version:CONFIG_VERSION,scoring:{endpoint:"https://example.invalid"}},d)).toThrow("config_unknown_field");
    expect(()=>parseConfig({schema_version:CONFIG_VERSION,scoring:{provider:"typesafe",model:"typesafe/jev-1.13-20260917"}},d)).toThrow("config_unsupported_scoring_model");
    expect(()=>parseConfig({schema_version:CONFIG_VERSION,scoring:{limits:{max_response_bytes:1048577}}},d)).toThrow("config_invalid_limit");
  });
});
