import { Plugin } from "@opencode/plugin"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { parse, type ParseError } from "jsonc-parser"
import { applyCatalog } from "./models"

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown) => typeof value === "string" && value ? value : undefined
const json = async (file: string) => {
  const errors: ParseError[] = []
  const value: unknown = parse(await readFile(file, "utf8"), errors, { allowTrailingComma: true })
  if (errors.length) throw new Error(`Invalid JSONC: ${file}`)
  return object(value)
}
export async function readConfig(configDir: string) {
  const file = path.join(configDir, "opencode.json")
  const content = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
    return undefined
  })
  if (content === undefined) return json(path.join(configDir, "opencode.jsonc"))
  const errors: ParseError[] = []
  const value: unknown = parse(content, errors, { allowTrailingComma: true })
  if (errors.length) throw new Error(`Invalid JSONC: ${file}`)
  return object(value)
}
export function configDirectory() {
  return process.env.OPENCODE_CONFIG_DIR || path.join(homedir(), ".config", "opencode")
}
const request = async (url: string, key?: string, timeout = 30000): Promise<unknown> => {
  const response = await fetch(url, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(timeout) })
  if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`)
  return response.json() as Promise<unknown>
}

export default Plugin.define({
  id: "ronigooja.models",
  async setup(ctx) {
    const configDir = configDirectory()
    const prefsPath = process.env.OPENCODE_MODEL_ROUTING || path.join(configDir, "model-routing.json")
    const interval = typeof ctx.options.interval === "number" && Number.isFinite(ctx.options.interval) && ctx.options.interval >= 1 && ctx.options.interval <= 2147483 ? ctx.options.interval : 86400
    let snapshot: Parameters<typeof applyCatalog>[1] | undefined
    let running = false
    let stopped = false
    const refresh = async () => {
      if (running || stopped) return
      running = true
      try {
        const prefs = await json(prefsPath).catch((): Record<string, unknown> => ({}))
        const id = text(ctx.options.provider) || process.env.OPENCODE_PROVIDER_ID || text(prefs.provider) || "cliproxyapi"
        const name = text(ctx.options.providerName) || process.env.OPENCODE_PROVIDER_NAME || text(prefs.providerName) || "zoeapi"
        const config = await readConfig(configDir)
        const settings = object(object(object(config.providers)[id]).settings)
        const baseURL = process.env.OPENCODE_BASE_URL || text(settings.baseURL)
        const apiKey = process.env.OPENCODE_API_KEY || text(settings.apiKey)
        if (!baseURL || !apiKey) throw new Error("Missing gateway configuration")
        const gateway = await request(process.env.OPENCODE_MODEL_CATALOG_URL || `${baseURL.replace(/\/$/, "")}/models`, apiKey)
        const official = await request(process.env.OPENCODE_OFFICIAL_CATALOG_URL || "https://models.opencode.ai/catalog.json", undefined, 60000).catch(() => ({}))
        const entries = object(gateway).data ?? object(gateway).models
        if (!Array.isArray(entries) || !entries.some((entry) => {
          const id = object(entry).id
          return typeof id === "string" && id.length > 0 && !/^(gpt-image|codex-auto-review)/.test(id)
        })) throw new Error("Invalid gateway catalog")
        if (stopped) return
        const selected = text(config.model)
        const defaultModel = process.env.OPENCODE_DEFAULT_MODEL || (selected?.startsWith(`${id}/`) ? selected.slice(id.length + 1) : undefined)
        const previous = snapshot
        snapshot = { id, name, baseURL, apiKey, gateway, official, defaultModel }
        try {
          await ctx.provider.reload()
        } catch (error) {
          snapshot = previous
          throw error
        }
      } catch {
      } finally {
        running = false
      }
    }
    await ctx.provider.transform((editor) => {
      if (snapshot) applyCatalog(editor, snapshot)
    })
    void refresh()
    const timer = setInterval(() => void refresh(), interval * 1000)
    return () => { stopped = true; clearInterval(timer) }
  },
})
