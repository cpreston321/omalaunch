function stripJsonc(raw) {
  return String(raw || "")
    .replace(/^\s*\/\/[^\n]*(\n|$)/gm, "")
    .replace(/,(\s*[}\]])/g, "$1")
}

function normalizeAliases(value) {
  if (Array.isArray(value)) return value.filter(function(v) { return v })
  if (typeof value === "string" && value) return [value]
  return []
}

function normalizeBadgeTone(value) {
  var tone = String(value || "neutral")
  return ["neutral", "success", "danger", "warning", "info"].indexOf(tone) >= 0 ? tone : "neutral"
}

function normalizeItem(id, raw) {
  var value = raw || {}
  var aliases = normalizeAliases(value.aliases)
  var parent = value.parent
  if (parent === undefined)
    parent = id.indexOf(".") >= 0 ? id.split(".").slice(0, -1).join(".") : "root"
  if (id === "root") parent = ""

  var kind = value.action ? "action" : (value.target ? "link" : "menu")

  return {
    id: id,
    parent: parent,
    kind: kind,
    icon: value.icon || "",
    iconFont: value.iconFont || "",
    trailingIcon: value.trailingIcon || "",
    trailingText: typeof value.trailingText === "string" ? value.trailingText.substring(0, 64) : "",
    badge: value.badge || "",
    badgeTone: normalizeBadgeTone(value.badgeTone),
    label: value.label || id,
    title: value.title || "",
    target: value.target || "",
    description: value.description || "",
    action: value.action || "",
    provider: value.provider || "",
    aliases: aliases,
    when: value.when || "",
    checked: value.checked || ""
  }
}

function parseMenuJsoncSnapshot(raw) {
  var stripped = stripJsonc(raw)
  if (!stripped.trim()) return { valid: false, items: [] }

  var parsed
  try {
    parsed = JSON.parse(stripped)
  } catch (e) {
    return { valid: false, items: [] }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { valid: false, items: [] }

  var source = (parsed.items && typeof parsed.items === "object" && !Array.isArray(parsed.items))
    ? parsed.items
    : parsed
  var out = []
  for (var id in source) {
    var entry = source[id]
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
    out.push(normalizeItem(id, entry))
  }
  return { valid: true, items: out }
}

function parseMenuJsonc(raw) {
  return parseMenuJsoncSnapshot(raw).items
}

function mergeMenuSources(defaultItems, userItems) {
  var nextItems = ({})
  var nextOrder = []
  var sources = [defaultItems || [], userItems || []]

  for (var s = 0; s < sources.length; s++) {
    var src = sources[s]
    for (var i = 0; i < src.length; i++) {
      var entry = src[i]
      if (!entry || !entry.id) continue
      if (!nextItems[entry.id]) nextOrder.push(entry.id)
      var prior = nextItems[entry.id] || {}
      var merged = {}
      for (var k in prior) merged[k] = prior[k]
      for (var k2 in entry) merged[k2] = entry[k2]
      merged.id = entry.id
      nextItems[entry.id] = merged
    }
  }

  if (!nextItems.root) {
    nextItems.root = { id: "root", parent: "", kind: "menu", icon: "", iconFont: "", label: "Go", title: "", target: "", description: "", aliases: [], when: "", checked: "", action: "", provider: "" }
    nextOrder.unshift("root")
  }
  for (var k3 = 0; k3 < nextOrder.length; k3++) nextItems[nextOrder[k3]].order = k3

  return {
    items: nextItems,
    itemOrder: nextOrder
  }
}

// Both merges below return fresh items/itemOrder objects for the caller to
// assign in one go. They must never write into the maps they are handed: those
// live in QML `var` properties, and an in-place write into such an object is
// occasionally dropped by the engine — the key lands with an undefined value.
// A lost write used to leave an id in itemOrder with no item behind it, and
// the next merge then kept that orphan and appended a second row for the same
// app, so the launcher listed it twice (and again on every later rescan).

// Swaps every app row for the current set. Rows keep the order they arrive in;
// ids already claimed (including duplicate desktop ids) are listed once.
function mergeAppRows(items, itemOrder, appRows) {
  var source = items || ({})
  var order = Array.isArray(itemOrder) ? itemOrder : []
  var rows = Array.isArray(appRows) ? appRows : []
  var nextItems = ({})
  var nextOrder = []

  for (var i = 0; i < order.length; i++) {
    var id = order[i]
    var existing = source[id]
    // Orphans (an id with no item) are dropped rather than carried forward,
    // so a single lost write cannot compound into a duplicate row.
    if (!existing || existing.kind === "app") continue
    nextItems[id] = existing
    nextOrder.push(id)
  }

  for (var j = 0; j < rows.length; j++) {
    var row = rows[j]
    if (!row || !row.id || nextItems[row.id]) continue
    row.order = nextOrder.length
    nextItems[row.id] = row
    nextOrder.push(row.id)
  }

  return { items: nextItems, itemOrder: nextOrder }
}

// Swaps the rows one provider contributed, leaving every other item untouched.
// Rows carry the id of the submenu that produced them, so a provider that runs
// again drops its previous batch — a plugin that was just enabled disappears
// from the Enable list — without disturbing static children declared in JSONC.
function swapProviderRows(items, itemOrder, menuId, rows) {
  var source = items || ({})
  var order = Array.isArray(itemOrder) ? itemOrder : []
  var incoming = Array.isArray(rows) ? rows : []
  var nextItems = ({})
  var nextOrder = []

  for (var i = 0; i < order.length; i++) {
    var id = order[i]
    var existing = source[id]
    if (!existing || existing.providerMenu === menuId) continue
    nextItems[id] = existing
    nextOrder.push(id)
  }

  for (var j = 0; j < incoming.length; j++) {
    var row = incoming[j]
    if (!row || !row.id || nextItems[row.id]) continue
    row.providerMenu = menuId
    row.order = nextOrder.length
    nextItems[row.id] = row
    nextOrder.push(row.id)
  }

  return { items: nextItems, itemOrder: nextOrder }
}

function item(items, id) {
  return items && items[id] ? items[id] : null
}

// Structural IDs are supplied by menu authors. Prefix them before using plain
// objects as maps so names such as constructor, toString, and __proto__ cannot
// collide with Object.prototype.
function structuralKey(value) {
  return "$" + String(value || "")
}

// Routes may name a real id (`system`, `setup.power`) or an alias declared in
// JSONC (`power-menu`, `settings`). An exact id beats any alias, and app rows
// are never routable: their aliases carry .desktop Keywords and GenericName
// for search, so an installed application could otherwise shadow a menu route
// (htop ships `Keywords=system;...`). Unknown strings fall through as the
// literal input so misspellings still attempt to open that id.
function resolveRoute(items, itemOrder, input) {
  var raw = String(input || "").toLowerCase().replace(/_/g, "-")
  if (!raw || raw === "go" || raw === "menu") return "root"
  if (item(items, raw)) return raw
  var order = Array.isArray(itemOrder) ? itemOrder : []
  for (var i = 0; i < order.length; i++) {
    var entry = item(items, order[i])
    if (!entry || entry.kind === "app" || !entry.aliases) continue
    for (var j = 0; j < entry.aliases.length; j++) {
      var alias = String(entry.aliases[j] || "").toLowerCase().replace(/_/g, "-")
      if (alias === raw) return entry.id
    }
  }
  return raw
}

function slugify(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item"
}

function depthFor(items, id) {
  var depth = 0
  var current = item(items, id)
  var guard = 0

  while (current && current.parent && current.parent !== "root" && guard < 32) {
    depth += 1
    current = item(items, current.parent)
    guard += 1
  }

  return depth
}

function pathFor(items, id) {
  var labels = []
  var current = item(items, id)
  var guard = 0

  while (current && current.id !== "root" && guard < 32) {
    labels.unshift(current.label)
    current = item(items, current.parent)
    guard += 1
  }

  return labels.join(" › ")
}

function parentPathFor(items, id, metadata) {
  var cached = metadata && metadata[id]
  if (cached) return cached.parentPath
  var entry = item(items, id)
  if (!entry || !entry.parent || entry.parent === "root") return ""
  return pathFor(items, entry.parent)
}

function isDescendantOf(items, id, ancestorId, metadata) {
  if (ancestorId === "root") return id !== "root"
  var cached = metadata && metadata[id]
  if (cached) return cached.ancestorSet[structuralKey(ancestorId)] === true

  var current = item(items, id)
  var guard = 0
  while (current && current.parent && guard < 32) {
    if (current.parent === ancestorId) return true
    current = item(items, current.parent)
    guard += 1
  }

  return false
}

function isSearchExcluded(items, id, excludedRoots, metadata) {
  var roots = Array.isArray(excludedRoots) ? excludedRoots : []
  for (var i = 0; i < roots.length; i++) {
    if (id === roots[i] || isDescendantOf(items, id, roots[i], metadata)) return true
  }
  return false
}

function childCount(items, itemOrder, id) {
  var count = 0
  var order = Array.isArray(itemOrder) ? itemOrder : []
  for (var i = 0; i < order.length; i++) {
    var entry = item(items, order[i])
    if (entry && entry.parent === id) count += 1
  }
  return count
}

function isVisible(items, itemOrder, whenResults, entry, depth) {
  if (!entry) return false
  if (entry.when && whenResults && whenResults[entry.id] === false) return false
  if (entry.kind !== "menu" && entry.kind !== "link") return true
  if (entry.provider) return true

  var guard = depth || 0
  if (guard >= 32) return false

  var target = entry.kind === "link" ? entry.target : entry.id
  var order = Array.isArray(itemOrder) ? itemOrder : []
  for (var i = 0; i < order.length; i++) {
    var child = item(items, order[i])
    if (child && child.parent === target && isVisible(items, itemOrder, whenResults, child, guard + 1)) return true
  }

  return false
}

function labelFor(entry, checkedResults) {
  if (!entry) return ""
  if (entry.checked && checkedResults && checkedResults[entry.id]) return entry.label + " ✓"
  return entry.label
}

function searchableToken(value) {
  return String(value || "").replace(/[._-]+/g, " ")
}

function leafIdFor(id) {
  var parts = String(id || "").split(".")
  return parts.length > 0 ? parts[parts.length - 1] : id
}

function nameSearchText(entry) {
  if (!entry) return ""
  var aliases = []
  var values = Array.isArray(entry.aliases) ? entry.aliases : []
  for (var i = 0; i < values.length; i++) aliases.push(searchableToken(values[i]))
  var identity = String(entry.id || "").indexOf("extension.menu:") === 0
    ? "" : searchableToken(leafIdFor(entry.id))
  return [entry.label, identity, aliases.join(" ")].join(" ").toLowerCase()
}

function wordSet(text) {
  var result = ({})
  var words = String(text || "").toLowerCase().split(/\s+/)
  // Prefix keys so special object properties such as __proto__ remain ordinary
  // searchable words in QML's plain JavaScript objects.
  for (var i = 0; i < words.length; i++) if (words[i]) result["$" + words[i]] = true
  return result
}

function hasWord(words, value) {
  return words["$" + value] === true
}

// Menu structure and searchable strings change only when a source/provider or
// application list changes. Precompute them there instead of rebuilding paths,
// walking descendants, and normalizing the same strings on every keystroke.
function buildItemMetadata(items, itemOrder, whenResults) {
  var source = items || ({})
  var order = Array.isArray(itemOrder) ? itemOrder : []
  var children = ({})
  var metadata = ({})

  for (var i = 0; i < order.length; i++) {
    var entry = item(source, order[i])
    if (!entry || !entry.parent) continue
    var parentKey = structuralKey(entry.parent)
    if (!children[parentKey]) children[parentKey] = []
    children[parentKey].push(entry.id)
  }

  function visible(id, depth, visiting) {
    var entry = item(source, id)
    var visitKey = structuralKey(id)
    if (!entry || visiting[visitKey]) return false
    if (entry.when && whenResults && whenResults[id] === false) return false
    // Match isVisible's ordering: leaves and provider-backed menus remain
    // visible even when reached at the recursion guard boundary.
    if ((entry.kind !== "menu" && entry.kind !== "link") || entry.provider) return true
    if (depth >= 32) return false

    visiting[visitKey] = true
    var target = entry.kind === "link" ? entry.target : id
    var childIds = children[structuralKey(target)] || []
    var result = false
    for (var childIndex = 0; childIndex < childIds.length; childIndex++) {
      if (visible(childIds[childIndex], depth + 1, visiting)) { result = true; break }
    }
    delete visiting[visitKey]
    return result
  }

  for (var j = 0; j < order.length; j++) {
    var current = item(source, order[j])
    if (!current) continue
    var labels = []
    var ancestorSet = ({})
    var cursor = current
    var guard = 0
    var depth = 0
    while (cursor && cursor.id !== "root" && guard < 32) {
      labels.unshift(cursor.label)
      if (cursor.parent) ancestorSet[structuralKey(cursor.parent)] = true
      if (cursor.parent && cursor.parent !== "root") depth += 1
      cursor = item(source, cursor.parent)
      guard += 1
    }

    var aliasesLower = []
    var aliases = Array.isArray(current.aliases) ? current.aliases : []
    for (var aliasIndex = 0; aliasIndex < aliases.length; aliasIndex++)
      aliasesLower.push(String(aliases[aliasIndex] || "").toLowerCase().trim())
    var descriptionText = String(current.description || "").toLowerCase()
    var target = current.kind === "link" ? current.target : current.id
    metadata[current.id] = {
      depth: depth,
      path: labels.join(" › "),
      parentPath: current.parent && current.parent !== "root" && metadata[current.parent]
        ? metadata[current.parent].path
        : (current.parent && current.parent !== "root" ? pathFor(source, current.parent) : ""),
      childCount: (children[structuralKey(target)] || []).length,
      ancestorSet: ancestorSet,
      visible: visible(current.id, 0, ({})),
      nameText: nameSearchText(current),
      descriptionText: descriptionText,
      descriptionWords: wordSet(descriptionText),
      labelLower: String(current.label || "").toLowerCase(),
      labelWords: wordSet(current.label),
      aliasesLower: aliasesLower
    }
  }

  return metadata
}

function prepareSearchQuery(query) {
  var needle = String(query || "").toLowerCase().trim()
  return { needle: needle, terms: needle ? needle.split(/\s+/) : [] }
}

function termInSearchWords(term, text) {
  var words = String(text || "").toLowerCase().split(/\s+/)
  for (var i = 0; i < words.length; i++) {
    if (words[i] === term) return true
  }
  return false
}

function descriptionTextMatches(query, text) {
  var terms = String(query || "").toLowerCase().trim().split(/\s+/)
  for (var i = 0; i < terms.length; i++) {
    if (terms[i] && !termInSearchWords(terms[i], text)) return false
  }
  return true
}

function termsInWordSet(terms, words) {
  for (var i = 0; i < terms.length; i++)
    if (terms[i] && !hasWord(words, terms[i])) return false
  return true
}

function stringArray(value) {
  if (!Array.isArray(value)) return []
  var result = []
  for (var i = 0; i < value.length; i++) result.push(String(value[i]))
  return result
}

// Package installation is deliberately allow-listed here rather than read
// from extension manifests. External plugins may declare executable
// requirements, but that never authorizes them to install system packages.
var DEPENDENCY_SETUPS = {
  qalc: {
    executable: "qalc",
    packageName: "libqalculate",
    label: "Enable Calculator & Currency",
    reason: "arithmetic, unit conversion, and currency conversion",
    installCommand: ["omarchy", "pkg", "add", "libqalculate"]
  },
  // The emoji insert helper swallows a wtype failure, so without this the
  // paste is a silent no-op rather than a visible missing dependency.
  wtype: {
    executable: "wtype",
    packageName: "wtype",
    label: "Enable emoji pasting",
    reason: "pasting emoji into the focused application",
    installCommand: ["omarchy", "pkg", "add", "wtype"]
  }
}

function dependencySetup(extension) {
  if (!extension || !extension.bundled) return null
  var missing = Array.isArray(extension.missingRequires) ? extension.missingRequires : []
  for (var i = 0; i < missing.length; i++) {
    var setup = DEPENDENCY_SETUPS[String(missing[i])]
    if (setup) return setup
  }
  return null
}

function unavailableExtensionDetail(extension) {
  if (!extension) return ""
  var setup = dependencySetup(extension)
  if (setup) return "Requires " + setup.packageName + " · Press Enter to install"
  return "Missing dependency: " + extension.missingRequires.join(", ")
}

function firstSetupExtension(extensions) {
  var values = Array.isArray(extensions) ? extensions : []
  for (var i = 0; i < values.length; i++)
    if (!values[i].available && dependencySetup(values[i])) return values[i]
  return null
}

// Extension matchers run on the QML UI thread. Reject oversized patterns and
// the most common nested-quantifier shapes, which can otherwise backtrack for
// seconds on a short launcher query. This deliberately accepts a conservative
// regex subset rather than trying to prove arbitrary JavaScript regexes safe.
function safeExtensionPattern(pattern) {
  var value = String(pattern || "")
  if (!value || value.length > 256) return false
  if (/\\[1-9]/.test(value)) return false
  if (/\((?:[^()\\]|\\.)*[+*{](?:[^()\\]|\\.)*\)\s*[+*{]/.test(value)) return false
  return true
}

var MAX_WORKFLOW_NODES = 256
var MAX_WORKFLOW_DEPTH = 8
var MAX_WORKFLOW_TEXT = 4096
var MAX_DYNAMIC_MENU_ROWS = 100
var MAX_DETAIL_DOCUMENT_TEXT = 64 * 1024
var MAX_SAFE_JSON_INTEGER = 9007199254740991

function utf8ByteLength(value) {
  var text = String(value || "")
  var bytes = 0
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i)
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff
             && i + 1 < text.length
             && text.charCodeAt(i + 1) >= 0xdc00
             && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4
      i += 1
    } else bytes += 3
  }
  return bytes
}

function finiteExtensionNumber(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback
  var number = Number(value)
  return isFinite(number) && Math.abs(number) <= MAX_SAFE_JSON_INTEGER ? number : null
}

// Keep the state contract for a new summon explicit and independently
// testable. QML performs the process/file-index side effects, then installs
// these values before applying the incoming request.
function openStateReset() {
  return {
    actionPanelActive: false,
    actionPanelFile: null,
    fileBrowserActive: false,
    directoryPickerActive: false,
    fileBrowserExtension: null,
    fileBrowserPath: "",
    fileEntries: [],
    workflowActive: false,
    workflowExtension: null,
    workflowNode: null,
    workflowContext: ({}),
    workflowStack: [],
    pendingExtensionCapability: "",
    routedExtensionSession: false,
    emojiPickerActive: false,
    emojiExtension: null,
    clipboardPickerActive: false,
    clipboardExtension: null,
    focusedExtension: null,
    extensionQuery: "",
    extensionExpression: "",
    extensionResult: "",
    resultExtension: null,
    unavailableResultExtension: null
  }
}

function boundedWorkflowText(value, limit) {
  var text = String(value === undefined || value === null ? "" : value)
  return text.length <= (limit || MAX_WORKFLOW_TEXT) ? text : ""
}

function workflowContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ({})
  var result = ({})
  var keys = Object.keys(value)
  if (keys.length > 16) return result
  for (var i = 0; i < keys.length; i++) {
    var key = String(keys[i] || "")
    var text = boundedWorkflowText(value[key])
    if (/^[A-Za-z][A-Za-z0-9_]*$/.test(key) && text) result[key] = text
  }
  return result
}

function normalizeWorkflowChildren(rawItems, state, depth) {
  if (!Array.isArray(rawItems)) return null
  var items = []
  var siblingIds = ({})
  for (var i = 0; i < rawItems.length; i++) {
    var child = normalizeWorkflowNode(rawItems[i], state, depth)
    if (!child) return null
    var key = structuralKey(child.id)
    if (siblingIds[key]) return null
    siblingIds[key] = true
    items.push(child)
  }
  return items
}

function normalizeWorkflowAliases(value) {
  var values = value === undefined ? [] : (typeof value === "string" ? [value] : value)
  if (!Array.isArray(values) || values.length > 16) return null
  var result = []
  for (var i = 0; i < values.length; i++) {
    if (typeof values[i] !== "string") return null
    var alias = boundedWorkflowText(values[i], 256).trim()
    if (!alias && values[i]) return null
    if (alias && result.indexOf(alias) < 0) result.push(alias)
  }
  return result
}

function normalizeProviderCommandArray(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 32) return null
  var command = []
  for (var i = 0; i < raw.length; i++) {
    if (typeof raw[i] !== "string" || !boundedWorkflowText(raw[i])) return null
    command.push(raw[i])
  }
  return command[0] ? command : null
}

function normalizeDocumentCommand(raw) {
  if (raw === undefined) return { command: [], refreshCommand: [] }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  var keys = Object.keys(raw)
  for (var keyIndex = 0; keyIndex < keys.length; keyIndex++)
    if (["command", "refreshCommand"].indexOf(keys[keyIndex]) < 0) return null
  if (keys.length < 1 || keys.length > 2) return null
  var command = normalizeProviderCommandArray(raw.command)
  var refreshCommand = raw.refreshCommand === undefined ? [] : normalizeProviderCommandArray(raw.refreshCommand)
  if (!command || refreshCommand === null) return null
  return { command: command, refreshCommand: refreshCommand }
}

function normalizeWorkflowNode(raw, state, depth) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || depth >= MAX_WORKFLOW_DEPTH || state.count >= MAX_WORKFLOW_NODES) return null
  var kind = String(raw.kind || "menu")
  if (["menu", "directoryPicker", "input", "action", "confirm"].indexOf(kind) < 0) return null
  var id = boundedWorkflowText(raw.id, 128).trim()
  var label = boundedWorkflowText(raw.label, 256).trim()
  if (!id || !label) return null
  var aliases = normalizeWorkflowAliases(raw.aliases)
  if (!aliases) return null
  state.count += 1
  var documentCommands = normalizeDocumentCommand(raw.document)
  var submenuCommands = normalizeDocumentCommand(raw.submenu)
  var node = {
    id: id,
    kind: kind,
    label: label,
    primaryActionLabel: boundedWorkflowText(raw.primaryActionLabel, 32).trim(),
    starredLabel: boundedWorkflowText(raw.starredLabel, 256),
    description: boundedWorkflowText(raw.description, 512),
    aliases: aliases,
    starred: raw.starred === true,
    globalSearch: raw.globalSearch !== false,
    icon: boundedWorkflowText(raw.icon, 32),
    iconFont: boundedWorkflowText(raw.iconFont, 128),
    trailingIcon: boundedWorkflowText(raw.trailingIcon, 32),
    trailingText: boundedWorkflowText(raw.trailingText, 64),
    badge: boundedWorkflowText(raw.badge, 16),
    badgeTone: normalizeBadgeTone(raw.badgeTone),
    // Semantic weight of the entry itself, as opposed to its badge. The action
    // popover paints a "danger" action so a destructive choice is not one
    // indistinguishable row among several.
    tone: normalizeBadgeTone(raw.tone),
    context: workflowContext(raw.context),
    items: [],
    next: null,
    prompt: boundedWorkflowText(raw.prompt, 256),
    capture: /^[A-Za-z][A-Za-z0-9_]*$/.test(String(raw.capture || "")) ? String(raw.capture) : "",
    defaultValue: "",
    allowEmpty: raw.allowEmpty === true,
    maxLength: MAX_WORKFLOW_TEXT,
    command: stringArray(raw.command),
    emptyCommand: stringArray(raw.emptyCommand),
    documentCommand: documentCommands ? documentCommands.command : null,
    documentRefreshCommand: documentCommands ? documentCommands.refreshCommand : null,
    submenuCommand: submenuCommands ? submenuCommands.command : null,
    submenuRefreshCommand: submenuCommands ? submenuCommands.refreshCommand : null,
    refreshExtensions: raw.refreshExtensions === true,
    refreshable: typeof raw.refreshable === "boolean" ? raw.refreshable : null,
    closeOnDispatch: raw.closeOnDispatch === true,
    closeOnSuccess: raw.closeOnSuccess === true,
    nextBackSteps: 0,
    confirm: boundedWorkflowText(raw.confirm, 512),
    confirmLabel: boundedWorkflowText(raw.confirmLabel, 64) || "Run",
    starAction: boundedWorkflowText(raw.starAction, 128),
    actions: []
  }
  var maxLength = finiteExtensionNumber(raw.maxLength, MAX_WORKFLOW_TEXT)
  var nextBackSteps = finiteExtensionNumber(raw.nextBackSteps, 0)
  if (maxLength === null || nextBackSteps === null || node.documentCommand === null
      || node.submenuCommand === null
      || (raw.document !== undefined && raw.submenu !== undefined)
      || (raw.capture !== undefined && !node.capture)
      || (raw.starred !== undefined && typeof raw.starred !== "boolean")
      || (raw.globalSearch !== undefined && typeof raw.globalSearch !== "boolean")
      || (raw.refreshable !== undefined && typeof raw.refreshable !== "boolean")
      || (raw.closeOnDispatch !== undefined && typeof raw.closeOnDispatch !== "boolean")) return null
  node.maxLength = Math.max(1, Math.min(MAX_WORKFLOW_TEXT, maxLength))
  node.nextBackSteps = Math.max(0, Math.min(MAX_WORKFLOW_DEPTH, nextBackSteps))
  node.defaultValue = boundedWorkflowText(raw.default, MAX_WORKFLOW_TEXT).substring(0, node.maxLength)
  var commandFields = [node.command, node.emptyCommand]
  for (var commandIndex = 0; commandIndex < commandFields.length; commandIndex++) {
    if (commandFields[commandIndex].length > 32) return null
    for (var argumentIndex = 0; argumentIndex < commandFields[commandIndex].length; argumentIndex++)
      if (!boundedWorkflowText(commandFields[commandIndex][argumentIndex])) return null
  }
  if (kind === "menu") {
    node.items = normalizeWorkflowChildren(raw.items, state, depth + 1)
    if (!node.items) return null
  } else if (raw.next !== undefined) {
    node.next = normalizeWorkflowNode(raw.next, state, depth + 1)
    if (!node.next) return null
  }
  if (kind === "directoryPicker" && !node.next) return null
  if (kind === "input" && node.command.length === 0 && !node.next) return null
  if (kind === "action" && node.command.length === 0 && node.documentCommand.length === 0
      && node.submenuCommand.length === 0) return null
  if (kind === "confirm" && node.command.length === 0) return null
  if (Array.isArray(raw.actions) && kind !== "menu") {
    if (raw.actions.length > 16) return null
    node.actions = normalizeWorkflowChildren(raw.actions.map(function(action) {
      var copy = Object.assign({}, action)
      copy.kind = copy.confirm ? "confirm" : (copy.input ? "input" : "action")
      if (copy.input) copy = Object.assign({}, copy, copy.input, { kind: "input", command: copy.input.command || copy.command })
      delete copy.actions
      return copy
    }), state, depth + 1)
    if (!node.actions) return null
  }
  if (raw.starAction !== undefined) {
    if (!node.starAction) return null
    var hasStarAction = false
    for (var starIndex = 0; starIndex < node.actions.length; starIndex++)
      if (node.actions[starIndex].id === node.starAction && node.actions[starIndex].kind === "action") { hasStarAction = true; break }
    if (!hasStarAction) return null
  }
  return node
}

function detailDocumentText(value, limit, required) {
  if (value === undefined && !required) return ""
  if (typeof value !== "string") return null
  if ((required && !value.trim()) || value.length > limit) return null
  return value
}

// Provider document output is plain structured text. The host renders these
// strings without rich-text interpretation and owns all action interaction.
function normalizeDetailDocument(raw) {
  var parsed
  try { parsed = typeof raw === "string" ? JSON.parse(raw) : raw } catch (e) { return null }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  var allowed = { title: true, subtitle: true, status: true, icon: true, iconFont: true,
    stats: true, fields: true, sections: true, actions: true }
  var keys = Object.keys(parsed)
  for (var keyIndex = 0; keyIndex < keys.length; keyIndex++) if (!allowed[keys[keyIndex]]) return null

  var title = detailDocumentText(parsed.title, 256, true)
  var subtitle = detailDocumentText(parsed.subtitle, 512, false)
  var status = detailDocumentText(parsed.status, 256, false)
  var icon = detailDocumentText(parsed.icon, 32, false)
  var iconFont = detailDocumentText(parsed.iconFont, 128, false)
  if (title === null || subtitle === null || status === null || icon === null || iconFont === null) return null
  var textSize = utf8ByteLength(title) + utf8ByteLength(subtitle) + utf8ByteLength(status)
    + utf8ByteLength(icon) + utf8ByteLength(iconFont)

  var rawStats = parsed.stats === undefined ? [] : parsed.stats
  if (!Array.isArray(rawStats) || rawStats.length > 6) return null
  var stats = []
  for (var statIndex = 0; statIndex < rawStats.length; statIndex++) {
    var stat = rawStats[statIndex]
    if (!stat || typeof stat !== "object" || Array.isArray(stat)) return null
    var statAllowed = { label: true, value: true, icon: true, iconFont: true }
    var statKeys = Object.keys(stat)
    for (var statKeyIndex = 0; statKeyIndex < statKeys.length; statKeyIndex++)
      if (!statAllowed[statKeys[statKeyIndex]]) return null
    var statLabel = detailDocumentText(stat.label, 128, true)
    var statValue = detailDocumentText(stat.value, 256, true)
    var statIcon = detailDocumentText(stat.icon, 32, false)
    var statIconFont = detailDocumentText(stat.iconFont, 128, false)
    if (statLabel === null || statValue === null || statIcon === null || statIconFont === null) return null
    textSize += utf8ByteLength(statLabel) + utf8ByteLength(statValue)
      + utf8ByteLength(statIcon) + utf8ByteLength(statIconFont)
    stats.push({ label: statLabel, value: statValue, icon: statIcon, iconFont: statIconFont })
  }

  var rawFields = parsed.fields === undefined ? [] : parsed.fields
  if (!Array.isArray(rawFields) || rawFields.length > 32) return null
  var fields = []
  for (var fieldIndex = 0; fieldIndex < rawFields.length; fieldIndex++) {
    var field = rawFields[fieldIndex]
    if (!field || typeof field !== "object" || Array.isArray(field)) return null
    var fieldKeys = Object.keys(field)
    if (fieldKeys.length !== 2 || fieldKeys.indexOf("label") < 0 || fieldKeys.indexOf("value") < 0) return null
    var label = detailDocumentText(field.label, 256, true)
    var value = detailDocumentText(field.value, 4096, false)
    if (label === null || value === null) return null
    textSize += utf8ByteLength(label) + utf8ByteLength(value)
    fields.push({ label: label, value: value })
  }

  var rawSections = parsed.sections === undefined ? [] : parsed.sections
  if (!Array.isArray(rawSections) || rawSections.length > 16) return null
  var sections = []
  for (var sectionIndex = 0; sectionIndex < rawSections.length; sectionIndex++) {
    var section = rawSections[sectionIndex]
    if (!section || typeof section !== "object" || Array.isArray(section)) return null
    var sectionKeys = Object.keys(section)
    if (sectionKeys.length < 2 || sectionKeys.length > 3 || sectionKeys.indexOf("heading") < 0
        || sectionKeys.indexOf("text") < 0) return null
    for (var sectionKeyIndex = 0; sectionKeyIndex < sectionKeys.length; sectionKeyIndex++)
      if (["heading", "text", "format"].indexOf(sectionKeys[sectionKeyIndex]) < 0) return null
    var heading = detailDocumentText(section.heading, 256, true)
    var text = detailDocumentText(section.text, 32768, false)
    var format = section.format === undefined ? "plain" : section.format
    if (heading === null || text === null || ["plain", "markdown"].indexOf(format) < 0) return null
    textSize += utf8ByteLength(heading) + utf8ByteLength(text)
    sections.push({ heading: heading, text: text, format: format })
  }
  if (textSize > MAX_DETAIL_DOCUMENT_TEXT) return null

  var rawActions = parsed.actions === undefined ? [] : parsed.actions
  if (!Array.isArray(rawActions) || rawActions.length > 16) return null
  var actionState = { count: 0 }
  var actions = normalizeWorkflowChildren(rawActions.map(function(action) {
    if (!action || typeof action !== "object" || Array.isArray(action)) return null
    var copy = Object.assign({}, action)
    copy.kind = copy.confirm ? "confirm" : (copy.input ? "input" : "action")
    if (copy.input) copy = Object.assign({}, copy, copy.input,
      { kind: "input", command: copy.input.command || copy.command })
    delete copy.actions
    delete copy.document
    return copy
  }), actionState, 0)
  if (!actions) return null
  return { title: title, subtitle: subtitle, status: status, icon: icon, iconFont: iconFont,
    stats: stats, fields: fields, sections: sections, actions: actions }
}

function normalizeWorkflow(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.items)) return null
  var state = { count: 0 }
  var items = normalizeWorkflowChildren(raw.items, state, 0)
  if (!items) return null
  return items.length > 0 ? { items: items } : null
}

function workflowInterpolate(value, context) {
  var result = String(value || "")
  var values = context || ({})
  var keys = Object.keys(values)
  for (var i = 0; i < keys.length; i++)
    result = result.split("{" + keys[i] + "}").join(String(values[keys[i]]))
  return result
}

function workflowInitialInput(node, context) {
  if (!node || node.kind !== "input") return ""
  return workflowInterpolate(node.defaultValue, context || ({})).substring(0, node.maxLength)
}

function workflowCommand(node, input, context) {
  if (!node || ["input", "action", "confirm"].indexOf(node.kind) < 0) return []
  var value = String(input === undefined || input === null ? "" : input).substring(0, node.maxLength)
  var source = value ? node.command : (node.emptyCommand.length > 0 ? node.emptyCommand : node.command)
  var replacements = Object.assign({}, context || ({}), { input: value })
  return source.map(function(argument) { return workflowInterpolate(argument, replacements) })
}

function workflowDirectoryTransition(node, path, context) {
  if (!node || node.kind !== "directoryPicker" || !node.next) return null
  var selectedPath = normalizeFavoritePath(path)
  if (!selectedPath) return null
  var slash = selectedPath.lastIndexOf("/")
  return {
    node: node.next,
    context: Object.assign({}, context || ({}), {
      path: selectedPath,
      basename: selectedPath === "/" ? "/" : selectedPath.substring(slash + 1)
    })
  }
}

function workflowInputTransition(node, input, context) {
  var value = node ? String(input || "").substring(0, node.maxLength) : ""
  if (!node || node.kind !== "input" || (!value && !node.allowEmpty)) return null
  var nextContext = Object.assign({}, context || ({}), { input: value })
  if (node.capture) nextContext[node.capture] = value
  return { node: node.next, context: nextContext }
}

function workflowChild(node, id) {
  var children = node && node.kind === "menu" ? node.items : (node && node.next ? [node.next] : [])
  for (var i = 0; i < children.length; i++) if (children[i].id === id) return children[i]
  return null
}

function workflowArraysEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  for (var i = 0; i < left.length; i++) if (left[i] !== right[i]) return false
  return true
}

function workflowNodeRebindCompatible(previous, fresh) {
  if (!previous || !fresh || previous.id !== fresh.id) return false
  // Synthetic roots from the active host are always menus. Older tests and
  // callers may only retain their reserved id.
  var previousKind = previous.id === "root" && !previous.kind ? "menu" : previous.kind
  if (previousKind !== fresh.kind) return false
  if (fresh.kind === "input"
      && (!workflowArraysEqual(previous.command, fresh.command)
        || !workflowArraysEqual(previous.emptyCommand, fresh.emptyCommand))) return false
  if (fresh.kind !== "menu") {
    var previousNext = previous.next
    var freshNext = fresh.next
    if (!!previousNext !== !!freshNext) return false
    if (previousNext && (previousNext.id !== freshNext.id || previousNext.kind !== freshNext.kind)) return false
  }
  return true
}

// Rebind every active node only along the same unambiguous structural path.
// Context values remain session data, but kind changes and changed command
// stages invalidate the session instead of silently acquiring new behavior.
function rebindWorkflow(extension, stack, current) {
  if (!extension || !extension.available || extension.mode !== "workflow" || !extension.workflow || !current) return null
  var freshRoot = { id: "root", kind: "menu", items: extension.workflow.items }
  var oldStack = Array.isArray(stack) ? stack : []
  var reboundStack = []
  var cursor = freshRoot
  for (var i = 0; i < oldStack.length; i++) {
    var oldEntry = oldStack[i]
    if (!oldEntry || !oldEntry.node) return null
    if (oldEntry.node.id === "root") {
      if (i !== 0 || !workflowNodeRebindCompatible(oldEntry.node, freshRoot)) return null
      reboundStack.push({ node: freshRoot, context: oldEntry.context || ({}) })
      continue
    }
    var freshEntry = workflowChild(cursor, oldEntry.node.id)
    if (!workflowNodeRebindCompatible(oldEntry.node, freshEntry)) return null
    cursor = freshEntry
    reboundStack.push({ node: cursor, context: oldEntry.context || ({}) })
  }
  var reboundCurrent = current.id === "root" ? freshRoot : workflowChild(cursor, current.id)
  if (!workflowNodeRebindCompatible(current, reboundCurrent)) return null
  return { node: reboundCurrent, stack: reboundStack }
}

function workflowActionIsCurrent(actionGeneration, generation, workflowActive, expectedCapability, extension) {
  return actionGeneration > 0 && actionGeneration === generation && workflowActive === true
    && !!extension && extension.available === true && ["workflow", "menu"].indexOf(extension.mode) >= 0
    && extension.capability === expectedCapability
}

// Only a complete, non-interactive leaf can use the independent background
// runner. Input and confirmation nodes must keep the staged foreground path.
function workflowBackgroundEligible(node, command) {
  return !!node && node.kind === "action" && !node.next
    && Array.isArray(command) && command.length > 0
    && !workflowClosesOnDispatch(node, command)
}

function backgroundActionIsCurrent(actionGeneration, generation, expectedCapability, extension) {
  return actionGeneration > 0 && actionGeneration === generation
    && !!extension && extension.available === true && extension.mode === "menu"
    && extension.capability === expectedCapability
}

var EXTENSION_ROOT_PREFIX = "extension.root:"

// Extension shortcuts are keyed by capability rather than provider id. A
// replacement therefore inherits the same global favorite and does not leave
// a stale shortcut behind when its bundled fallback becomes active again.
function extensionRootId(extensionOrCapability) {
  var capability = typeof extensionOrCapability === "object" && extensionOrCapability
    ? extensionOrCapability.capability : extensionOrCapability
  capability = String(capability || "").trim()
  return capability ? EXTENSION_ROOT_PREFIX + JSON.stringify(capability) : ""
}

function extensionRootCapability(itemId) {
  var value = String(itemId || "")
  if (value.indexOf(EXTENSION_ROOT_PREFIX) !== 0) return ""
  try {
    var capability = JSON.parse(value.substring(EXTENSION_ROOT_PREFIX.length))
    return typeof capability === "string" ? capability.trim() : ""
  } catch (e) { return "" }
}

function extensionRootDetail(extension, disabled, lockedByConfig) {
  if (disabled) return lockedByConfig ? "Disabled in configuration" : "Disabled · Press Delete to enable"
  if (!extension.available) return unavailableExtensionDetail(extension)
  return extension.rootDescription
}

function extensionRootItem(extension, disabled, lockedByConfig) {
  if (!extension || !extension.capability) return null
  var id = extensionRootId(extension)
  if (!id) return null
  return normalizeItem(id, {
    parent: "extensions",
    icon: extension.icon,
    iconFont: extension.iconFont,
    label: extension.label,
    description: extensionRootDetail(extension, disabled === true, lockedByConfig === true),
    aliases: [extension.id, extension.capability].concat(extension.prefixes || []),
    action: extension.capability
  })
}

function sortExtensionRootRows(rows) {
  var result = Array.isArray(rows) ? rows.slice() : []
  result.sort(function(a, b) {
    if (!!a.starred !== !!b.starred) return a.starred ? -1 : 1
    var labels = String(a.label || "").toLowerCase().localeCompare(String(b.label || "").toLowerCase())
    return labels || String(a.itemId || "").localeCompare(String(b.itemId || ""))
  })
  return result
}

var MAX_EMOJI_FILE_CANDIDATES = 8

// One or an ordered list of candidates; the host reads the first that loads.
function emojiFileList(value, fallback) {
  if (Array.isArray(value)) {
    var paths = []
    for (var i = 0; i < value.length && paths.length < MAX_EMOJI_FILE_CANDIDATES; i++) {
      var entry = String(value[i] === undefined || value[i] === null ? "" : value[i])
      if (entry && paths.indexOf(entry) < 0) paths.push(entry)
    }
    return paths
  }
  var single = String(value === undefined || value === null ? "" : value)
  if (single) return [single]
  return Array.isArray(fallback) ? fallback.slice() : []
}

var MAX_EXTENSION_ROUTE_CAPABILITY = 128

function extensionRouteCapability(value) {
  if (typeof value !== "string") return ""
  var capability = value.trim()
  return capability.length > 0 && capability.length <= MAX_EXTENSION_ROUTE_CAPABILITY ? capability : ""
}

function extensionRootActivation(extension) {
  if (!extension || !extension.available) return ""
  // An action runs on Enter. Every other mode opens something first — which is
  // why a launcher entry that just does one thing had no mode to be: prefix
  // completes its prefix and waits for a prompt that the command never wanted.
  if (extension.mode === "action") return "action"
  if (extension.mode === "files") return "files"
  if (extension.mode === "workflow") return "workflow"
  if (extension.mode === "emoji") return "emoji"
  if (extension.mode === "clipboard") return "clipboard"
  if (extension.mode === "menu") return "menu"
  return "input"
}

function extensionRootInput(extension) {
  return ""
}

// A focused extension owns its input, so users should not need to see or type
// the global-search prefix. Add it only to the query sent to the provider.
function focusedExtensionQuery(extension, input) {
  var query = String(input || "").trim()
  if (!extension || extension.mode !== "query" || !Array.isArray(extension.prefixes) || extension.prefixes.length === 0) return query
  var prefix = String(extension.prefixes[0] || "").trim()
  if (!prefix || query === prefix || query.indexOf(prefix + " ") === 0) return query || prefix
  return query ? prefix + " " + query : prefix
}

function focusedPrefixMatch(extension, input) {
  var prompt = String(input || "").trim()
  return extension && extension.mode === "prefix" && extension.available && prompt
    ? { extension: extension, prompt: prompt } : null
}

function workflowClosesOnDispatch(node, command) {
  if (!node || ["input", "action", "confirm"].indexOf(node.kind) < 0 || node.next || !Array.isArray(command) || command.length === 0) return false
  if (node.closeOnDispatch === true) return true
  var executable = String(command[0] || "").split("/").pop()
  return executable === "xdg-terminal-exec" || executable === "omarchy-launch-terminal"
}

// Where a definition came from, ranked by how specific it is to this machine.
// Resolution uses the rank to break a tie between two providers of the same
// capability at equal priority: the user's own file is the most specific thing
// present, then an installed plugin, then whatever Omalaunch ships. Without a
// rank the winner would depend on catalog order, which is not something a user
// can see or control.
function extensionOrigin(raw) {
  var origin = String(raw && raw._origin || "")
  if (origin === "user" || origin === "plugin" || origin === "bundled") return origin
  // Older catalogs only carried the bundled flag.
  return raw && raw._bundled === true ? "bundled" : "plugin"
}

function extensionOriginRank(extension) {
  if (!extension) return -1
  if (extension.origin === "user") return 2
  if (extension.origin === "plugin") return 1
  return 0
}

function dynamicMenuSearchNodes(workflow) {
  if (!workflow || !Array.isArray(workflow.items)) return []
  return Object.prototype.hasOwnProperty.call(workflow, "globalSearchItems")
    ? workflow.globalSearchItems : workflow.items
}

function dynamicMenuSearchItems(extension, workflow) {
  if (!extension || !workflow || !Array.isArray(workflow.items)) return []
  var source = dynamicMenuSearchNodes(workflow)
  if (!Array.isArray(source)) return []
  var result = []
  for (var i = 0; i < source.length; i++) {
    var node = source[i]
    if (!node || ["action", "confirm", "input"].indexOf(node.kind) < 0 || node.globalSearch === false) continue
    result.push(normalizeItem(dynamicMenuItemId(extension.capability, node.id), {
      parent: "extensions",
      icon: node.icon || extension.icon,
      iconFont: node.iconFont || extension.iconFont,
      trailingIcon: node.trailingIcon,
      trailingText: node.trailingText,
      badge: node.badge,
      badgeTone: node.badgeTone,
      label: node.starred && node.starredLabel ? node.starredLabel : node.label,
      description: node.description,
      aliases: node.aliases,
      starred: node.starred,
      action: node.id
    }))
  }
  return result
}

function dynamicMenuItemId(capability, nodeId) {
  capability = String(capability || "").trim()
  nodeId = String(nodeId || "").trim()
  return capability && nodeId ? "extension.menu:" + JSON.stringify([capability, nodeId]) : ""
}

function dynamicMenuSearchIdentity(itemId) {
  var prefix = "extension.menu:"
  var value = String(itemId || "")
  if (value.indexOf(prefix) !== 0) return null
  try {
    var parsed = JSON.parse(value.substring(prefix.length))
    return Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "string" && typeof parsed[1] === "string"
      ? { capability: parsed[0], id: parsed[1] } : null
  } catch (e) { return null }
}

function dynamicMenuUsageItemId(extension, node) {
  if (!extension || extension.mode !== "menu" || !node || !node.usageItemId) return ""
  if ((extension.id === "omalaunch.quicklinks" || extension.id === "omalaunch.web-search")
      && extension.config && extension.config.rankByUsage === false) return ""
  // Usage belongs to the exact provider. The search/routing identity uses the
  // capability so replacement remains safe, but replacements must not inherit
  // another provider's learned ranking.
  return dynamicMenuItemId(extension.id, node.usageItemId)
}

function normalizeDynamicMenuRows(rows, allowEmpty) {
  if (!Array.isArray(rows) || rows.length > MAX_DYNAMIC_MENU_ROWS) return null
  var prepared = []
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i]
    if (!row || typeof row !== "object" || Array.isArray(row)) return null
    var copy = Object.assign({}, row)
    copy.kind = copy.confirm ? "confirm" : (copy.input ? "input" : "action")
    if (copy.input) copy = Object.assign({}, copy, copy.input, { kind: "input", command: copy.input.command || copy.command })
    prepared.push(copy)
  }
  if (allowEmpty && prepared.length === 0) return []
  var workflow = normalizeWorkflow({ items: prepared })
  if (!workflow) return null
  for (var itemIndex = 0; itemIndex < workflow.items.length; itemIndex++) {
    var item = workflow.items[itemIndex]
    if (item.closeOnSuccess) item.usageItemId = item.id
    for (var actionIndex = 0; actionIndex < item.actions.length; actionIndex++)
      if (item.actions[actionIndex].id === "open") item.actions[actionIndex].usageItemId = item.id
  }
  return workflow.items
}

function normalizeDynamicMenuOutput(raw) {
  var parsed
  try { parsed = typeof raw === "string" ? JSON.parse(raw) : raw } catch (e) { return null }
  var rows = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.items) ? parsed.items : null)
  var items = normalizeDynamicMenuRows(rows, false)
  if (!items) return null
  var workflow = { items: items }
  if (!Array.isArray(parsed) && Object.prototype.hasOwnProperty.call(parsed, "globalSearchItems")) {
    var globalSearchItems = normalizeDynamicMenuRows(parsed.globalSearchItems, true)
    if (!globalSearchItems) return null
    workflow.globalSearchItems = globalSearchItems
  }
  return workflow
}

function normalizeExtension(raw) {
  if (!raw || typeof raw !== "object" || raw.schemaVersion !== 1) return null

  var id = String(raw.id || "").trim()
  var label = String(raw.label || "").trim()
  var mode = String(raw.mode || "prefix")
  var command = stringArray(raw.command)
  if (!id || !label || ["action", "prefix", "query", "files", "workflow", "emoji", "clipboard", "menu"].indexOf(mode) < 0) return null
  if (mode !== "workflow" && command.length === 0) return null
  if (mode !== "menu" && (raw.configuration !== undefined || raw.refreshable !== undefined)) return null
  if (raw.refreshable !== undefined && typeof raw.refreshable !== "boolean") return null
  var configurationProvider = ""
  if (raw.configuration !== undefined) {
    if (!raw.configuration || typeof raw.configuration !== "object" || Array.isArray(raw.configuration)
        || Object.keys(raw.configuration).length !== 1
        || typeof raw.configuration.provider !== "string" || !raw.configuration.provider.trim()) return null
    configurationProvider = raw.configuration.provider.trim()
    // Configuration belongs to the exact provider. A capability replacement
    // must not open or edit a bundled provider's files.
    if (configurationProvider !== id
        || ["omalaunch.quicklinks", "omalaunch.web-search"].indexOf(configurationProvider) < 0) return null
  }

  var priority = finiteExtensionNumber(raw.priority, 0)
  if (priority === null) return null

  var extension = {
    id: id,
    capability: String(raw.capability || id).trim(),
    mode: mode,
    label: label,
    icon: String(raw.icon || ""),
    iconFont: String(raw.iconFont || ""),
    description: String(raw.description || (mode === "prefix" ? "Start new session"
      : (mode === "action" ? "Press Enter to run" : "Press Enter to copy"))),
    rootDescription: String(raw.rootDescription || raw.description || (mode === "prefix" ? "Start new session"
      : (mode === "action" ? "Press Enter to run" : "Open extension"))),
    command: command,
    priority: priority,
    bundled: raw._bundled === true,
    origin: extensionOrigin(raw),
    sourceDir: String(raw._sourceDir || ""),
    source: String(raw._source || ""),
    globalSearch: mode === "menu" && raw.globalSearch === true,
    globalSearchCommand: stringArray(raw.globalSearchCommand),
    configurationProvider: configurationProvider,
    refreshable: raw.refreshable === true,
    requires: stringArray(raw.requires),
    missingRequires: stringArray(raw._missingRequires)
  }

  if (mode === "action" || mode === "prefix" || mode === "files" || mode === "workflow" || mode === "emoji" || mode === "clipboard" || mode === "menu") {
    var sourcePrefixes = Array.isArray(raw.prefixes) ? raw.prefixes : [raw.prefix]
    extension.prefixes = []
    for (var i = 0; i < sourcePrefixes.length; i++) {
      var prefix = String(sourcePrefixes[i] || "").toLowerCase().trim()
      if (prefix && extension.prefixes.indexOf(prefix) < 0) extension.prefixes.push(prefix)
    }
    if (extension.prefixes.length === 0 && mode !== "action") return null
    if (mode === "workflow") {
      extension.workflow = normalizeWorkflow(raw.workflow)
      if (!extension.workflow) return null
    } else if (mode === "menu") {
      if (command.length > 32) return null
      for (var menuArg = 0; menuArg < command.length; menuArg++)
        if (!boundedWorkflowText(command[menuArg])) return null
      if (raw.globalSearchCommand !== undefined) {
        if (!extension.globalSearch || !Array.isArray(raw.globalSearchCommand)
            || extension.globalSearchCommand.length === 0
            || extension.globalSearchCommand.length > 32) return null
        for (var searchArg = 0; searchArg < extension.globalSearchCommand.length; searchArg++)
          if (!boundedWorkflowText(extension.globalSearchCommand[searchArg])) return null
      }
    } else if (mode === "files") {
      extension.root = String(raw.root || "~")
      extension.directoryCommand = stringArray(raw.directoryCommand)
      if (extension.directoryCommand.length === 0) extension.directoryCommand = extension.command
      extension.terminalCommand = stringArray(raw.terminalCommand)
      extension.copyCommand = stringArray(raw.copyCommand)
      if (extension.copyCommand.length === 0) extension.copyCommand = ["wl-copy", "--", "{path}"]
      extension.copyFileCommand = stringArray(raw.copyFileCommand)
    } else if (mode === "emoji") {
      // Default to the emoji set Omarchy already ships so the bundled
      // provider carries no duplicate dataset. An external provider can point
      // `data` at its own file with {extensionDir}.
      extension.data = emojiFileList(raw.data, [
        "{omarchyPath}/shell/plugins/emojis/emojis.json",
        "{extensionDir}/emojis.json"
      ])
      extension.groups = emojiFileList(raw.groups, [])
      extension.extraData = emojiFileList(raw.extraData, [])
      extension.copyCommand = stringArray(raw.copyCommand)
      if (extension.copyCommand.length === 0) extension.copyCommand = ["wl-copy", "--", "{emoji}"]
    } else if (mode === "clipboard") {
      extension.history = emojiFileList(raw.history, [
        "{stateHome}/omarchy/clipboard-history.json"
      ])
      extension.copyCommand = stringArray(raw.copyCommand)
      extension.fileCommand = stringArray(raw.fileCommand)
      extension.fileCopyCommand = stringArray(raw.fileCopyCommand)
    }
  } else {
    extension.prefixes = []
    var queryPrefixes = Array.isArray(raw.prefixes) ? raw.prefixes : (raw.prefix ? [raw.prefix] : [])
    for (var p = 0; p < queryPrefixes.length; p++) {
      var queryPrefix = String(queryPrefixes[p] || "").toLowerCase().trim()
      if (queryPrefix && extension.prefixes.indexOf(queryPrefix) < 0) extension.prefixes.push(queryPrefix)
    }
    var match = raw.match || {}
    extension.matchAll = stringArray(match.all)
    extension.matchAny = stringArray(match.any)
    extension.matchNone = stringArray(match.none)
    extension.matchAllRegex = []
    extension.matchAnyRegex = []
    extension.matchNoneRegex = []
    extension.resultCommand = stringArray(raw.resultCommand)
    if (extension.resultCommand.length === 0) extension.resultCommand = ["wl-copy", "--", "{result}"]
    extension.normalizeUnits = raw.normalizeUnits === true
    if (extension.matchAll.length === 0 && extension.matchAny.length === 0) return null
    try {
      for (var j = 0; j < extension.matchAll.length; j++) {
        if (!safeExtensionPattern(extension.matchAll[j])) return null
        extension.matchAllRegex.push(new RegExp(extension.matchAll[j], "i"))
      }
      for (var k = 0; k < extension.matchAny.length; k++) {
        if (!safeExtensionPattern(extension.matchAny[k])) return null
        extension.matchAnyRegex.push(new RegExp(extension.matchAny[k], "i"))
      }
      for (var n = 0; n < extension.matchNone.length; n++) {
        if (!safeExtensionPattern(extension.matchNone[n])) return null
        extension.matchNoneRegex.push(new RegExp(extension.matchNone[n], "i"))
      }
    } catch (e) { return null }
  }
  if (raw.globalSearchCommand !== undefined && mode !== "menu") return null
  extension.available = extension.missingRequires.length === 0
  return extension
}

function lookupKey(value) {
  return "$" + String(value || "")
}

// A disabled capability is dropped before resolution rather than after, so it
// leaves no shortcut, no prefix, and no provider to fall back to — a bundled
// extension is always on disk, so this is the only way to remove one.
// A capability whose `enabled` is written out in config.jsonc is pinned there:
// the launcher's own toggle must not fight a value the user typed.
// The launcher keeps one size so it never resizes as results change. The
// default is deliberately smaller than Omarchy's clipboard panel; the numbers
// are configurable because the right size depends on the screen.
var DEFAULT_LAUNCHER_WIDTH = 660
var DEFAULT_LAUNCHER_HEIGHT = 460
var MIN_LAUNCHER_WIDTH = 320
var MAX_LAUNCHER_WIDTH = 2000
var MIN_LAUNCHER_HEIGHT = 240
var MAX_LAUNCHER_HEIGHT = 1600

function launcherSizeValue(value, fallback, low, high) {
  var size = finiteExtensionNumber(value, fallback)
  if (size === null) return fallback
  size = Math.round(size)
  return size >= low && size <= high ? size : fallback
}

function launcherSize(launcherConfig) {
  var config = launcherConfig && typeof launcherConfig === "object" && !Array.isArray(launcherConfig)
    ? launcherConfig : ({})
  return {
    width: launcherSizeValue(config.width, DEFAULT_LAUNCHER_WIDTH, MIN_LAUNCHER_WIDTH, MAX_LAUNCHER_WIDTH),
    height: launcherSizeValue(config.height, DEFAULT_LAUNCHER_HEIGHT, MIN_LAUNCHER_HEIGHT, MAX_LAUNCHER_HEIGHT)
  }
}

function capabilityLockedByConfig(capability, configuredCapabilities) {
  var configured = configuredCapabilities && typeof configuredCapabilities === "object"
    ? configuredCapabilities : ({})
  var setting = configured[String(capability || "")]
  return !!setting && typeof setting === "object" && typeof setting.enabled === "boolean"
}

// Same objects, filtered — never copies. Callers compare extension identity
// across catalog reloads, so a new object per evaluation would break rebinding.
function enabledExtensions(extensions, disabledCapabilities) {
  var values = Array.isArray(extensions) ? extensions : []
  var disabled = disabledCapabilitySet(disabledCapabilities)
  var result = []
  for (var i = 0; i < values.length; i++)
    if (values[i] && !disabled[lookupKey(values[i].capability)]) result.push(values[i])
  return result
}

function disabledCapabilitySet(disabledCapabilities) {
  var disabled = ({})
  var values = Array.isArray(disabledCapabilities) ? disabledCapabilities : []
  for (var i = 0; i < values.length; i++) {
    var capability = typeof values[i] === "string" ? values[i].trim() : ""
    if (capability) disabled[lookupKey(capability)] = true
  }
  return disabled
}

function resolveExtensions(extensions, providerPreferences, diagnostics, diagnosticState, disabledCapabilities) {
  var selected = ({})
  var order = []
  var values = Array.isArray(extensions) ? extensions : []
  var preferences = providerPreferences && typeof providerPreferences === "object" ? providerPreferences : ({})
  var disabled = disabledCapabilitySet(disabledCapabilities)
  var reported = ({})
  for (var i = 0; i < values.length; i++) {
    var extension = values[i]
    var key = lookupKey(extension.capability)
    if (disabled[key]) {
      // One diagnostic per capability, not per provider of it.
      if (!reported[key]) {
        reported[key] = true
        appendExtensionDiagnostic(diagnostics,
          "Capability '" + extension.capability + "' is disabled in configuration; its extensions were not loaded",
          diagnosticState)
      }
      continue
    }
    var current = selected[key]
    if (!current) order.push(key)
    var preferredId = typeof preferences[extension.capability] === "string" ? preferences[extension.capability] : ""
    if (preferredId && extension.id === preferredId && extension.available) selected[key] = extension
    else if (current && preferredId && current.id === preferredId && current.available) continue
    else if (!current
        || (extension.available && !current.available)
        || (extension.available === current.available && extension.priority > current.priority)
        || (extension.available === current.available && extension.priority === current.priority
          && extensionOriginRank(extension) > extensionOriginRank(current)))
      selected[key] = extension
  }
  for (var capability in preferences) {
    if (!Object.prototype.hasOwnProperty.call(preferences, capability)) continue
    if (disabled[lookupKey(capability)]) continue
    var requested = preferences[capability]
    var found = null
    for (var valueIndex = 0; valueIndex < values.length; valueIndex++)
      if (values[valueIndex].capability === capability && values[valueIndex].id === requested) found = values[valueIndex]
    if (!found || !found.available) appendExtensionDiagnostic(diagnostics,
      "Configured provider '" + requested + "' for capability '" + capability + "' is "
        + (found ? "unavailable" : "missing") + "; normal provider resolution was used", diagnosticState)
  }
  // Shadowing is legitimate — it is why the rank exists — but silent shadowing
  // is a bug nobody can find. A user file left behind after the plugin it was
  // overriding got installed looks exactly like the plugin not working.
  for (var shadowIndex = 0; shadowIndex < values.length; shadowIndex++) {
    var candidate = values[shadowIndex]
    var winner = selected[lookupKey(candidate.capability)]
    if (!winner || winner === candidate || winner.origin !== "user") continue
    appendExtensionDiagnostic(diagnostics,
      "Capability '" + candidate.capability + "' is provided by your own extension '" + winner.id
        + "'; '" + candidate.id + "' was not used", diagnosticState)
  }

  var result = []
  for (var orderIndex = 0; orderIndex < order.length; orderIndex++) result.push(selected[order[orderIndex]])
  return result
}

function extensionSource(raw, index) {
  var source = raw && typeof raw === "object" ? String(raw._source || "").trim() : ""
  return source || "catalog index " + index
}

var MAX_EXTENSION_DIAGNOSTICS = 256
var MAX_EXTENSION_DIAGNOSTIC_TEXT = 1024
var MAX_EXTENSION_CATALOG_VALUES = 1024

function appendExtensionDiagnostic(diagnostics, message, state) {
  var text = String(message || "").replace(/\0/g, "�")
  if (text.length > MAX_EXTENSION_DIAGNOSTIC_TEXT) text = text.substring(0, MAX_EXTENSION_DIAGNOSTIC_TEXT - 1) + "…"
  if (diagnostics.length < MAX_EXTENSION_DIAGNOSTICS) diagnostics.push(text)
  else if (!state.omitted) {
    diagnostics[diagnostics.length - 1] = "Further extension diagnostics were omitted after the "
      + MAX_EXTENSION_DIAGNOSTICS + "-message limit"
    state.omitted = true
  }
}

function parseExtensionCatalog(text) {
  var parsed
  try { parsed = JSON.parse(String(text || "[]")) }
  catch (e) { return { extensions: [], diagnostics: ["Extension catalog is not valid JSON"], valid: false, complete: false } }

  var diagnostics = []
  var diagnosticState = { omitted: false }
  var complete = true
  var values = parsed
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.extensions)) {
    values = parsed.extensions
    complete = parsed.complete !== false
    if (Array.isArray(parsed.diagnostics)) {
      for (var d = 0; d < parsed.diagnostics.length; d++)
        if (typeof parsed.diagnostics[d] === "string" && parsed.diagnostics[d])
          appendExtensionDiagnostic(diagnostics, parsed.diagnostics[d], diagnosticState)
    }
  } else if (!Array.isArray(values)) values = [values]

  var providerPreferences = parsed && typeof parsed.providerPreferences === "object" && !Array.isArray(parsed.providerPreferences)
    ? parsed.providerPreferences : ({})
  var disabledCapabilities = parsed && Array.isArray(parsed.disabledCapabilities) ? parsed.disabledCapabilities : []
  var launcherConfig = parsed && parsed.omalaunchConfig && typeof parsed.omalaunchConfig === "object"
    ? parsed.omalaunchConfig.launcher : null
  var configuredCapabilities = parsed && parsed.omalaunchConfig && typeof parsed.omalaunchConfig === "object"
    && parsed.omalaunchConfig.capabilities && typeof parsed.omalaunchConfig.capabilities === "object"
    && !Array.isArray(parsed.omalaunchConfig.capabilities)
    ? parsed.omalaunchConfig.capabilities : ({})
  var omalaunchConfig = parsed && typeof parsed.omalaunchConfig === "object" && !Array.isArray(parsed.omalaunchConfig)
    ? parsed.omalaunchConfig : ({})
  var providerConfig = parsed && typeof parsed.providerConfig === "object" && !Array.isArray(parsed.providerConfig)
    ? parsed.providerConfig : ({})
  var extensions = []
  var ids = ({})
  if (values.length > MAX_EXTENSION_CATALOG_VALUES)
    appendExtensionDiagnostic(diagnostics, "Extension catalog contains more than " + MAX_EXTENSION_CATALOG_VALUES
      + " definitions; trailing definitions were ignored", diagnosticState)
  for (var i = 0; i < Math.min(values.length, MAX_EXTENSION_CATALOG_VALUES); i++) {
    var extension = normalizeExtension(values[i])
    if (!extension) {
      appendExtensionDiagnostic(diagnostics, "Ignored invalid extension from " + extensionSource(values[i], i), diagnosticState)
      continue
    }
    var idKey = lookupKey(extension.id)
    if (ids[idKey]) {
      appendExtensionDiagnostic(diagnostics, "Ignored duplicate extension id '" + extension.id + "' from " + extensionSource(values[i], i)
        + "; already supplied by " + ids[idKey], diagnosticState)
      continue
    }
    ids[idKey] = extensionSource(values[i], i)
    extension.config = providerConfig[extension.id] && typeof providerConfig[extension.id] === "object"
      ? providerConfig[extension.id] : ({})
    extensions.push(extension)
    if (!extension.available)
      appendExtensionDiagnostic(diagnostics, extension.id + " is missing: " + extension.missingRequires.join(", "), diagnosticState)
  }

  var resolved = resolveExtensions(extensions, providerPreferences, diagnostics, diagnosticState, disabledCapabilities)
  var prefixes = ({})
  for (var j = 0; j < resolved.length; j++) {
    var current = resolved[j]
    if (!current.prefixes || current.prefixes.length === 0) continue
    for (var k = 0; k < current.prefixes.length; k++) {
      var prefix = current.prefixes[k]
      var prefixKey = lookupKey(prefix)
      if (prefixes[prefixKey]) appendExtensionDiagnostic(diagnostics, "Duplicate extension prefix '" + prefix + "': " + prefixes[prefixKey]
        + ", " + current.id + " (" + (current.source || "unknown source") + ")", diagnosticState)
      else prefixes[prefixKey] = current.id + " (" + (current.source || "unknown source") + ")"
    }
  }
  return {
    extensions: resolved,
    diagnostics: diagnostics,
    configuredCapabilities: configuredCapabilities,
    launcherSize: launcherSize(launcherConfig),
    omalaunchConfig: omalaunchConfig,
    providerConfig: providerConfig,
    migrationComplete: parsed && parsed.migrationComplete === true,
    valid: true,
    complete: complete
  }
}

function parseExtensions(text) {
  return parseExtensionCatalog(text).extensions
}

function matchesRules(extension, query) {
  var input = String(query || "").trim()
  if (input.length > 4096) return false
  var all = extension.matchAllRegex || extension.matchAll.map(function(pattern) { return new RegExp(pattern, "i") })
  var anyRules = extension.matchAnyRegex || extension.matchAny.map(function(pattern) { return new RegExp(pattern, "i") })
  var none = extension.matchNoneRegex || extension.matchNone.map(function(pattern) { return new RegExp(pattern, "i") })
  for (var i = 0; i < all.length; i++)
    if (!all[i].test(input)) return false
  if (anyRules.length > 0) {
    var any = false
    for (var j = 0; j < anyRules.length; j++)
      if (anyRules[j].test(input)) { any = true; break }
    if (!any) return false
  }
  for (var k = 0; k < none.length; k++)
    if (none[k].test(input)) return false
  return true
}

function matchingQueryExtensions(extensions, query) {
  var matches = []
  var values = Array.isArray(extensions) ? extensions : []
  for (var i = 0; i < values.length; i++) {
    if (values[i].mode === "query" && matchesRules(values[i], query)) matches.push(values[i])
  }
  matches.sort(function(a, b) { return b.priority - a.priority })
  return matches
}

function queryExtension(extensions, query) {
  var matches = matchingQueryExtensions(extensions, query)
  for (var i = 0; i < matches.length; i++) if (matches[i].available) return matches[i]
  return null
}

function unavailableQueryExtension(extensions, query) {
  var matches = matchingQueryExtensions(extensions, query)
  return matches.length > 0 && !matches[0].available ? matches[0] : null
}

function extensionQueryRunIsCurrent(revision, currentRevision, query, effectiveQuery,
                                    extensionId, resultExtension, stopping, opened) {
  return opened === true && stopping !== true
    && revision === currentRevision
    && query === effectiveQuery
    && !!resultExtension && extensionId === resultExtension.id
}

var SEARCH_MATCH_TIER = {
  NONE: 0,
  MANAGEMENT: 5,
  METADATA: 10,
  ALIAS_PREFIX: 20,
  EXACT_ALIAS: 30,
  TITLE_CONTAINS: 40,
  TITLE_PREFIX: 50,
  EXACT_TITLE: 60,
  EXPLICIT_EXTENSION: 100,
  LIVE_RESULT: 110
}

function extensionSuggestionPriority(suggestion, query) {
  if (!suggestion || !suggestion.extension || !suggestion.extension.available) return SEARCH_MATCH_TIER.NONE
  var input = String(query || "").toLowerCase().trim()
  return suggestion.prefix === input ? SEARCH_MATCH_TIER.EXACT_ALIAS : SEARCH_MATCH_TIER.ALIAS_PREFIX
}

function extensionMatchPriority(extension) {
  return extension && extension.available ? SEARCH_MATCH_TIER.EXPLICIT_EXTENSION : SEARCH_MATCH_TIER.NONE
}

function extensionResultPriority() {
  return SEARCH_MATCH_TIER.LIVE_RESULT
}

function suggestExtensions(extensions, query) {
  var input = String(query || "").toLowerCase().trim()
  if (!input || /\s/.test(input)) return []

  var suggestions = []
  var values = Array.isArray(extensions) ? extensions : []
  for (var i = 0; i < values.length; i++) {
    var extension = values[i]
    if (!extension.prefixes || extension.prefixes.length === 0) continue
    for (var j = 0; j < extension.prefixes.length; j++) {
      if (extension.prefixes[j].indexOf(input) !== 0) continue
      suggestions.push({ extension: extension, prefix: extension.prefixes[j] })
      break
    }
  }
  return suggestions
}

function matchExtensions(extensions, query) {
  var input = String(query || "").trim()
  var separator = input.search(/\s/)
  if (separator < 1) return []

  var prefix = input.slice(0, separator).toLowerCase()
  var prompt = input.slice(separator).trim()
  if (!prompt) return []

  var matches = []
  var values = Array.isArray(extensions) ? extensions : []
  for (var i = 0; i < values.length; i++) {
    var extension = values[i]
    if (extension.mode === "prefix" && extension.prefixes.indexOf(prefix) >= 0)
      matches.push({ extension: extension, prompt: prompt })
  }
  return matches
}

function matchesQuery(entry, query, visible, metadata) {
  if (!entry || entry.id === "root") return false
  if (!visible) return false

  var prepared = query && typeof query === "object" ? query : prepareSearchQuery(query)
  var nameText = metadata ? metadata.nameText : nameSearchText(entry)
  var descriptionText = metadata ? metadata.descriptionText : String(entry.description || "").toLowerCase()
  var descriptionWords = metadata ? metadata.descriptionWords : null

  for (var i = 0; i < prepared.terms.length; i++) {
    var term = prepared.terms[i]
    if (!term) continue
    if (nameText.indexOf(term) >= 0) continue
    if (descriptionWords ? hasWord(descriptionWords, term) : termInSearchWords(term, descriptionText)) continue
    return false
  }

  return true
}

function searchMatchPriority(entry, query, metadata) {
  var prepared = query && typeof query === "object" ? query : prepareSearchQuery(query)
  var needle = prepared.needle
  if (!entry || !needle) return SEARCH_MATCH_TIER.NONE
  var label = metadata ? metadata.labelLower : String(entry.label || "").toLowerCase()
  var priority = SEARCH_MATCH_TIER.NONE

  if (label === needle) priority = SEARCH_MATCH_TIER.EXACT_TITLE
  else if (label.indexOf(needle) === 0) priority = SEARCH_MATCH_TIER.TITLE_PREFIX
  else if (label.indexOf(needle) >= 0) priority = SEARCH_MATCH_TIER.TITLE_CONTAINS

  var aliases = metadata ? metadata.aliasesLower : []
  if (!metadata) {
    var sourceAliases = Array.isArray(entry.aliases) ? entry.aliases : []
    for (var sourceIndex = 0; sourceIndex < sourceAliases.length; sourceIndex++)
      aliases.push(String(sourceAliases[sourceIndex] || "").toLowerCase().trim())
  }
  for (var i = 0; i < aliases.length; i++) {
    if (aliases[i] === needle) priority = Math.max(priority, SEARCH_MATCH_TIER.EXACT_ALIAS)
    else if (aliases[i].indexOf(needle) === 0) priority = Math.max(priority, SEARCH_MATCH_TIER.ALIAS_PREFIX)
    else if (aliases[i].indexOf(needle) >= 0) priority = Math.max(priority, SEARCH_MATCH_TIER.METADATA)
  }
  if (priority === SEARCH_MATCH_TIER.NONE && matchesQuery(entry, prepared, true, metadata))
    priority = SEARCH_MATCH_TIER.METADATA

  var id = String(entry.id || "")
  if (priority > SEARCH_MATCH_TIER.NONE
      && (id.indexOf("install.") === 0 || id.indexOf("remove.") === 0))
    return SEARCH_MATCH_TIER.MANAGEMENT
  return priority
}

function searchScore(items, entry, query, metadata) {
  var prepared = query && typeof query === "object" ? query : prepareSearchQuery(query)
  var needle = prepared.needle
  var label = metadata ? metadata.labelLower : entry.label.toLowerCase()
  var nameText = metadata ? metadata.nameText : nameSearchText(entry)
  var descriptionText = metadata ? metadata.descriptionText : String(entry.description || "").toLowerCase()
  var score = 80

  if (label === needle) score = entry.parent === "root" ? 2 : 0
  // An installed app whose name contains the query as a whole word ("zen"
  // for Zen Browser) beats exact-labeled menu entries like Install > Zen.
  else if (entry.kind === "app" && (metadata ? hasWord(metadata.labelWords, needle) : label.split(/\s+/).indexOf(needle) >= 0)) score = 0
  else if (label.indexOf(needle) === 0) score = 10
  else if (label.indexOf(needle) >= 0) score = 30
  else if (nameText.indexOf(needle) >= 0) score = 40
  else if (metadata
    ? termsInWordSet(prepared.terms, metadata.descriptionWords)
    : descriptionTextMatches(needle, descriptionText)) score = 60

  if (entry.kind === "menu" || entry.kind === "link") score -= 2
  // App rows sort after all menu items, so they lose the tiebreak below to an
  // equal match. Outrank those, but stay inside the tier so better ones win.
  if (entry.kind === "app") score -= 5

  return score * 1000 + (metadata ? metadata.depth : depthFor(items, entry.id)) * 25 + entry.order
}

function compareSearchRows(a, b) {
  if (a.starred !== b.starred) return a.starred ? -1 : 1
  var aPriority = Math.max(0, Number(a.matchPriority) || 0)
  var bPriority = Math.max(0, Number(b.matchPriority) || 0)
  if (aPriority !== bPriority) return bPriority - aPriority

  var aCount = Math.max(0, Number(a.usageCount) || 0)
  var bCount = Math.max(0, Number(b.usageCount) || 0)
  if (aCount !== bCount) return bCount - aCount
  var aLast = Math.max(0, Number(a.lastUsedAt) || 0)
  var bLast = Math.max(0, Number(b.lastUsedAt) || 0)
  if (aCount > 0 && aLast !== bLast) return bLast - aLast

  if (a.score !== b.score) return a.score - b.score
  return String(a.path || "").localeCompare(String(b.path || ""))
}

function rankSearchRows(rows, diagnosticRows, maxRows) {
  var ranked = Array.isArray(rows) ? rows.slice() : []
  var diagnostics = Array.isArray(diagnosticRows) ? diagnosticRows.slice() : []
  ranked.sort(compareSearchRows)
  diagnostics.sort(compareSearchRows)

  var limit = Math.max(0, Number(maxRows) || 0)
  if (!limit) return []
  // Even a saturated diagnostic set must not hide the best actionable result,
  // such as a live extension result. Reserve one slot when one is available.
  if (diagnostics.length >= limit) {
    if (ranked.length === 0) return diagnostics.slice(0, limit)
    return ranked.slice(0, 1).concat(diagnostics.slice(0, limit - 1))
  }
  return ranked.slice(0, limit - diagnostics.length).concat(diagnostics)
}

function isImagePath(path) {
  return /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(String(path || ""))
}

function localFileUrl(path) {
  var value = String(path || "")
  if (!value || value.charAt(0) !== "/") return ""
  return "file://" + value.split("/").map(function(part) {
    return encodeURIComponent(part)
  }).join("/")
}

var FILE_FAVORITE_PREFIX = "file.favorite:"
var LEGACY_DIRECTORY_FAVORITE_PREFIX = "file.favorite.directory:"
var LEGACY_FILE_FAVORITE_PREFIX = "file.favorite.file:"

function normalizeFavoritePath(path) {
  var value = String(path || "")
  if (!value || value.charAt(0) !== "/") return ""
  value = value.replace(/\/+$/, "")
  return value || "/"
}

function fileFavoriteId(path, type, capability) {
  var value = normalizeFavoritePath(path)
  var behavior = String(capability || "").trim()
  if (!value || !behavior || (type !== "directory" && type !== "file")) return ""
  return FILE_FAVORITE_PREFIX + JSON.stringify([behavior, type, value])
}

function legacyFileFavoriteId(path, type) {
  var value = normalizeFavoritePath(path)
  if (!value || (type !== "directory" && type !== "file")) return ""
  return (type === "directory" ? LEGACY_DIRECTORY_FAVORITE_PREFIX : LEGACY_FILE_FAVORITE_PREFIX) + value
}

function fileFavorite(itemId) {
  var value = String(itemId || "")
  var type = ""
  var path = ""

  // Stars created by the initial directory/file implementation implicitly
  // belong to the canonical Files capability.
  if (value.indexOf(LEGACY_DIRECTORY_FAVORITE_PREFIX) === 0) {
    type = "directory"
    path = value.substring(LEGACY_DIRECTORY_FAVORITE_PREFIX.length)
  } else if (value.indexOf(LEGACY_FILE_FAVORITE_PREFIX) === 0) {
    type = "file"
    path = value.substring(LEGACY_FILE_FAVORITE_PREFIX.length)
  } else if (value.indexOf(FILE_FAVORITE_PREFIX) === 0) {
    try {
      var parsed = JSON.parse(value.substring(FILE_FAVORITE_PREFIX.length))
      if (!Array.isArray(parsed) || parsed.length !== 3) return null
      var capability = String(parsed[0] || "").trim()
      type = String(parsed[1] || "")
      path = parsed[2]
      if (!capability || (type !== "directory" && type !== "file")) return null
      path = normalizeFavoritePath(path)
      return path ? { capability: capability, type: type, path: path } : null
    } catch (e) { return null }
  } else return null

  path = normalizeFavoritePath(path)
  return path ? { capability: "files", type: type, path: path } : null
}

function fileFavoritePath(itemId) {
  var favorite = fileFavorite(itemId)
  return favorite ? favorite.path : ""
}

function fileFavoriteType(itemId) {
  var favorite = fileFavorite(itemId)
  return favorite ? favorite.type : ""
}

function fileFavoriteCapability(itemId) {
  var favorite = fileFavorite(itemId)
  return favorite ? favorite.capability : ""
}

function fileFavoriteLabel(path) {
  var value = normalizeFavoritePath(path)
  if (!value) return ""
  if (value === "/") return "/"
  return value.substring(value.lastIndexOf("/") + 1)
}

function fileFavoriteItem(itemId) {
  var favorite = fileFavorite(itemId)
  if (!favorite) return null
  var id = fileFavoriteId(favorite.path, favorite.type, favorite.capability)
  return normalizeItem(id, {
    label: fileFavoriteLabel(favorite.path),
    description: favorite.path,
    action: favorite.path
  })
}

function matchesFileFavoriteQuery(entry, query) {
  if (!entry) return false
  var prepared = query && typeof query === "object" ? query : prepareSearchQuery(query)
  if (prepared.terms.length === 0) return false

  // Match the visible label normally, but only match path tokens from their
  // beginning. This prevents a short query such as `fi` from matching every
  // favorite below `/home/quantumfire` while retaining useful path lookup.
  var label = String(entry.label || "").toLowerCase()
  var pathTokens = String(entry.description || "").toLowerCase().split(/[\/._\s-]+/)
  for (var i = 0; i < prepared.terms.length; i++) {
    var term = prepared.terms[i]
    if (!term || label.indexOf(term) >= 0) continue
    var pathMatch = false
    for (var tokenIndex = 0; tokenIndex < pathTokens.length; tokenIndex++) {
      if (pathTokens[tokenIndex].indexOf(term) === 0) { pathMatch = true; break }
    }
    if (!pathMatch) return false
  }
  return true
}

// Recents are keyed per capability, so replacing the emoji provider keeps the
// history. The prefix still reads "favorite" because pinning used to share
// this key; renaming it would orphan every recent already recorded.
var EMOJI_USAGE_PREFIX = "emoji.favorite:"
// The bundled dataset holds roughly 1.8k entries. Both caps exist so a
// malformed or hostile dataset cannot make the grid unbounded.
var MAX_EMOJI_DEFINITIONS = 8192
var MAX_EMOJI_ROWS = 1000
var MAX_EMOJI_SEQUENCE = 32

function emojiUsageId(emoji, capability) {
  var value = String(emoji || "")
  var behavior = String(capability || "").trim()
  if (!value || !behavior) return ""
  return EMOJI_USAGE_PREFIX + JSON.stringify([behavior, value])
}

// Omarchy's dataset stores one space-joined keyword blob per emoji with no
// separate display name, so searching and captioning both derive from it.
function emojiSearchText(keywords) {
  return String(keywords || "").toLowerCase().replace(/[_\-\/]+/g, " ").replace(/\s+/g, " ").trim()
}

// Repeated words are common in the source keywords ("grinning face smile
// grinning happy"). Collapse them so the caption reads as a description.
function emojiCaption(keywords) {
  var text = emojiSearchText(keywords)
  if (!text) return ""
  var words = text.split(" ")
  var seen = ({})
  var out = []
  for (var i = 0; i < words.length; i++) {
    var key = lookupKey(words[i])
    if (!words[i] || seen[key]) continue
    seen[key] = true
    out.push(words[i])
  }
  text = out.join(" ")
  return text.charAt(0).toUpperCase() + text.substring(1)
}

function parseEmojiData(raw) {
  var parsed
  try { parsed = JSON.parse(String(raw || "")) } catch (e) { return [] }
  var source = Array.isArray(parsed) ? parsed
    : (parsed && Array.isArray(parsed.emojis) ? parsed.emojis : [])
  var values = []
  var seen = ({})
  for (var i = 0; i < source.length && values.length < MAX_EMOJI_DEFINITIONS; i++) {
    var entry = source[i]
    if (!entry || typeof entry !== "object") continue
    var emoji = String(entry.e || entry.emoji || "")
    if (!emoji || emoji.length > MAX_EMOJI_SEQUENCE) continue
    var key = lookupKey(emoji)
    if (seen[key]) continue
    seen[key] = true
    var keywords = String(entry.k || entry.keywords || entry.name || "")
    values.push({
      emoji: emoji,
      keywords: keywords,
      search: emojiSearchText(keywords),
      caption: emojiCaption(keywords)
    })
  }
  return values
}

// Word-prefix matching, so "smi fac" finds "smiling face" while a term buried
// mid-word does not. A leading keyword scores higher than a trailing one
// because the source blobs put the primary name first.
function emojiMatchScore(text, terms) {
  if (!terms || terms.length === 0) return 0
  var words = String(text || "").split(" ")
  var total = 0
  for (var i = 0; i < terms.length; i++) {
    var term = terms[i]
    if (!term) continue
    var best = 0
    for (var j = 0; j < words.length; j++) {
      if (words[j] === term) best = Math.max(best, j === 0 ? 4 : 3)
      else if (words[j].indexOf(term) === 0) best = Math.max(best, j === 0 ? 2 : 1)
    }
    if (best === 0) return -1
    total += best
  }
  return total
}

// Match quality outranks history: a search for "cat" must not lead with a
// frequently used emoji that does not match. Without a query every score is 0,
// which leaves the most-used first.
function compareEmojiRows(a, b) {
  if (a.score !== b.score) return b.score - a.score
  if (a.usageCount !== b.usageCount) return b.usageCount - a.usageCount
  if (a.lastUsedAt !== b.lastUsedAt) return b.lastUsedAt - a.lastUsedAt
  return a.order - b.order
}

function emojiRows(values, query, options) {
  var source = Array.isArray(values) ? values : []
  var settings = options || ({})
  var capability = String(settings.capability || "")
  var usageCount = typeof settings.usageCount === "function" ? settings.usageCount : null
  var lastUsedAt = typeof settings.lastUsedAt === "function" ? settings.lastUsedAt : null
  var limit = finiteExtensionNumber(settings.limit, MAX_EMOJI_ROWS)
  if (limit === null || limit < 0) limit = MAX_EMOJI_ROWS
  limit = Math.min(limit, MAX_EMOJI_ROWS)

  var terms = prepareSearchQuery(query).terms
  var rows = []
  for (var i = 0; i < source.length; i++) {
    var entry = source[i]
    if (!entry || !entry.emoji) continue
    var score = emojiMatchScore(entry.search, terms)
    if (score < 0) continue
    var itemId = emojiUsageId(entry.emoji, capability)
    rows.push({
      emoji: entry.emoji,
      caption: entry.caption,
      itemId: itemId,
      usageCount: itemId && usageCount ? Math.max(0, Number(usageCount(itemId)) || 0) : 0,
      lastUsedAt: itemId && lastUsedAt ? Math.max(0, Number(lastUsedAt(itemId)) || 0) : 0,
      score: score,
      order: i
    })
  }

  rows.sort(compareEmojiRows)
  return rows.length > limit ? rows.slice(0, limit) : rows
}

// Emoji file locations are resolved by the host rather than read from an
// arbitrary string: only {omarchyPath} and {extensionDir} expand, and the
// result must be absolute.
function emojiFilePath(extension, omarchyPath, value) {
  if (!extension || extension.mode !== "emoji") return ""
  var path = String(value || "")
  if (!path || path.indexOf("..") >= 0) return ""
  path = path.replace(/\{omarchyPath\}/g, String(omarchyPath || ""))
    .replace(/\{extensionDir\}/g, String(extension.sourceDir || ""))
  return path.indexOf("/") === 0 ? path : ""
}

// A list of candidates rather than one path: the bundled provider prefers the
// dataset Omarchy ships so it stays current, and falls back to its own copy so
// disabling or removing that plugin cannot take the picker with it.
function emojiFilePaths(extension, omarchyPath, values) {
  if (!extension || extension.mode !== "emoji") return []
  var source = Array.isArray(values) ? values : (values ? [values] : [])
  var paths = []
  for (var i = 0; i < source.length; i++) {
    var resolved = emojiFilePath(extension, omarchyPath, source[i])
    if (resolved && paths.indexOf(resolved) < 0) paths.push(resolved)
  }
  return paths
}

function emojiDataPaths(extension, omarchyPath) {
  return emojiFilePaths(extension, omarchyPath, extension && extension.data)
}

// Appended to the dataset rather than replacing it. Because groups are derived
// by scanning the dataset in order, a set appended at the end needs nothing
// more than one further boundary in the groups file to become its own category.
function emojiExtraDataPaths(extension, omarchyPath) {
  return emojiFilePaths(extension, omarchyPath, extension && extension.extraData)
}

// Cross-file duplicates are dropped, keeping the first occurrence, so the
// supplementary set cannot introduce a second cell for an existing glyph.
function concatEmojiData(values, extra) {
  var base = Array.isArray(values) ? values : []
  var more = Array.isArray(extra) ? extra : []
  if (more.length === 0) return base
  var seen = ({})
  var out = []
  for (var i = 0; i < base.length; i++) {
    seen[lookupKey(base[i].emoji)] = true
    out.push(base[i])
  }
  for (var j = 0; j < more.length; j++) {
    if (seen[lookupKey(more[j].emoji)]) continue
    seen[lookupKey(more[j].emoji)] = true
    out.push(more[j])
  }
  return out
}

function emojiGroupsPaths(extension, omarchyPath) {
  return emojiFilePaths(extension, omarchyPath, extension && extension.groups)
}

var EMOJI_FREQUENT_SECTION = "Frequently Used"
var MAX_EMOJI_FREQUENT = 16
var MAX_EMOJI_GROUPS = 64

function parseEmojiGroups(raw) {
  var parsed
  try { parsed = JSON.parse(stripJsonc(String(raw || ""))) } catch (e) { return [] }
  var source = Array.isArray(parsed) ? parsed
    : (parsed && Array.isArray(parsed.groups) ? parsed.groups : [])
  var groups = []
  for (var i = 0; i < source.length && groups.length < MAX_EMOJI_GROUPS; i++) {
    var entry = source[i]
    if (!entry || typeof entry !== "object") continue
    var label = String(entry.label || "").trim()
    var start = String(entry.start || "")
    if (!label || !start || start.length > MAX_EMOJI_SEQUENCE) continue
    groups.push({ label: label, start: start })
  }
  return groups
}

// The bundled dataset is in Unicode CLDR group order, so a group is everything
// from its first emoji up to the next group's. That keeps the boundary file
// tiny and categorizes emoji added inside a group for free — but it is only
// true while the dataset stays in that order, so an out-of-order or missing
// boundary abandons grouping rather than mislabeling half the grid.
function emojiGroupLabels(values, groups) {
  var source = Array.isArray(values) ? values : []
  var boundaries = Array.isArray(groups) ? groups : []
  if (source.length === 0 || boundaries.length === 0) return null

  var starts = []
  var previous = -1
  for (var i = 0; i < boundaries.length; i++) {
    var at = -1
    for (var j = previous + 1; j < source.length; j++) {
      if (source[j] && source[j].emoji === boundaries[i].start) { at = j; break }
    }
    if (at < 0 || at <= previous) return null
    starts.push(at)
    previous = at
  }
  // Anything before the first boundary is uncategorized, which means the file
  // does not describe this dataset.
  if (starts[0] !== 0) return null

  var labels = []
  var current = 0
  for (var k = 0; k < source.length; k++) {
    while (current + 1 < starts.length && k >= starts[current + 1]) current++
    labels.push(boundaries[current].label)
  }
  return labels
}

// Lay a run of cells out into rows of `columns`, tagged with one section label.
function appendEmojiSection(cells, rows, section, entries, columns, options) {
  if (entries.length === 0) return
  var width = Math.max(1, columns)
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i]
    var itemId = emojiUsageId(entry.emoji, options.capability)
    if (i % width === 0) rows.push({ section: section, start: cells.length, count: 0 })
    rows[rows.length - 1].count += 1
    cells.push({
      emoji: entry.emoji,
      caption: entry.caption,
      itemId: itemId,
      row: rows.length - 1,
      column: i % width
    })
  }
}

// A query is answered by one ranked list: category order would fight the
// ranking, so headers only appear while browsing.
function emojiSections(values, query, options) {
  var source = Array.isArray(values) ? values : []
  var settings = options || ({})
  var columns = Math.max(1, finiteExtensionNumber(settings.columns, 8) || 8)
  var context = { capability: String(settings.capability || "") }
  var usageCount = typeof settings.usageCount === "function" ? settings.usageCount : null
  var lastUsedAt = typeof settings.lastUsedAt === "function" ? settings.lastUsedAt : null
  var cells = []
  var rows = []

  if (prepareSearchQuery(query).terms.length > 0) {
    appendEmojiSection(cells, rows, "", emojiRows(source, query, settings), columns, context)
    return { cells: cells, rows: rows, sectioned: false }
  }

  var frequent = []
  if (usageCount) {
    for (var i = 0; i < source.length; i++) {
      var entry = source[i]
      if (!entry || !entry.emoji) continue
      var itemId = emojiUsageId(entry.emoji, context.capability)
      if (!itemId) continue
      var count = Math.max(0, Number(usageCount(itemId)) || 0)
      if (count > 0) {
        frequent.push({
          entry: entry,
          count: count,
          lastUsedAt: lastUsedAt ? Math.max(0, Number(lastUsedAt(itemId)) || 0) : 0,
          order: i
        })
      }
    }
    frequent.sort(function(a, b) {
      if (a.count !== b.count) return b.count - a.count
      if (a.lastUsedAt !== b.lastUsedAt) return b.lastUsedAt - a.lastUsedAt
      return a.order - b.order
    })
    frequent = frequent.slice(0, MAX_EMOJI_FREQUENT).map(function(value) { return value.entry })
  }

  appendEmojiSection(cells, rows, EMOJI_FREQUENT_SECTION, frequent, columns, context)

  // A frequently used emoji stays listed in its own category too, so browsing
  // a category never has holes in it.
  var labels = emojiGroupLabels(source, settings.groups)
  if (!labels) {
    appendEmojiSection(cells, rows, "", source, columns, context)
    return { cells: cells, rows: rows, sectioned: frequent.length > 0 }
  }

  var runLabel = ""
  var run = []
  for (var k = 0; k < source.length; k++) {
    if (labels[k] !== runLabel) {
      appendEmojiSection(cells, rows, runLabel, run, columns, context)
      runLabel = labels[k]
      run = []
    }
    if (source[k] && source[k].emoji) run.push(source[k])
  }
  appendEmojiSection(cells, rows, runLabel, run, columns, context)
  return { cells: cells, rows: rows, sectioned: true }
}

// qalc reads an abbreviated plural as the singular times seconds — "lbs" is
// lb·s, "kms" is km·s, "tsps" is tsp·s — and reads a bare temperature letter as
// a physics constant: "c" the speed of light, "f" femto, "k" kilo. So "180 lbs
// to kg" answered "81.65 kg·s" and "100 c to f" answered "2.99e25 fm/s".
// Neither is what someone typing into a launcher means.
//
// The map is curated rather than a rule that strips a trailing "s", because
// ms, ns, ps, us and fs are real units: SI-prefixed seconds. Stripping those
// would break "500 ms to s".
var UNIT_ALIASES = {
  kms: "km", cms: "cm", mms: "mm", fts: "ft", ins: "in", yds: "yd", mis: "mi",
  lbs: "lb", ozs: "oz", kgs: "kg",
  gals: "gal", qts: "qt", pints: "pint", tsps: "tsp", tbsps: "tbsp",
  mins: "min", secs: "sec",
  // Compact rates qalc does not recognise. kph and mph it does.
  kmh: "km/h", kmph: "km/h", mps: "m/s"
}

var TEMPERATURE_UNITS = {
  c: "°C", celsius: "°C", centigrade: "°C", degc: "°C", "°c": "°C",
  f: "°F", fahrenheit: "°F", degf: "°F", "°f": "°F",
  k: "K", kelvin: "K", degk: "K"
}

var TEMPERATURE_CONVERSION = /^([\s\S]*?)([A-Za-z°]+)\s+(to|in)\s+([A-Za-z°]+)\s*$/i

// A bare amount and unit is a conversion request with the obvious counterpart
// left unsaid: "1 inch" means centimetres, "80 kg" means pounds. Each entry
// crosses the metric/imperial line, which is the only reading that makes a
// lone unit worth converting at all.
//
// Deliberately absent: a bare c, f, k, or s. They are ambiguous even in a
// conversion, and a launcher query like "4k" or "5g" must stay a search.
var IMPLICIT_TARGETS = {
  inch: "cm", inches: "cm", "in": "cm",
  cm: "inch", mm: "inch", m: "ft", km: "mi",
  mi: "km", mile: "km", miles: "km",
  ft: "cm", foot: "cm", feet: "cm",
  yd: "m", yard: "m", yards: "m",
  lb: "kg", pound: "kg", pounds: "kg", kg: "lb",
  oz: "g", ounce: "g", ounces: "g", g: "oz", gram: "oz", grams: "oz",
  ton: "kg", tons: "kg",
  l: "gal", liter: "gal", liters: "gal", litre: "gal", litres: "gal",
  gal: "l", gallon: "l", gallons: "l",
  ml: "floz", floz: "ml",
  cup: "ml", cups: "ml", tsp: "ml", tbsp: "ml",
  celsius: "fahrenheit", fahrenheit: "celsius",
  mph: "km/h", "km/h": "mph"
}

var BARE_AMOUNT = /^([+-]?[0-9][0-9,]*(?:\.[0-9]+)?)(\s*)([A-Za-z°]+(?:\/[A-Za-z]+)?)$/

// A trailing "to" or "in" with nothing after it is not a conversion — "2 in"
// is two inches — so the keyword only counts when something follows it.
function implicitConversionTarget(query) {
  var text = String(query || "").trim()
  if (/\b(to|in)\b\s*\S/i.test(text)) return ""
  var parts = BARE_AMOUNT.exec(text)
  if (!parts) return ""
  var unit = parts[3].toLowerCase()
  // A one-letter unit must be separated from the amount. Without this, "5g"
  // and "4k" stop being searches and start being conversions.
  if (unit.length === 1 && parts[2].length === 0) return ""
  var target = IMPLICIT_TARGETS[unit]
  return target && target !== unit ? target : ""
}

function normalizeCalculationQuery(query) {
  var text = String(query === undefined || query === null ? "" : query)
  if (!text.trim()) return text

  // Unit aliases are unambiguous, so a plain token swap is safe anywhere.
  text = text.replace(/[A-Za-z]+/g, function(token) {
    var alias = UNIT_ALIASES[token.toLowerCase()]
    return alias === undefined ? token : alias
  })

  // A lone amount and unit gains its implied counterpart before the
  // temperature pass, so "100 celsius" becomes "100 °C to °F".
  var implicit = implicitConversionTarget(text)
  if (implicit) text = text.trim() + " to " + implicit

  // Temperature is rewritten only when both sides of the conversion are
  // temperatures. That is what makes a bare "c" safe to touch: on its own it
  // still means the speed of light, and "3 c to m" is left alone.
  var pair = TEMPERATURE_CONVERSION.exec(text)
  if (pair) {
    var from = TEMPERATURE_UNITS[pair[2].toLowerCase()]
    var to = TEMPERATURE_UNITS[pair[4].toLowerCase()]
    if (from && to) text = pair[1] + from + " " + pair[3] + " " + to
  }

  return text
}

// qalc prints a currency code before the amount and to full precision
// ("CAD 13.89019350"). A conversion is read as money, so present it the way
// money is written: amount first, two decimals, grouped thousands.
var CURRENCY_RESULT = /^([A-Za-z]{3})\s+([+-]?[0-9][0-9,]*(?:\.[0-9]+)?)$/
var LEADING_NUMBER = /^([+-]?[0-9][0-9,]*(?:\.[0-9]+)?)([\s\S]*)$/

function groupThousands(text) {
  var parts = String(text).split(".")
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return parts.join(".")
}

// Trailing zeros in a fraction carry no information; a bare trailing point is
// never wanted either.
function trimTrailingZeros(text) {
  var value = String(text)
  if (value.indexOf(".") < 0) return value
  return value.replace(/(\.[0-9]*?)0+$/, "$1").replace(/\.$/, "")
}

// qalc answers to full precision: "81.6466266 kg", "0.3962580785 gal". Two
// decimals reads well above 1, but would flatten a value below it, so a small
// number keeps four significant digits instead.
function tidyNumber(raw) {
  var text = String(raw)
  var amount = Number(text.replace(/,/g, ""))
  if (!isFinite(amount)) return text
  var tidy = Math.abs(amount) >= 1 ? amount.toFixed(2) : amount.toPrecision(4)
  // toPrecision can return exponential notation for very small values, which
  // is less readable here than the original digits.
  if (tidy.indexOf("e") >= 0 || tidy.indexOf("E") >= 0) return text
  return groupThousands(trimTrailingZeros(tidy))
}

function isCurrencyResult(raw) {
  return CURRENCY_RESULT.test(String(raw || "").trim())
}

function formatCalculationValue(raw) {
  var text = String(raw || "").trim()
  if (!text) return ""

  var currency = CURRENCY_RESULT.exec(text)
  if (currency) {
    var amount = Number(currency[2].replace(/,/g, ""))
    if (!isFinite(amount)) return text
    var fixed = amount.toFixed(2)
    // Two decimals would round a small non-zero amount to "0.00", which reads
    // as nothing at all. Keep that one's own precision instead.
    if (amount !== 0 && Number(fixed) === 0) fixed = trimTrailingZeros(currency[2].replace(/,/g, ""))
    return groupThousands(fixed) + " " + currency[1].toUpperCase()
  }

  // qalc spells fluid ounces with an underscore; nothing else in its output
  // uses one, so this is safe to spell the way people write it.
  text = text.replace(/\bfl_oz\b/g, "fl oz")

  // Everything else keeps its own shape — units, ratios, times, mixed units
  // like "154 lb + 5.18 oz", and anything qalc could not evaluate — with every
  // number in it tidied.
  // A comma counts as a thousands separator only when three digits follow it,
  // so a comma between arguments — "rem(25, 1 B)" — is left where it is.
  return text.replace(/[0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?/g, function(number) { return tidyNumber(number) })
}

// The expression shown beside the answer. Currency codes are uppercased only
// when the answer is a currency, so function names like sin, cos, and log are
// never touched.
function calculationExpression(query, currency) {
  var text = String(query || "").trim().replace(/\s+/g, " ")
  if (!text || !currency) return text
  return text.replace(/\b([A-Za-z]{3})\b/g, function(match) { return match.toUpperCase() })
}

// Clipboard history is a JSON array of {type:"text",text} and
// {type:"image",path,mime,capturedAt}, newest first, written by Omarchy's
// clipboard capture. Omalaunch reads it and never writes it.
//
// Only a prefix of an entry is ever scanned or rendered. A single large paste
// otherwise costs hundreds of megabytes of string work on every keystroke.
// Pasting passes the history index to Omarchy's helper, which reads the full
// entry back itself — so nothing is lost, and no clipboard content is ever put
// on a command line where a process listing could show it.
var MAX_CLIPBOARD_TEXT = 8192
var MAX_CLIPBOARD_ENTRIES = 500
var MAX_CLIPBOARD_ROWS = 100

function clipboardFileUriPath(line) {
  var value = String(line || "").trim()
  if (value.indexOf("file://") !== 0) return ""
  var path = value.substring(7)
  if (path.indexOf("localhost/") === 0) path = path.substring(9)
  if (path.charAt(0) !== "/") return ""
  try { return decodeURIComponent(path) } catch (e) { return path }
}

function clipboardFilePaths(text) {
  var lines = String(text || "").split(/\r?\n/)
  var paths = []
  for (var i = 0; i < lines.length; i++) {
    var path = clipboardFileUriPath(lines[i])
    if (path) paths.push(path)
  }
  return paths
}

function clipboardBaseName(path) {
  var parts = String(path || "").split("/")
  return parts.length > 0 ? parts[parts.length - 1] : String(path || "")
}

function parseClipboardHistory(raw) {
  var parsed
  try { parsed = JSON.parse(String(raw || "[]")) } catch (e) { return [] }
  if (!Array.isArray(parsed)) return []

  var entries = []
  for (var i = 0; i < parsed.length && entries.length < MAX_CLIPBOARD_ENTRIES; i++) {
    var value = parsed[i]
    if (typeof value === "string") value = { type: "text", text: value }
    if (!value || typeof value !== "object") continue

    var type = String(value.type || value.kind || "")
    if (type === "image") {
      var imagePath = String(value.path || "")
      if (!imagePath) continue
      entries.push({
        kind: "image",
        index: i,
        path: imagePath,
        mime: String(value.mime || "image/png"),
        capturedAt: String(value.capturedAt || ""),
        text: ""
      })
      continue
    }
    if (type !== "text") continue

    var text = String(value.text || "")
    if (!text.trim()) continue
    // Cut on a line break so a file:// URI never truncates into a bogus path.
    if (text.length > MAX_CLIPBOARD_TEXT) {
      var cut = text.lastIndexOf("\n", MAX_CLIPBOARD_TEXT)
      text = text.slice(0, cut > 0 ? cut : MAX_CLIPBOARD_TEXT)
    }
    var paths = clipboardFilePaths(text)
    entries.push({
      kind: paths.length > 0 ? "file" : "text",
      index: i,
      path: paths.length === 1 ? paths[0] : "",
      paths: paths,
      mime: "text/plain",
      capturedAt: "",
      text: text
    })
  }
  return entries
}

function clipboardEntryPreview(entry) {
  if (!entry) return ""
  if (entry.kind === "image")
    return (entry.mime === "image/png" ? "Screenshot" : "Image")
      + (entry.capturedAt ? " from " + entry.capturedAt : "")
  if (entry.kind === "file")
    return entry.paths.length === 1 ? clipboardBaseName(entry.paths[0]) : entry.paths.length + " files"
  return String(entry.text || "").replace(/\s+/g, " ").trim()
}

function clipboardEntryDetail(entry) {
  if (!entry) return ""
  if (entry.kind === "image") return String(entry.mime || "image")
  if (entry.kind === "file") return entry.paths.length === 1 ? entry.paths[0] : entry.paths.join(", ")
  var lines = String(entry.text || "").split(/\r?\n/).length
  var characters = String(entry.text || "").length
  return lines > 1 ? lines + " lines · " + characters + " characters" : characters + " characters"
}

// A remembered fragment is what people search a clipboard by, so this is a
// plain case-insensitive substring rather than the word matching used
// elsewhere.
function clipboardSearchText(entry) {
  if (!entry) return ""
  if (entry.kind === "image") return ("image screenshot " + entry.mime + " " + entry.capturedAt).toLowerCase()
  return (String(entry.text || "") + " " + clipboardEntryPreview(entry)).toLowerCase()
}

function clipboardRows(entries, query, limit) {
  var values = Array.isArray(entries) ? entries : []
  var needle = String(query || "").trim().toLowerCase()
  var max = finiteExtensionNumber(limit, MAX_CLIPBOARD_ROWS)
  if (max === null || max < 0) max = MAX_CLIPBOARD_ROWS
  max = Math.min(max, MAX_CLIPBOARD_ROWS)

  var rows = []
  for (var i = 0; i < values.length && rows.length < max; i++) {
    var entry = values[i]
    if (needle && clipboardSearchText(entry).indexOf(needle) < 0) continue
    rows.push({
      kind: entry.kind,
      index: entry.index,
      preview: clipboardEntryPreview(entry),
      detail: clipboardEntryDetail(entry),
      path: entry.path,
      mime: entry.mime
    })
  }
  return rows
}

// The detail pane shows one entry at a time, so it can afford the whole
// (already capped) text where a row could not.
var MAX_CLIPBOARD_BODY = 4000

function clipboardEntryBody(entry) {
  if (!entry) return ""
  if (entry.kind === "image") return ""
  if (entry.kind === "file") return entry.paths.join("\n")
  var text = String(entry.text || "")
  return text.length > MAX_CLIPBOARD_BODY ? text.slice(0, MAX_CLIPBOARD_BODY) : text
}

function clipboardCountLabel(count, singular) {
  return count + " " + (count === 1 ? singular : singular + "s")
}

// Label/value pairs for the detail pane, in the order Raycast reads them:
// what it is, then how big, then where it came from.
function clipboardEntryMetadata(entry) {
  if (!entry) return []
  if (entry.kind === "image") {
    var image = [{ label: "Type", value: "Image" }, { label: "Format", value: String(entry.mime || "") }]
    if (entry.capturedAt) image.push({ label: "Captured", value: String(entry.capturedAt) })
    if (entry.path) image.push({ label: "Path", value: String(entry.path) })
    return image
  }
  if (entry.kind === "file") {
    var files = [{ label: "Type", value: entry.paths.length === 1 ? "File" : "Files" },
      { label: "Count", value: clipboardCountLabel(entry.paths.length, "file") }]
    if (entry.paths.length === 1) files.push({ label: "Path", value: entry.paths[0] })
    return files
  }
  var text = String(entry.text || "")
  var lines = text.split(/\r?\n/).length
  var words = text.trim() ? text.trim().split(/\s+/).length : 0
  var meta = [{ label: "Type", value: "Text" },
    { label: "Characters", value: String(text.length) },
    { label: "Words", value: String(words) }]
  if (lines > 1) meta.push({ label: "Lines", value: String(lines) })
  return meta
}

// {stateHome} follows the XDG convention the rest of Omalaunch's state uses.
function clipboardHistoryPaths(extension, stateHome, omarchyPath) {
  if (!extension || extension.mode !== "clipboard") return []
  var source = Array.isArray(extension.history) ? extension.history : []
  var paths = []
  for (var i = 0; i < source.length; i++) {
    var value = String(source[i] || "")
    if (!value || value.indexOf("..") >= 0) continue
    value = value.replace(/\{stateHome\}/g, String(stateHome || ""))
      .replace(/\{omarchyPath\}/g, String(omarchyPath || ""))
      .replace(/\{extensionDir\}/g, String(extension.sourceDir || ""))
    if (value.indexOf("/") === 0 && paths.indexOf(value) < 0) paths.push(value)
  }
  return paths
}

function displayRow(items, itemOrder, checkedResults, entry, detail, score, section, metadata) {
  var target = entry.kind === "link" ? entry.target : entry.id
  return {
    itemId: entry.id,
    kind: entry.kind,
    icon: entry.icon,
    iconFont: entry.iconFont || "",
    trailingIcon: entry.trailingIcon || "",
    trailingText: typeof entry.trailingText === "string" ? entry.trailingText.substring(0, 64) : "",
    badge: entry.badge || "",
    badgeTone: normalizeBadgeTone(entry.badgeTone),
    appIcon: entry.appIcon || "",
    appId: entry.appId || "",
    label: labelFor(entry, checkedResults),
    target: target,
    detail: detail || "",
    path: metadata ? metadata.path : pathFor(items, entry.id),
    childCount: (entry.kind === "menu" || entry.kind === "link")
      ? (metadata ? metadata.childCount : childCount(items, itemOrder, target)) : 0,
    action: entry.action || "",
    provider: entry.provider || "",
    score: score || 0,
    section: section || "",
    starred: false,
    // Every row carries these roles so the ListModel's role set stays uniform
    // regardless of which build path produced the row.
    disabled: false,
    value: "",
    matchPriority: 0,
    usageCount: 0,
    lastUsedAt: 0
  }
}

// Commands a `checked:` expression reads a value out of. Every sibling row
// asks the same one -- Defaults > Browser has seven rows all comparing
// against `omarchy-default-browser` -- so the batch runs it once and the rows
// read the captured answer.
//
// The capture has to be eager. These are read inside `$(...)`, and a value
// cached while one expression runs lives in that subshell only, so a lazy
// memo never survives to the expression after it.
var GUARD_READERS = [
  "omarchy-channel-current",
  "omarchy-default-agent",
  "omarchy-default-browser",
  "omarchy-default-editor",
  "omarchy-default-terminal",
  "omarchy-dns"
]

// Package and command presence account for most of what the guards ask, and
// asked one at a time they are almost all fork: the shipped menu spends over
// a second on them. Answer them inside the guard process instead. These
// shadow the real commands for the batch only, so they have to agree with
// them everywhere, including for no arguments at all (present is true of
// nothing, missing is not).
//
// `pacman -Q` resolves a name through what installed packages provide, not
// just what they are called -- with gvim installed it reports `vim` as
// present -- so the set has to carry provides too, or `install.editor.vim`
// comes back and offers to install what is already there. A version
// constraint (`bash>=1`) is not a name any set can answer, so it goes to
// pacman itself; no shipped guard writes one.
//
// `pacman -Qi` wraps a long list across continuation lines whenever COLUMNS
// is set in the environment, which a login shell may well have done, so the
// parser follows the indented lines rather than reading the first one and
// dropping half of what is installed.
function guardHelpers() {
  return 'declare -A __omarchy_pkgs=()\n'
    + 'mapfile -t __omarchy_pkg_names < <({ pacman -Qq; LC_ALL=C pacman -Qi'
    + " | awk '/^[A-Za-z]/ { provides = ($0 ~ /^Provides/); sub(/^[^:]*: /, \"\") }"
    + ' provides && $0 != "None" { n = split($0, p, " ");'
    + ' for (i = 1; i <= n; i++) { sub(/[<>=].*/, "", p[i]); print p[i] } }\'; } 2>/dev/null)\n'
    + 'for __omarchy_pkg in "${__omarchy_pkg_names[@]}"; do __omarchy_pkgs[$__omarchy_pkg]=1; done\n'
    + '__omarchy_pkg_has() { [[ -n ${__omarchy_pkgs[$1]-} ]] && return 0; '
    + '[[ $1 == *[\\<\\>=]* ]] && { pacman -Q "$1" &>/dev/null; return; }; return 1; }\n'
    + 'omarchy-pkg-present() { local p; for p in "$@"; do __omarchy_pkg_has "$p" || return 1; done; return 0; }\n'
    + 'omarchy-pkg-missing() { local p; for p in "$@"; do __omarchy_pkg_has "$p" || return 0; done; return 1; }\n'
    + 'omarchy-cmd-present() { local c; for c in "$@"; do command -v "$c" &>/dev/null || return 1; done; return 0; }\n'
    + 'omarchy-cmd-missing() { local c; for c in "$@"; do command -v "$c" &>/dev/null || return 0; done; return 1; }\n'
}

// Substitute the captured answer into the expression rather than shadowing
// the reader with a function. `$(reader)` and the variable holding what it
// printed are interchangeable -- both strip trailing newlines, both split the
// same way unquoted -- while a function would also catch `command -v reader`,
// `VAR=x reader`, and every other form, and answer those wrong. Anything but
// the plain substitution is left alone to run the real command.
function guardPrelude(guards) {
  var prelude = guardHelpers()

  for (var i = 0; i < GUARD_READERS.length; i++) {
    // The guards arrive already substituted, so what marks a reader as wanted
    // is the slot standing in for it, not the call it replaced.
    if (guards.indexOf(guardReaderSlot(i)) < 0) continue
    // `|| :` so a reader that exits nonzero cannot take the batch down with
    // it under a login shell that turned on errexit.
    prelude += "__omarchy_read_" + i + "=$(" + GUARD_READERS[i] + " 2>/dev/null) || :\n"
  }

  return prelude
}

function guardReaderSlot(index) {
  return "${__omarchy_read_" + index + "}"
}

function substituteGuardReaders(expression) {
  for (var i = 0; i < GUARD_READERS.length; i++)
    expression = expression.split("$(" + GUARD_READERS[i] + ")").join(guardReaderSlot(i))

  return expression
}

function shellSingleQuote(value) {
  return "'" + String(value || "").replace(/'/g, "'\\''") + "'"
}

function guardLine(id, tag, expression) {
  var success = shellSingleQuote(id + ":" + tag + ":1")
  var failure = shellSingleQuote(id + ":" + tag + ":0")
  return "if { " + substituteGuardReaders(expression) + "; } >/dev/null 2>&1; then printf '%s\\n' "
    + success + "; else printf '%s\\n' " + failure + "; fi\n"
}

// One bash script for every `when:` and `checked:` in the menu, reporting
// `<id>:<w|c>:<0|1>` per line. Speed is the whole point: the menu opens on
// the last evaluation's answers, so however long this takes is how long a row
// can contradict the state it describes.
function guardScript(items) {
  var guards = ""
  var ids = Object.keys(items || {})

  for (var i = 0; i < ids.length; i++) {
    var entry = items[ids[i]]
    if (!entry) continue
    if (entry.when) guards += guardLine(ids[i], "w", entry.when)
    if (entry.checked) guards += guardLine(ids[i], "c", entry.checked)
  }

  return guards ? guardPrelude(guards) + guards : ""
}

// This registry is the single source for footer order, displayed shortcuts,
// keyboard lookup, and compact-layout priority. IDs are stable host actions.
var FOOTER_ACTION_DEFINITIONS = [
  { id: "primary", shortcut: "Enter", key: "Enter", modifiers: "", order: 10, compactPriority: 1000 },
  { id: "refresh", shortcut: "Ctrl R", key: "R", modifiers: "Ctrl", order: 20, compactPriority: 100 },
  { id: "copy", shortcut: "Ctrl C", key: "C", modifiers: "Ctrl", order: 30, compactPriority: 20 },
  { id: "star", shortcut: "Ctrl S", key: "S", modifiers: "Ctrl", order: 40, compactPriority: 40 },
  { id: "actions", shortcut: "Ctrl K", key: "K", modifiers: "Ctrl", order: 50, compactPriority: 300 },
  { id: "settings", shortcut: "Ctrl ,", key: ",", modifiers: "Ctrl", order: 60, compactPriority: 200 },
  { id: "capability", shortcut: "Del", key: "Delete", modifiers: "", order: 70, compactPriority: 30 }
]

function footerActionDefinitions() {
  return FOOTER_ACTION_DEFINITIONS.map(function(definition) { return Object.assign({}, definition) })
}

function footerActionIdForShortcut(key, modifiers) {
  for (var i = 0; i < FOOTER_ACTION_DEFINITIONS.length; i++) {
    var definition = FOOTER_ACTION_DEFINITIONS[i]
    if (definition.key === key && definition.modifiers === modifiers) return definition.id
  }
  return ""
}

function footerActionDefinition(id) {
  for (var i = 0; i < FOOTER_ACTION_DEFINITIONS.length; i++)
    if (FOOTER_ACTION_DEFINITIONS[i].id === id) return FOOTER_ACTION_DEFINITIONS[i]
  return null
}

// Keep the footer limited to actions that the current launcher state accepts.
function fileEscapeAction(state) {
  var value = state || ({})
  if (value.actionPanelActive) return "close-actions"
  if (value.hasFilter) return "clear-search"
  var path = normalizeFavoritePath(value.path)
  var home = normalizeFavoritePath(value.home)
  if (path === "/" || (home && path === home))
    return value.directoryPickerActive ? "leave-picker" : "leave-files"
  return path ? "parent" : "leave-files"
}

function isHomeOrAncestorPath(path, home) {
  var value = normalizeFavoritePath(path)
  var homePath = normalizeFavoritePath(home)
  return !!value && value !== "/" && !!homePath
    && (value === homePath || homePath.indexOf(value + "/") === 0)
}

function selectedPrimaryActionLabel(state) {
  var value = state || ({})
  if (value.selectedFileNavigation) return "Go up"
  if (value.workflowInputActive && value.workflowNode) return value.workflowNode.primaryActionLabel || ""
  if (value.selectedWorkflowNode) return value.selectedWorkflowNode.primaryActionLabel || ""
  if (value.selectedDynamicSearchNode) return value.selectedDynamicSearchNode.primaryActionLabel || ""
  return ""
}

// Keep the footer limited to actions that the current launcher state accepts.
function actionBarHints(state) {
  var value = state || ({})
  var labels = {}
  if (value.dmenuInput) labels.primary = "Submit"
  else if (value.workflowInputActive) labels.primary = value.primaryActionLabel || "Continue"
  else if (value.hasSelection) labels.primary = value.primaryActionLabel || (value.actionPanelActive ? "Run"
    : (value.emojiPickerActive || value.clipboardPickerActive ? "Paste"
      : (value.directoryPickerActive || value.dmenuActive ? "Select"
        : (value.workflowActive ? "Continue" : "Open"))))

  if (value.canRefresh) labels.refresh = "Refresh"
  var fileActionsAvailable = value.fileBrowserActive && value.hasSelection
    && value.fileActionsAvailable !== false
    && !value.directoryPickerActive && !value.actionPanelActive
  if (fileActionsAvailable) labels.copy = value.fileSelectionType === "file" ? "Copy" : "Copy Path"
  // The emoji and clipboard pickers paste on Enter, so Ctrl C is their way to
  // put the selection on the clipboard without dismissing anything.
  else if ((value.emojiPickerActive || value.clipboardPickerActive) && value.hasSelection) labels.copy = "Copy"
  if (value.canStar) labels.star = value.starred ? "Unstar" : "Star"
  if (value.canContextActions || fileActionsAvailable) labels.actions = "Actions"
  if (value.canConfigure || value.canSettings) labels.settings = "Settings"
  if (value.canToggleCapability) labels.capability = value.capabilityDisabled ? "Enable" : "Disable"

  var hints = []
  for (var i = 0; i < FOOTER_ACTION_DEFINITIONS.length; i++) {
    var definition = FOOTER_ACTION_DEFINITIONS[i]
    if (labels[definition.id]) hints.push(Object.assign({}, definition, { label: labels[definition.id] }))
  }
  return hints
}

// Hidden hints remain active keyboard commands; this function controls help text.
function compactActionBarHints(hints) {
  var values = Array.isArray(hints) ? hints : []
  if (values.length <= 2) return values.slice()
  var compact = values.length > 0 ? [values[0]] : []
  var fallback = null
  for (var i = 1; i < values.length; i++) {
    var definition = footerActionDefinition(values[i].id)
    var priority = definition ? definition.compactPriority : 0
    if (!fallback || priority > fallback.priority)
      fallback = { hint: values[i], priority: priority }
  }
  if (fallback) compact.push(fallback.hint)
  return compact
}

if (typeof module !== "undefined") {
  module.exports = {
    guardReaders: GUARD_READERS,
    guardScript: guardScript,
    stripJsonc: stripJsonc,
    normalizeAliases: normalizeAliases,
    normalizeItem: normalizeItem,
    parseMenuJsonc: parseMenuJsonc,
    parseMenuJsoncSnapshot: parseMenuJsoncSnapshot,
    mergeMenuSources: mergeMenuSources,
    mergeAppRows: mergeAppRows,
    swapProviderRows: swapProviderRows,
    item: item,
    resolveRoute: resolveRoute,
    slugify: slugify,
    depthFor: depthFor,
    pathFor: pathFor,
    parentPathFor: parentPathFor,
    isDescendantOf: isDescendantOf,
    buildItemMetadata: buildItemMetadata,
    prepareSearchQuery: prepareSearchQuery,
    isSearchExcluded: isSearchExcluded,
    childCount: childCount,
    isVisible: isVisible,
    labelFor: labelFor,
    searchableToken: searchableToken,
    leafIdFor: leafIdFor,
    nameSearchText: nameSearchText,
    termInSearchWords: termInSearchWords,
    descriptionTextMatches: descriptionTextMatches,
    dependencySetup: dependencySetup,
    unavailableExtensionDetail: unavailableExtensionDetail,
    firstSetupExtension: firstSetupExtension,
    safeExtensionPattern: safeExtensionPattern,
    openStateReset: openStateReset,
    utf8ByteLength: utf8ByteLength,
    normalizeWorkflow: normalizeWorkflow,
    normalizeDetailDocument: normalizeDetailDocument,
    normalizeDynamicMenuOutput: normalizeDynamicMenuOutput,
    dynamicMenuSearchNodes: dynamicMenuSearchNodes,
    dynamicMenuSearchItems: dynamicMenuSearchItems,
    dynamicMenuItemId: dynamicMenuItemId,
    dynamicMenuSearchIdentity: dynamicMenuSearchIdentity,
    dynamicMenuUsageItemId: dynamicMenuUsageItemId,
    workflowInterpolate: workflowInterpolate,
    workflowInitialInput: workflowInitialInput,
    workflowCommand: workflowCommand,
    workflowDirectoryTransition: workflowDirectoryTransition,
    workflowInputTransition: workflowInputTransition,
    rebindWorkflow: rebindWorkflow,
    workflowActionIsCurrent: workflowActionIsCurrent,
    workflowBackgroundEligible: workflowBackgroundEligible,
    backgroundActionIsCurrent: backgroundActionIsCurrent,
    workflowClosesOnDispatch: workflowClosesOnDispatch,
    extensionRootId: extensionRootId,
    extensionRootCapability: extensionRootCapability,
    extensionRootItem: extensionRootItem,
    extensionRootDetail: extensionRootDetail,
    sortExtensionRootRows: sortExtensionRootRows,
    extensionRootActivation: extensionRootActivation,
    extensionRouteCapability: extensionRouteCapability,
    extensionRootInput: extensionRootInput,
    focusedExtensionQuery: focusedExtensionQuery,
    focusedPrefixMatch: focusedPrefixMatch,
    extensionOriginRank: extensionOriginRank,
    normalizeExtension: normalizeExtension,
    resolveExtensions: resolveExtensions,
    disabledCapabilitySet: disabledCapabilitySet,
    enabledExtensions: enabledExtensions,
    capabilityLockedByConfig: capabilityLockedByConfig,
    launcherSize: launcherSize,
    parseExtensionCatalog: parseExtensionCatalog,
    parseExtensions: parseExtensions,
    matchesRules: matchesRules,
    queryExtension: queryExtension,
    unavailableQueryExtension: unavailableQueryExtension,
    extensionQueryRunIsCurrent: extensionQueryRunIsCurrent,
    extensionSuggestionPriority: extensionSuggestionPriority,
    extensionMatchPriority: extensionMatchPriority,
    extensionResultPriority: extensionResultPriority,
    suggestExtensions: suggestExtensions,
    matchExtensions: matchExtensions,
    matchesQuery: matchesQuery,
    searchMatchPriority: searchMatchPriority,
    searchScore: searchScore,
    compareSearchRows: compareSearchRows,
    rankSearchRows: rankSearchRows,
    isImagePath: isImagePath,
    localFileUrl: localFileUrl,
    normalizeFavoritePath: normalizeFavoritePath,
    fileFavoriteId: fileFavoriteId,
    legacyFileFavoriteId: legacyFileFavoriteId,
    fileFavorite: fileFavorite,
    fileFavoritePath: fileFavoritePath,
    fileFavoriteType: fileFavoriteType,
    fileFavoriteCapability: fileFavoriteCapability,
    fileFavoriteLabel: fileFavoriteLabel,
    fileFavoriteItem: fileFavoriteItem,
    matchesFileFavoriteQuery: matchesFileFavoriteQuery,
    emojiUsageId: emojiUsageId,
    emojiSearchText: emojiSearchText,
    emojiCaption: emojiCaption,
    parseEmojiData: parseEmojiData,
    emojiMatchScore: emojiMatchScore,
    compareEmojiRows: compareEmojiRows,
    emojiRows: emojiRows,
    emojiFileList: emojiFileList,
    emojiDataPaths: emojiDataPaths,
    emojiGroupsPaths: emojiGroupsPaths,
    emojiExtraDataPaths: emojiExtraDataPaths,
    concatEmojiData: concatEmojiData,
    parseEmojiGroups: parseEmojiGroups,
    emojiGroupLabels: emojiGroupLabels,
    emojiSections: emojiSections,
    groupThousands: groupThousands,
    trimTrailingZeros: trimTrailingZeros,
    tidyNumber: tidyNumber,
    isCurrencyResult: isCurrencyResult,
    implicitConversionTarget: implicitConversionTarget,
    normalizeCalculationQuery: normalizeCalculationQuery,
    formatCalculationValue: formatCalculationValue,
    calculationExpression: calculationExpression,
    parseClipboardHistory: parseClipboardHistory,
    clipboardRows: clipboardRows,
    clipboardEntryPreview: clipboardEntryPreview,
    clipboardEntryDetail: clipboardEntryDetail,
    clipboardFilePaths: clipboardFilePaths,
    clipboardHistoryPaths: clipboardHistoryPaths,
    clipboardEntryBody: clipboardEntryBody,
    clipboardEntryMetadata: clipboardEntryMetadata,
    fileEscapeAction: fileEscapeAction,
    isHomeOrAncestorPath: isHomeOrAncestorPath,
    displayRow: displayRow,
    footerActionDefinitions: footerActionDefinitions,
    footerActionIdForShortcut: footerActionIdForShortcut,
    selectedPrimaryActionLabel: selectedPrimaryActionLabel,
    actionBarHints: actionBarHints,
    compactActionBarHints: compactActionBarHints
  }
}
