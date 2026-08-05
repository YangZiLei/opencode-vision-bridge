import assert from "node:assert/strict"
import { existsSync, mkdirSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
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
const RUNTIME_DIR = join(tmpdir(), "opencode-vision")
mkdirSync(RUNTIME_DIR, { recursive: true })

// Seed one stale file (older than MAX_AGE_MS = 24h) and one fresh file.
const stale = join(RUNTIME_DIR, `test-stale-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`)
const fresh = join(RUNTIME_DIR, `test-fresh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`)
writeFileSync(stale, Buffer.from("stale"))
writeFileSync(fresh, Buffer.from("fresh"))
const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
utimesSync(stale, tenDaysAgo, tenDaysAgo)

test("cleans stale temp images but keeps fresh ones", async () => {
  // First transform triggers the (throttled) cleanup since lastCleanTime starts at 0.
  const output = {
    messages: [
      {
        info: { role: "user", model: { providerID: "opencode-go", modelID: "deepseek-v4-flash" } },
        parts: [{ type: "text", text: "no image" }],
      },
    ],
  }
  await transform({}, output)

  assert.equal(existsSync(stale), false, "stale file (>24h) should be removed")
  assert.equal(existsSync(fresh), true, "fresh file should be kept")
  unlinkSync(fresh)
})
