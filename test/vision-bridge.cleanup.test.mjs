import assert from "node:assert/strict"
import { existsSync, mkdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test, { after } from "node:test"

// Isolate from the real production temp dir.
const TEST_RUNTIME = join(tmpdir(), `opencode-vision-test-cleanup-${Date.now()}`)
process.env.VISION_BRIDGE_RUNTIME_DIR = TEST_RUNTIME
process.env.VISION_BRIDGE_CONFIG = fileURLToPath(
  new URL("../plugins/text-models.json", import.meta.url),
)

const { VisionBridge } = await import("../plugins/vision-bridge.mjs")

// Seed one stale file (older than MAX_AGE_MS = 24h) and one fresh file BEFORE
// the plugin factory runs: load-time cleanup (which consumes the 3-day
// throttle) must remove the stale one and keep the fresh one.
const RUNTIME_DIR = TEST_RUNTIME
mkdirSync(RUNTIME_DIR, { recursive: true })
const stale = join(RUNTIME_DIR, `test-stale-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`)
const fresh = join(RUNTIME_DIR, `test-fresh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`)
writeFileSync(stale, Buffer.from("stale"))
writeFileSync(fresh, Buffer.from("fresh"))
const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
utimesSync(stale, tenDaysAgo, tenDaysAgo)

const hooks = await VisionBridge() // triggers load-time cleanup

after(() => rmSync(TEST_RUNTIME, { recursive: true, force: true }))

test("cleans stale temp images but keeps fresh ones", async () => {
  assert.equal(existsSync(stale), false, "stale file (>24h) should be removed")
  assert.equal(existsSync(fresh), true, "fresh file should be kept")
  unlinkSync(fresh)
})
