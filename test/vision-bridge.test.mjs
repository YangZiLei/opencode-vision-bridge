import assert from "node:assert/strict"
import { existsSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

process.env.VISION_BRIDGE_CONFIG = fileURLToPath(
  new URL("../plugins/text-models.json", import.meta.url),
)

const { VisionBridge } = await import("../plugins/vision-bridge.mjs")
const hooks = await VisionBridge()
const transform = hooks["experimental.chat.messages.transform"]
const image = "data:image/png;base64,aGVsbG8="
const RUNTIME_DIR = join(tmpdir(), "opencode-vision")

function message(providerID, modelID, parts) {
  return {
    messages: [
      { info: { role: "user", model: { providerID, modelID } }, parts },
    ],
  }
}

function filePart(overrides = {}) {
  return { type: "file", mime: "image/png", filename: "test.png", url: image, ...overrides }
}

test("bridges a blacklisted DeepSeek model to a file path", async () => {
  const output = message("opencode-go", "deepseek-v4-flash", [filePart()])
  await transform({}, output)
  const part = output.messages[0].parts[0]
  assert.equal(part.type, "text")
  const path = part.text.match(/\[Image attachment: (.+?) —/)?.[1]
  assert.ok(path, "should carry a file path")
  assert.equal(existsSync(path), true, "decoded file should exist on disk")
  unlinkSync(path)
})

test("passes a non-blacklisted vision model through unchanged", async () => {
  const output = message("opencode-go", "qwen3.7-plus", [filePart()])
  await transform({}, output)
  assert.equal(output.messages[0].parts[0].type, "file")
})

test("reuses an existing file for duplicate pastes (dedup)", async () => {
  // Pre-seed one unique file in the runtime dir, then paste identical content.
  const seed = Buffer.from("dupe-test-content-12345")
  const seedPath = join(RUNTIME_DIR, `test-seed-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`)
  writeFileSync(seedPath, seed)

  const seedUri = `data:image/png;base64,${seed.toString("base64")}`
  const output = message("opencode-go", "deepseek-v4-flash", [filePart({ url: seedUri })])
  await transform({}, output)
  const part = output.messages[0].parts[0]
  const path = part.text.match(/\[Image attachment: (.+?) —/)?.[1]

  assert.equal(path, seedPath, "should reuse the pre-seeded file, not create a new one")
  unlinkSync(seedPath)
})

test("uses the original path when a file part already has a path", async () => {
  const original = join(RUNTIME_DIR, `test-original-${Date.now()}.png`)
  writeFileSync(original, Buffer.from("original-path-test"))
  const output = message("opencode-go", "deepseek-v4-flash", [filePart({ path: original })])
  await transform({}, output)
  const part = output.messages[0].parts[0]
  assert.match(part.text, new RegExp(original.replace(/\\/g, "\\\\")))
  unlinkSync(original)
})

test("leaves non-image file parts untouched", async () => {
  const output = message("opencode-go", "deepseek-v4-flash", [
    { type: "file", mime: "text/plain", filename: "note.txt", url: "data:text/plain;base64,aGk=" },
  ])
  await transform({}, output)
  assert.equal(output.messages[0].parts[0].type, "file")
})

test("leaves text parts untouched", async () => {
  const output = message("opencode-go", "deepseek-v4-flash", [{ type: "text", text: "hello" }])
  await transform({}, output)
  assert.equal(output.messages[0].parts[0].text, "hello")
})
