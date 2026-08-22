/**
 * Vision Bridge — opencode plugin
 *
 * Problem: some main models (e.g. DeepSeek V4, GLM-5.x) are text-only and cannot
 * process images. opencode rejects image attachments BEFORE sending them to the
 * model, surfacing "this model does not support image input".
 *
 * Solution: for models listed in the text-only blacklist (text-models.json),
 * replace image parts with a text part that carries the image file path. The
 * main model then dispatches to a vision subagent (opencode/mimo-v2.5-free)
 * to recognize the image. All other models are left untouched — real vision
 * models (qwen3.x, MiMo, Claude, GPT, ...) see images natively.
 *
 * Two image sources are covered:
 *   1. File path (opencode run -f, tool output referencing a local image)
 *      -> original path is reused
 *   2. Clipboard paste (Ctrl+V in the TUI: base64 data URI, no path)
 *      -> decoded and written to a temp file
 *
 * Housekeeping:
 *   - Temp images expire after 24h (configurable via VISION_BRIDGE_MAX_AGE_HOURS)
 *   - Duplicate pastes are deduplicated by SHA-256 content hash
 *   - Cleanup runs at most once every 3 days
 *
 * When another text-only model reports "does not support image input", add it
 * to text-models.json (glob patterns supported, e.g. the deepseek family).
 */

import { tmpdir, homedir } from "node:os"
import {
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  rmSync,
} from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"

const IMAGE_MIME_RE = /^image\//

// Config file location — overridable via VISION_BRIDGE_CONFIG
const CONFIG_PATH =
  process.env.VISION_BRIDGE_CONFIG ||
  join(homedir(), ".config", "opencode", "plugins", "text-models.json")

// Temp image retention — overridable via VISION_BRIDGE_MAX_AGE_HOURS
const MAX_AGE_MS =
  (Number(process.env.VISION_BRIDGE_MAX_AGE_HOURS) || 24) * 60 * 60 * 1000

const RUNTIME_DIR = join(tmpdir(), "opencode-vision")
const CLEAN_THROTTLE_MS = 3 * 24 * 60 * 60 * 1000 // cleanup at most once per 3 days

const DEBUG = process.env.VISION_BRIDGE_DEBUG === "1"
const log = DEBUG ? (...a) => console.log("[vision-bridge]", ...a) : () => {}

let lastCleanTime = 0

// Content-hash dedup cache: repeated pastes of the same image reuse one file.
const hashIndex = new Map() // sha256 -> path

// Model capability cache, populated by the experimental.chat.system.transform
// hook which receives the FULL Model object (info.model in messages.transform
// only carries {providerID, modelID}). Keyed "providerID/id" so concurrent
// sessions can't cross-contaminate: messages.transform only trusts a cached
// entry whose key matches the request's own model.
const CAPS_CACHE_MAX = 50
const capsCache = new Map() // "providerID/id" -> capabilities object

function rememberCaps(model) {
  const caps = model?.capabilities
  if (!caps || !model?.providerID || !model?.id) return
  const key = `${model.providerID}/${model.id}`
  capsCache.delete(key)
  capsCache.set(key, caps)
  if (capsCache.size > CAPS_CACHE_MAX) {
    capsCache.delete(capsCache.keys().next().value)
  }
}

/** True when the model's runtime metadata says it accepts image input. */
function declaresImageInput(caps) {
  return caps?.input?.image === true || caps?.attachment === true
}

/** Delete temp images older than MAX_AGE_MS. Throttled to once per 3 days. */
function cleanOldImages() {
  const now = Date.now()
  if (now - lastCleanTime < CLEAN_THROTTLE_MS) return
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true })
    for (const name of readdirSync(RUNTIME_DIR)) {
      const full = join(RUNTIME_DIR, name)
      try {
        const info = statSync(full)
        if (info.isFile() && now - info.mtimeMs > MAX_AGE_MS) {
          rmSync(full, { force: true })
          for (const [hash, cachedPath] of hashIndex) {
            if (cachedPath === full) hashIndex.delete(hash)
          }
          log("cleaned", full)
        }
      } catch {}
    }
    lastCleanTime = now
  } catch {}
}

/** Return an existing file path for identical content, or null. */
function dedupeImage(buffer) {
  try {
    const hash = createHash("sha256").update(buffer).digest("hex")
    if (hashIndex.has(hash) && existsSync(hashIndex.get(hash))) return hashIndex.get(hash)
    for (const name of readdirSync(RUNTIME_DIR)) {
      const full = join(RUNTIME_DIR, name)
      try {
        if (statSync(full).isFile() && statSync(full).size === buffer.length) {
          const existing = readFileSync(full)
          if (createHash("sha256").update(existing).digest("hex") === hash) {
            hashIndex.set(hash, full)
            return full
          }
        }
      } catch {}
    }
  } catch {}
  return null
}

/**
 * Persist a pasted image to the runtime dir, deduping identical content.
 * The hash index is backfilled right after the write so concurrent
 * transform invocations reuse the same file instead of writing duplicates.
 */
function persistImage(buffer, name) {
  const existing = dedupeImage(buffer)
  if (existing) {
    log("  deduped image ->", existing)
    return existing
  }
  const hash = createHash("sha256").update(buffer).digest("hex")
  const filePath = join(
    RUNTIME_DIR,
    `${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${name || "image.png"}`
  )
  try {
    writeFileSync(filePath, buffer)
    hashIndex.set(hash, filePath)
    log("  wrote", filePath)
    return filePath
  } catch {
    return ""
  }
}

let textPatterns = null

function loadTextPatterns() {
  if (textPatterns) return textPatterns
  textPatterns = []
  try {
    if (existsSync(CONFIG_PATH)) {
      const j = JSON.parse(readFileSync(CONFIG_PATH, "utf8"))
      if (Array.isArray(j?.textModels)) {
        textPatterns = j.textModels.map(String)
        log("loaded", textPatterns.length, "blacklist patterns")
      }
    }
  } catch (e) {
    log("failed to load text-models.json:", e.message)
  }
  return textPatterns
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function matchTextModel(patterns, providerID, modelID) {
  const key = `${providerID}/${modelID}`
  for (const pat of patterns) {
    if (pat === key) return true
    if (pat.includes("*")) {
      const re = new RegExp("^" + pat.split("*").map(escapeRegExp).join(".*") + "$")
      if (re.test(key)) return true
    }
  }
  return false
}

function decodeDataUri(dataUri) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUri)
  if (!m) return null
  const extMatch = /^image\/(png|jpe?g|gif|webp)/.exec(m[1])
  const ext = extMatch ? (extMatch[1] === "jpeg" ? "jpg" : extMatch[1]) : "png"
  try {
    return { buffer: Buffer.from(m[2], "base64"), ext }
  } catch {
    return null
  }
}

export const VisionBridge = async () => {
  log("plugin loaded")
  return {
    // Fires before messages.transform on every LLM call with the FULL Model
    // object — our source of runtime truth for input modality.
    "experimental.chat.system.transform": async (input, output) => {
      rememberCaps(input?.model)
      // Text-only models get a mandatory delegation rule. The bridged text
      // part alone is advisory and weak models (e.g. big-pickle) ignore it.
      const caps = input?.model?.capabilities
      if (caps && caps.input?.image !== true) {
        output.system.push(
          "IMAGE DELEGATION RULE (mandatory): If a user message contains " +
          '"[Image attachment: <file path>]", this model cannot see the image ' +
          "directly. You MUST use the task tool to invoke the 'vision' subagent " +
          "with that file path, receive its description, and answer based on it. " +
          "Never reply that you cannot see images — always delegate instead."
        )
        log("  injected delegation rule for", `${input.model.providerID}/${input.model.id}`)
      }
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      // Resolve the target model from the last user message
      let targetModel = null
      for (const m of [...output.messages].reverse()) {
        if (m.info?.role === "user") {
          targetModel = m.info.model
          break
        }
      }
      if (!targetModel?.providerID || !targetModel?.modelID) return

      const modelKey = `${targetModel.providerID}/${targetModel.modelID}`
      log("transform fired for", modelKey)

      // Primary decision: runtime capabilities captured from
      // system.transform for THIS provider/model. Zero-config — no
      // blacklist maintenance needed.
      const caps = capsCache.get(modelKey)
      if (caps) {
        if (declaresImageInput(caps)) {
          log("  runtime caps: image input supported, PASS")
          return
        }
        log("  runtime caps: text-only, BRIDGING image")
        return bridgeImageParts(output)
      }

      // Fallback (cache miss): legacy blacklist behavior so bridging still
      // works if the hook order ever changes or state was evicted.
      const capsFromMsg =
        targetModel.capabilities?.input?.image === true ||
        targetModel.modalities?.input?.includes("image") === true
      if (capsFromMsg) {
        log("  msg carries image capability, PASS")
        return
      }
      if (!matchTextModel(loadTextPatterns(), targetModel.providerID, targetModel.modelID)) {
        log("  not in text blacklist, PASS")
        return
      }
      log("  in text blacklist, BRIDGING image")
      bridgeImageParts(output)
    },
  }
}

/** Replace every image part across all messages with a path-bearing text part. */
function bridgeImageParts(output) {
  cleanOldImages()
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true })
  } catch {}

  for (const msg of output.messages) {
    for (const part of msg.parts) {
      const p = part
      let filePath = ""

      if (part.type === "file" && IMAGE_MIME_RE.test(String(p.mime ?? ""))) {
        if (p.path) {
          filePath = p.path
        } else if (String(p.url ?? "").startsWith("data:")) {
          const decoded = decodeDataUri(String(p.url))
          if (decoded) {
            const name = String(p.filename ?? `pasted-${Date.now()}`).replace(/[^\w.\-]/g, "_")
            filePath = persistImage(decoded.buffer, name)
          }
        }
      } else if (part.type === "image") {
        const src = String(p.image ?? "")
        const decoded = src.startsWith("data:") ? decodeDataUri(src) : null
        if (decoded) {
          filePath = persistImage(decoded.buffer, `pasted.${decoded.ext}`)
        }
      }

      if (!filePath) continue

      part.type = "text"
      delete p.mime
      delete p.path
      delete p.file
      delete p.image
      delete p.url
      delete p.filename
      p.text =
        `[Image attachment: ${filePath} — main model does not support image input, ` +
        `call the vision subagent to recognize this image before continuing]`
    }
  }
}
