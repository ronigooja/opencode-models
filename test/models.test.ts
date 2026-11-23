import assert from "node:assert/strict"
import { applyCatalog } from "../src/models"
import type { ProviderEditor } from "@opencode/plugin/promise/provider"
import type { Model } from "@opencode/plugin"
import { configDirectory, readConfig, selectProvider } from "../src/server"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

let saved: readonly Model.Info[] = []
const editor = {
  get: () => undefined,
  add: (input: { models: readonly Model.Info[] }) => { saved = input.models },
} as unknown as ProviderEditor
applyCatalog(editor, {
  id: "gateway", name: "Gateway", baseURL: "https://example.test", apiKey: "test",
  gateway: { data: [{ id: "gpt-test", context_length: 500, created: 1700000000 }, { id: "claude-test" }] },
  official: { providers: { openai: { models: { "gpt-test": { limit: { context: 100, input: 80, output: 20 } } } }, anthropic: { models: { "claude-test": { limit: { context: 300, input: 200, output: 50 } } } }, reseller: { models: { "claude-test": { limit: { context: 999 } } } } } },
})
assert.deepEqual(saved[0].limit, { context: 500, input: 80, output: 20 })
assert.equal(saved[0].time.released, Date.parse("2023-11-14"))
assert.deepEqual(saved[1].limit, { context: 300, input: 200, output: 50 })
applyCatalog(editor, {
  id: "gateway", name: "Gateway", baseURL: "https://example.test", apiKey: "test",
  gateway: { data: [{ id: "claude-sonnet-3-20241022" }, { id: "gpt-image-1" }, { id: "codex-auto-review" }] },
  official: {}, defaultModel: "missing",
})
assert.deepEqual(saved.map((model) => model.name), ["Claude Sonnet 3 (2024-10-22)", "missing"])
const dir = await mkdtemp(path.join(process.cwd(), "test-config-"))
const previousDir = process.env.OPENCODE_CONFIG_DIR
const previousXdg = process.env.XDG_CONFIG_HOME
const previousConfig = process.env.OPENCODE_CONFIG
try {
  process.env.OPENCODE_CONFIG_DIR = dir
  process.env.XDG_CONFIG_HOME = "/ignored"
  process.env.OPENCODE_CONFIG = "/ignored/config.json"
  assert.equal(configDirectory(), dir)
  await writeFile(path.join(dir, "opencode.jsonc"), '{ // comment\n "providers": { "gateway": { "settings": { "baseURL": "https://example.test", }, }, }, }')
  assert.deepEqual(await readConfig(configDirectory()), { providers: { gateway: { settings: { baseURL: "https://example.test" } } } })
  await writeFile(path.join(dir, "opencode.json"), '{ /* comment */ "model": "gateway/test", }')
  assert.deepEqual(await readConfig(dir), { model: "gateway/test" })
  const gateway = { name: "Gateway", settings: { baseURL: "http://localhost", apiKey: "mock-only" } }
  await writeFile(path.join(dir, "opencode.json"), JSON.stringify({ providers: { gateway } }))
  assert.deepEqual(selectProvider(await readConfig(dir), undefined), { id: "gateway", name: "Gateway", baseURL: "http://localhost", apiKey: "mock-only" })
  assert.match(selectProvider({ providers: { gateway, other: gateway } }, undefined).reason ?? "", /found 2/)
  assert.equal(selectProvider({ providers: { gateway, other: gateway } }, "other").id, "other")
  assert.match(selectProvider({ providers: { gateway: { settings: { baseURL: "http://localhost" } } } }, "gateway").reason ?? "", /Missing/)
  assert.match(selectProvider({ providers: { gateway: { settings: { baseURL: "http://localhost" } } } }, undefined).reason ?? "", /found 0/)
  await writeFile(path.join(dir, "opencode.json"), '{ invalid }')
  await assert.rejects(readConfig(dir))
  delete process.env.OPENCODE_CONFIG_DIR
  assert.equal(configDirectory(), path.join(homedir(), ".config", "opencode"))
} finally {
  if (previousDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = previousDir
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = previousXdg
  if (previousConfig === undefined) delete process.env.OPENCODE_CONFIG
  else process.env.OPENCODE_CONFIG = previousConfig
  await rm(dir, { recursive: true, force: true })
}
console.log("catalog conversion passed")
