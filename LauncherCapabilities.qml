import QtQuick
import Quickshell
import Quickshell.Io

// Extensions switched off from the launcher itself. This is state, not
// configuration: `config.jsonc` is hand-authored and Omalaunch never rewrites
// it, so an explicit `enabled` there wins over anything toggled here.
Item {
  id: root

  readonly property string stateDir: Quickshell.env("HOME") + "/.local/state/omarchy"
  readonly property string statePath: stateDir + "/omalaunch-capabilities.json"
  property var disabledIds: ({})
  property bool directoryReady: false
  property bool loaded: false

  signal changed()

  function load(rawText) {
    var next = ({})
    try {
      var parsed = JSON.parse(String(rawText || "{}"))
      var ids = parsed && parsed.version === 1 && Array.isArray(parsed.disabled) ? parsed.disabled : []
      for (var i = 0; i < ids.length; i++) {
        var id = String(ids[i] || "").trim()
        if (id) next[id] = true
      }
    } catch (e) {
      next = ({})
    }
    root.disabledIds = next
    root.loaded = true
    root.changed()
  }

  function isDisabled(capability) {
    return root.disabledIds[String(capability || "")] === true
  }

  function save(next) {
    var ids = Object.keys(next).filter(function(id) { return next[id] === true }).sort()
    stateFile.setText(JSON.stringify({ version: 1, disabled: ids }, null, 2) + "\n")
  }

  function setDisabled(capability, disabled) {
    var id = String(capability || "").trim()
    if (!root.loaded || !id) return
    var next = Object.assign({}, root.disabledIds)
    if (disabled) next[id] = true
    else delete next[id]
    root.disabledIds = next
    root.save(next)
    root.changed()
  }

  function toggle(capability) {
    root.setDisabled(capability, !root.isDisabled(capability))
  }

  Process {
    id: initDir
    command: ["install", "-d", "-m", "0700", root.stateDir]
    onExited: root.directoryReady = true
  }

  FileView {
    id: stateFile
    path: root.directoryReady ? root.statePath : ""
    atomicWrites: true
    printErrors: false
    onLoaded: root.load(text())
    onLoadFailed: if (root.directoryReady) root.load("{}")
  }

  Component.onCompleted: initDir.running = true
}
