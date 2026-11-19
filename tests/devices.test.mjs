// Tests of DeviceList.js: what the panel shows for each answer of the
// yonder command. Run with tests/run, or `node tests/devices.test.mjs`.

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import vm from "node:vm"
import { fileURLToPath } from "node:url"

// The file is written for QML, which has no modules, so it is run in a
// context of its own and its functions are read from there.
const testDir = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(testDir, "..", "DeviceList.js"), "utf8")
const list = vm.createContext({})
vm.runInContext(source, list)

// same compares by value: objects made in the other context have other
// prototypes, which deepStrictEqual would call a difference.
const same = (actual, expected) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected)

// answer is what `yonder devices -json -app` prints for these devices.
const answer = (devices, more = {}) =>
  JSON.stringify({ version: 1, running: true, name: "Quiet Harbor", devices, ...more })

const device = (more) => ({
  id: "f0", name: "Swift Comet", label: "", model: "", paired: false, nearby: false,
  presence: "offline", always: false, pairable: false, localsend: false, ...more,
})

test("a list: tags, status and order as the command gave them", () => {
  const shown = list.read(0, answer([
    device({ id: "a", label: "Mum's laptop", paired: true, presence: "online" }),
    device({ id: "b", name: "Kind Pineapple", nearby: true, presence: "online", localsend: true }),
    device({ id: "c", name: "Pixel 7", paired: true, nearby: true, presence: "online" }),
    device({ id: "d", name: "Mellow Harbour", paired: true }),
    device({ id: "e", name: "Slow Otter", paired: true, presence: "checking" }),
  ]), "")
  assert.equal(shown.state, "list")
  assert.equal(shown.name, "Quiet Harbor")
  same(shown.rows, [
    { id: "a", name: "Swift Comet", label: "Mum's laptop", tags: ["Paired"], offline: false, status: "Online, on another network" },
    { id: "b", name: "Kind Pineapple", label: "", tags: ["Nearby", "LocalSend"], offline: false, status: "Same network" },
    { id: "c", name: "Pixel 7", label: "", tags: ["Paired", "Nearby"], offline: false, status: "Same network" },
    { id: "d", name: "Mellow Harbour", label: "", tags: ["Paired"], offline: true, status: "Offline, or it has unpaired this device" },
    { id: "e", name: "Slow Otter", label: "", tags: ["Paired"], offline: false, status: "Checking whether it is online…" },
  ])
  assert.equal(list.subtitle(shown), "Quiet Harbor · 4 devices")
})

test("a nearby device is never offline, whatever its presence says", () => {
  const shown = list.read(0, answer([device({ nearby: true, presence: "offline" })]), "")
  assert.equal(shown.rows[0].offline, false)
  assert.equal(list.subtitle(shown), "Quiet Harbor · 1 device")
})

test("only offline devices: a list, and the subtitle counts none", () => {
  const shown = list.read(0, answer([device({ paired: true })]), "")
  assert.equal(shown.state, "list")
  assert.equal(list.subtitle(shown), "Quiet Harbor · no devices")
})

test("no devices", () => {
  const shown = list.read(0, answer([]), "")
  assert.equal(shown.state, "empty")
  assert.equal(list.subtitle(shown), "Quiet Harbor · no devices")
})

test("a device that can only be paired is left out", () => {
  const shown = list.read(0, answer([device({ id: "p", nearby: true, pairable: true })]), "")
  assert.equal(shown.state, "empty")
})

test("devices without an ID, twice in the list, or not objects are left out", () => {
  const shown = list.read(0, answer([
    null, "x", 7, device({ id: "" }), device({ id: 12 }),
    device({ id: "a", name: "First" }), device({ id: "a", name: "Second" }),
  ]), "")
  same(shown.rows.map((r) => r.name), ["First"])
})

test("names from other devices become one short line", () => {
  const shown = list.read(0, answer([
    device({ id: "a", name: "Two\nlines\tand  spaces ", label: "x".repeat(300) }),
    device({ id: "b", name: "" }),
    device({ id: "c", name: null, label: null }),
  ]), "")
  assert.equal(shown.rows[0].name, "Two lines and spaces")
  assert.equal(shown.rows[0].label.length, 80)
  assert.equal(shown.rows[1].name, "Unnamed device")
  assert.equal(shown.rows[2].name, "Unnamed device")
  assert.equal(shown.rows[2].label, "")
})

test("Yonder is not running", () => {
  const shown = list.read(0, JSON.stringify({ version: 1, running: false, name: "", devices: [] }), "")
  assert.equal(shown.state, "stopped")
  assert.equal(list.subtitle(shown), "not running")
})

test("Yonder is not installed", () => {
  const shown = list.read(list.NOT_INSTALLED, "", "")
  assert.equal(shown.state, "missing")
  assert.equal(list.subtitle(shown), "not installed")
})

test("a Yonder too old for -json answers with its usage line", () => {
  const usage = "usage: yonder [flags] [receive | devices | send DEVICE FILE... | unpair DEVICE]\n"
  assert.equal(list.read(1, "", usage).state, "old")
  assert.equal(list.read(1, "", "2026/11/16 10:00:00 " + usage).state, "error", "the usage line starts a line")
  assert.equal(list.read(2, "", "flag provided but not defined: -app\n").state, "old")
  assert.equal(list.subtitle(list.read(1, "", usage)), "too old")
})

test("a list without a version, or of an older one, is too old", () => {
  assert.equal(list.read(0, JSON.stringify({ devices: [] }), "").state, "old")
  assert.equal(list.read(0, JSON.stringify({ version: 0, running: true, devices: [] }), "").state, "old")
})

test("a later version is read as this one", () => {
  const shown = list.read(0, answer([device({ nearby: true, extra: 1 })], { version: 2, more: true }), "")
  assert.equal(shown.state, "list")
})

test("any other failure says what the command said", () => {
  const shown = list.read(1, "", "2026/11/16 10:00:00 permission denied\n\n")
  assert.equal(shown.state, "error")
  assert.equal(shown.note, "permission denied")
  assert.equal(list.subtitle(shown), "no answer")
  assert.equal(list.read(3, "", "").note, "The yonder command stopped with status 3.")
})

test("an answer that is not the list is an error, not a crash", () => {
  for (const out of ["", "not json", "[]", "null", "7", '"text"']) {
    const shown = list.read(0, out, "")
    assert.equal(shown.state, "error", out)
    assert.equal(shown.rows.length, 0)
    assert.notEqual(shown.note, "")
  }
  assert.equal(list.read(0, JSON.stringify({ version: 1, running: true, devices: "x" }), "").state, "empty")
})

test("picked: one path on each line", () => {
  same(list.picked("/a/one.txt\n/b/two words.txt\n"), ["/a/one.txt", "/b/two words.txt"])
  same(list.picked(""), [])
  same(list.picked("\n"), [])
})

test("picked: a line that is not an absolute path refuses the whole answer", () => {
  same(list.picked("/tmp/x\nrest of a name\n"), [])
  same(list.picked("/a/one.txt\nrelative.txt\n"), [])
})

test("sendArguments: by ID, and a path is never a flag", () => {
  same(list.sendArguments("f0", ["/a", "-rf"]), ["send", "-id", "f0", "--", "/a", "-rf"])
})

test("size", () => {
  assert.equal(list.size(0), "0 bytes")
  assert.equal(list.size(1), "1 byte")
  assert.equal(list.size(999), "999 bytes")
  assert.equal(list.size(1000), "1.0 kB")
  assert.equal(list.size(8400000), "8.4 MB")
  assert.equal(list.size(123456789), "123 MB")
  assert.equal(list.size(5e12), "5.0 TB")
  assert.equal(list.size(-1), "")
  assert.equal(list.size("x"), "")
})

test("sending: what the box says", () => {
  same(list.sending(["/p/holiday-01.jpg", "/p/holiday-02.jpg", "/p/notes.pdf"], 8400000, false),
    { title: "Sending 3 files", detail: "holiday-01.jpg, holiday-02.jpg, notes.pdf · 8.4 MB" })
  same(list.sending(["/a", "/b", "/c", "/d", "/e/"], -1, false),
    { title: "Sending 5 files", detail: "a, b, c and 2 more" })
  same(list.sending(["/one.txt"], 12, false), { title: "Sending 1 file", detail: "one.txt · 12 bytes" })
  same(list.sending(["/run/x/clipboard.txt"], 1200, true), { title: "Sending the clipboard", detail: "Text · 1.2 kB" })
})

test("offered", () => {
  assert.equal(list.offered(1), "Offered 1 file, waiting for them to accept…")
  assert.equal(list.offered(3), "Offered 3 files, waiting for them to accept…")
})

test("ended: Yonder's own words", () => {
  same(list.ended(0, "Sent 1 file to Swift Comet.\n", ""), { ok: true, text: "Sent 1 file to Swift Comet." })
  same(list.ended(0, "", ""), { ok: true, text: "Sent." })
  same(list.ended(1, "", "2026/11/16 10:00:00 Pixel 7 declined.\n"), { ok: false, text: "Pixel 7 declined." })
  same(list.ended(1, "", ""), { ok: false, text: "Could not send." })
  same(list.ended(list.NOT_INSTALLED, "", ""), { ok: false, text: "Yonder is not installed." })
  assert.equal(list.ended(1, "", "x".repeat(500)).text.length, 200)
})

test("step stays inside the list", () => {
  assert.equal(list.step(0, 3, -1), 0)
  assert.equal(list.step(0, 3, 1), 1)
  assert.equal(list.step(2, 3, 1), 2)
  assert.equal(list.step(5, 0, 1), 0)
})

test("what the helper hands over is read as files to send", () => {
  same(list.handover("yonder-send 1\nfiles\n8400000\n/home/u/holiday 01.jpg\n/home/u/notes.pdf\n"),
    { paths: ["/home/u/holiday 01.jpg", "/home/u/notes.pdf"], bytes: 8400000, clipboard: false, remove: "" })
})

test("a clipboard handed over is the panel's to remove, when it is where the helper puts it", () => {
  const file = "/run/user/1000/yonder-clipboard.aB3dEf/clipboard.txt"
  same(list.handover(`yonder-send 1\nclipboard\n9\n${file}\n`),
    { paths: [file], bytes: 9, clipboard: true, remove: file })
  same(list.handover("yonder-send 1\nclipboard\n9\n/home/u/notes.pdf\n"),
    { paths: ["/home/u/notes.pdf"], bytes: 9, clipboard: true, remove: "" })
})

test("nothing handed over, or a form not known, is nothing to send", () => {
  for (const text of ["", "\n", "yonder-send 2\nfiles\n1\n/a\n", "yonder-send 1\nfolders\n1\n/a\n",
    "yonder-send 1\nfiles\n1\n", "yonder-send 1\nfiles\n1\nrelative.txt\n"]) {
    assert.equal(list.handover(text), null)
  }
})

test("a size that is not a number is a size not known", () => {
  assert.equal(list.handover("yonder-send 1\nfiles\n\n/a\n").bytes, -1)
})

test("the setting's value is one of the three, and has the panel's words", () => {
  assert.equal(list.shareMode("takeover"), "takeover")
  assert.equal(list.shareMode(undefined), "off")
  assert.equal(list.shareMode("everything"), "off")
  same(list.SHARE_MODES.map((mode) => list.shareText(mode.key)), ["Off", "Beside LocalSend", "In place of LocalSend"])
})

test("a failure of the helper is told in its own words", () => {
  assert.equal(list.shareFailure("share: could not write /home/u/menu.jsonc\n"), "Not changed: could not write /home/u/menu.jsonc")
  assert.equal(list.shareFailure(""), "Not changed: the helper failed.")
  assert.equal(list.shareDone(""), "")
  assert.match(list.shareDone("files-restart\n"), /^Files shows this after it is started again/)
})
