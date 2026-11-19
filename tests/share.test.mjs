// Tests of the helper `share` and of files-action.py: what the "Share and
// Files" setting writes, and what is handed to the panel. Run with tests/run,
// or `node tests/share.test.mjs`.
//
// Every test works in a folder of its own under the system's temporary
// folder: a home with copies of a menu file and a Files extensions folder,
// a runtime folder, and stand-ins for the commands the helper runs
// (omarchy-shell, the file chooser, the clipboard, yonder). The user's real
// menu file, Files extensions and shell are never reached; run() refuses to
// start the helper if a folder it is given lies anywhere else.

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const testDir = path.dirname(fileURLToPath(import.meta.url))
const plugin = path.join(testDir, "..")
const helper = path.join(plugin, "share")
const ID = "org.getyonder.yonder"

// The menu file of a new Omarchy installation: comments only.
const COMMENTS_ONLY = `{
  // Extend the Quickshell Omarchy menu with JSONC.
  //
  // Examples:
  // "personal": {"icon":"","label":"Personal"},
}
`

// A menu file with rows of the user's own, the last without a comma.
const WITH_ROWS = `// my menu
{
  // notes
  "personal": {"icon":"N","label":"Personal"},
  "personal.notes": {"label":"Notes","action":"omarchy-launch-editor ~/notes"}
}
`

const LOCALSEND = "# LocalSend's action in Files\n"
const TRANSCODE = "# another action of the user's\n"

// A stand-in writes its name and arguments to the calls file, one call on
// each line, and then does what its body says.
const STAND_INS = {
  "omarchy-shell": 'cat "$SANDBOX/summon-answer" 2>/dev/null || echo ok',
  "omarchy-file-select": 'cat "$SANDBOX/picked" 2>/dev/null; exit "$(cat "$SANDBOX/pick-status" 2>/dev/null || echo 0)"',
  "omarchy-notification-send": "",
  "omarchy-menu-share": "",
  "wl-paste": 'cat "$SANDBOX/clipboard" 2>/dev/null',
  "uwsm-app": "",
  "yonder": "",
  // Files is running when the test says so.
  "pgrep": '[ -e "$SANDBOX/files-running" ]',
}

// sandbox makes the folders of one test and removes them when it ends.
function sandbox(t, { menu = COMMENTS_ONLY, extensions = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yonder-share-test-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const box = {
    root,
    home: path.join(root, "home"),
    config: path.join(root, "home", ".config"),
    data: path.join(root, "home", ".local", "share"),
    runtime: path.join(root, "runtime"),
    bin: path.join(root, "bin"),
    calls: path.join(root, "calls"),
  }
  box.menu = path.join(box.config, "omarchy", "extensions", "omarchy-menu.jsonc")
  box.files = path.join(box.data, "nautilus-python", "extensions")
  box.handover = path.join(box.runtime, ID + ".send")

  for (const dir of [box.config, box.data, box.bin]) fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(box.runtime, { mode: 0o700 })
  if (menu !== null) {
    fs.mkdirSync(path.dirname(box.menu), { recursive: true })
    fs.writeFileSync(box.menu, menu)
  }
  if (extensions) {
    fs.mkdirSync(box.files, { recursive: true })
    fs.writeFileSync(path.join(box.files, "localsend.py"), LOCALSEND)
    fs.writeFileSync(path.join(box.files, "transcode.py"), TRANSCODE)
  }
  for (const [name, body] of Object.entries(STAND_INS)) {
    // pgrep only looks, so it is left out of the calls.
    const record = name === "pgrep" ? "" : `printf '%s\\n' "${name} $*" >>"$SANDBOX/calls"\n`
    fs.writeFileSync(path.join(box.bin, name), `#!/bin/sh\n${record}${body}\n`, { mode: 0o755 })
  }
  return box
}

function environment(box) {
  const env = {
    HOME: box.home,
    XDG_CONFIG_HOME: box.config,
    XDG_DATA_HOME: box.data,
    XDG_RUNTIME_DIR: box.runtime,
    SANDBOX: box.root,
    PATH: `${box.bin}:/usr/bin:/bin`,
    LC_ALL: "C",
  }
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR"]) {
    assert.ok(env[key].startsWith(os.tmpdir() + path.sep), `${key} is outside the temporary folder`)
  }
  return env
}

// run runs the helper in a sandbox and returns its status and what it printed.
function run(box, args, { script = helper, cwd = box.root } = {}) {
  const done = spawnSync("bash", [script, ...args], { env: environment(box), cwd, encoding: "utf8" })
  return { status: done.status, out: done.stdout, err: done.stderr }
}

function ok(box, args, more) {
  const done = run(box, args, more)
  assert.equal(done.status, 0, `share ${args.join(" ")}: ${done.err}`)
  return done.out
}

const read = (file) => fs.readFileSync(file, "utf8")
const calls = (box) => (fs.existsSync(box.calls) ? read(box.calls).split("\n").filter(Boolean) : [])
const listing = (dir) => fs.readdirSync(dir).sort()

// rows reads a menu file as Omarchy's shell does (stripJsonc in its
// plugins/menu/MenuModel.js: whole-line comments go, then a comma before a
// closing brace) and fails if what is left is not JSON.
function rows(text) {
  const stripped = text.replace(/^\s*\/\/[^\n]*(\n|$)/gm, "").replace(/,(\s*[}\]])/g, "$1")
  return JSON.parse(stripped)
}

// withoutBlock is a menu file with the lines from mark to mark taken out.
function withoutBlock(text) {
  const kept = []
  let inside = false
  for (const line of text.split("\n")) {
    if (line.includes("// >>> " + ID)) inside = true
    else if (line.includes("// <<< " + ID)) inside = false
    else if (!inside) kept.push(line)
  }
  return kept.join("\n")
}

// installPlugin puts the helper where an installed plugin has it.
function installPlugin(box) {
  const dir = path.join(box.config, "omarchy", "plugins", ID)
  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(helper, path.join(dir, "share"))
  fs.copyFileSync(path.join(plugin, "files-action.py"), path.join(dir, "files-action.py"))
  return path.join(dir, "share")
}

// runAction runs a menu row's action as the menu does.
function runAction(box, action) {
  const done = spawnSync("bash", ["-c", action], { env: environment(box), cwd: box.root, encoding: "utf8" })
  assert.equal(done.status, 0, done.stderr)
}

// ---- The setting: the menu file ----

test("beside adds one row and leaves every other line as it was", (t) => {
  const box = sandbox(t)
  ok(box, ["apply", "beside"])

  const text = read(box.menu)
  assert.equal(withoutBlock(text), COMMENTS_ONLY)
  const menu = rows(text)
  assert.deepEqual(Object.keys(menu), ["trigger.share.yonder"])
  assert.equal(menu["trigger.share.yonder"].label, "Send with Yonder")
  assert.equal(menu["trigger.share.yonder"].icon, "\u{f048a}")
  assert.equal(ok(box, ["status"]), "beside\n")
})

test("take over replaces the four Share rows by id and adds none", (t) => {
  const box = sandbox(t)
  ok(box, ["apply", "takeover"])

  const text = read(box.menu)
  assert.equal(withoutBlock(text), COMMENTS_ONLY)
  const menu = rows(text)
  assert.deepEqual(Object.keys(menu),
    ["trigger.share.clipboard", "trigger.share.file", "trigger.share.folder", "trigger.share.receive"])
  // The shell replaces a row whole, so each carries Omarchy's icon and label.
  assert.deepEqual(Object.values(menu).map((row) => [row.icon, row.label, row.description]), [
    ["\u{f07f}", "Clipboard", "Yonder"],
    ["\u{ea7b}", "File", "Yonder"],
    ["\u{f114}", "Folder", "Yonder"],
    ["\u{f0966}", "Receive", "Yonder"],
  ])
  assert.equal(ok(box, ["status"]), "takeover\n")
})

test("off puts the menu file back byte for byte", (t) => {
  for (const mode of ["beside", "takeover"]) {
    for (const before of [COMMENTS_ONLY, WITH_ROWS]) {
      const box = sandbox(t, { menu: before })
      ok(box, ["apply", mode])
      assert.notEqual(read(box.menu), before)
      ok(box, ["apply", "off"])
      assert.equal(read(box.menu), before)
      assert.equal(ok(box, ["status"]), "off\n")
    }
  }
})

test("a change of mode leaves one block", (t) => {
  const box = sandbox(t)
  ok(box, ["apply", "takeover"])
  ok(box, ["apply", "beside"])

  const text = read(box.menu)
  assert.equal(text.split("// >>> " + ID).length - 1, 1)
  assert.deepEqual(Object.keys(rows(text)), ["trigger.share.yonder"])
  assert.equal(withoutBlock(text), COMMENTS_ONLY)
})

test("the same mode again writes nothing", (t) => {
  const box = sandbox(t)
  ok(box, ["apply", "beside"])
  const past = new Date(Date.now() - 100000)
  fs.utimesSync(box.menu, past, past)
  fs.utimesSync(path.join(box.files, "yonder_send.py"), past, past)

  ok(box, ["apply", "beside"])
  assert.equal(fs.statSync(box.menu).mtimeMs, past.getTime())
  assert.equal(fs.statSync(path.join(box.files, "yonder_send.py")).mtimeMs, past.getTime())
})

test("the user's own rows stay, and one of theirs with the same id wins", (t) => {
  const own = WITH_ROWS.replace('"personal":', '"trigger.share.file": {"action":"mine"},\n  "personal":')
  const box = sandbox(t, { menu: own })
  ok(box, ["apply", "takeover"])

  const text = read(box.menu)
  assert.equal(withoutBlock(text), own)
  const menu = rows(text)
  assert.equal(menu["personal.notes"].label, "Notes")
  assert.equal(menu["trigger.share.file"].action, "mine")
  assert.match(menu["trigger.share.folder"].action, /menu folder/)
})

test("with no menu file, beside makes one and off removes it again", (t) => {
  const box = sandbox(t, { menu: null })
  ok(box, ["apply", "off"])
  assert.equal(fs.existsSync(box.menu), false)

  ok(box, ["apply", "beside"])
  assert.deepEqual(Object.keys(rows(read(box.menu))), ["trigger.share.yonder"])
  ok(box, ["apply", "takeover"])
  ok(box, ["apply", "off"])
  assert.equal(fs.existsSync(box.menu), false)
})

test("a menu file the helper made stays once the user has written in it", (t) => {
  const box = sandbox(t, { menu: null })
  ok(box, ["apply", "beside"])
  fs.writeFileSync(box.menu, read(box.menu).replace(/\}\s*$/, '  "personal": {"label":"Personal"}\n}\n'))

  ok(box, ["apply", "off"])
  assert.deepEqual(rows(read(box.menu)), { personal: { label: "Personal" } })
})

test("a menu file that does not open with a line of its own is left alone", (t) => {
  const oneLine = '{"personal": {"label":"Personal"}}\n'
  const box = sandbox(t, { menu: oneLine })
  const before = listing(box.files)

  const done = run(box, ["apply", "beside"])
  assert.equal(done.status, 1)
  assert.match(done.err, /does not start with a line that holds only \{/)
  assert.equal(read(box.menu), oneLine)
  assert.deepEqual(listing(box.files), before)
})

test("damaged marks stop the helper before it removes anything", (t) => {
  const box = sandbox(t)
  ok(box, ["apply", "beside"])
  const damaged = read(box.menu).split("\n").filter((line) => !line.includes("// <<< " + ID)).join("\n")
  fs.writeFileSync(box.menu, damaged)

  for (const mode of ["off", "beside", "takeover"]) {
    const done = run(box, ["apply", mode])
    assert.equal(done.status, 1)
    assert.match(done.err, /marks .* are damaged/)
    assert.equal(read(box.menu), damaged)
  }
})

test("a menu file that is a link stays a link", (t) => {
  const box = sandbox(t)
  const kept = path.join(box.root, "dotfiles-menu.jsonc")
  fs.renameSync(box.menu, kept)
  fs.symlinkSync(kept, box.menu)

  ok(box, ["apply", "beside"])
  assert.ok(fs.lstatSync(box.menu).isSymbolicLink())
  assert.deepEqual(Object.keys(rows(read(kept))), ["trigger.share.yonder"])
  ok(box, ["apply", "off"])
  assert.ok(fs.lstatSync(box.menu).isSymbolicLink())
  assert.equal(read(kept), COMMENTS_ONLY)
})

test("apply refuses a mode it does not know", (t) => {
  const box = sandbox(t)
  assert.equal(run(box, ["apply", "everything"]).status, 1)
  assert.equal(run(box, ["apply"]).status, 1)
  assert.equal(read(box.menu), COMMENTS_ONLY)
})

// ---- The setting: the rows' commands ----

test("a row runs the helper while the plugin is installed", (t) => {
  const box = sandbox(t)
  ok(box, ["apply", "takeover"])
  installPlugin(box)
  fs.writeFileSync(path.join(box.root, "pick-status"), "1")

  runAction(box, rows(read(box.menu))["trigger.share.file"].action)
  assert.deepEqual(calls(box), ["omarchy-file-select --title Send with Yonder --multiple"])
})

test("a row left behind runs Omarchy's own command once the plugin is gone", (t) => {
  const box = sandbox(t)
  ok(box, ["apply", "takeover"])
  const menu = rows(read(box.menu))

  for (const key of Object.keys(menu)) runAction(box, menu[key].action)
  assert.deepEqual(calls(box), [
    "omarchy-menu-share clipboard",
    "omarchy-menu-share file",
    "omarchy-menu-share folder",
    "uwsm-app -- localsend",
  ])
})

test("the row beside LocalSend's shows only while the plugin is installed", (t) => {
  const box = sandbox(t)
  ok(box, ["apply", "beside"])
  const row = rows(read(box.menu))["trigger.share.yonder"]
  const shown = () => spawnSync("bash", ["-c", row.when], { env: environment(box) }).status === 0

  assert.equal(shown(), false)
  runAction(box, row.action)
  assert.deepEqual(calls(box), [])

  installPlugin(box)
  assert.equal(shown(), true)
})

// ---- The setting: Files ----

test("beside adds the Files action and leaves LocalSend's", (t) => {
  const box = sandbox(t)
  ok(box, ["apply", "beside"])

  assert.deepEqual(listing(box.files), ["localsend.py", "transcode.py", "yonder_send.py"])
  assert.equal(read(path.join(box.files, "yonder_send.py")), read(path.join(plugin, "files-action.py")))
  assert.equal(read(path.join(box.files, "localsend.py")), LOCALSEND)
})

test("take over puts LocalSend's action aside, and beside or off bring it back", (t) => {
  for (const back of ["beside", "off"]) {
    const box = sandbox(t)
    ok(box, ["apply", "takeover"])
    assert.deepEqual(listing(box.files), ["localsend.py.yonder-aside", "transcode.py", "yonder_send.py"])
    assert.equal(read(path.join(box.files, "localsend.py.yonder-aside")), LOCALSEND)

    ok(box, ["apply", back])
    assert.equal(read(path.join(box.files, "localsend.py")), LOCALSEND)
    assert.equal(read(path.join(box.files, "transcode.py")), TRANSCODE)
    assert.deepEqual(listing(box.files),
      back === "off" ? ["localsend.py", "transcode.py"] : ["localsend.py", "transcode.py", "yonder_send.py"])
  }
})

test("a LocalSend action that came back by itself is the one that stays", (t) => {
  const box = sandbox(t)
  ok(box, ["apply", "takeover"])
  fs.writeFileSync(path.join(box.files, "localsend.py"), "# a newer one\n")

  ok(box, ["apply", "off"])
  assert.equal(read(path.join(box.files, "localsend.py")), "# a newer one\n")
  // The older one is not thrown away: it differs from what is there now.
  assert.equal(read(path.join(box.files, "localsend.py.yonder-aside")), LOCALSEND)
})

test("with no Files extensions folder, beside makes it and off removes it", (t) => {
  const box = sandbox(t, { extensions: false })
  ok(box, ["apply", "takeover"])
  assert.deepEqual(listing(box.files), ["yonder_send.py"])

  ok(box, ["apply", "off"])
  assert.equal(fs.existsSync(path.join(box.data, "nautilus-python")), false)
  assert.ok(fs.existsSync(box.data))
})

test("remove is off, and clears what was handed over and not collected", (t) => {
  const box = sandbox(t)
  ok(box, ["apply", "takeover"])
  fs.writeFileSync(path.join(box.root, "clipboard"), "some text")
  ok(box, ["menu", "clipboard"])
  assert.ok(fs.existsSync(box.handover))

  ok(box, ["remove"])
  assert.equal(read(box.menu), COMMENTS_ONLY)
  assert.deepEqual(listing(box.files), ["localsend.py", "transcode.py"])
  assert.deepEqual(listing(box.runtime), [])
})

test("remove with nothing handed over is not a fault", (t) => {
  const box = sandbox(t)
  ok(box, ["apply", "beside"])
  ok(box, ["remove"])
  assert.equal(read(box.menu), COMMENTS_ONLY)
})

test("off removes the compiled copy of the Files action, and no other", (t) => {
  const box = sandbox(t)
  ok(box, ["apply", "beside"])
  const cache = path.join(box.files, "__pycache__")
  fs.mkdirSync(cache)
  fs.writeFileSync(path.join(cache, "yonder_send.cpython-314.pyc"), "")
  fs.writeFileSync(path.join(cache, "transcode.cpython-314.pyc"), "")

  ok(box, ["apply", "off"])
  assert.deepEqual(listing(cache), ["transcode.cpython-314.pyc"])

  // A cache folder that held only the action's copy goes with it.
  ok(box, ["apply", "beside"])
  fs.rmSync(path.join(cache, "transcode.cpython-314.pyc"))
  fs.writeFileSync(path.join(cache, "yonder_send.cpython-314.pyc"), "")
  ok(box, ["apply", "off"])
  assert.deepEqual(listing(box.files), ["localsend.py", "transcode.py"])
})

test("apply says that Files must be started again only when Files is running and its actions changed", (t) => {
  const box = sandbox(t)
  assert.equal(ok(box, ["apply", "beside"]), "")

  fs.writeFileSync(path.join(box.root, "files-running"), "")
  assert.equal(ok(box, ["apply", "beside"]), "")
  assert.equal(ok(box, ["apply", "takeover"]), "files-restart\n")
  assert.equal(ok(box, ["apply", "takeover"]), "")
  assert.equal(ok(box, ["apply", "off"]), "files-restart\n")
  assert.equal(ok(box, ["apply", "off"]), "")
})

// ---- Handing files to the panel ----

test("files writes the list for the panel, readable by the owner only, and opens the panel", (t) => {
  const box = sandbox(t)
  const a = path.join(box.root, "holiday 01.jpg")
  const b = path.join(box.root, "notes.pdf")
  fs.writeFileSync(a, "12345")
  fs.writeFileSync(b, "123")

  ok(box, ["files", a, "notes.pdf", path.join(box.root, "not there")])
  assert.equal(read(box.handover), `yonder-send 1\nfiles\n8\n${a}\n${b}\n`)
  assert.equal(fs.statSync(box.handover).mode & 0o777, 0o600)
  assert.deepEqual(listing(box.runtime), [ID + ".send"])
  assert.deepEqual(calls(box), [`omarchy-shell shell summon ${ID} {}`])
})

test("a folder stands for the files in it", (t) => {
  const box = sandbox(t)
  const dir = path.join(box.root, "trip")
  fs.mkdirSync(path.join(dir, "day 2"), { recursive: true })
  fs.writeFileSync(path.join(dir, "b.txt"), "bb")
  fs.writeFileSync(path.join(dir, "day 2", "a.txt"), "a")

  ok(box, ["files", dir])
  assert.equal(read(box.handover),
    `yonder-send 1\nfiles\n3\n${path.join(dir, "b.txt")}\n${path.join(dir, "day 2", "a.txt")}\n`)
})

test("with nothing to send the panel is not opened", (t) => {
  const box = sandbox(t)
  fs.mkdirSync(path.join(box.root, "empty"))

  const done = run(box, ["files", path.join(box.root, "empty"), path.join(box.root, "not there")])
  assert.equal(done.status, 1)
  assert.equal(fs.existsSync(box.handover), false)
  assert.deepEqual(calls(box), ["omarchy-notification-send -g  -u critical Could not share there are no files to send"])
})

test("when the panel does not open, nothing is left behind", (t) => {
  const box = sandbox(t)
  fs.writeFileSync(path.join(box.root, "summon-answer"), "unknown\n")
  fs.writeFileSync(path.join(box.root, "clipboard"), "some text")
  fs.writeFileSync(path.join(box.root, "a.txt"), "a")

  assert.equal(run(box, ["files", path.join(box.root, "a.txt")]).status, 1)
  assert.equal(run(box, ["menu", "clipboard"]).status, 1)
  assert.deepEqual(listing(box.runtime), [])
  assert.equal(calls(box).filter((line) => line.startsWith("omarchy-notification-send")).length, 2)
})

test("take prints the list once and removes it", (t) => {
  const box = sandbox(t)
  fs.writeFileSync(path.join(box.root, "a.txt"), "a")
  ok(box, ["files", path.join(box.root, "a.txt")])

  assert.equal(ok(box, ["take"]), `yonder-send 1\nfiles\n1\n${path.join(box.root, "a.txt")}\n`)
  assert.equal(fs.existsSync(box.handover), false)
  assert.equal(ok(box, ["take"]), "")
})

test("a list nobody collected in time is removed and not shown", (t) => {
  const box = sandbox(t)
  fs.writeFileSync(path.join(box.root, "clipboard"), "some text")
  ok(box, ["menu", "clipboard"])
  const old = new Date(Date.now() - 61000)
  fs.utimesSync(box.handover, old, old)

  assert.equal(ok(box, ["take"]), "")
  assert.deepEqual(listing(box.runtime), [])
})

test("the menu's Clipboard hands over the clipboard's text as a file", (t) => {
  const box = sandbox(t)
  fs.writeFileSync(path.join(box.root, "clipboard"), "some text")
  ok(box, ["menu", "clipboard"])

  const lines = read(box.handover).split("\n")
  assert.deepEqual(lines.slice(0, 3), ["yonder-send 1", "clipboard", "9"])
  assert.match(lines[3], /\/runtime\/yonder-clipboard\.\w+\/clipboard\.txt$/)
  assert.equal(read(lines[3]), "some text")
  assert.equal(fs.statSync(path.dirname(lines[3])).mode & 0o777, 0o700)
})

test("an empty clipboard hands nothing over", (t) => {
  const box = sandbox(t)
  assert.equal(run(box, ["menu", "clipboard"]).status, 1)
  assert.deepEqual(listing(box.runtime), [])
  assert.equal(run(box, ["clipboard-file"]).status, 1)
  assert.deepEqual(listing(box.runtime), [])
})

test("clipboard-file prints the file and its size, for the panel", (t) => {
  const box = sandbox(t)
  fs.writeFileSync(path.join(box.root, "clipboard"), "some text")
  const lines = ok(box, ["clipboard-file"]).split("\n")
  assert.equal(read(lines[0]), "some text")
  assert.equal(lines[1], "9")
  assert.deepEqual(calls(box), ["wl-paste --type text"])
})

test("the menu's File and Folder ask the chooser, then hand over", (t) => {
  const box = sandbox(t)
  const dir = path.join(box.root, "trip")
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, "a.txt"), "a")
  fs.writeFileSync(path.join(box.root, "b.txt"), "bb")

  fs.writeFileSync(path.join(box.root, "picked"), `${path.join(dir, "a.txt")}\n${path.join(box.root, "b.txt")}\n`)
  ok(box, ["menu", "file"])
  assert.equal(ok(box, ["take"]), `yonder-send 1\nfiles\n3\n${path.join(dir, "a.txt")}\n${path.join(box.root, "b.txt")}\n`)

  fs.writeFileSync(path.join(box.root, "picked"), dir + "\n")
  ok(box, ["menu", "folder"])
  assert.equal(ok(box, ["take"]), `yonder-send 1\nfiles\n1\n${path.join(dir, "a.txt")}\n`)

  assert.deepEqual(calls(box).filter((line) => line.startsWith("omarchy-file-select")), [
    "omarchy-file-select --title Send with Yonder --multiple",
    "omarchy-file-select --title Send a folder with Yonder --directory",
  ])
})

test("a pick with a line that is not an existing absolute path hands over nothing", (t) => {
  const box = sandbox(t)
  fs.writeFileSync(path.join(box.root, "b.txt"), "bb")
  // A folder "x\n" holding "y" would print as two lines: "<tmp>/x" and the rest.
  for (const answer of [
    `${path.join(box.root, "x")}\n/etc/hostname\n`,
    `${path.join(box.root, "b.txt")}\nrelative.txt\n`,
    `${path.join(box.root, "b.txt")}\n${path.join(box.root, "gone")}\n`,
  ]) {
    fs.writeFileSync(path.join(box.root, "picked"), answer)
    for (const kind of ["file", "folder"]) {
      const done = run(box, ["menu", kind])
      assert.equal(done.status, 1, answer)
      assert.match(done.err, /not a list of paths/)
    }
    assert.equal(fs.existsSync(box.handover), false)
  }
})

test("a pick under a folder whose name ends in a line break hands over nothing, though both lines exist", (t) => {
  const box = sandbox(t)
  // A file "evil" beside a folder "evil\n": the pick "evil\n/etc/hostname"
  // prints as two lines that both exist.
  fs.writeFileSync(path.join(box.root, "evil"), "e")
  fs.mkdirSync(path.join(box.root, "evil\n"))
  fs.writeFileSync(path.join(box.root, "picked"), `${path.join(box.root, "evil")}\n/etc/hostname\n`)
  const done = run(box, ["menu", "file"])
  assert.equal(done.status, 1)
  assert.match(done.err, /not a list of paths/)
  assert.equal(fs.existsSync(box.handover), false)
})

test("pick prints the paths chosen for the panel, or says by its status why not", (t) => {
  const box = sandbox(t)
  fs.writeFileSync(path.join(box.root, "a.txt"), "a")
  fs.writeFileSync(path.join(box.root, "evil"), "e")
  fs.mkdirSync(path.join(box.root, "evil\n"))

  fs.writeFileSync(path.join(box.root, "picked"), `${path.join(box.root, "a.txt")}\n`)
  assert.equal(ok(box, ["pick", "Send to Quiet Harbor"]), `${path.join(box.root, "a.txt")}\n`)
  assert.deepEqual(calls(box), ["omarchy-file-select --title Send to Quiet Harbor --multiple"])

  // Both lines exist, but the first is also a name with a line break after it.
  for (const answer of [`${path.join(box.root, "evil")}\n/etc/hostname\n`, `${path.join(box.root, "gone")}\n`, "relative\n"]) {
    fs.writeFileSync(path.join(box.root, "picked"), answer)
    const refused = run(box, ["pick", "Send to Quiet Harbor"])
    assert.equal(refused.status, 3, answer)
    assert.equal(refused.out, "")
  }

  fs.writeFileSync(path.join(box.root, "picked"), "")
  fs.writeFileSync(path.join(box.root, "pick-status"), "1")
  assert.equal(run(box, ["pick", "Send to Quiet Harbor"]).status, 1)
  fs.writeFileSync(path.join(box.root, "pick-status"), "2")
  assert.equal(run(box, ["pick", "Send to Quiet Harbor"]).status, 2)
  // The panel shows the message itself: no notification from here.
  assert.equal(calls(box).some((line) => line.startsWith("omarchy-notification-send")), false)
})

test("nothing chosen is not a fault; a chooser that did not open is", (t) => {
  const box = sandbox(t)
  fs.writeFileSync(path.join(box.root, "pick-status"), "1")
  assert.equal(run(box, ["menu", "file"]).status, 0)
  assert.deepEqual(calls(box), ["omarchy-file-select --title Send with Yonder --multiple"])

  fs.writeFileSync(path.join(box.root, "pick-status"), "2")
  assert.equal(run(box, ["menu", "file"]).status, 1)
  assert.match(calls(box).at(-1), /^omarchy-notification-send .* the file chooser did not open$/)
  assert.deepEqual(listing(box.runtime), [])
})

test("the menu's Receive opens Yonder", (t) => {
  const box = sandbox(t)
  ok(box, ["menu", "receive"])
  assert.deepEqual(calls(box), ["uwsm-app -- yonder"])
})

// ---- The Files action ----

// A stand-in for the parts of PyGObject the action uses, and a driver that
// loads the action as Files does and prints what it offers and runs.
const GI = {
  "gi/__init__.py": "def require_version(name, version):\n    pass\n",
  "gi/repository.py": `
import json, os

class _GObject:
    class GObject:
        pass

class _Gio:
    class SubprocessFlags:
        NONE = 0
    class Subprocess:
        @staticmethod
        def new(argv, flags):
            print(json.dumps({"ran": argv}))

class _Item:
    def __init__(self, name, label, icon):
        self.name, self.label, self.icon = name, label, icon
    def connect(self, signal, handler, *args):
        self.handler, self.args = handler, args

class _Nautilus:
    MenuProvider = object
    MenuItem = _Item

GObject, Gio, Nautilus = _GObject, _Gio, _Nautilus
`,
  "drive.py": `
import importlib.util, json, sys

class Location:
    def __init__(self, path): self.path = path
    def get_path(self): return self.path

class File:
    def __init__(self, path): self.path = path
    def get_location(self): return Location(self.path)

spec = importlib.util.spec_from_file_location("yonder_send", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
items = module.SendWithYonderAction().get_file_items([File(p) for p in sys.argv[2:]])
print(json.dumps({"labels": [item.label for item in items]}))
for item in items:
    item.handler(None, *item.args)
`,
}

// filesAction loads the installed action with a selection and returns the
// labels it offers and the command each runs when pressed.
function filesAction(box, selection) {
  const stand = path.join(box.root, "python")
  for (const [name, body] of Object.entries(GI)) {
    fs.mkdirSync(path.dirname(path.join(stand, name)), { recursive: true })
    fs.writeFileSync(path.join(stand, name), body)
  }
  const done = spawnSync("python3", [path.join(stand, "drive.py"), path.join(box.files, "yonder_send.py"), ...selection],
    { env: { ...environment(box), PYTHONPATH: stand, PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8" })
  assert.equal(done.status, 0, done.stderr)
  const lines = done.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line))
  return { labels: lines[0].labels, ran: lines.slice(1).map((line) => line.ran) }
}

test("the Files action offers the selection to the helper", (t) => {
  const box = sandbox(t)
  ok(box, ["apply", "beside"])
  const installed = installPlugin(box)
  const a = path.join(box.root, "a.txt")
  const b = path.join(box.root, "b.txt")
  const dir = path.join(box.root, "trip")
  fs.writeFileSync(a, "a")
  fs.writeFileSync(b, "b")
  fs.mkdirSync(dir)

  assert.deepEqual(filesAction(box, [a]), { labels: ["Send with Yonder"], ran: [["bash", installed, "files", a]] })
  assert.deepEqual(filesAction(box, [a, b, a]).labels, ["Send 2 files with Yonder"])
  assert.deepEqual(filesAction(box, [a, dir]),
    { labels: ["Send 2 items with Yonder"], ran: [["bash", installed, "files", a, dir]] })
  assert.deepEqual(filesAction(box, []), { labels: [], ran: [] })
})

test("with the plugin gone, the Files action puts LocalSend's back and removes itself", (t) => {
  const box = sandbox(t)
  ok(box, ["apply", "takeover"])

  assert.deepEqual(filesAction(box, [path.join(box.root, "a.txt")]), { labels: [], ran: [] })
  assert.deepEqual(listing(box.files), ["localsend.py", "transcode.py"])
  assert.equal(read(path.join(box.files, "localsend.py")), LOCALSEND)
})

test("with the plugin gone, the Files action takes the rows out of the menu file", (t) => {
  for (const mode of ["beside", "takeover"]) {
    const box = sandbox(t, { menu: WITH_ROWS })
    ok(box, ["apply", mode])
    const cache = path.join(box.files, "__pycache__")
    fs.mkdirSync(cache)
    fs.writeFileSync(path.join(cache, "yonder_send.cpython-314.pyc"), "")
    fs.writeFileSync(path.join(cache, "transcode.cpython-314.pyc"), "")

    filesAction(box, [path.join(box.root, "a.txt")])
    assert.equal(read(box.menu), WITH_ROWS)
    assert.deepEqual(listing(cache), ["transcode.cpython-314.pyc"])
  }
})

test("off puts back a menu file's last blank lines, and no temporary file is left", (t) => {
  const before = WITH_ROWS + "\n\n"
  for (const mode of ["beside", "takeover"]) {
    const box = sandbox(t, { menu: before })
    ok(box, ["apply", mode])
    assert.equal(withoutBlock(read(box.menu)), before)
    ok(box, ["apply", "off"])
    assert.equal(read(box.menu), before)
    assert.deepEqual(listing(path.dirname(box.menu)), ["omarchy-menu.jsonc"])
  }
})

test("with the plugin gone, the Files action keeps the menu file's last blank lines", (t) => {
  const before = WITH_ROWS + "\n\n"
  const box = sandbox(t, { menu: before })
  ok(box, ["apply", "beside"])
  filesAction(box, [path.join(box.root, "a.txt")])
  assert.equal(read(box.menu), before)
  assert.deepEqual(listing(path.dirname(box.menu)), ["omarchy-menu.jsonc"])
})

test("with the plugin gone, the Files action removes a menu file the helper made", (t) => {
  const box = sandbox(t, { menu: null })
  ok(box, ["apply", "beside"])
  filesAction(box, [path.join(box.root, "a.txt")])
  assert.equal(fs.existsSync(box.menu), false)
})

test("with the plugin gone, the Files action leaves a menu file with damaged marks alone", (t) => {
  const box = sandbox(t)
  ok(box, ["apply", "takeover"])
  const damaged = read(box.menu).split("\n").filter((line) => !line.includes("// <<< " + ID)).join("\n")
  fs.writeFileSync(box.menu, damaged)

  filesAction(box, [path.join(box.root, "a.txt")])
  assert.equal(read(box.menu), damaged)
  assert.deepEqual(listing(box.files), ["localsend.py", "transcode.py"])
})

test("with the plugin gone, a menu file that is a link stays a link", (t) => {
  const box = sandbox(t, { menu: null })
  const kept = path.join(box.root, "dotfiles-menu.jsonc")
  fs.writeFileSync(kept, COMMENTS_ONLY)
  fs.mkdirSync(path.dirname(box.menu), { recursive: true })
  fs.symlinkSync(kept, box.menu)
  ok(box, ["apply", "beside"])

  filesAction(box, [path.join(box.root, "a.txt")])
  assert.ok(fs.lstatSync(box.menu).isSymbolicLink())
  assert.equal(read(kept), COMMENTS_ONLY)
})
