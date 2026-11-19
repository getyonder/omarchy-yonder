import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "DeviceList.js" as DeviceList

// Yonder in the bar: its mark, and a panel that lists the devices Yonder can
// send to. Everything goes through the yonder command: the list is
// `yonder devices -json -app`, read when the panel opens and every few
// seconds while it is open; a send is `yonder send -id`. Nothing runs while
// the panel is closed, and the panel reads no file of Yonder's.
//
// Omarchy's Share menu and Files can lead here too: the "Share and Files"
// setting says whether, and the helper `share` beside this file makes the
// menu file and Files agree with it. Nothing outside the bar is changed
// before the user has answered the question the panel asks once. Those
// routes hand over what to send through a file only this user can read, which
// the panel collects while it is open (`share take`).
Panel {
  id: root
  moduleName: "org.getyonder.yonder"
  ipcTarget: "org.getyonder.yonder"

  // The command that is Yonder. A "command" list on the widget's entry in
  // shell.json puts another in its place, for a yonder that is not on the
  // PATH: "command": ["/path/to/yonder", "-config", "/path/to/folder"].
  readonly property var yonder: {
    var given = root.setting("command", null)
    if (!given || typeof given === "string" || !(given.length > 0)) return ["yonder"]
    var argv = []
    for (var i = 0; i < given.length; i++) argv.push(String(given[i]))
    return argv
  }

  // What DeviceList.read made of the last answer; "loading" before the first.
  property var shown: ({ state: "loading", name: "", rows: [], note: "" })
  // What a press on a device sends, when the panel was opened with something
  // to send: { paths, bytes, clipboard, remove }. null when a press opens the
  // file chooser. remove is a file of the panel's own to delete afterwards.
  property var pending: null
  // How the sends from this panel stand, by device ID:
  // { busy, ok, text }. Ended ones are forgotten when the panel closes.
  property var sends: ({})
  // The device the file chooser is open for.
  property var choosingFor: null
  property string clipboardNote: ""

  // The helper script beside this file.
  readonly property string helper: decodeURIComponent(Qt.resolvedUrl("share").toString().replace(/^file:\/\//, ""))
  // The "Share and Files" setting, and whether the user has answered the
  // question about it; both are on the widget's entry in shell.json.
  readonly property string share: DeviceList.shareMode(root.setting("share", "off"))
  readonly property bool asked: root.setting("shareAsked", false) === true
  // The question is asked where Yonder works, and not over something to send.
  readonly property bool asking: !asked && !pending && (shown.state === "list" || shown.state === "empty")
  // The answer the question's OK would give.
  property string shareChoice: "beside"
  property bool shareOpen: false
  property string shareNote: ""
  // Whether shareNote tells of a failure, or only of something to know.
  property bool shareFailed: false
  // The mode to apply when the helper's present run ends.
  property string shareNext: ""

  property bool cursorActive: false
  property int cursorIndex: 0

  readonly property color foreground: bar ? bar.foreground : Commons.Color.foreground
  readonly property color urgent: bar ? bar.urgent : Commons.Color.urgent
  readonly property color accent: Commons.Color.accent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property color line: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.25)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  // The words and buttons for each state that has no list.
  readonly property var message: {
    var state = shown.state
    if (state === "empty") return {
      title: "No devices yet",
      body: "Devices on this network that run Yonder or LocalSend show here by themselves. For a device anywhere else, pair it once in Yonder.",
      buttons: [{ key: "open", text: "Open Yonder" }]
    }
    if (state === "stopped") return {
      title: "Yonder is not running",
      body: "While it is closed this computer cannot receive files, and the list is empty.",
      buttons: [{ key: "open", text: "Start Yonder" }]
    }
    if (state === "missing") return {
      title: "Yonder is not installed",
      body: "This panel is a way into the Yonder app and does not hold it. Get it from getyonder.org.",
      buttons: [{ key: "site", text: "Open getyonder.org" }]
    }
    if (state === "old") return {
      title: "This Yonder is too old",
      body: "The panel needs Yonder 0.1.8 or newer. The app itself still works.",
      buttons: [{ key: "site", text: "Open getyonder.org" }, { key: "open", text: "Open Yonder" }]
    }
    if (state === "error") return {
      title: "Yonder did not answer",
      body: shown.note,
      buttons: [{ key: "open", text: "Open Yonder" }]
    }
    return null
  }

  // The places the keyboard cursor can stand, top to bottom: the devices
  // that can be pressed, then the actions or buttons under them.
  readonly property var targets: {
    var keys = []
    if (asking) return ["choice:beside", "choice:takeover", "choice:off", "ok"]
    if (message) {
      for (var b = 0; b < message.buttons.length; b++) keys.push(message.buttons[b].key)
      return keys
    }
    for (var i = 0; i < shown.rows.length; i++) {
      if (root.canPress(shown.rows[i])) keys.push("device:" + shown.rows[i].id)
    }
    if (shown.state !== "list") return keys
    if (pending) keys.push("cancel")
    else {
      keys.push("clipboard", "open", "share")
      if (shareOpen) {
        for (var m = 0; m < DeviceList.SHARE_MODES.length; m++) keys.push("mode:" + DeviceList.SHARE_MODES[m].key)
      }
    }
    return keys
  }
  readonly property string cursorKey: cursorActive && cursorIndex < targets.length ? targets[cursorIndex] : ""

  // command is the yonder command with arguments, run so that a missing
  // yonder ends with DeviceList.NOT_INSTALLED and not with a failure to start.
  function command(args) {
    return ["sh", "-c", 'command -v "$1" >/dev/null 2>&1 || exit ' + DeviceList.NOT_INSTALLED + '; exec "$@"', "sh"]
      .concat(root.yonder, args)
  }

  function refresh() {
    if (!takeRun.running) takeRun.running = true
    if (listRun.running) return
    listRun.command = root.command(["devices", "-json", "-app"])
    listRun.running = true
  }

  function canPress(row) {
    var send = root.sends[row.id]
    return !row.offline && !(send && send.busy)
  }

  function setCursor(key) {
    var at = targets.indexOf(key)
    if (at < 0) return
    cursorActive = true
    cursorIndex = at
  }

  function moveCursor(delta) {
    if (!cursorActive) {
      cursorActive = true
      cursorIndex = DeviceList.step(cursorIndex, targets.length, 0)
      return
    }
    cursorIndex = DeviceList.step(cursorIndex, targets.length, delta)
  }

  function activate(key) {
    if (key === "open") root.openYonder()
    else if (key === "site") root.openSite()
    else if (key === "clipboard") root.takeClipboard()
    else if (key === "cancel") root.dropPending()
    else if (key === "share") root.shareOpen = !root.shareOpen
    else if (key === "ok") root.setShare(root.shareChoice)
    else if (key.indexOf("choice:") === 0) root.shareChoice = key.slice(7)
    else if (key.indexOf("mode:") === 0) {
      root.shareOpen = false
      root.setShare(key.slice(5))
    }
    else if (key.indexOf("device:") === 0) {
      for (var i = 0; i < shown.rows.length; i++) {
        if (shown.rows[i].id === key.slice(7)) root.press(shown.rows[i])
      }
    }
  }

  // press is a press on a device: send what is waiting, or with nothing
  // waiting ask which files. The chooser is another window, so the panel
  // gets out of its way; the row says how the send went when it is opened
  // again.
  function press(row) {
    if (!root.canPress(row)) return
    if (root.pending) {
      var waiting = root.pending
      root.pending = null
      root.send(row, waiting.paths, waiting.remove)
      return
    }
    if (chooser.running) return
    root.choosingFor = row
    chooser.command = ["bash", root.helper, "pick", "Send to " + row.name]
    chooser.running = true
    root.close()
  }

  function setSend(id, value) {
    var next = {}
    for (var key in root.sends) next[key] = root.sends[key]
    if (value) next[id] = value
    else delete next[id]
    root.sends = next
  }

  function send(row, paths, remove) {
    root.setSend(row.id, { busy: true, ok: false, text: DeviceList.offered(paths.length) })
    var run = sendRun.createObject(root, { deviceId: row.id, remove: remove || "" })
    run.command = root.command(DeviceList.sendArguments(row.id, paths))
    run.running = true
  }

  function takeClipboard() {
    if (clipboard.running) return
    root.clipboardNote = ""
    clipboard.running = true
  }

  function dropPending() {
    if (!root.pending) return
    root.removeOwn(root.pending.remove)
    root.pending = null
  }

  // setShare is the user's choice of "Share and Files": it is written to the
  // widget's entry in shell.json, and the helper makes the menu file and
  // Files agree with it.
  function setShare(mode) {
    mode = DeviceList.shareMode(mode)
    if (!root.bar || !root.bar.shell || typeof root.bar.shell.updateEntryInline !== "function") {
      root.shareNote = "Not changed: the bar did not take the setting."
      root.shareFailed = true
      return
    }
    var entry = { id: root.moduleName }
    for (var key in root.settings) if (key !== "id") entry[key] = root.settings[key]
    entry.share = mode
    entry.shareAsked = true
    root.bar.shell.updateEntryInline(root.moduleName, entry)
    root.applyShare(mode)
  }

  // applyShare runs the helper for a mode; it writes nothing where the menu
  // file and Files agree with the mode already.
  function applyShare(mode) {
    if (shareRun.running) {
      root.shareNext = mode
      return
    }
    shareRun.command = ["bash", root.helper, "apply", mode]
    shareRun.running = true
  }

  // removeOwn deletes a file the panel made, and the folder made for it.
  function removeOwn(path) {
    if (!path) return
    Quickshell.execDetached(["sh", "-c", 'rm -f -- "$1" && rmdir -- "${1%/*}"', "sh", path])
  }

  // A second launch of Yonder only brings the running one's window forward.
  function openYonder() {
    Quickshell.execDetached(root.yonder)
    if (shown.state !== "stopped") root.close()
  }

  function openSite() {
    Quickshell.execDetached(["xdg-open", "https://getyonder.org"])
    root.close()
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onOpenedChanged: {
    if (opened) {
      cursorActive = false
      cursorIndex = 0
      if (panelFlick) panelFlick.contentY = 0
      Qt.callLater(function() { keyCatcher.forceActiveFocus() })
      // A setting changed elsewhere, or rows from an older version of the
      // plugin, are put right here. Before the question is answered nothing
      // is written.
      if (root.asked) root.applyShare(root.share)
      return
    }
    root.dropPending()
    root.clipboardNote = ""
    root.shareOpen = false
    root.shareNote = ""
    var busy = {}
    for (var id in root.sends) if (root.sends[id].busy) busy[id] = root.sends[id]
    root.sends = busy
  }
  onTargetsChanged: cursorIndex = DeviceList.step(cursorIndex, targets.length, 0)

  Timer {
    interval: 3000
    running: root.opened
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  Process {
    id: listRun
    running: false
    command: []
    stdout: StdioCollector { id: listOut; waitForEnd: true }
    stderr: StdioCollector { id: listErr; waitForEnd: true }
    onExited: function(exitCode) {
      root.shown = DeviceList.read(exitCode, String(listOut.text || ""), String(listErr.text || ""))
    }
  }

  // The helper runs Omarchy's file chooser, checks its answer against the
  // disk and prints the paths; status 1 is nothing chosen, 2 a chooser that
  // did not open, and 3 an answer that is not a list of paths.
  Process {
    id: chooser
    running: false
    command: []
    stdout: StdioCollector { id: chooserOut; waitForEnd: true }
    onExited: function(exitCode) {
      var row = root.choosingFor
      root.choosingFor = null
      if (!row) return
      var paths = DeviceList.picked(String(chooserOut.text || ""))
      if (exitCode === 0 && paths.length > 0) root.send(row, paths, "")
      else if (exitCode === 3 || (exitCode === 0 && String(chooserOut.text || "").trim() !== "")) root.setSend(row.id, { busy: false, ok: false, text: "The file chooser gave an answer that is not a list of paths." })
      else if (exitCode > 1) root.setSend(row.id, { busy: false, ok: false, text: "The file chooser did not open." })
    }
  }

  // The helper puts the clipboard's text into a file of its own in a new
  // folder only this user can read, and prints the file's path and size.
  // Status 1 is a clipboard with no text in it.
  Process {
    id: clipboard
    running: false
    command: ["bash", root.helper, "clipboard-file"]
    stdout: StdioCollector { id: clipboardOut; waitForEnd: true }
    onExited: function(exitCode) {
      var lines = DeviceList.picked(String(clipboardOut.text || ""))
      if (exitCode !== 0 || lines.length < 2) {
        root.clipboardNote = exitCode === 1 ? "the clipboard holds no text" : "could not read the clipboard"
        return
      }
      if (!root.opened) {
        root.removeOwn(lines[0])
        return
      }
      root.pending = { paths: [lines[0]], bytes: Number(lines[1]), clipboard: true, remove: lines[0] }
    }
  }

  // What the Share menu or Files handed over since the last look; the helper
  // removes it as it prints it.
  Process {
    id: takeRun
    running: false
    command: ["bash", root.helper, "take"]
    stdout: StdioCollector { id: takeOut; waitForEnd: true }
    onExited: function(exitCode) {
      var handed = DeviceList.handover(String(takeOut.text || ""))
      if (!handed) return
      if (!root.opened) {
        root.removeOwn(handed.remove)
        return
      }
      root.dropPending()
      root.shareOpen = false
      root.pending = handed
    }
  }

  Process {
    id: shareRun
    running: false
    command: []
    stdout: StdioCollector { id: shareOut; waitForEnd: true }
    stderr: StdioCollector { id: shareErr; waitForEnd: true }
    onExited: function(exitCode) {
      root.shareFailed = exitCode !== 0
      root.shareNote = root.shareFailed ? DeviceList.shareFailure(String(shareErr.text || ""))
                                        : DeviceList.shareDone(String(shareOut.text || ""))
      if (root.shareNext === "") return
      var next = root.shareNext
      root.shareNext = ""
      root.applyShare(next)
    }
  }

  // One for each send that is under way. `yonder send` ends when the
  // transfer does; the running Yonder does the transfer, so it goes on
  // whatever becomes of the panel.
  Component {
    id: sendRun

    Process {
      id: run
      property string deviceId: ""
      property string remove: ""

      running: false
      stdout: StdioCollector { id: sendOut; waitForEnd: true }
      stderr: StdioCollector { id: sendErr; waitForEnd: true }
      onExited: function(exitCode) {
        var end = DeviceList.ended(exitCode, String(sendOut.text || ""), String(sendErr.text || ""))
        root.setSend(run.deviceId, { busy: false, ok: end.ok, text: end.text })
        root.removeOwn(run.remove)
        run.destroy()
      }
    }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    iconComponent: Component {
      Item {
        YonderIcon {
          anchors.centerIn: parent
          iconSize: Style.bar.iconCanvas
          color: root.barForeground
        }
      }
    }
    onPressed: function(buttonCode) { root.toggle() }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(380))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(560))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) { if (dy !== 0) root.moveCursor(dy) }
      onActivateRequested: if (root.cursorKey !== "") root.activate(root.cursorKey)
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: column
          width: panelFlick.width
          spacing: Style.space(10)

          PanelHero {
            width: parent.width
            title: "Yonder"
            meta: root.shown.state === "loading" ? "" : DeviceList.subtitle(root.shown)
            foreground: root.foreground
            fontFamily: root.fontFamily
            iconComponent: Component {
              YonderIcon {
                iconSize: Style.font.display
                color: root.accent
              }
            }
          }

          // What is waiting to be sent.
          Rectangle {
            visible: root.pending !== null && root.shown.state === "list"
            width: parent.width
            implicitHeight: waitingText.implicitHeight + Style.space(16)
            color: "transparent"
            border.width: 1
            border.color: root.line

            readonly property var words: root.pending
              ? DeviceList.sending(root.pending.paths, root.pending.bytes, root.pending.clipboard)
              : ({ title: "", detail: "" })

            Column {
              id: waitingText
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              anchors.leftMargin: Style.space(10)
              anchors.rightMargin: Style.space(10)
              spacing: Style.space(1)

              Text {
                textFormat: Text.PlainText
                width: parent.width
                text: parent.parent.words.title
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                elide: Text.ElideRight
              }

              Text {
                textFormat: Text.PlainText
                width: parent.width
                text: parent.parent.words.detail
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                elide: Text.ElideMiddle
              }
            }
          }

          Column {
            visible: root.shown.state === "list" && !root.asking
            width: parent.width
            spacing: Style.space(4)

            PanelSectionHeader {
              text: root.pending ? "SEND TO" : "SEND FILES TO"
              foreground: root.foreground
              fontFamily: root.fontFamily
              bottomPadding: Style.space(4)
            }

            Repeater {
              model: root.shown.rows
              DeviceRow {
                required property var modelData
                width: column.width
                device: modelData
              }
            }
          }

          PanelSeparator {
            visible: root.shown.state === "list" && !root.asking
            foreground: root.foreground
          }

          Column {
            visible: root.shown.state === "list" && !root.pending && !root.asking
            width: parent.width
            spacing: Style.space(2)

            ActionRow {
              key: "clipboard"
              glyph: "󰅌"
              text: "Send the clipboard…"
              note: root.clipboardNote
            }

            ActionRow {
              key: "open"
              glyph: "󰖯"
              text: "Open Yonder"
              note: "pair, settings, received files"
            }

            ActionRow {
              key: "share"
              glyph: "󰘮"
              text: "Share and Files"
              drop: DeviceList.shareText(root.share) + (root.shareOpen ? " ▴" : " ▾")
            }

            // The setting, opened: the three choices under its line.
            Item {
              visible: root.shareOpen
              width: parent.width
              implicitHeight: modes.implicitHeight + 2

              Rectangle {
                anchors.right: parent.right
                anchors.rightMargin: Style.space(8)
                width: Math.min(Style.space(200), parent.width)
                height: parent.implicitHeight
                color: "transparent"
                border.width: 1
                border.color: root.line

                Column {
                  id: modes
                  x: 1
                  y: 1
                  width: parent.width - 2

                  Repeater {
                    model: DeviceList.SHARE_MODES
                    ModeRow {
                      required property var modelData
                      mode: modelData.key
                      text: modelData.text
                    }
                  }
                }
              }
            }

            Text {
              textFormat: Text.PlainText
              visible: root.shareNote !== ""
              width: parent.width
              leftPadding: Style.space(8)
              rightPadding: Style.space(8)
              text: root.shareNote
              color: root.shareFailed ? root.urgent : root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.Wrap
            }
          }

          // The question, asked once: nothing outside the bar is changed
          // before it is answered.
          Column {
            visible: root.asking
            width: parent.width
            spacing: Style.space(4)

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: "Add Yonder to Omarchy's Share menu and to Files?"
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              wrapMode: Text.WordWrap
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              bottomPadding: Style.space(4)
              text: "Omarchy sends with LocalSend there today."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              wrapMode: Text.WordWrap
            }

            ChoiceRow {
              mode: "beside"
              title: "Beside LocalSend"
              detail: "Adds \"Send with Yonder\" to both. LocalSend's entries stay."
            }

            ChoiceRow {
              mode: "takeover"
              title: "In place of LocalSend"
              detail: "Share › Clipboard, File, Folder and Receive use Yonder, and Files shows \"Send with Yonder\" only. The command omarchy share still uses LocalSend."
            }

            ChoiceRow {
              mode: "off"
              title: "Not now"
              detail: "Yonder stays in the bar only."
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              topPadding: Style.space(4)
              bottomPadding: Style.space(4)
              leftPadding: Style.space(8)
              rightPadding: Style.space(8)
              text: "Changes your menu file (~/.config/omarchy/extensions/omarchy-menu.jsonc) and your Files extensions folder. \"Off\" puts both back."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.Wrap
            }

            PanelButton { key: "ok"; text: "OK"; main: true }
          }

          Row {
            visible: root.shown.state === "list" && root.pending !== null
            spacing: Style.space(8)

            PanelButton { key: "cancel"; text: "Cancel" }
          }

          Column {
            visible: root.message !== null && !root.asking
            width: parent.width
            spacing: Style.space(4)

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: root.message ? root.message.title : ""
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              wrapMode: Text.WordWrap
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: root.message ? root.message.body : ""
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              wrapMode: Text.WordWrap
            }
          }

          Row {
            visible: root.message !== null && !root.asking
            spacing: Style.space(8)

            Repeater {
              model: root.message ? root.message.buttons : []
              PanelButton {
                required property var modelData
                required property int index
                key: modelData.key
                text: modelData.text
                main: index === 0
              }
            }
          }
        }
      }
    }
  }

  // One device: a dot for whether it can be reached, its name and the
  // owner's own name for it, and under them its tags and where it is, or
  // how the send to it stands.
  component DeviceRow: CursorSurface {
    id: deviceRow
    property var device: null
    readonly property string key: "device:" + device.id
    readonly property var sendState: root.sends[device.id] || null
    readonly property bool pressable: root.canPress(device)

    hasCursor: root.cursorKey === key
    foreground: root.foreground
    opacity: device.offline ? 0.5 : 1
    implicitHeight: deviceText.implicitHeight + Style.spacing.rowPaddingX

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      enabled: deviceRow.pressable
      cursorShape: deviceRow.pressable ? Qt.PointingHandCursor : Qt.ArrowCursor
      onEntered: root.setCursor(deviceRow.key)
      onClicked: root.press(deviceRow.device)
    }

    RowLayout {
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(8)
      anchors.rightMargin: Style.space(8)
      spacing: Style.space(8)

      Rectangle {
        Layout.alignment: Qt.AlignVCenter
        implicitWidth: Style.space(8)
        implicitHeight: Style.space(8)
        radius: width / 2
        color: deviceRow.device.offline ? "transparent"
          : (deviceRow.sendState && deviceRow.sendState.busy ? root.accent : root.foreground)
        border.width: deviceRow.device.offline ? 1 : 0
        border.color: root.dim
      }

      ColumnLayout {
        id: deviceText
        Layout.fillWidth: true
        spacing: Style.space(2)

        RowLayout {
          Layout.fillWidth: true
          spacing: 0

          Text {
            textFormat: Text.PlainText
            Layout.maximumWidth: deviceText.width * (deviceRow.device.label !== "" ? 0.6 : 1)
            text: deviceRow.device.name
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            elide: Text.ElideRight
          }

          Text {
            textFormat: Text.PlainText
            Layout.fillWidth: true
            text: deviceRow.device.label !== "" ? " · " + deviceRow.device.label : ""
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            elide: Text.ElideRight
          }
        }

        RowLayout {
          Layout.fillWidth: true
          spacing: Style.space(4)

          Repeater {
            model: deviceRow.sendState ? [] : deviceRow.device.tags
            Rectangle {
              required property string modelData
              implicitWidth: tagText.implicitWidth + Style.space(8)
              implicitHeight: tagText.implicitHeight + Style.space(2)
              color: "transparent"
              border.width: 1
              border.color: root.line

              Text {
                id: tagText
                textFormat: Text.PlainText
                anchors.centerIn: parent
                text: parent.modelData
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }
          }

          Text {
            textFormat: Text.PlainText
            Layout.fillWidth: true
            text: deviceRow.sendState ? deviceRow.sendState.text : deviceRow.device.status
            color: !deviceRow.sendState || deviceRow.sendState.busy ? root.dim
              : (deviceRow.sendState.ok ? root.foreground : root.urgent)
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }
        }
      }

      Text {
        textFormat: Text.PlainText
        visible: deviceRow.hasCursor
        Layout.alignment: Qt.AlignVCenter
        text: root.pending ? "Send" : "Choose files…"
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }
    }
  }

  // One line under the list: an icon, what it does, and a note at the right.
  component ActionRow: CursorSurface {
    id: actionRow
    property string key: ""
    property string glyph: ""
    property string text: ""
    property string note: ""
    // The value of a setting, drawn in a box at the right.
    property string drop: ""

    width: parent ? parent.width : implicitWidth
    hasCursor: root.cursorKey === key
    foreground: root.foreground
    implicitHeight: actionLine.implicitHeight + Style.spacing.rowPaddingX

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onEntered: root.setCursor(actionRow.key)
      onClicked: root.activate(actionRow.key)
    }

    RowLayout {
      id: actionLine
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(8)
      anchors.rightMargin: Style.space(8)
      spacing: Style.space(8)

      Text {
        textFormat: Text.PlainText
        text: actionRow.glyph
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.icon
      }

      Text {
        textFormat: Text.PlainText
        text: actionRow.text
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
      }

      Text {
        textFormat: Text.PlainText
        Layout.fillWidth: true
        horizontalAlignment: Text.AlignRight
        text: actionRow.note
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        elide: Text.ElideRight
      }

      Rectangle {
        visible: actionRow.drop !== ""
        implicitWidth: dropText.implicitWidth + Style.space(16)
        implicitHeight: dropText.implicitHeight + Style.space(2)
        color: "transparent"
        border.width: 1
        border.color: root.line

        Text {
          id: dropText
          textFormat: Text.PlainText
          anchors.centerIn: parent
          text: actionRow.drop
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
        }
      }
    }
  }

  // One choice of the opened setting; the one in force is in the accent.
  component ModeRow: CursorSurface {
    id: modeRow
    property string mode: ""
    property string text: ""
    readonly property string key: "mode:" + mode

    width: parent ? parent.width : implicitWidth
    hasCursor: root.cursorKey === key
    foreground: root.foreground
    implicitHeight: modeText.implicitHeight + Style.spacing.rowPaddingX

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onEntered: root.setCursor(modeRow.key)
      onClicked: root.activate(modeRow.key)
    }

    Text {
      id: modeText
      textFormat: Text.PlainText
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(8)
      anchors.rightMargin: Style.space(8)
      text: modeRow.text
      color: root.share === modeRow.mode ? root.accent : root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      elide: Text.ElideRight
    }
  }

  // One answer to the question asked once: a radio mark, its name, and what
  // it does.
  component ChoiceRow: CursorSurface {
    id: choiceRow
    property string mode: ""
    property string title: ""
    property string detail: ""
    readonly property string key: "choice:" + mode
    readonly property bool chosen: root.shareChoice === mode

    width: parent ? parent.width : implicitWidth
    hasCursor: root.cursorKey === key
    foreground: root.foreground
    implicitHeight: choiceText.implicitHeight + Style.spacing.rowPaddingX

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onEntered: root.setCursor(choiceRow.key)
      onClicked: root.activate(choiceRow.key)
    }

    Rectangle {
      id: radio
      x: Style.space(8)
      y: choiceText.y + Style.space(4)
      width: Style.space(10)
      height: width
      radius: width / 2
      color: "transparent"
      border.width: 1
      border.color: choiceRow.chosen ? root.accent : root.dim

      Rectangle {
        visible: choiceRow.chosen
        anchors.centerIn: parent
        width: parent.width / 2
        height: width
        radius: width / 2
        color: root.accent
      }
    }

    Column {
      id: choiceText
      anchors.left: radio.right
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(8)
      anchors.rightMargin: Style.space(8)
      spacing: Style.space(2)

      Text {
        textFormat: Text.PlainText
        width: parent.width
        text: choiceRow.title
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        elide: Text.ElideRight
      }

      Text {
        textFormat: Text.PlainText
        width: parent.width
        text: choiceRow.detail
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        wrapMode: Text.WordWrap
      }
    }
  }

  // A button under a message; the first of a row is drawn in the accent.
  component PanelButton: Button {
    id: panelButton
    property string key: ""
    property bool main: false

    bordered: true
    foreground: main ? root.accent : root.foreground
    fontFamily: root.fontFamily
    hasCursor: root.cursorKey === key
    onHovered: function(isHovered) { if (isHovered) root.setCursor(panelButton.key) }
    onClicked: root.activate(panelButton.key)
  }
}
