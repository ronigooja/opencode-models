import assert from "node:assert/strict"
import { applyCatalog } from "../src/models"
import type { ProviderEditor } from "@opencode/plugin/promise/provider"
import type { Model } from "@opencode/plugin"
import plugin, { configDirectory, readCache, readConfig, selectProvider } from "../src/server"
import type { Context } from "@opencode/plugin/promise/plugin"
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

const catalog = { gateway: { data: [{ id: "gpt-test" }] }, official: { providers: { openai: {} } }, savedAt: 1 }
assert.deepEqual(readCache(JSON.parse(JSON.stringify(catalog))), catalog)
for (const invalid of [undefined, {}, { ...catalog, gateway: {} }, { ...catalog, gateway: { data: [{ id: "gpt-image-1" }] } }, { ...catalog, official: [] }, { ...catalog, savedAt: "1" }]) assert.equal(readCache(invalid), undefined)

const cacheDir = await mkdtemp(path.join(process.cwd(), "test-cache-"))
const oldDir = process.env.OPENCODE_CONFIG_DIR
const oldFetch = globalThis.fetch
try {
  process.env.OPENCODE_CONFIG_DIR = cacheDir
  await writeFile(path.join(cacheDir, "opencode.json"), JSON.stringify({ providers: { gateway: { settings: { baseURL: "http://localhost", apiKey: "mock-only" } } } }))
  let stored: unknown = catalog
  let transformed = false
  let reloaded: (() => void) | undefined
  let refreshDone = new Promise<void>((resolve) => { reloaded = resolve })
  let officialFails = true
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).startsWith("http://localhost/")) return new Response(JSON.stringify({ data: [{ id: "gpt-new" }] }))
    if (officialFails) throw new Error("offline")
    return new Response(JSON.stringify({ providers: {} }))
  }) as typeof fetch
  const ctx = {
    options: {},
    storage: { get: async () => stored, set: async (_key: string, value: unknown) => { stored = value; reloaded?.() } },
    provider: {
      transform: async (callback: (editor: ProviderEditor) => void) => { saved = []; callback(editor); transformed = saved.some((model) => model.id === "gpt-test") },
      reload: async () => {},
    },
  } as unknown as Context
  const cleanup = await plugin.setup(ctx)
  assert.equal(transformed, true)
  await refreshDone
  assert.deepEqual((stored as typeof catalog).official, catalog.official)
  assert.equal((stored as typeof catalog).gateway.data[0].id, "gpt-new")
  assert.deepEqual(Object.keys(stored as object).sort(), ["gateway", "official", "savedAt"])
  if (cleanup) await cleanup()
  for (const invalid of [undefined, { gateway: {} }]) {
    stored = invalid
    transformed = true
    officialFails = false
    refreshDone = new Promise<void>((resolve) => { reloaded = resolve })
    const stop = await plugin.setup(ctx)
    assert.equal(transformed, false)
    await refreshDone
    if (stop) await stop()
  }
} finally {
  globalThis.fetch = oldFetch
  if (oldDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = oldDir
  await rm(cacheDir, { recursive: true, force: true })
}
console.log("catalog cache passed")
