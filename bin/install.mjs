#!/usr/bin/env node
/**
 * opencode-vision-bridge — zero-dependency installer CLI
 *
 * Commands:
 *   install [--local|--global] [--yes]
 *   uninstall [--local|--global] [--yes]
 *   --help
 *
 * Scopes:
 *   --global (default)  install into ~/.config/opencode/ and register the
 *                       plugin in the global opencode config
 *   --local             install into <cwd>/.opencode/ and register the plugin
 *                       in the project opencode.json
 *
 * Design notes:
 *   - Dependency-free (Node built-ins only), same constraint as the plugin.
 *   - Idempotent: repeated installs never duplicate plugin entries or files.
 *   - Safe uninstall: only files installed by this tool are removed; any
 *     file the user modified locally (text-models.json / vision.md) is kept
 *     and reported instead of being deleted.
 *   - --yes skips every confirmation prompt (CI/automation friendly).
 */

import { homedir } from "node:os"
import { join, dirname, resolve, isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"
import { stdin as input, stdout as output } from "node:process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
} from "node:fs"
import { createInterface } from "node:readline/promises"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, "..")

/** Entry that must be registered in the opencode `plugin` array. */
const PLUGIN_ENTRY = "plugins/vision-bridge.mjs"

/** Every file shipped by this installer, with uninstall semantics per kind. */
const SHIPPED = [
  {
    rel: "plugins/vision-bridge.mjs",
    kind: "plugin",
    label: "vision-bridge plugin",
  },
  {
    rel: "plugins/text-models.json",
    kind: "config",
    label: "text-models.json (fallback blacklist)",
  },
  {
    rel: "agent/vision.md",
    kind: "agent",
    label: "vision subagent definition",
  },
]

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let command = null
  let scope = "global"
  let yes = false
  for (const a of argv) {
    switch (a) {
      case "install":
      case "uninstall":
        command = a
        break
      case "--local":
        scope = "local"
        break
      case "--global":
        scope = "global"
        break
      case "--yes":
      case "-y":
        yes = true
        break
      case "--help":
      case "-h":
        return { help: true }
      default:
        return { error: `unknown argument: ${a}` }
    }
  }
  if (command === "uninstall" && !yes) {
    // fine — uninstall will prompt separately
  }
  return { command, scope, yes }
}

// ---------------------------------------------------------------------------
// Help / confirmation
// ---------------------------------------------------------------------------

function printHelp(error) {
  if (error) console.error(`error: ${error}\n`)
  console.log(
    `opencode-vision-bridge installer (v${process.env.npm_package_version ?? "dev"})

Usage:
  node bin/install.mjs install [--local|--global] [--yes]
  node bin/install.mjs uninstall [--local|--global] [--yes]

Options:
  --local      Install into <cwd>/.opencode/ and register in project opencode.json
  --global     Install into ~/.config/opencode/ and register in global config (default)
  --yes        Skip all confirmation prompts (CI/automation)
  -h, --help   Show this help

Examples:
  node bin/install.mjs install --global
  node bin/install.mjs install --local --yes
  node bin/install.mjs uninstall --global --yes
`
  )
}

async function askYesNo(question) {
  const rl = createInterface({ input, output })
  try {
    const answer = await rl.question(`${question} [y/N] `)
    return /^y(es)?$/i.test(answer.trim())
  } catch {
    return false // EOF (Ctrl+D) counts as No
  } finally {
    rl.close()
  }
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

/** Resolve the install scope into concrete directories and config file. */
function resolveTarget(scope) {
  if (scope === "local") {
    const cwd = process.cwd()
    return {
      scope,
      configDir: join(cwd, ".opencode"),
      configFile: pickConfigFile(cwd),
      label: `${cwd}/.opencode`,
    }
  }
  const base = join(homedir(), ".config", "opencode")
  return {
    scope,
    configDir: base,
    configFile: pickConfigFile(base),
    label: base,
  }
}

/** Prefer opencode.json, fall back to opencode.jsonc, else default to .json. */
function pickConfigFile(dir) {
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const p = join(dir, name)
    if (existsSync(p)) return p
  }
  return join(dir, "opencode.json")
}

// ---------------------------------------------------------------------------
// Config file read/write (JSON with JSONC tolerance)
// ---------------------------------------------------------------------------

/** Strip // and /* *\/ comments outside of strings — small JSONC-tolerant parser. */
function stripJsonComments(text) {
  let out = ""
  let inString = false
  let i = 0
  while (i < text.length) {
    const c = text[i]
    const next = text[i + 1]
    if (inString) {
      out += c
      if (c === "\\" && next !== undefined) {
        out += next
        i += 2
        continue
      }
      if (c === '"') inString = false
      i++
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      i++
      continue
    }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++
      continue
    }
    if (c === "/" && next === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

function readConfig(file) {
  const raw = readFileSync(file, "utf8")
  try {
    return JSON.parse(raw)
  } catch {
    return JSON.parse(stripJsonComments(raw))
  }
}

function writeConfig(file, json) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`)
}

/**
 * Does a `plugin` array entry point at the same file as pluginPath?
 * Handles absolute paths, relative paths (resolved against baseDir) and
 * plain npm package names (compared verbatim).
 */
function pluginMatches(entry, pluginPath, baseDir) {
  if (typeof entry !== "string") return false
  if (entry === pluginPath) return true
  if (isAbsolute(entry)) return resolve(entry) === pluginPath
  if (entry.startsWith(".") || entry.includes("/") || entry.includes("\\")) {
    return resolve(baseDir, entry) === pluginPath
  }
  return false
}

/** Append the plugin path to the config `plugin` array unless present. */
function registerPlugin(configFile, pluginPath) {
  let json = {}
  if (existsSync(configFile)) {
    json = readConfig(configFile)
  }
  if (json.plugin === undefined) {
    json.plugin = []
  }
  if (!Array.isArray(json.plugin)) {
    throw new Error(`"plugin" in ${configFile} is not an array — please fix manually`)
  }
  const baseDir = dirname(configFile)
  if (json.plugin.some((p) => pluginMatches(p, pluginPath, baseDir))) {
    return { registered: false, configFile }
  }
  json.plugin.push(pluginPath)
  writeConfig(configFile, json)
  return { registered: true, configFile }
}

/** Remove the plugin path from the config `plugin` array. */
function unregisterPlugin(configFile, pluginPath) {
  if (!existsSync(configFile)) return { removed: false, hadConfig: false }
  const json = readConfig(configFile)
  if (!Array.isArray(json.plugin)) return { removed: false, hadConfig: true }
  const before = json.plugin.length
  json.plugin = json.plugin.filter((p) => !pluginMatches(p, pluginPath, dirname(configFile)))
  if (json.plugin.length === before) return { removed: false, hadConfig: true }
  writeConfig(configFile, json)
  return { removed: true, hadConfig: true }
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function filesEqual(a, b) {
  try {
    return readFileSync(a).equals(readFileSync(b))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

async function install(opts) {
  const target = resolveTarget(opts.scope)
  console.log(`Installing opencode-vision-bridge (${opts.scope})`)
  console.log(`  target dir: ${target.label}`)
  if (!opts.yes) {
    const ok = await askYesNo("Continue?")
    if (!ok) {
      console.log("Aborted.")
      process.exit(0)
    }
  }

  // 1. Copy shipped files (plugins + agent), confirming overwrites.
  for (const f of SHIPPED) {
    const src = join(ROOT, f.rel)
    const dest = join(target.configDir, f.rel)
    mkdirSync(dirname(dest), { recursive: true })
    if (existsSync(dest)) {
      if (filesEqual(src, dest)) {
        console.log(`  [skip] ${f.label} already present and identical`)
        continue
      }
      if (!opts.yes) {
        const ok = await askYesNo(`  Overwrite ${dest}? (differs from shipped version)`)
        if (!ok) {
          console.log(`  [keep] ${f.label} (left as-is)`)
          continue
        }
      }
    }
    copyFileSync(src, dest)
    console.log(`  [copy] ${f.label} -> ${dest}`)
  }

  // 2. Register the plugin entry in opencode config.
  const pluginPath = join(target.configDir, PLUGIN_ENTRY)
  let result
  try {
    result = registerPlugin(target.configFile, pluginPath)
  } catch (err) {
    console.error(`  [error] ${err.message}`)
    console.error("  Files were copied but the plugin was NOT registered — fix the config and re-run install.")
    process.exit(1)
  }
  console.log(
    result.registered
      ? `  [ok] registered plugin entry in ${result.configFile}`
      : `  [skip] plugin entry already present in ${result.configFile}`
  )

  // 3. Print verification steps.
  console.log("\nopencode-vision-bridge installed (" + opts.scope + ")")
  console.log("  files  -> " + target.configDir)
  console.log("  config -> " + target.configFile)
  console.log("\nNext steps:")
  console.log("  1. Fully restart opencode (quit the app, reopen, start a new session)")
  console.log("  2. Paste (Ctrl+V) or drag an image and ask a question")
  console.log("  3. Quick check:")
  console.log("     VISION_BRIDGE_DEBUG=1 opencode run -m <text-only-model> -f <image.png>")
  console.log("     You should see [vision-bridge] ... BRIDGING image in the logs")
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

async function uninstall(opts) {
  const target = resolveTarget(opts.scope)
  console.log(`Uninstalling opencode-vision-bridge (${opts.scope})`)
  console.log(`  target dir: ${target.label}`)
  if (!opts.yes) {
    const ok = await askYesNo("Continue?")
    if (!ok) {
      console.log("Aborted.")
      process.exit(0)
    }
  }

  // 1. Remove the plugin entry from the config.
  const pluginPath = join(target.configDir, PLUGIN_ENTRY)
  const unreg = unregisterPlugin(target.configFile, pluginPath)
  if (unreg.hadConfig) {
    console.log(
      unreg.removed
        ? `  [ok] removed plugin entry from ${target.configFile}`
        : `  [skip] no plugin entry found in ${target.configFile}`
    )
  } else {
    console.log(`  [skip] no config file at ${target.configFile}`)
  }

  // 2. Remove files this installer placed — but never user-modified content.
  for (const f of SHIPPED) {
    const dest = join(target.configDir, f.rel)
    if (!existsSync(dest)) {
      console.log(`  [skip] ${f.label} not present at ${dest}`)
      continue
    }
    const identical = filesEqual(join(ROOT, f.rel), dest)
    if (f.kind === "plugin" || identical) {
      rmSync(dest, { force: true })
      console.log(`  [ok] removed ${dest}`)
    } else {
      console.log(`  [keep] ${dest} was modified locally — left in place to protect your changes`)
    }
  }

  // 3. Drop now-empty dirs we created (plugins/, agent/) — never touch non-empty ones.
  for (const rel of ["plugins", "agent"]) {
    const dir = join(target.configDir, rel)
    if (existsSync(dir) && readdirSync(dir).length === 0) {
      rmSync(dir, { recursive: true, force: true })
      console.log(`  [ok] removed empty directory ${dir}`)
    }
  }

  console.log("\nUninstall complete. Restart opencode for changes to take effect.")
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.error || opts.help || !opts.command) {
    printHelp(opts.error)
    process.exit(opts.error ? 1 : 0)
  }
  if (opts.command === "install") {
    await install(opts)
  } else {
    await uninstall(opts)
  }
}

main().catch((err) => {
  console.error(`error: ${err?.message ?? err}`)
  process.exit(1)
})
