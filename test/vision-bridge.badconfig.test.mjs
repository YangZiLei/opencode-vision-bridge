import assert from "node:assert/strict"
import { writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

// Point the plugin at a malformed JSON config, then verify it degrades gracefully
// (falls back to an empty blacklist instead of crashing).
const badConfig = join(tmpdir(), `vision-bridge-bad-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`)
writeFileSync(badConfig, "{ this is not valid json, ]")
process.env.VISION_BRIDGE_CONFIG = badConfig

const { VisionBridge } = await import("../plugins/vision-bridge.mjs")
const hooks = await VisionBridge()
const transform = hooks["experimental.chat.messages.transform"]

test("gracefully degrades when text-models.json is malformed", async () => {
  const output = {
    messages: [
      {
        info: { role: "user", model: { providerID: "opencode-go", modelID: "deepseek-v4-flash" } },
        parts: [{ type: "file", mime: "image/png", filename: "x.png", url: "data:image/png;base64,aGVsbG8=" }],
      },
    ],
  }
  // Should not throw; with an empty blacklist nothing is bridged.
  await transform({}, output)
  assert.equal(output.messages[0].parts[0].type, "file", "image should pass through untouched")
})

rmSync(badConfig, { force: true })
