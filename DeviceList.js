// What the panel shows, worked out from what the yonder command printed.
// Plain JavaScript with nothing of QML in it, so that tests/devices.test.mjs
// can run it; Panel.qml only draws what these functions return.
//
// Names and labels come from other devices on the network, so every text
// that leaves this file is one line of limited length.

// The exit status of the panel's command when there is no yonder to run.
var NOT_INSTALLED = 127

// The oldest shape of `devices -json` the panel reads. Later versions only
// add fields, so a higher number is read the same way.
var LIST_VERSION = 1

var NAME_LENGTH = 80
var NOTE_LENGTH = 200

// plural writes a count with its noun: "1 file", "2 files".
function plural(n, noun) {
  return n === 1 ? "1 " + noun : n + " " + noun + "s"
}

// line makes one line of at most limit characters from any value.
function line(value, limit) {
  var text = String(value === undefined || value === null ? "" : value)
    .replace(/\s+/g, " ").replace(/^ | $/g, "")
  return text.length > limit ? text.slice(0, limit - 1) + "…" : text
}

// lastLine is the last line of a command's output that says something,
// without the date and time Go's log writes before a message.
function lastLine(output) {
  var lines = String(output || "").split("\n")
  for (var i = lines.length - 1; i >= 0; i--) {
    var text = line(lines[i].replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d /, ""), NOTE_LENGTH)
    if (text !== "") return text
  }
  return ""
}

// row is one device as the panel lists it. A device that is offline is
// shown but cannot be sent to.
function row(d) {
  var nearby = d.nearby === true
  var offline = !nearby && d.presence !== "online" && d.presence !== "checking"
  var tags = []
  if (d.paired === true) tags.push("Paired")
  if (nearby) tags.push("Nearby")
  if (d.localsend === true) tags.push("LocalSend")
  var status = "Offline, or it has unpaired this device"
  if (nearby) status = "Same network"
  else if (d.presence === "online") status = "Online, on another network"
  else if (d.presence === "checking") status = "Checking whether it is online…"
  return {
    id: d.id,
    name: line(d.name, NAME_LENGTH) || "Unnamed device",
    label: line(d.label, NAME_LENGTH),
    tags: tags,
    offline: offline,
    status: status
  }
}

// read turns the end of `yonder devices -json -app` into what the panel
// shows. state is one of:
//   "missing"  there is no yonder to run
//   "old"      this yonder does not know -json or -app
//   "stopped"  Yonder is not running
//   "empty"    it is running and has no device to send to
//   "list"     rows holds the devices
//   "error"    something else; note says what
function read(exitCode, stdout, stderr) {
  var shown = { state: "error", name: "", rows: [], note: "" }
  if (exitCode === NOT_INSTALLED) {
    shown.state = "missing"
    return shown
  }
  if (exitCode !== 0) {
    // An older yonder answers a flag it does not know with its usage line.
    var old = /^usage: yonder/m.test(String(stderr || "")) || /flag provided but not defined/.test(String(stderr || ""))
    shown.state = old ? "old" : "error"
    shown.note = old ? "" : lastLine(stderr) || "The yonder command stopped with status " + exitCode + "."
    return shown
  }
  var list = null
  try {
    list = JSON.parse(stdout)
  } catch (e) {
    list = null
  }
  if (list === null || typeof list !== "object" || Array.isArray(list)) {
    shown.note = "The yonder command gave an answer the panel cannot read."
    return shown
  }
  if (typeof list.version !== "number" || list.version < LIST_VERSION) {
    shown.state = "old"
    return shown
  }
  if (list.running !== true) {
    shown.state = "stopped"
    return shown
  }
  shown.name = line(list.name, NAME_LENGTH)
  var devices = Array.isArray(list.devices) ? list.devices : []
  var seen = {}
  for (var i = 0; i < devices.length; i++) {
    var d = devices[i]
    if (d === null || typeof d !== "object") continue
    if (typeof d.id !== "string" || d.id === "" || seen[d.id]) continue
    // Known only through the meeting point: nothing can be sent to it until
    // it is paired, and pairing is done in the Yonder window.
    if (d.pairable === true) continue
    seen[d.id] = true
    shown.rows.push(row(d))
  }
  shown.state = shown.rows.length > 0 ? "list" : "empty"
  return shown
}

// subtitle is the line under "Yonder" at the top of the panel: this
// device's name and how many devices can be sent to now.
function subtitle(shown) {
  if (shown.state === "missing") return "not installed"
  if (shown.state === "old") return "too old"
  if (shown.state === "stopped") return "not running"
  if (shown.state === "error") return "no answer"
  var ready = 0
  for (var i = 0; i < shown.rows.length; i++) if (!shown.rows[i].offline) ready++
  var count = ready === 0 ? "no devices" : plural(ready, "device")
  return shown.name === "" ? count : shown.name + " · " + count
}

// picked is the list of paths a command printed, one on each line. The
// command prints a path raw, so a name with a line break would split in two:
// when any line is not an absolute path, the whole answer is refused and the
// list is empty. (Whether a path exists is not looked at here; the panel
// cannot read the disk, and the helper's `pick` has looked already.)
function picked(stdout) {
  var paths = []
  var lines = String(stdout || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    if (lines[i] === "") continue
    if (lines[i].charAt(0) !== "/") return []
    paths.push(lines[i])
  }
  return paths
}

// sendArguments is what follows the yonder command to send paths to the
// device with the ID. The "--" keeps a path from being read as a flag.
function sendArguments(id, paths) {
  return ["send", "-id", id, "--"].concat(paths)
}

// size writes a number of bytes as people read it: "8.4 MB".
function size(bytes) {
  var n = Number(bytes)
  if (!isFinite(n) || n < 0) return ""
  var units = ["bytes", "kB", "MB", "GB", "TB"]
  var u = 0
  while (n >= 1000 && u < units.length - 1) {
    n /= 1000
    u++
  }
  if (u === 0) return plural(n, "byte")
  return (n >= 100 ? n.toFixed(0) : n.toFixed(1)) + " " + units[u]
}

// baseName is the last part of a path.
function baseName(path) {
  var parts = String(path).replace(/\/+$/, "").split("/")
  return parts[parts.length - 1] || String(path)
}

// sending says what is waiting to be sent, for the box at the top of the
// panel: a title, and the names with their size together (bytes < 0 for a
// size that is not known).
function sending(paths, bytes, clipboard) {
  var names = []
  for (var i = 0; i < paths.length && i < 3; i++) names.push(line(baseName(paths[i]), 40))
  var detail = names.join(", ")
  if (paths.length > 3) detail += " and " + (paths.length - 3) + " more"
  if (clipboard) detail = "Text"
  var total = bytes >= 0 ? size(bytes) : ""
  if (total !== "") detail += " · " + total
  return {
    title: clipboard ? "Sending the clipboard" : "Sending " + plural(paths.length, "file"),
    detail: detail
  }
}

// offered is what a device's row says from the press until the send ends.
function offered(count) {
  return "Offered " + plural(count, "file") + ", waiting for them to accept…"
}

// ended is what a device's row says when `yonder send` has ended, in the
// words Yonder printed.
function ended(exitCode, stdout, stderr) {
  if (exitCode === 0) return { ok: true, text: lastLine(stdout) || "Sent." }
  if (exitCode === NOT_INSTALLED) return { ok: false, text: "Yonder is not installed." }
  return { ok: false, text: lastLine(stderr) || lastLine(stdout) || "Could not send." }
}

// step moves a cursor over count places by delta and stays inside them.
function step(index, count, delta) {
  if (count <= 0) return 0
  return Math.max(0, Math.min(count - 1, index + delta))
}

// The values of the "Share and Files" setting, in the order the panel lists
// them, each with the panel's words for it.
var SHARE_MODES = [
  { key: "off", text: "Off" },
  { key: "beside", text: "Beside LocalSend" },
  { key: "takeover", text: "In place of LocalSend" }
]

// shareMode is the setting's value, or "off" for one that is not known.
function shareMode(value) {
  for (var i = 0; i < SHARE_MODES.length; i++) {
    if (SHARE_MODES[i].key === value) return SHARE_MODES[i].key
  }
  return "off"
}

function shareText(mode) {
  for (var i = 0; i < SHARE_MODES.length; i++) {
    if (SHARE_MODES[i].key === mode) return SHARE_MODES[i].text
  }
  return SHARE_MODES[0].text
}

// shareFailure is what the panel says when the helper could not make the
// menu file and Files agree with the setting, in the helper's own words.
function shareFailure(stderr) {
  var said = lastLine(stderr).replace(/^share: /, "")
  return said ? "Not changed: " + said : "Not changed: the helper failed."
}

// shareDone is what the panel says after the helper made the menu file and
// Files agree with the setting: nothing, unless the helper printed that
// Files is running, which reads its actions only when it starts.
function shareDone(stdout) {
  if (String(stdout || "").split("\n").indexOf("files-restart") < 0) return ""
  return "Files shows this after it is started again: close its windows, or run nautilus -q."
}

// handover reads what the helper's `take` printed: what the Share menu or
// Files handed to the panel to send. null when there is nothing, or when it
// is not in a form this panel knows. remove is the clipboard's file, which
// is the panel's to delete after the send.
function handover(text) {
  var lines = String(text || "").split("\n")
  if (lines[0] !== "yonder-send 1") return null
  if (lines[1] !== "files" && lines[1] !== "clipboard") return null
  var paths = []
  for (var i = 3; i < lines.length; i++) {
    if (lines[i].charAt(0) === "/") paths.push(lines[i])
  }
  if (paths.length === 0) return null
  var bytes = /^[0-9]+$/.test(lines[2]) ? Number(lines[2]) : -1
  var clipboard = lines[1] === "clipboard"
  var own = clipboard && /\/yonder-clipboard\.[A-Za-z0-9]+\/clipboard\.txt$/.test(paths[0])
  return { paths: clipboard ? [paths[0]] : paths, bytes: bytes, clipboard: clipboard, remove: own ? paths[0] : "" }
}
