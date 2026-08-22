import assert from "node:assert/strict"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test, { after } from "node:test"

// Isolate from the real production temp dir.
const TEST_RUNTIME = join(tmpdir(), `opencode-vision-test-caps-${Date.now()}`)
process.env.VISION_BRIDGE_RUNTIME_DIR = TEST_RUNTIME
process.env.VISION_BRIDGE_CONFIG = fileURLToPath(
  new URL("../plugins/text-models.json", import.meta.url),
)

const { VisionBridge } = await import("../plugins/vision-bridge.mjs")
const hooks = await VisionBridge()
const systemTransform = hooks["experimental.chat.system.transform"]
const transform = hooks["experimental.chat.messages.transform"]

const image = "data:image/png;base64,aGVsbG8="

function caps(imageSupported) {
  return {
    temperature: true,
    reasoning: true,
    attachment: imageSupported,
    toolcall: true,
    input: { text: true, image: imageSupported, audio: false, video: false, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
  }
}

function modelObj(providerID, id, capabilities) {
  return { providerID, id, capabilities }
}

function userMsg(providerID, modelID, parts) {
  return {
    messages: [{ info: { role: "user", model: { providerID, modelID } }, parts }],
  }
}

function filePart(overrides = {}) {
  return { type: "file", mime: "image/png", filename: "x.png", url: image, ...overrides }
}

after(() => rmSync(TEST_RUNTIME, { recursive: true, force: true }))

test("system.transform injects delegation rule for text-only model", async () => {
  const out = { system: [] }
  await systemTransform({ model: modelObj("opencode", "hy3-free", caps(false)) }, out)
  assert.ok(
    out.system.some((s) => s.includes("IMAGE DELEGATION RULE")),
    "text-only model should get the mandatory delegation rule",
  )
})

test("system.transform does NOT inject rule for vision model", async () => {
  const out = { system: [] }
  await systemTransform({ model: modelObj("opencode", "mimo-v2.5-free", caps(true)) }, out)
  assert.equal(out.system.length, 0, "vision model must not get the delegation rule")
})

test("bridges image for a cached text-only model (capability path)", async () => {
  // Seed capability cache via system.transform.
  await systemTransform({ model: modelObj("opencode", "big-pickle", caps(false)) }, { system: [] })
  const output = userMsg("opencode", "big-pickle", [filePart()])
  await transform({}, output)
  const part = output.messages[0].parts[0]
  assert.equal(part.type, "text", "text-only model image should be bridged")
  const path = part.text.match(/\[Image attachment: (.+?) —/)?.[1]
  assert.ok(path, "bridged text should carry a file path")
})

test("passes image through for a cached vision model", async () => {
  await systemTransform({ model: modelObj("opencode", "mimo-v2.5-free", caps(true)) }, { system: [] })
  const output = userMsg("opencode", "mimo-v2.5-free", [filePart()])
  await transform({}, output)
  assert.equal(output.messages[0].parts[0].type, "file", "vision model image should pass untouched")
})

test("falls back to blacklist when metadata omits input modality", async () => {
  // caps.input is entirely absent (some custom providers) — must NOT bridge
  // a possibly-vision model; fall back to blacklist (deepseek is listed,
  // a made-up unknown model is not).
  await systemTransform(
    { model: modelObj("custom", "unknown-vision-model", { input: {}, output: {} }) },
    { system: [] },
  )
  const output = userMsg("custom", "unknown-vision-model", [filePart()])
  await transform({}, output)
  assert.equal(output.messages[0].parts[0].type, "file", "unknown modality should pass through (blacklist miss)")
})

test("attachment-capable model gets a consistent single decision", async () => {
  // attachment:true but input.image:false must neither be bridged nor given
  // a delegation rule — both predicates must agree via declaresImageInput.
  const weirdCaps = { ...caps(false), attachment: true }
  const out = { system: [] }
  await systemTransform({ model: modelObj("custom", "attach-model", weirdCaps) }, out)
  assert.equal(out.system.length, 0, "attachment-capable model must not receive delegation rule")
  const output = userMsg("custom", "attach-model", [filePart()])
  await transform({}, output)
  assert.equal(output.messages[0].parts[0].type, "file", "attachment-capable model image should pass through")
})