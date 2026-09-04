const fs = require('fs')
const vm = require('vm')
const path = require('path')
const os = require('os')
const childProcess = require('child_process')

function assert(condition, message) {
  if (!condition) throw new Error(message)
  console.log(`ok - ${message}`)
}

const source = fs.readFileSync(path.join(__dirname, '..', 'MenuModel.js'), 'utf8')
const context = { module: { exports: {} } }
vm.runInNewContext(source, context)
const menu = context.module.exports

assert(menu.utf8ByteLength('GitHub') === 6, 'UTF-8 limits count ASCII bytes')
assert(menu.utf8ByteLength('é') === 2, 'UTF-8 limits count multibyte characters')
assert(menu.utf8ByteLength('󰊤') === 4, 'UTF-8 limits count surrogate pairs once')
assert(menu.utf8ByteLength('\ud800') === 3, 'UTF-8 limits count an unpaired surrogate as replacement bytes')

const validMenuSnapshot = menu.parseMenuJsoncSnapshot('{"items":{"root":{"label":"Root"}}}')
assert(validMenuSnapshot.valid && validMenuSnapshot.items.length === 1, 'valid menu snapshots are identified')
assert(menu.parseMenuJsoncSnapshot('{}').valid, 'empty menu objects remain valid snapshots')
assert(!menu.parseMenuJsoncSnapshot('{"items":').valid, 'partial menu JSON is an invalid snapshot')
assert(!menu.parseMenuJsoncSnapshot('').valid, 'empty menu files are invalid snapshots')

const extensions = menu.parseExtensions(JSON.stringify([{
  schemaVersion: 1,
  id: 'pi-agent',
  label: 'Pi Agent',
  prefixes: ['pi'],
  icon: 'pi-icon',
  iconFont: 'omarchy',
  description: 'Start new session',
  command: ['omarchy-launch-terminal', 'pi', '--', '{prompt}']
}]))
assert(extensions.length === 1, 'valid extension manifests are parsed')
assert(menu.parseExtensions('{bad json').length === 0, 'invalid extension manifests are ignored')
assert(menu.parseExtensions('[{"id":"missing-fields"}]').length === 0, 'incomplete extension manifests are ignored')
assert(!menu.safeExtensionPattern('(a+)+$'), 'nested quantified extension regexes are rejected')
assert(!menu.safeExtensionPattern('a'.repeat(257)), 'oversized extension regexes are rejected')
assert(menu.safeExtensionPattern('^\\s*\\d+(?: km)?$'), 'ordinary extension regexes remain accepted')
assert(menu.parseExtensions(JSON.stringify([{
  schemaVersion: 1,
  id: 'unsafe-regex',
  mode: 'query',
  label: 'Unsafe',
  command: ['printf', 'x'],
  match: { all: ['(a+)+$'] }
}])).length === 0, 'extensions with unsafe regexes are ignored')
assert(menu.suggestExtensions(extensions, 'p')[0].prefix === 'pi', 'partial prefixes suggest extensions')
assert(menu.suggestExtensions(extensions, 'PI')[0].prefix === 'pi', 'extension suggestions ignore case')
assert(menu.suggestExtensions(extensions, 'pi explain').length === 0, 'extension suggestions stop after prompt entry begins')
assert(menu.matchExtensions(extensions, 'pi explain this code')[0].prompt === 'explain this code', 'extension prefixes extract prompts')
assert(menu.matchExtensions(extensions, 'PI   fix the tests  ')[0].prompt === 'fix the tests', 'extension matching ignores prefix case and surrounding whitespace')
assert(menu.matchExtensions(extensions, 'pi').length === 0, 'a prefix without a prompt does not match')
assert(menu.matchExtensions(extensions, 'pilot a plane').length === 0, 'extension prefixes must be standalone')
assert(menu.extensionRootActivation(extensions[0]) === 'input' && menu.extensionRootInput(extensions[0]) === '', 'prefix roots enter focused input without exposing the global prefix')
assert(menu.focusedPrefixMatch(extensions[0], ' explain this code ').prompt === 'explain this code', 'focused prefix input produces one trimmed actionable prompt')
assert(menu.focusedPrefixMatch(extensions[0], '   ') === null, 'focused prefix input has a safe non-actionable empty state')
assert(menu.focusedExtensionQuery(extensions[0], 'literal prompt') === 'literal prompt', 'focused prefix prompts are not rewritten as live queries')

const filesExtension = menu.parseExtensions(JSON.stringify([{
  schemaVersion: 1,
  id: 'files',
  capability: 'files',
  mode: 'files',
  label: 'Files',
  prefixes: ['files'],
  root: '~',
  command: ['xdg-open', '{path}'],
  directoryCommand: ['xdg-open', '{path}'],
  terminalCommand: ['xdg-terminal-exec', '--dir={path}'],
  copyCommand: ['wl-copy', '--', '{path}'],
  copyFileCommand: ['copy-file', '{path}']
}]))
assert(filesExtension.length === 1 && filesExtension[0].mode === 'files', 'file browser extensions are parsed')
const partialFilesSuggestion = menu.suggestExtensions(filesExtension, 'fil')[0]
const exactFilesSuggestion = menu.suggestExtensions(filesExtension, 'files')[0]
assert(partialFilesSuggestion.extension.id === 'files', 'file browser extensions appear in prefix suggestions')
assert(menu.extensionSuggestionPriority(partialFilesSuggestion, 'fil') === 20, 'partial extension suggestions receive alias-prefix priority')
assert(menu.extensionSuggestionPriority(exactFilesSuggestion, ' FILES ') === 30, 'exact extension prefixes receive exact-alias priority')
assert(menu.extensionSuggestionPriority({ extension: { available: false }, prefix: 'files' }, 'files') === 0, 'unavailable extension suggestions receive no priority boost')
assert(menu.extensionMatchPriority(filesExtension[0]) === 100, 'explicit available extension invocations receive top priority')
assert(menu.extensionMatchPriority({ available: false }) === 0, 'unavailable extension invocations receive no priority boost')
assert(filesExtension[0].copyCommand[2] === '{path}', 'file browser copy path commands are retained')
assert(filesExtension[0].copyFileCommand[1] === '{path}', 'file browser copy file commands are retained')
assert(filesExtension[0].terminalCommand[1] === '--dir={path}', 'file browser terminal commands are retained')
assert(menu.extensionRootActivation(filesExtension[0]) === 'files', 'Files root activation selects the browser')
assert(menu.isImagePath('/tmp/Photo.JPEG'), 'image paths are recognized case-insensitively')
assert(menu.isImagePath('/tmp/vector.svg'), 'SVG paths are recognized for previews')
assert(!menu.isImagePath('/tmp/photo.jpeg.txt'), 'non-image paths do not get previews')
assert(menu.localFileUrl('/tmp/My photo #1.png') === 'file:///tmp/My%20photo%20%231.png', 'local image URLs encode reserved characters')
assert(menu.localFileUrl('relative.png') === '', 'relative paths are not converted to local file URLs')
const directoryFavorite = menu.fileFavoriteId('/tmp/Projects///', 'directory', 'files')
const fileFavorite = menu.fileFavoriteId('/tmp/Projects/notes.txt', 'file', 'project-files')
assert(directoryFavorite === 'file.favorite:["files","directory","/tmp/Projects"]', 'directory favorite ids use normalized absolute paths')
assert(fileFavorite === 'file.favorite:["project-files","file","/tmp/Projects/notes.txt"]', 'file favorite ids preserve their capability and path type')
assert(menu.fileFavoritePath(directoryFavorite) === '/tmp/Projects', 'directory favorite ids recover their paths')
assert(menu.fileFavoritePath(fileFavorite) === '/tmp/Projects/notes.txt', 'file favorite ids recover their paths')
assert(menu.fileFavoriteType(directoryFavorite) === 'directory', 'directory favorite ids recover their type')
assert(menu.fileFavoriteType(fileFavorite) === 'file', 'file favorite ids recover their type')
assert(menu.fileFavoriteCapability(directoryFavorite) === 'files', 'directory favorite ids recover their capability')
assert(menu.fileFavoriteCapability(fileFavorite) === 'project-files', 'external file-browser favorite ids recover their capability')
assert(menu.legacyFileFavoriteId('/tmp/Legacy/', 'directory') === 'file.favorite.directory:/tmp/Legacy', 'legacy favorite ids can be found for migration')
assert(menu.fileFavoriteCapability('file.favorite.directory:/tmp/Legacy') === 'files', 'legacy path favorites migrate to the Files capability')
const legacyFavorite = menu.fileFavorite('file.favorite.directory:/tmp/Projects')
assert(menu.fileFavoriteId(legacyFavorite.path, legacyFavorite.type, legacyFavorite.capability) === directoryFavorite, 'legacy and current ids share one canonical favorite identity')
assert(menu.fileFavoritePath('app.example') === '', 'non-file-browser favorites do not produce paths')
assert(menu.fileFavoriteId('relative/path', 'file', 'files') === '', 'relative paths cannot become file-browser favorites')
assert(menu.fileFavoriteId('/tmp/notes.txt', 'other', 'files') === '', 'unknown path types cannot become file-browser favorites')
assert(menu.fileFavoriteId('/tmp/notes.txt', 'file', '') === '', 'path favorites require a capability')
assert(menu.fileFavorite('file.favorite:not-json') === null, 'malformed path favorites are ignored')
assert(menu.fileFavoriteLabel('/tmp/Projects/') === 'Projects', 'path favorites use their basename as a label')
assert(menu.fileFavoriteLabel('/') === '/', 'the filesystem root has a useful favorite label')
const favoriteSearchItem = menu.fileFavoriteItem('file.favorite.directory:/home/quantumfire/Downloads')
assert(favoriteSearchItem.id === menu.fileFavoriteId('/home/quantumfire/Downloads', 'directory', 'files'), 'favorite search items canonicalize legacy ids')
assert(favoriteSearchItem.label === 'Downloads' && favoriteSearchItem.action === '/home/quantumfire/Downloads', 'favorite search items retain their label and path action')
assert(menu.matchesFileFavoriteQuery(favoriteSearchItem, menu.prepareSearchQuery('downloads')), 'favorite search items match their visible labels')
assert(menu.matchesFileFavoriteQuery(favoriteSearchItem, menu.prepareSearchQuery('home quantumfire')), 'favorite search items match path-component prefixes')
assert(menu.matchesFileFavoriteQuery(favoriteSearchItem, menu.prepareSearchQuery('home downloads')), 'favorite search terms can match both path components and the visible label')
assert(!menu.matchesFileFavoriteQuery(favoriteSearchItem, menu.prepareSearchQuery('fi')), 'short queries do not match inside shared path components')
assert(!menu.matchesFileFavoriteQuery(favoriteSearchItem, menu.prepareSearchQuery('fire')), 'path matching does not start in the middle of a component')
assert(!menu.matchesFileFavoriteQuery(favoriteSearchItem, menu.prepareSearchQuery('documents')), 'nonmatching file favorites remain hidden from search')
assert(!menu.matchesFileFavoriteQuery(favoriteSearchItem, menu.prepareSearchQuery('files')), 'favorite search ignores the hidden extension capability in canonical ids')
assert(!menu.matchesFileFavoriteQuery(favoriteSearchItem, menu.prepareSearchQuery('directory')), 'favorite search ignores the hidden path type in canonical ids')
const filesPathFavorite = menu.fileFavoriteItem(menu.fileFavoriteId('/home/quantumfire/files/Downloads', 'directory', 'files'))
assert(menu.matchesFileFavoriteQuery(filesPathFavorite, menu.prepareSearchQuery('files')), 'favorite search still matches capability-like words when they occur in the visible path')
assert(menu.fileFavoriteItem('app.example') === null, 'ordinary starred items do not become synthetic file rows')

const queryExtensions = menu.parseExtensions(JSON.stringify([
  {
    schemaVersion: 1,
    id: 'bundled-calculator',
    capability: 'calculator',
    mode: 'query',
    label: 'Calculator',
    command: ['qalc', '{query}'],
    match: { all: ['^\\d'], any: ['[+]'] },
    _bundled: true
  },
  {
    schemaVersion: 1,
    id: 'replacement-calculator',
    capability: 'calculator',
    mode: 'query',
    label: 'Replacement',
    command: ['other-calc', '{query}'],
    match: { all: ['^\\d'], any: ['[+]'] },
    _bundled: false
  }
]))
assert(queryExtensions.length === 1 && queryExtensions[0].id === 'replacement-calculator', 'equal-priority external extensions replace bundled capabilities')
assert(menu.queryExtension(queryExtensions, '2+2').id === 'replacement-calculator', 'query extensions match live input')
assert(Object.prototype.toString.call(queryExtensions[0].matchAllRegex[0]) === '[object RegExp]', 'query extension regular expressions are compiled once')
assert(menu.queryExtension(queryExtensions, 'hello') === null, 'query extensions ignore unrelated input')

const replacementFixture = {
  schemaVersion: 1,
  id: 'fixture-calculator',
  capability: 'calculator',
  mode: 'query',
  label: 'Fixture',
  description: 'Copy calculated result',
  rootDescription: 'Open fixture calculator',
  priority: 10,
  command: ['printf', 'fixture'],
  match: { all: ['^\\d'], any: ['[+]'] },
  _bundled: false
}
const bundledFixture = {
  schemaVersion: 1,
  id: 'bundled-fixture',
  capability: 'calculator',
  mode: 'query',
  label: 'Bundled',
  priority: 10,
  command: ['printf', 'bundled'],
  match: { all: ['^\\d'], any: ['[+]'] },
  _bundled: true
}
assert(menu.parseExtensions(JSON.stringify([bundledFixture, { ...replacementFixture, priority: 9 }]))[0].id === 'bundled-fixture', 'lower-priority external extensions do not replace bundled extensions')
assert(menu.parseExtensions(JSON.stringify([bundledFixture, { ...replacementFixture, priority: 11 }]))[0].id === 'fixture-calculator', 'higher-priority external extensions replace bundled extensions')
assert(menu.parseExtensions(JSON.stringify([bundledFixture]))[0].id === 'bundled-fixture', 'removing a replacement restores the bundled extension')
assert(menu.parseExtensions(JSON.stringify([bundledFixture, { ...replacementFixture, _missingRequires: ['fixture-calc'] }]))[0].id === 'bundled-fixture', 'unavailable replacements fall back to bundled extensions')

const bundledRootId = menu.extensionRootId(bundledFixture)
const replacementRootId = menu.extensionRootId(replacementFixture)
assert(bundledRootId === replacementRootId, 'extension root ids remain stable across capability provider replacement')
assert(menu.extensionRootCapability(bundledRootId) === 'calculator', 'extension root ids recover their capability')
assert(menu.extensionRootCapability('extension.root:not-json') === '', 'malformed extension root ids are ignored')
const replacementRootItem = menu.extensionRootItem(menu.parseExtensions(JSON.stringify([replacementFixture]))[0])
assert(replacementRootItem.id === replacementRootId && replacementRootItem.parent === 'extensions', 'extension roots are children of the fixed Extensions directory')
assert(replacementRootItem.description === 'Open fixture calculator', 'extension roots can describe activation separately from result actions')
assert(menu.extensionRootActivation(menu.parseExtensions(JSON.stringify([replacementFixture]))[0]) === 'input', 'query-only extension roots select focused input')
assert(menu.extensionRootInput(menu.parseExtensions(JSON.stringify([replacementFixture]))[0]) === '', 'query-only extension roots start with empty functional input')
assert(replacementRootItem.aliases.includes('calculator') && replacementRootItem.aliases.includes('fixture-calculator'), 'extension roots are globally searchable by stable capability and provider id')
assert(menu.matchesQuery(replacementRootItem, menu.prepareSearchQuery('calculator'), true), 'extension roots participate in global search')
const unavailableRootExtension = menu.parseExtensions(JSON.stringify([{ ...replacementFixture, _missingRequires: ['fixture-calc'] }]))[0]
const unavailableRootItem = menu.extensionRootItem(unavailableRootExtension)
assert(unavailableRootItem.description === 'Missing dependency: fixture-calc', 'unavailable extension roots remain visible with dependency detail')
assert(menu.extensionRootActivation(unavailableRootExtension) === '', 'unavailable extension roots cannot dispatch an activation')
const sortedExtensionRoots = menu.sortExtensionRootRows([
  { itemId: 'timezone', label: 'Timezone', starred: false },
  { itemId: 'currency', label: 'Currency conversion', starred: false },
  { itemId: 'files', label: 'Files', starred: true },
  { itemId: 'calculator', label: 'Calculator', starred: true }
])
assert(sortedExtensionRoots.map(row => row.itemId).join(',') === 'calculator,files,currency,timezone', 'Extensions rows sort starred first and alphabetically within each group')

const bundledExtensions = menu.parseExtensions(JSON.stringify([
  { ...JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extensions', 'calculator', 'extension.json'), 'utf8')), _bundled: true },
  { ...JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extensions', 'currency', 'extension.json'), 'utf8')), _bundled: true }
]))
assert(menu.queryExtension(bundledExtensions, '2 + 2').capability === 'calculator', 'bundled calculator matches arithmetic')
assert(menu.queryExtension(bundledExtensions, '(2 + 2) * 3').capability === 'calculator', 'bundled calculator matches expressions beginning with parentheses')
assert(menu.queryExtension(bundledExtensions, '(-1 + 1) * 2').capability === 'calculator', 'bundled calculator matches unary signs inside opening parentheses')
assert(menu.queryExtension(bundledExtensions, '10 USD to CAD').capability === 'currency', 'bundled currency extension outranks general conversions')
assert(menu.queryExtension(bundledExtensions, 'hello') === null, 'bundled extensions ignore ordinary searches')
const calculatorResult = bundledExtensions.find(extension => extension.capability === 'calculator')
assert(menu.extensionQueryRunIsCurrent(4, 4, '2 + 2', '2 + 2', calculatorResult.id, calculatorResult, false, true),
  'only a current open live-query run may publish output')
assert(!menu.extensionQueryRunIsCurrent(3, 4, '2 + 2', '2 + 2', calculatorResult.id, calculatorResult, false, true)
  && !menu.extensionQueryRunIsCurrent(4, 4, '2 + 1', '2 + 2', calculatorResult.id, calculatorResult, false, true)
  && !menu.extensionQueryRunIsCurrent(4, 4, '2 + 2', '2 + 2', calculatorResult.id, calculatorResult, true, true)
  && !menu.extensionQueryRunIsCurrent(4, 4, '2 + 2', '2 + 2', calculatorResult.id, calculatorResult, false, false),
  'stale, replaced, stopping, and closed live-query runs cannot publish output')

const timezoneExtension = menu.parseExtensions(JSON.stringify([{
  ...JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extensions', 'timezone', 'extension.json'), 'utf8')),
  _bundled: true,
  _sourceDir: '/tmp/timezone'
}]))
assert(menu.suggestExtensions(timezoneExtension, 'tim')[0].prefix === 'time', 'live query extensions can suggest prefixes')
assert(menu.queryExtension(timezoneExtension, 'time seattle').capability === 'timezone', 'timezone extension matches explicit time queries')
assert(menu.queryExtension(timezoneExtension, 'timer') === null, 'timezone extension ignores unrelated searches')
assert(timezoneExtension[0].sourceDir === '/tmp/timezone', 'extension source directories are retained for bundled scripts')
assert(menu.extensionRootActivation(timezoneExtension[0]) === 'input' && menu.extensionRootInput(timezoneExtension[0]) === '', 'Timezone root activation starts with a clean focused input')
assert(menu.focusedExtensionQuery(timezoneExtension[0], '') === 'time', 'focused Timezone input applies its hidden prefix')
assert(menu.focusedExtensionQuery(timezoneExtension[0], 'seattle') === 'time seattle', 'focused Timezone queries apply the hidden prefix')
assert(menu.focusedExtensionQuery(timezoneExtension[0], 'time seattle') === 'time seattle', 'focused Timezone queries do not duplicate an explicit prefix')

const workflowExtensions = menu.parseExtensions(JSON.stringify([{
  schemaVersion: 1,
  id: 'codex-agent',
  capability: 'codex-agent',
  mode: 'workflow',
  label: 'Codex',
  prefixes: ['codex'],
  command: [],
  workflow: {
    items: [{
      id: 'projects', kind: 'menu', label: 'Projects', items: [
        {
          id: 'saved', kind: 'menu', label: 'Saved', context: { path: '/tmp/Saved Project' }, items: [
            {
              id: 'session', kind: 'input', label: 'New Session', prompt: 'Prompt', allowEmpty: true,
              command: ['xdg-terminal-exec', '--dir={path}', '--', 'codex', '{input}'],
              emptyCommand: ['xdg-terminal-exec', '--dir={path}', '--', 'codex']
            }
          ]
        },
        {
          id: 'add', kind: 'directoryPicker', label: 'Add Project…', next: {
            id: 'name', kind: 'input', label: 'Name project', default: '{basename}', maxLength: 120,
            command: ['helper', 'add', '{path}', '{input}'],
            next: { id: 'selected', kind: 'menu', label: '{input}', items: [] }
          }
        }
      ]
    }]
  }
}]))
const dynamicMenuExtensions = menu.parseExtensions(JSON.stringify([{
  schemaVersion: 1, id: 'quicklinks', capability: 'quicklinks', mode: 'menu', label: 'Quicklinks',
  prefixes: ['links'], command: ['{extensionDir}/bin/menu', '--json'], globalSearch: true,
  globalSearchCommand: ['{extensionDir}/bin/menu', '--global-search']
}, {
  schemaVersion: 1, id: 'private-menu', mode: 'menu', label: 'Private', prefixes: ['private'], command: ['private-menu']
}]))
assert(dynamicMenuExtensions.length === 2 && dynamicMenuExtensions[0].command[0] === '{extensionDir}/bin/menu', 'dynamic menu provider extensions are parsed')
assert(dynamicMenuExtensions[0].globalSearch && !dynamicMenuExtensions[1].globalSearch, 'dynamic menu global search is explicit opt-in')
assert(dynamicMenuExtensions[0].globalSearchCommand[1] === '--global-search', 'dynamic menus retain a separate global search command')
assert(menu.normalizeExtension({ schemaVersion: 1, id: 'bad-search-command', mode: 'menu', label: 'Bad', prefixes: ['bad'], command: ['menu'], globalSearch: true, globalSearchCommand: 'search' }) === null, 'global search commands must be argument arrays')
assert(menu.normalizeExtension({ schemaVersion: 1, id: 'disabled-search-command', mode: 'menu', label: 'Bad', prefixes: ['bad'], command: ['menu'], globalSearchCommand: ['search'] }) === null, 'separate search commands require global search opt-in')
assert(menu.normalizeExtension({ schemaVersion: 1, id: 'wrong-mode-search-command', mode: 'prefix', label: 'Bad', prefixes: ['bad'], command: ['run'], globalSearchCommand: ['search'] }) === null, 'separate search commands are limited to menu extensions')
assert(menu.extensionRootActivation(dynamicMenuExtensions[0]) === 'menu', 'dynamic menu roots start their provider')
const dynamicMenu = menu.normalizeDynamicMenuOutput(JSON.stringify({ items: [
  { id: 'open', label: 'Open docs', description: 'Documentation', aliases: ['manual', 'reference'], starred: true, starAction: 'star', command: ['xdg-open', 'https://example.test'], closeOnSuccess: true, actions: [
    { id: 'star', label: 'Unstar', command: ['links', 'star', 'open', 'false'] },
    { id: 'open', label: 'Open', command: ['xdg-open', 'https://example.test'], closeOnSuccess: true },
    { id: 'delete', label: 'Delete', confirm: 'Delete this link?', confirmLabel: 'Delete', command: ['links', 'delete', 'open'], refreshExtensions: true }
  ] },
  { id: 'add', label: 'Add Quicklink', input: { prompt: 'URL', maxLength: 200, command: ['links', 'add', '{input}'] } }
] }))
assert(dynamicMenu && dynamicMenu.items.length === 2, 'bounded dynamic menu output is normalized')
assert(dynamicMenu.items[0].kind === 'action' && dynamicMenu.items[0].actions[2].kind === 'confirm', 'rows retain direct actions and contextual confirmations')
assert(dynamicMenu.items[0].closeOnSuccess, 'launch rows can request launcher closure after successful dispatch')
assert(dynamicMenu.items[0].starred, 'dynamic rows retain explicit starred state')
assert(dynamicMenu.items[0].starAction === 'star', 'dynamic rows can identify a direct Ctrl+S star action')
const dynamicSearchItems = menu.dynamicMenuSearchItems(dynamicMenuExtensions[0], dynamicMenu)
assert(dynamicSearchItems.length === 2 && dynamicSearchItems[0].aliases.join(',') === 'manual,reference', 'search rows retain bounded provider aliases')
assert(menu.matchesQuery(dynamicSearchItems[0], menu.prepareSearchQuery('documentation'), true), 'dynamic menu rows search descriptions')
assert(menu.matchesQuery(dynamicSearchItems[0], menu.prepareSearchQuery('reference'), true), 'dynamic menu rows search aliases')
assert(!menu.matchesQuery(dynamicSearchItems[0], menu.prepareSearchQuery('quicklinks'), true), 'dynamic routing identities do not leak provider capabilities into search')
assert(menu.matchesQuery(dynamicSearchItems[1], menu.prepareSearchQuery('quicklink'), true), 'dynamic rows still match provider words in visible labels')
assert(menu.dynamicMenuSearchIdentity(dynamicSearchItems[0].id).capability === 'quicklinks', 'dynamic search identities retain stable extension capability')
assert(menu.dynamicMenuItemId('quicklinks', 'open') === dynamicSearchItems[0].id, 'dynamic usage uses the stable synthetic search identity')
const quicklinksUsageId = menu.dynamicMenuItemId(dynamicMenuExtensions[0].id, dynamicMenu.items[0].id)
assert(menu.dynamicMenuUsageItemId(dynamicMenuExtensions[0], dynamicMenu.items[0]) === quicklinksUsageId, 'provider-menu primary launches map to a provider-owned usage identity')
assert(menu.dynamicMenuUsageItemId(dynamicMenuExtensions[0], dynamicMenu.items[0].actions.find(action => action.id === 'open')) === quicklinksUsageId, 'contextual Open maps to its primary provider-owned usage identity')
assert(menu.dynamicMenuUsageItemId(dynamicMenuExtensions[0], dynamicMenu.items[0].actions.find(action => action.id === 'star')) === '', 'contextual mutations do not publish usage')
assert(menu.dynamicMenuUsageItemId(dynamicMenuExtensions[0], dynamicMenu.items[0].actions.find(action => action.id === 'delete')) === '', 'unrelated confirmations do not publish usage')
assert(menu.dynamicMenuUsageItemId(dynamicMenuExtensions[0], dynamicMenu.items[1]) === '', 'Add and other non-launch mutations do not publish usage')
assert(menu.dynamicMenuUsageItemId({ ...dynamicMenuExtensions[0], id: 'omalaunch.quicklinks', config: { rankByUsage: false } }, dynamicMenu.items[0]) === '', 'bundled Quicklinks can disable usage ranking')
assert(menu.dynamicMenuUsageItemId({ ...dynamicMenuExtensions[0], id: 'replacement.quicklinks', config: { rankByUsage: false } }, dynamicMenu.items[0]) === menu.dynamicMenuItemId('replacement.quicklinks', 'open'), 'bundled Quicklinks configuration does not control replacement providers or leak usage identity')
assert(menu.dynamicMenuUsageItemId({ ...dynamicMenuExtensions[0], id: 'omalaunch.web-search', config: { rankByUsage: false } }, dynamicMenu.items[0]) === '', 'bundled Web Search can disable usage ranking for all engines')
assert(menu.dynamicMenuSearchIdentity('extension.menu:not-json') === null, 'malformed dynamic search identities are rejected')
assert(dynamicMenu.items[0].actions[2].refreshExtensions, 'mutation actions can request an extension refresh')
assert(dynamicMenu.items[1].kind === 'input' && dynamicMenu.items[1].prompt === 'URL', 'rows can open bounded host input forms')
assert(menu.workflowCommand(dynamicMenu.items[1], 'https://literal.test/?q=$(bad)', {}).slice(-1)[0] === 'https://literal.test/?q=$(bad)', 'dynamic input is substituted as one literal argument')
const scopedSearch = menu.normalizeDynamicMenuOutput([
  { id: 'global', label: 'Google', starredLabel: 'Web · Google', globalSearch: true, trailingIcon: 'globe', trailingText: '⌘ G', badge: '12', badgeTone: 'success', command: ['search', 'google'] },
  { id: 'menu-only', label: 'Bing', globalSearch: false, command: ['search', 'bing'] }
])
assert(menu.dynamicMenuSearchItems(dynamicMenuExtensions[0], scopedSearch).length === 1, 'dynamic rows can remain in their extension menu without entering global search')
assert(menu.dynamicMenuSearchItems(dynamicMenuExtensions[0], scopedSearch)[0].trailingIcon === 'globe', 'dynamic rows retain bounded trailing icons')
assert(menu.dynamicMenuSearchItems(dynamicMenuExtensions[0], scopedSearch)[0].trailingText === '⌘ G', 'dynamic search rows retain bounded trailing text')
assert(menu.displayRow({}, [], {}, scopedSearch.items[0], '', 0, '').trailingText === '⌘ G', 'display rows retain bounded trailing text')
assert(menu.normalizeDynamicMenuOutput([{ id: 'long-trailing', label: 'Long', trailingText: 'x'.repeat(65), command: ['true'] }]).items[0].trailingText === '', 'oversized dynamic row trailing text is omitted')
assert(menu.normalizeItem('bounded', { trailingText: 'x'.repeat(65) }).trailingText.length === 64, 'normalized row trailing text is bounded to 64 characters')
assert(menu.dynamicMenuSearchItems(dynamicMenuExtensions[0], scopedSearch)[0].badge === '12', 'dynamic rows retain bounded badges')
assert(menu.dynamicMenuSearchItems(dynamicMenuExtensions[0], scopedSearch)[0].badgeTone === 'success', 'dynamic rows retain semantic badge tones')
assert(menu.dynamicMenuSearchItems(dynamicMenuExtensions[0], scopedSearch)[0].label === 'Google', 'unstarred dynamic rows retain their menu label')
scopedSearch.items[0].starred = true
assert(menu.dynamicMenuSearchItems(dynamicMenuExtensions[0], scopedSearch)[0].label === 'Web · Google', 'starred dynamic rows use their distinct top-level label')
scopedSearch.items[0].starred = false
assert(menu.normalizeDynamicMenuOutput([{ id: 'badge', label: 'Badge', badge: 'x'.repeat(17), command: ['true'] }]).items[0].badge === '', 'oversized dynamic row badges are omitted')
const separateGlobalSearchMenu = menu.normalizeDynamicMenuOutput({
  items: [{ id: 'visible', label: 'Visible only', command: ['open-visible'] }],
  globalSearchItems: [{ id: 'search', label: 'Search only', aliases: ['dedicated'], command: ['open-search'] }]
})
assert(separateGlobalSearchMenu.items.length === 1 && separateGlobalSearchMenu.items[0].id === 'visible',
  'dedicated global search rows do not change the visible dynamic menu collection')
const separateGlobalSearchItems = menu.dynamicMenuSearchItems(dynamicMenuExtensions[0], separateGlobalSearchMenu)
assert(separateGlobalSearchItems.length === 1 && separateGlobalSearchItems[0].label === 'Search only'
  && separateGlobalSearchItems[0].aliases[0] === 'dedicated',
  'dedicated global search rows replace visible rows as the dynamic search source')
assert(menu.dynamicMenuSearchNodes(separateGlobalSearchMenu)[0].command[0] === 'open-search',
  'dedicated global search actions use the dedicated source nodes')
const emptyGlobalSearchMenu = menu.normalizeDynamicMenuOutput({
  items: [{ id: 'visible', label: 'Visible only', command: ['true'] }], globalSearchItems: []
})
assert(emptyGlobalSearchMenu && menu.dynamicMenuSearchItems(dynamicMenuExtensions[0], emptyGlobalSearchMenu).length === 0,
  'an explicit empty global search collection disables dynamic search rows')
const legacyObjectMenu = menu.normalizeDynamicMenuOutput({ items: [
  { id: 'legacy-object', label: 'Legacy object', command: ['true'] }
] })
assert(menu.dynamicMenuSearchItems(dynamicMenuExtensions[0], legacyObjectMenu)[0].label === 'Legacy object',
  'object responses without global search rows preserve visible-row search behavior')
assert(menu.dynamicMenuSearchItems(dynamicMenuExtensions[0], scopedSearch)[0].label === 'Google',
  'array responses preserve visible-row search behavior')
assert(menu.normalizeDynamicMenuOutput({
  items: [{ id: 'visible', label: 'Visible', command: ['true'] }], globalSearchItems: {}
}) === null, 'malformed dedicated global search collections are rejected')
assert(menu.normalizeDynamicMenuOutput({
  items: [{ id: 'visible', label: 'Visible', command: ['true'] }],
  globalSearchItems: [{ id: 'same', label: 'One', command: ['true'] }, { id: 'same', label: 'Two', command: ['true'] }]
}) === null, 'dedicated global search row ids must be unique within their collection')
assert(menu.normalizeDynamicMenuOutput({
  items: [{ id: 'shared', label: 'Visible', command: ['true'] }],
  globalSearchItems: [{ id: 'shared', label: 'Search', command: ['true'] }]
}) !== null, 'visible and dedicated global search collections normalize ids independently')
assert(menu.normalizeDynamicMenuOutput({
  items: [{ id: 'visible', label: 'Visible', command: ['true'] }],
  globalSearchItems: Array.from({ length: 101 }, (_, i) => ({ id: String(i), label: String(i), command: ['true'] }))
}) === null, 'dedicated global search row counts are independently bounded')
assert(menu.normalizeDynamicMenuOutput({
  items: Array.from({ length: 101 }, (_, i) => ({ id: String(i), label: String(i), command: ['true'] })),
  globalSearchItems: [{ id: 'search', label: 'Search', command: ['true'] }]
}) === null, 'visible dynamic menu row counts remain independently bounded')
assert(menu.normalizeDynamicMenuOutput({
  items: [{ id: 'visible', label: 'Visible', command: ['true'] }],
  globalSearchItems: [{ id: 'bad', label: 'Bad', command: 'true' }]
}) === null, 'dedicated global search rows use strict row normalization')
const capturedMenu = menu.normalizeDynamicMenuOutput([{ id: 'add', label: 'Add', input: {
  prompt: 'Target', capture: 'target', next: { id: 'name', kind: 'input', label: 'Name', command: ['links', 'add', '{target}', '{input}'] }
} }])
const capturedTransition = menu.workflowInputTransition(capturedMenu.items[0], 'https://example.test', {})
assert(capturedTransition.context.target === 'https://example.test' && capturedTransition.node.id === 'name', 'input capture passes a named literal value to the next host input without persistent draft state')
assert(menu.normalizeDynamicMenuOutput([{ id: 'bad-capture', label: 'Bad', input: { prompt: 'Bad', capture: '__proto__', command: ['true'] } }]) === null, 'input capture names reject unsafe structural keys')
assert(menu.normalizeDynamicMenuOutput('{bad') === null, 'malformed dynamic menu output is rejected')
assert(menu.normalizeDynamicMenuOutput({ items: Array.from({ length: 101 }, (_, i) => ({ id: String(i), label: String(i), command: ['true'] })) }) === null, 'dynamic menu row counts are bounded')
assert(menu.normalizeDynamicMenuOutput([{ id: 'bad', label: 'Bad', command: 'true' }]) === null, 'dynamic menu commands must be argument arrays')
assert(menu.normalizeDynamicMenuOutput([{ id: 'same', label: 'One', command: ['true'] }, { id: 'same', label: 'Two', command: ['true'] }]) === null, 'dynamic menu row ids are unique')
const documentMenu = menu.normalizeDynamicMenuOutput([{ id: 'inspect', label: 'Inspect', document: {
  command: ['helper', 'detail', '--cached'], refreshCommand: ['helper', 'detail', '--refresh']
} }])
assert(documentMenu && documentMenu.items[0].kind === 'action'
  && documentMenu.items[0].command.length === 0
  && documentMenu.items[0].documentCommand.join(',') === 'helper,detail,--cached'
  && documentMenu.items[0].documentRefreshCommand.join(',') === 'helper,detail,--refresh',
'dynamic action rows can request a document without a primary command')
assert(menu.normalizeDynamicMenuOutput([{ id: 'bad-document', label: 'Bad', document: { command: 'helper detail' } }]) === null,
'dynamic document commands must be argument arrays')
assert(menu.normalizeDynamicMenuOutput([{ id: 'bad-document-extra', label: 'Bad', document: { command: ['true'], format: 'html' } }]) === null,
'dynamic document requests reject unsupported fields')
assert(menu.normalizeDynamicMenuOutput([{ id: 'bad-document-command', label: 'Bad', document: { command: Array(33).fill('x') } }]) === null,
'dynamic document commands have a bounded argument count')
const submenuMenu = menu.normalizeDynamicMenuOutput([{
  id: 'projects', label: 'Projects', submenu: {
    command: ['helper', 'projects', '--cached'], refreshCommand: ['helper', 'projects', '--refresh']
  }
}])
assert(submenuMenu && submenuMenu.items[0].kind === 'action'
  && submenuMenu.items[0].command.length === 0
  && submenuMenu.items[0].submenuCommand.join(',') === 'helper,projects,--cached'
  && submenuMenu.items[0].submenuRefreshCommand.join(',') === 'helper,projects,--refresh',
'dynamic action rows can request an on-demand submenu without a primary command')
const nestedSubmenu = menu.normalizeDynamicMenuOutput(JSON.stringify({ items: [
  { id: 'open', label: 'Open project', command: ['xdg-open', '/tmp/project'] },
  { id: 'recent', label: 'Recent', submenu: { command: ['helper', 'recent'] } }
] }))
assert(nestedSubmenu && nestedSubmenu.items.length === 2
  && nestedSubmenu.items[1].submenuCommand.join(',') === 'helper,recent',
'submenu provider output uses the same dynamic menu normalization recursively')
assert(menu.normalizeDynamicMenuOutput([{ id: 'bad-submenu', label: 'Bad', submenu: ['helper'] }]) === null,
'dynamic submenu requests must be strict command objects')
assert(menu.normalizeDynamicMenuOutput([{ id: 'bad-submenu-extra', label: 'Bad', submenu: { command: ['true'], format: 'menu' } }]) === null,
'dynamic submenu requests reject unsupported fields')
assert(menu.normalizeDynamicMenuOutput([{ id: 'bad-submenu-empty', label: 'Bad', submenu: { command: [] } }]) === null,
'dynamic submenu commands require at least one argument')
assert(menu.normalizeDynamicMenuOutput([{ id: 'bad-submenu-argument', label: 'Bad', submenu: { command: ['helper', ''] } }]) === null,
'dynamic submenu command arguments must be nonempty strings')
assert(menu.normalizeDynamicMenuOutput([{ id: 'bad-submenu-command', label: 'Bad', submenu: { command: Array(33).fill('x') } }]) === null,
'dynamic submenu commands have a bounded argument count')
assert(menu.normalizeDynamicMenuOutput([{
  id: 'ambiguous', label: 'Ambiguous', document: { command: ['detail'] }, submenu: { command: ['children'] }
}]) === null, 'dynamic rows cannot declare both a document and a submenu')

const detailDocument = menu.normalizeDetailDocument({
  title: 'Build report', subtitle: 'main', status: 'Ready', icon: 'repo', iconFont: 'icons',
  stats: [{ label: 'Stars', value: '12', icon: 'star' }],
  fields: [{ label: 'Commit', value: '<b>literal</b>' }],
  sections: [
    { heading: 'Summary', text: 'No rich text is evaluated.' },
    { heading: 'Notes', text: '**Markdown** is host rendered.', format: 'markdown' }
  ],
  actions: [
    { id: 'copy', label: 'Copy', command: ['wl-copy', '--', '<b>literal</b>'] },
    { id: 'remove', label: 'Remove', confirm: 'Remove it?', command: ['helper', 'remove'] },
    { id: 'rename', label: 'Rename', input: { prompt: 'Name', command: ['helper', 'rename', '{input}'] } }
  ]
})
assert(detailDocument && detailDocument.title === 'Build report'
  && detailDocument.icon === 'repo' && detailDocument.stats[0].value === '12'
  && detailDocument.fields[0].value === '<b>literal</b>'
  && detailDocument.sections[0].format === 'plain'
  && detailDocument.sections[1].format === 'markdown'
  && detailDocument.actions.map(action => action.kind).join(',') === 'action,confirm,input',
'structured detail documents retain bounded plain text and host-normalized actions')
assert(menu.normalizeDetailDocument({ subtitle: 'Missing title' }) === null, 'detail documents require a title')
assert(menu.normalizeDetailDocument({ title: 'Report', stats: Array.from({ length: 7 }, (_, i) => ({ label: String(i), value: '1' })) }) === null,
'detail document statistic counts are bounded')
assert(menu.normalizeDetailDocument({ title: 'Report', stats: [{ label: 'Stars', value: '1', html: '<b>1</b>' }] }) === null,
'detail document statistics reject unsupported fields')
assert(menu.normalizeDetailDocument({ title: 'Report', fields: Array.from({ length: 33 }, (_, i) => ({ label: String(i), value: 'x' })) }) === null,
'detail document field counts are bounded')
assert(menu.normalizeDetailDocument({ title: 'Report', sections: Array.from({ length: 17 }, (_, i) => ({ heading: String(i), text: 'x' })) }) === null,
'detail document section counts are bounded')
assert(menu.normalizeDetailDocument({ title: 'Report', sections: [{ heading: 'Bad', text: 'x', format: 'html' }] }) === null,
'detail document sections reject unsupported formats')
assert(menu.normalizeDetailDocument({ title: 'Report', sections: [{ heading: 'Bad', text: 'x', format: 1 }] }) === null,
'detail document section formats must be plain or markdown strings')
assert(menu.normalizeDetailDocument({ title: 'Report', actions: Array.from({ length: 17 }, (_, i) => ({ id: String(i), label: String(i), command: ['true'] })) }) === null,
'detail document action counts are bounded')
assert(menu.normalizeDetailDocument({ title: 'Report', sections: [
  { heading: 'One', text: 'x'.repeat(32768) }, { heading: 'Two', text: 'x'.repeat(32768) }
] }) === null, 'detail documents have a 64 KiB aggregate text limit')
assert(menu.normalizeDetailDocument({ title: 'Report', sections: [
  { heading: 'Unicode', text: '界'.repeat(32768) }
] }) === null, 'detail document aggregate limits count UTF-8 bytes')
assert(menu.normalizeDetailDocument({ title: 'Report', format: 'html' }) === null,
'detail documents reject unsupported rich-content fields')

assert(workflowExtensions.length === 1 && workflowExtensions[0].mode === 'workflow', 'workflow extension menus are parsed')
assert(menu.extensionRootActivation(workflowExtensions[0]) === 'workflow', 'workflow extension roots enter their host-rendered workflow')
const addExtension = menu.parseExtensions(JSON.stringify({
  ...JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extensions', 'add', 'extension.json'), 'utf8')),
  _bundled: true,
  _sourceDir: path.join(__dirname, '..', 'extensions', 'add')
}))
assert(addExtension.length === 1 && addExtension[0].workflow.items.length === 1
  && addExtension[0].workflow.items[0].kind === 'input'
  && addExtension[0].workflow.items[0].closeOnDispatch === true,
'bundled Add extension exposes its detached agent creation workflow')
const projectsNode = workflowExtensions[0].workflow.items[0]
assert(projectsNode.label === 'Projects' && projectsNode.items.length === 2, 'workflow navigation data retains Projects and Add Project stages')
const directoryTransition = menu.workflowDirectoryTransition(projectsNode.items[1], '/tmp/Saved Project/', {})
assert(directoryTransition.node.id === 'name' && directoryTransition.context.path === '/tmp/Saved Project' && directoryTransition.context.basename === 'Saved Project', 'directory selection transitions to naming with a basename default context')
assert(menu.workflowInterpolate(directoryTransition.node.defaultValue, directoryTransition.context) === 'Saved Project', 'project naming defaults to the selected directory basename')
assert(menu.workflowInitialInput(directoryTransition.node, directoryTransition.context) === 'Saved Project', 'workflow defaults are prepared through the bounded initial-input path')
const sessionNode = projectsNode.items[0].items[0]
assert(menu.workflowCommand(sessionNode, '', { path: '/tmp/Saved Project' }).join('\0') === ['xdg-terminal-exec', '--dir=/tmp/Saved Project', '--', 'codex'].join('\0'), 'empty prompts launch blank interactive Codex without an empty argument')
const hostilePrompt = 'fix $(touch /tmp/nope); echo owned'
const promptedCommand = menu.workflowCommand(sessionNode, hostilePrompt, { path: '/tmp/Saved Project' })
assert(promptedCommand.length === 5 && promptedCommand[4] === hostilePrompt, 'nonempty prompts remain one literal command argument')
assert(menu.workflowInputTransition(sessionNode, '', { path: '/tmp/Saved Project' }).context.input === '', 'empty workflow input is accepted when declared')
assert(menu.workflowClosesOnDispatch(sessionNode, promptedCommand), 'terminal workflow leaf commands close immediately after dispatch')
assert(menu.workflowClosesOnDispatch(sessionNode, ['/usr/bin/omarchy-launch-terminal', 'codex']), 'terminal workflow detection accepts absolute launcher paths')
assert(!menu.workflowClosesOnDispatch({ ...sessionNode, next: { id: 'next', kind: 'menu', label: 'Next', items: [] } }, promptedCommand), 'workflow commands with a next stage stay open')
assert(!menu.workflowClosesOnDispatch(sessionNode, ['helper', 'save']), 'non-terminal workflow commands wait for successful completion')
assert(menu.workflowClosesOnDispatch({ ...sessionNode, closeOnDispatch: true }, ['helper', 'launch']), 'explicit detached launch commands close immediately after dispatch')
assert(!menu.workflowClosesOnDispatch({ ...sessionNode, allowEmpty: false }, []), 'pre-dispatch validation failures do not request closure')
const backgroundStar = dynamicMenu.items[0].actions[0]
assert(menu.workflowBackgroundEligible(backgroundStar, menu.workflowCommand(backgroundStar, '', {})), 'non-interactive action leaves are eligible for the background runner')
assert(!menu.workflowBackgroundEligible(dynamicMenu.items[0].actions[2], menu.workflowCommand(dynamicMenu.items[0].actions[2], '', {})), 'confirmation actions remain on the staged foreground path')
assert(!menu.workflowBackgroundEligible(dynamicMenu.items[1], menu.workflowCommand(dynamicMenu.items[1], 'value', {})), 'input actions remain on the staged foreground path')
assert(!menu.workflowBackgroundEligible({ ...backgroundStar, next: { id: 'next' } }, ['true']), 'actions with a next stage remain on the foreground path')
assert(menu.backgroundActionIsCurrent(3, 3, 'quicklinks', dynamicMenuExtensions[0]), 'current dynamic-provider background actions can publish completion')
assert(!menu.backgroundActionIsCurrent(2, 3, 'quicklinks', dynamicMenuExtensions[0])
  && !menu.backgroundActionIsCurrent(3, 3, 'other', dynamicMenuExtensions[0]), 'stale and provider-mismatched background actions cannot publish completion')
assert(menu.normalizeWorkflow({ items: [{ id: 'bad', kind: 'directoryPicker', label: 'Bad' }] }) === null, 'directory picker stages require a declared next transition')
assert(menu.normalizeWorkflow({ items: [
  { id: 'duplicate', kind: 'menu', label: 'First', items: [] },
  { id: 'duplicate', kind: 'input', label: 'Second', command: ['true'] }
] }) === null, 'duplicate sibling workflow ids are rejected even when kinds differ')
assert(menu.normalizeWorkflow({ items: [{ id: 'parent', kind: 'menu', label: 'Parent', items: [
  { id: 'duplicate', kind: 'menu', label: 'First', items: [] },
  { id: 'duplicate', kind: 'menu', label: 'Second', items: [] }
] }] }) === null, 'duplicate nested sibling workflow ids are rejected')
assert(menu.normalizeWorkflow({ items: [{ id: 'huge', kind: 'input', label: 'Huge', maxLength: 1e400, command: ['true'] }] }) === null, 'non-finite workflow numeric fields are rejected')
const truncatedWorkflow = menu.normalizeWorkflow({ items: [{
  id: 'short', kind: 'input', label: 'Short', default: 'abcdefgh', maxLength: 4,
  command: ['printf', '{input}']
}] })
assert(menu.workflowInitialInput(truncatedWorkflow.items[0], {}) === 'abcd', 'workflow defaults are truncated to maxLength before the first submit')
assert(menu.workflowCommand(truncatedWorkflow.items[0], menu.workflowInitialInput(truncatedWorkflow.items[0], {}), {})[1] === 'abcd', 'initial-submit commands receive only the bounded default')
let eightLevelNode = { id: 'level7', kind: 'menu', label: 'Level 7', items: [] }
for (let level = 6; level >= 0; level--) eightLevelNode = { id: `level${level}`, kind: 'menu', label: `Level ${level}`, items: [eightLevelNode] }
assert(menu.normalizeWorkflow({ items: [eightLevelNode] }) !== null, 'workflow trees accept exactly eight documented levels')
eightLevelNode.items[0].items[0].items[0].items[0].items[0].items[0].items[0].items.push({ id: 'level8', kind: 'menu', label: 'Level 8', items: [] })
assert(menu.normalizeWorkflow({ items: [eightLevelNode] }) === null, 'workflow trees reject a ninth level')
const oldProjects = JSON.parse(JSON.stringify(projectsNode))
const oldSaved = oldProjects.items[0]
const oldRoot = { id: 'root', kind: 'menu', items: [oldProjects] }
const reboundWorkflow = menu.rebindWorkflow(workflowExtensions[0], [{ node: oldRoot, context: {} }, { node: oldProjects, context: {} }], oldSaved)
assert(reboundWorkflow && reboundWorkflow.node === workflowExtensions[0].workflow.items[0].items[0], 'catalog refresh rebinds active workflow paths to fresh node objects')
const changedKindExtension = JSON.parse(JSON.stringify(workflowExtensions[0]))
changedKindExtension.workflow.items[0].items[0].kind = 'input'
changedKindExtension.workflow.items[0].items[0].command = ['true']
assert(menu.rebindWorkflow(changedKindExtension, [{ node: oldRoot, context: {} }, { node: oldProjects, context: {} }], oldSaved) === null, 'menu to input kind changes invalidate workflow refresh state')
const oldPicker = JSON.parse(JSON.stringify(projectsNode.items[1]))
const pickerRoot = { id: 'root', kind: 'menu', items: [oldPicker] }
const changedPickerExtension = JSON.parse(JSON.stringify(workflowExtensions[0]))
changedPickerExtension.workflow.items = [{ id: 'add', kind: 'menu', label: 'Now menu', items: [] }]
assert(menu.rebindWorkflow(changedPickerExtension, [{ node: pickerRoot, context: {} }], oldPicker) === null, 'directory picker to menu changes invalidate file-picker state')
const oldInput = JSON.parse(JSON.stringify(sessionNode))
const inputRoot = { id: 'root', kind: 'menu', items: [oldInput] }
const changedCommandExtension = JSON.parse(JSON.stringify(workflowExtensions[0]))
changedCommandExtension.workflow.items = [JSON.parse(JSON.stringify(oldInput))]
changedCommandExtension.workflow.items[0].command = ['helper', 'changed']
assert(menu.rebindWorkflow(changedCommandExtension, [{ node: inputRoot, context: {} }], oldInput) === null, 'changed active command stages cannot acquire refreshed behavior')
assert(menu.rebindWorkflow({ ...workflowExtensions[0], available: false }, [], oldRoot) === null, 'unavailable refreshed workflows cannot retain active state')
assert(menu.workflowActionIsCurrent(7, 7, true, 'codex-agent', workflowExtensions[0]), 'current workflow action generations may transition')
assert(!menu.workflowActionIsCurrent(6, 7, true, 'codex-agent', workflowExtensions[0]), 'stale workflow action generations cannot transition')
assert(!menu.workflowActionIsCurrent(7, 7, true, 'other-capability', workflowExtensions[0]), 'replacement capability mismatches cannot transition')

const unavailableCatalog = menu.parseExtensionCatalog(JSON.stringify([
  {
    schemaVersion: 1,
    id: 'needs-tool',
    mode: 'prefix',
    label: 'Needs Tool',
    prefixes: ['needs'],
    command: ['missing-tool', '{prompt}'],
    requires: ['missing-tool'],
    _missingRequires: ['missing-tool']
  },
  {
    schemaVersion: 1,
    id: 'needs-tool',
    mode: 'prefix',
    label: 'Duplicate',
    prefixes: ['duplicate'],
    command: ['duplicate', '{prompt}']
  }
]))
assert(!unavailableCatalog.extensions[0].available, 'missing dependencies mark extensions unavailable')
assert(unavailableCatalog.diagnostics.some(message => message.indexOf('missing-tool') >= 0), 'missing dependencies produce diagnostics')
assert(unavailableCatalog.diagnostics.some(message => message.indexOf('duplicate extension id') >= 0), 'duplicate extension ids produce diagnostics')

const providerCatalog = menu.parseExtensionCatalog(JSON.stringify({
  diagnostics: ['plugin example provider #2 timed out'],
  extensions: [
    {
      schemaVersion: 1,
      id: 'provider-first',
      label: 'First',
      prefixes: ['shared'],
      command: ['printf', 'first'],
      _source: 'plugin example provider #1'
    },
    {
      schemaVersion: 1,
      id: 'provider-first',
      label: 'Duplicate id',
      prefixes: ['other'],
      command: ['printf', 'duplicate'],
      _source: 'plugin example provider #2'
    },
    {
      schemaVersion: 1,
      id: 'provider-prefix',
      label: 'Duplicate prefix',
      prefixes: ['shared'],
      command: ['printf', 'prefix'],
      _source: 'plugin example provider #3'
    },
    {
      _source: 'plugin example provider #4'
    }
  ]
}))
assert(providerCatalog.extensions.length === 2, 'loader catalog envelopes preserve valid provider extensions')
assert(providerCatalog.diagnostics.some(message => message.indexOf('provider #2 timed out') >= 0), 'loader diagnostics pass through catalog validation')
assert(providerCatalog.diagnostics.some(message => message.indexOf("duplicate extension id 'provider-first'") >= 0 && message.indexOf('provider #2') >= 0), 'duplicate provider ids identify their source')
assert(providerCatalog.diagnostics.some(message => message.indexOf("Duplicate extension prefix 'shared'") >= 0 && message.indexOf('provider #3') >= 0), 'duplicate provider prefixes identify their source')
assert(providerCatalog.diagnostics.some(message => message.indexOf('invalid extension from plugin example provider #4') >= 0), 'invalid provider definitions identify their source')

const hostileCatalog = menu.parseExtensionCatalog(JSON.stringify([
  { schemaVersion: 1, id: '__proto__', capability: '__proto__', label: 'Proto', prefixes: ['__proto__'], command: ['printf', '{prompt}'] },
  { schemaVersion: 1, id: 'constructor', capability: 'constructor', label: 'Constructor', prefixes: ['constructor'], command: ['printf', '{prompt}'] },
  { schemaVersion: 1, id: 'toString', capability: 'toString', label: 'To String', prefixes: ['toString'], command: ['printf', '{prompt}'] },
  { schemaVersion: 1, id: 'constructor', capability: 'other', label: 'Duplicate', prefixes: ['other'], command: ['printf', '{prompt}'] },
  { schemaVersion: 1, id: 'prefix-duplicate', capability: 'prefix-duplicate', label: 'Prefix duplicate', prefixes: ['__proto__'], command: ['printf', '{prompt}'] }
]))
assert(hostileCatalog.extensions.map(extension => extension.id).join(',') === '__proto__,constructor,toString,prefix-duplicate', 'hostile object-property names remain ordinary extension ids and capabilities')
assert(hostileCatalog.diagnostics.some(message => message.indexOf("duplicate extension id 'constructor'") >= 0), 'hostile duplicate ids are still detected')
assert(hostileCatalog.diagnostics.some(message => message.indexOf("Duplicate extension prefix '__proto__'") >= 0), 'hostile duplicate prefixes are still detected')
assert(menu.resolveExtensions([{ capability: '__proto__', available: true, priority: 0, bundled: true }, { capability: '__proto__', available: true, priority: 1, bundled: false }])[0].priority === 1, 'hostile capability keys resolve replacements normally')
assert(menu.parseExtensionCatalog('{bad').valid === false, 'malformed catalogs are marked invalid for last-known-good retention')
assert(menu.parseExtensionCatalog(JSON.stringify({ extensions: [], diagnostics: [], complete: false })).complete === false, 'incomplete loader catalogs are marked transient')
assert(menu.parseExtensions('[{"schemaVersion":1,"id":"overflow","label":"Overflow","prefixes":["overflow"],"command":["true"],"priority":1e400}]').length === 0, 'QML-side normalization rejects floating-point overflow from otherwise valid JSON')
assert(menu.parseExtensions(JSON.stringify({ schemaVersion: 1, id: 'unsafe-int', label: 'Unsafe', prefixes: ['unsafe'], command: ['true'], priority: 9007199254740992 })).length === 0, 'QML-side normalization rejects numeric fields outside the interoperable safe range')
const boundedQmlDiagnostics = menu.parseExtensionCatalog(JSON.stringify({
  diagnostics: ['x'.repeat(5000)],
  extensions: Array.from({ length: 1100 }, (_, index) => ({ _source: `invalid-${index}` }))
}))
assert(boundedQmlDiagnostics.extensions.length === 0 && boundedQmlDiagnostics.diagnostics.length === 256,
  'QML catalog validation bounds definition use and aggregate diagnostics')
assert(boundedQmlDiagnostics.diagnostics[0].length <= 1024
  && boundedQmlDiagnostics.diagnostics.some(message => message.indexOf('Further extension diagnostics were omitted') >= 0),
  'QML catalog validation bounds diagnostic text and reports omissions')
const fileActionHints = menu.actionBarHints({
  fileBrowserActive: true,
  hasSelection: true,
  canStar: true,
  starred: false
})
assert(fileActionHints.map(hint => `${hint.label}:${hint.shortcut}`).join(',')
  === 'Open:Enter,Actions:Ctrl K,Copy Path:Ctrl C,Star:Ctrl S',
  'the action bar lists every available file shortcut')
const starredActionHints = menu.actionBarHints({ hasSelection: true, canStar: true, starred: true })
assert(starredActionHints.some(hint => hint.label === 'Unstar' && hint.shortcut === 'Ctrl S'),
  'the action bar reflects the selected favorite state')
const refreshActionHints = menu.actionBarHints({ hasSelection: true, canRefresh: true })
assert(refreshActionHints.some(hint => hint.label === 'Refresh' && hint.shortcut === 'Ctrl R'),
  'refreshable extension surfaces advertise Ctrl+R')
assert(menu.compactActionBarHints(refreshActionHints.concat([{ label: 'Star', shortcut: 'Ctrl S' }])).map(hint => hint.label).join(',') === 'Open,Refresh',
  'narrow action bars retain refresh when no action panel is available')
const inputActionHints = menu.actionBarHints({ dmenuActive: true, dmenuInput: true })
assert(inputActionHints.map(hint => hint.label).join(',') === 'Submit',
  'input requests only advertise their submit action')
const panelActionHints = menu.actionBarHints({ fileBrowserActive: true, actionPanelActive: true, hasSelection: true })
assert(panelActionHints.map(hint => hint.label).join(',') === 'Run',
  'action panels hide file-browser shortcuts that they do not accept')
assert(menu.compactActionBarHints(fileActionHints).map(hint => hint.label).join(',') === 'Open,Actions',
  'narrow action bars retain the primary action and action-panel shortcut')
assert(menu.compactActionBarHints(starredActionHints).map(hint => hint.label).join(',') === 'Open,Unstar',
  'action bars with only two hints do not compact further')

const resetOpenState = menu.openStateReset({ workflowActive: true, fileBrowserActive: true })
assert(resetOpenState.workflowActive === false && resetOpenState.workflowNode === null && resetOpenState.workflowStack.length === 0, 'new opens reset workflow state')
assert(resetOpenState.fileBrowserActive === false && resetOpenState.directoryPickerActive === false && resetOpenState.fileBrowserExtension === null, 'new opens reset file browser and directory picker state')
assert(resetOpenState.focusedExtension === null && resetOpenState.actionPanelActive === false && resetOpenState.resultExtension === null, 'new opens reset focused and action-panel state')

const bundledMissingQalc = menu.parseExtensions(JSON.stringify([{
  ...JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extensions', 'calculator', 'extension.json'), 'utf8')),
  _bundled: true,
  _missingRequires: ['qalc']
}]))[0]
const qalcSetup = menu.dependencySetup(bundledMissingQalc)
assert(qalcSetup.packageName === 'libqalculate', 'bundled qalc requirements map to libqalculate setup')
assert(qalcSetup.installCommand.join(' ') === 'omarchy pkg add libqalculate', 'dependency setup exposes the exact supported install command')
assert(menu.unavailableExtensionDetail(bundledMissingQalc).indexOf('Press Enter to install') >= 0, 'known bundled dependencies are actionable')
assert(menu.firstSetupExtension([bundledMissingQalc]) === bundledMissingQalc, 'missing bundled dependencies produce a root setup extension')
assert(menu.firstSetupExtension(bundledExtensions) === null, 'available bundled dependencies do not produce root setup')
assert(menu.dependencySetup(unavailableCatalog.extensions[0]) === null, 'external extensions cannot authorize package installation')
assert(menu.firstSetupExtension(unavailableCatalog.extensions) === null, 'external dependencies cannot produce root package setup')
assert(menu.unavailableExtensionDetail(unavailableCatalog.extensions[0]) === 'Missing dependency: missing-tool', 'unknown dependencies retain diagnostic-only messaging')

const searchTree = {
  setup: { id: 'setup', parent: 'root' },
  'setup.default': { id: 'setup.default', parent: 'setup' },
  'setup.default.agent': { id: 'setup.default.agent', parent: 'setup.default' },
  'setup.security': { id: 'setup.security', parent: 'setup' }
}
assert(menu.isSearchExcluded(searchTree, 'setup.default', ['setup.default']), 'excluded search roots are hidden')
assert(menu.isSearchExcluded(searchTree, 'setup.default.agent', ['setup.default']), 'descendants of excluded search roots are hidden')
assert(!menu.isSearchExcluded(searchTree, 'setup.security', ['setup.default']), 'sibling menu results remain searchable')

const metadataItems = {
  root: menu.normalizeItem('root', { label: 'Go' }),
  tools: menu.normalizeItem('tools', { label: 'Tools' }),
  'tools.editor': menu.normalizeItem('tools.editor', {
    label: 'Text Editor',
    action: 'editor',
    aliases: ['Edit'],
    description: 'Open text files'
  }),
  hidden: menu.normalizeItem('hidden', { label: 'Hidden' }),
  'hidden.child': menu.normalizeItem('hidden.child', { label: 'Guarded', action: 'guarded', when: 'false' }),
  provider: menu.normalizeItem('provider', { label: 'Dynamic', provider: 'apps' })
}
const metadataOrder = ['root', 'tools', 'tools.editor', 'hidden', 'hidden.child', 'provider']
metadataOrder.forEach((id, index) => { metadataItems[id].order = index })
const itemMetadata = menu.buildItemMetadata(metadataItems, metadataOrder, { 'hidden.child': false })
assert(itemMetadata['tools.editor'].path === 'Tools › Text Editor', 'derived metadata caches item paths')
assert(itemMetadata['tools.editor'].parentPath === 'Tools', 'derived metadata caches parent paths')
assert(itemMetadata['tools.editor'].depth === menu.depthFor(metadataItems, 'tools.editor'), 'derived metadata caches item depth')
assert(itemMetadata.tools.childCount === 1, 'derived metadata caches direct child counts')
assert(itemMetadata.tools.visible, 'derived metadata caches visible menu descendants')
assert(!itemMetadata.hidden.visible, 'derived metadata propagates guarded descendant visibility')
assert(itemMetadata.provider.visible, 'provider-backed menus remain visible in derived metadata')
assert(menu.isDescendantOf(metadataItems, 'tools.editor', 'tools', itemMetadata), 'derived ancestry answers descendant checks')
const preparedEditorQuery = menu.prepareSearchQuery('EDIT text')
assert(menu.matchesQuery(metadataItems['tools.editor'], preparedEditorQuery, true, itemMetadata['tools.editor']), 'prepared queries use cached aliases and description words')
assert(
  menu.searchScore(metadataItems, metadataItems['tools.editor'], preparedEditorQuery, itemMetadata['tools.editor'])
    === menu.searchScore(metadataItems, metadataItems['tools.editor'], 'EDIT text'),
  'cached metadata preserves search scoring'
)
const specialWordItem = menu.normalizeItem('special', { label: 'Special', action: 'special', description: '__proto__' })
specialWordItem.order = 0
const specialWordMetadata = menu.buildItemMetadata({ special: specialWordItem }, ['special'], {}).special
assert(menu.matchesQuery(specialWordItem, menu.prepareSearchQuery('__proto__'), true, specialWordMetadata), 'cached word sets retain special object-property names')

const deepItems = { root: menu.normalizeItem('root', { label: 'Go' }) }
const deepOrder = ['root']
let deepParent = 'root'
for (let depth = 0; depth < 34; depth++) {
  const id = `deep.${depth}`
  deepItems[id] = menu.normalizeItem(id, { label: `Depth ${depth}`, parent: deepParent })
  deepItems[id].order = deepOrder.length
  deepOrder.push(id)
  deepParent = id
}
deepItems['deep.leaf'] = menu.normalizeItem('deep.leaf', { label: 'Leaf', parent: deepParent, action: 'leaf' })
deepItems['deep.leaf'].order = deepOrder.length
deepOrder.push('deep.leaf')
const deepMetadata = menu.buildItemMetadata(deepItems, deepOrder, {})
assert(deepOrder.every(id => deepMetadata[id].visible === menu.isVisible(deepItems, deepOrder, {}, deepItems[id])), 'cached visibility preserves recursion-boundary behavior')

const specialParentItems = { root: menu.normalizeItem('root', { label: 'Go' }) }
specialParentItems.constructor = menu.normalizeItem('constructor', { label: 'Constructor' })
specialParentItems['constructor.child'] = menu.normalizeItem('constructor.child', { label: 'Child', parent: 'constructor', action: 'child' })
specialParentItems['toString.child'] = menu.normalizeItem('toString.child', { label: 'String Child', parent: 'toString', action: 'child' })
specialParentItems['__proto__.child'] = menu.normalizeItem('__proto__.child', { label: 'Proto Child', parent: '__proto__', action: 'child' })
const specialParentOrder = ['root', 'constructor', 'constructor.child', 'toString.child', '__proto__.child']
specialParentOrder.forEach((id, index) => { specialParentItems[id].order = index })
const specialParentMetadata = menu.buildItemMetadata(specialParentItems, specialParentOrder, {})
assert(specialParentMetadata.constructor.childCount === 1, 'derived child maps accept inherited object-property names')
assert(specialParentMetadata['constructor.child'].ancestorSet.$constructor, 'derived ancestry accepts inherited object-property names')
assert(specialParentMetadata['toString.child'].visible && specialParentMetadata['__proto__.child'].visible, 'special parent ids do not prevent metadata construction')

assert(menu.searchMatchPriority({ kind: 'app', label: 'Apps', aliases: ['app', 'applications'] }, 'apps') === 60, 'exact titles receive exact-title priority')
assert(menu.searchMatchPriority({ kind: 'app', label: 'Apple Music', aliases: [] }, 'app') === 50, 'title prefixes receive title-prefix priority')
assert(menu.searchMatchPriority({ kind: 'action', parent: 'apps', label: 'Work Browser', aliases: [] }, 'browser') === 40, 'whole title words receive title-contains priority')
assert(menu.searchMatchPriority({ kind: 'app', label: 'Delfin', aliases: [] }, 'fi') === 40, 'title substrings share one title-contains tier below prefixes')
assert(menu.searchMatchPriority({ kind: 'app', label: 'LibreOffice Calc', aliases: [] }, 'calc') === menu.searchMatchPriority({ kind: 'app', label: 'Omacalc', aliases: [] }, 'calc'), 'title words and in-word substrings have equal match tiers')
assert(menu.searchMatchPriority({ kind: 'app', parent: 'apps', label: 'Chromium', aliases: ['Web Browser'] }, 'browser') === 10, 'app metadata uses the same metadata tier as other result types')
assert(menu.searchMatchPriority({ kind: 'app', parent: 'apps', label: 'Chromium', aliases: ['Web Browser'] }, 'calculator') === 0, 'unmatched items receive no priority')
assert(menu.searchMatchPriority({ kind: 'menu', parent: 'apps', label: 'Other', aliases: ['Browser'] }, 'browser') === 30, 'exact aliases receive exact-alias priority')
assert(menu.searchMatchPriority({ kind: 'menu', label: 'Browser', aliases: [] }, 'browser') === 60, 'item type does not change exact-title priority')
assert(menu.searchMatchPriority({ label: 'Apps', aliases: ['app', 'applications'] }, 'ap') === 50, 'title prefixes outrank aliases')
assert(menu.searchMatchPriority({ label: 'Utilities', aliases: ['applications'] }, 'ap') === 20, 'alias prefixes are recognized')
assert(menu.searchMatchPriority({ id: 'install.browser', kind: 'menu', label: 'Browser', aliases: [] }, 'browser') === 5, 'install routes receive explicit management priority')
assert(menu.searchMatchPriority({ id: 'remove.browser', kind: 'menu', label: 'Browser', aliases: [] }, 'browser') === 5, 'remove routes receive explicit management priority')

const filesApp = { id: 'apps.files', kind: 'app', parent: 'apps', label: 'Files', aliases: [] }
const filesRoot = menu.extensionRootItem(filesExtension[0])
for (const filesQuery of ['f', 'fi', 'fil', 'file', 'files']) {
  assert(
    menu.searchMatchPriority(filesApp, filesQuery) === menu.searchMatchPriority(filesRoot, filesQuery),
    `Files app and extension have equal match tiers for ${filesQuery}`
  )
}

assert(menu.compareSearchRows(
  { matchPriority: 0, starred: false, usageCount: 2, lastUsedAt: 100, score: 20, path: 'A' },
  { matchPriority: 0, starred: false, usageCount: 1, lastUsedAt: 200, score: 0, path: 'B' },
  true
) < 0, 'frequency ranks before recency and text relevance')

assert(menu.compareSearchRows(
  { matchPriority: 40, starred: false, usageCount: 1, lastUsedAt: 100, score: 0, path: 'LibreOffice Calc' },
  { matchPriority: 40, starred: false, usageCount: 3, lastUsedAt: 200, score: 10, path: 'Omacalc' }
) > 0, 'usage ranks Omacalc above LibreOffice Calc within the shared title-contains tier')

assert(menu.compareSearchRows(
  { matchPriority: 0, starred: false, usageCount: 2, lastUsedAt: 200, score: 20, path: 'A' },
  { matchPriority: 0, starred: false, usageCount: 2, lastUsedAt: 100, score: 0, path: 'B' },
  true
) < 0, 'recency breaks equal frequency ties')

assert(menu.compareSearchRows(
  { matchPriority: 50, starred: false, usageCount: 0, lastUsedAt: 0, score: 20, path: 'Apple Music' },
  { matchPriority: 30, starred: true, usageCount: 10, lastUsedAt: 200, score: 0, path: 'Apps' },
  true
) > 0, 'starred aliases outrank unstarred title prefixes')

assert(menu.compareSearchRows(
  { matchPriority: 60, starred: false, usageCount: 0, lastUsedAt: 0, score: -3, path: 'Exact extension' },
  { matchPriority: 60, starred: true, usageCount: 10, lastUsedAt: 200, score: 0, path: 'Exact app' },
  true
) > 0, 'starred exact apps outrank exact extension activations')

assert(menu.compareSearchRows(
  { matchPriority: 60, starred: false, usageCount: 0, lastUsedAt: 0, score: -3, path: 'Exact extension' },
  { matchPriority: 50, starred: true, usageCount: 10, lastUsedAt: 200, score: 0, path: 'App prefix' },
  true
) > 0, 'starred app title prefixes outrank exact extension activations')

assert(menu.compareSearchRows(
  { matchPriority: 40, starred: false, usageCount: 0, lastUsedAt: 0, score: 0, path: 'App word' },
  { matchPriority: 20, starred: true, usageCount: 10, lastUsedAt: 200, score: -3, path: 'Partial extension' },
  true
) > 0, 'starred weak matches outrank unstarred app title words')

const crowdedRows = []
for (let rowIndex = 0; rowIndex < 105; rowIndex++) {
  crowdedRows.push({
    itemId: `row-${rowIndex}`,
    matchPriority: 0,
    starred: false,
    usageCount: 0,
    lastUsedAt: 0,
    score: rowIndex,
    path: `Row ${rowIndex}`
  })
}
const diagnosticRow = {
  itemId: 'extension.unavailable.test',
  matchPriority: 0,
  starred: false,
  usageCount: 0,
  lastUsedAt: 0,
  score: -3,
  path: 'Unavailable extension'
}
const cappedRows = menu.rankSearchRows(crowdedRows, [diagnosticRow], 100)
assert(cappedRows.length === 100, 'ranked search rows respect the result cap')
assert(cappedRows[0].itemId === 'row-0', 'highest ordinary result remains first after capping')
assert(cappedRows[98].itemId === 'row-98', 'diagnostics reserve space inside the result cap')
assert(cappedRows[99].itemId === diagnosticRow.itemId, 'unavailable extension diagnostics remain visible at the bottom')

const saturatedDiagnostics = []
for (let diagnosticIndex = 0; diagnosticIndex < 4; diagnosticIndex++) {
  saturatedDiagnostics.push({
    itemId: `diagnostic-${diagnosticIndex}`,
    matchPriority: 0,
    starred: false,
    usageCount: 0,
    lastUsedAt: 0,
    score: diagnosticIndex,
    path: `Diagnostic ${diagnosticIndex}`
  })
}
const saturatedRows = menu.rankSearchRows([
  { itemId: 'live-result', matchPriority: 110, starred: false, usageCount: 0, lastUsedAt: 0, score: -1, path: 'Live result' },
  { itemId: 'ordinary-result', matchPriority: 0, starred: false, usageCount: 0, lastUsedAt: 0, score: 0, path: 'Ordinary result' }
], saturatedDiagnostics, 3)
assert(saturatedRows.length === 3, 'saturated diagnostics still respect the result cap')
assert(saturatedRows[0].itemId === 'live-result', 'saturated diagnostics preserve the highest-ranked actionable result')
assert(saturatedRows.slice(1).every(row => row.itemId.indexOf('diagnostic-') === 0), 'remaining saturated slots are reserved for diagnostics')

const assembledRanking = menu.rankSearchRows([
  { itemId: 'starred-favorite', matchPriority: 30, starred: true, usageCount: 0, lastUsedAt: 0, score: 10, path: 'Starred favorite' },
  { itemId: 'partial-extension', matchPriority: 20, starred: false, usageCount: 0, lastUsedAt: 0, score: -3, path: 'Partial extension' },
  { itemId: 'exact-app', matchPriority: 60, starred: false, usageCount: 1, lastUsedAt: 100, score: 0, path: 'Exact app' },
  { itemId: 'exact-extension', matchPriority: 60, starred: false, usageCount: 2, lastUsedAt: 200, score: -3, path: 'Exact extension' },
  { itemId: 'live-result', matchPriority: 110, starred: false, usageCount: 0, lastUsedAt: 0, score: -1, path: 'Live result' }
], [], 100)
assert(assembledRanking.map(row => row.itemId).join(',') === 'starred-favorite,live-result,exact-extension,exact-app,partial-extension', 'assembled rows rank starred matches before extension and app priority tiers')

assert(menu.compareSearchRows(
  { matchPriority: 0, starred: false, usageCount: 10, lastUsedAt: 200, score: 20, path: 'A' },
  { matchPriority: 0, starred: false, usageCount: 0, lastUsedAt: 0, score: 0, path: 'B' },
  false
) < 0, 'usage breaks match-tier ties even for short queries')

const missingWtype = menu.parseExtensions(JSON.stringify([{
  schemaVersion: 1, id: 'omalaunch.emoji', mode: 'emoji', label: 'Emoji', prefixes: ['emoji'],
  command: ['omarchy-menu-emoji-insert', '{emoji}'],
  _bundled: true, _missingRequires: ['wtype']
}]))[0]
assert(!missingWtype.available, 'a missing wtype leaves the emoji extension unavailable')
assert(menu.dependencySetup(missingWtype).packageName === 'wtype',
  'wtype is offered as a trusted installable dependency')
assert(menu.dependencySetup(missingWtype).label === 'Enable emoji pasting',
  'each installable dependency names what it enables')
assert(menu.unavailableExtensionDetail(missingWtype) === 'Requires wtype · Press Enter to install',
  'a missing wtype offers installation rather than a bare dependency name')
assert(menu.firstSetupExtension([missingWtype]) === missingWtype,
  'the emoji extension surfaces its own setup prompt')
const missingInsert = menu.parseExtensions(JSON.stringify([{
  schemaVersion: 1, id: 'omalaunch.emoji', mode: 'emoji', label: 'Emoji', prefixes: ['emoji'],
  command: ['omarchy-menu-emoji-insert', '{emoji}'],
  _bundled: true, _missingRequires: ['omarchy-menu-emoji-insert']
}]))[0]
assert(menu.dependencySetup(missingInsert) === null
  && menu.unavailableExtensionDetail(missingInsert) === 'Missing dependency: omarchy-menu-emoji-insert',
  'a missing Omarchy helper is reported but never offered as a package install')

// ---- calculation and conversion presentation ----

assert(menu.formatCalculationValue('CAD 13.89019350') === '13.89 CAD',
  'a currency answer leads with the amount at two decimals')
assert(menu.formatCalculationValue('CAD 1234567.891') === '1,234,567.89 CAD',
  'currency amounts group thousands')
assert(menu.formatCalculationValue('USD -1234.5') === '-1,234.50 USD',
  'a negative currency amount keeps its sign and grouping')
assert(menu.formatCalculationValue('EUR 0.004') === '0.004 EUR',
  'two decimals never round a small non-zero amount away to nothing')
assert(menu.formatCalculationValue('JPY 0') === '0.00 JPY',
  'a genuine zero still formats as a currency amount')
assert(menu.formatCalculationValue('1.5 m/s') === '1.5 m/s'
  && menu.formatCalculationValue('2 h 30 min') === '2 h 30 min'
  && menu.formatCalculationValue('15 mL') === '15 mL',
  'unit answers keep their own units and separators')
assert(menu.formatCalculationValue('81.6466266 kg') === '81.65 kg'
  && menu.formatCalculationValue('4046.856422 m\u00b2') === '4,046.86 m\u00b2'
  && menu.formatCalculationValue('1000 m') === '1,000 m',
  'unit answers above one are tidied to two decimals and grouped')
assert(menu.formatCalculationValue('0.3962580785 gal') === '0.3963 gal'
  && menu.formatCalculationValue('0.00004521 m') === '0.00004521 m',
  'a value below one keeps four significant digits rather than being flattened')
assert(menu.formatCalculationValue('154 lb + 5.177336471 oz') === '154 lb + 5.18 oz',
  'every number in a mixed-unit answer is tidied')
assert(menu.formatCalculationValue('13.890000') === '13.89'
  && menu.formatCalculationValue('0.30000000') === '0.3'
  && menu.formatCalculationValue('20') === '20',
  'trailing zeros are trimmed without touching whole numbers')
assert(menu.formatCalculationValue('rem(25, 1 B)') === 'rem(25, 1 B)'
  && menu.formatCalculationValue('f(1, 2, 3)') === 'f(1, 2, 3)',
  'a comma between arguments is not mistaken for a thousands separator')
assert(menu.tidyNumber('81.6466266') === '81.65' && menu.tidyNumber('0.3962580785') === '0.3963'
  && menu.tidyNumber('1000') === '1,000' && menu.tidyNumber('nope') === 'nope',
  'number tidying handles magnitudes, grouping, and non-numbers')

// ---- unit aliases qalc misreads ----

assert(menu.normalizeCalculationQuery('180 lbs to kg') === '180 lb to kg'
  && menu.normalizeCalculationQuery('5 kms to m') === '5 km to m'
  && menu.normalizeCalculationQuery('3 tsps to ml') === '3 tsp to ml',
  'an abbreviated plural is singularised, because qalc reads it as unit times seconds')
assert(menu.normalizeCalculationQuery('500 ms to s') === '500 ms to s'
  && menu.normalizeCalculationQuery('20 ns to ms') === '20 ns to ms',
  'SI-prefixed seconds are real units and must survive untouched')
assert(menu.normalizeCalculationQuery('60 kmh to mph') === '60 km/h to mph'
  && menu.normalizeCalculationQuery('60 mps to kmh') === '60 m/s to km/h',
  'compact rate spellings become the ones qalc evaluates')
assert(menu.normalizeCalculationQuery('100 c to f') === '100 \u00b0C to \u00b0F'
  && menu.normalizeCalculationQuery('100 C to F') === '100 \u00b0C to \u00b0F'
  && menu.normalizeCalculationQuery('100 degC to degF') === '100 \u00b0C to \u00b0F'
  && menu.normalizeCalculationQuery('212 f to celsius') === '212 \u00b0F to \u00b0C'
  && menu.normalizeCalculationQuery('300 k to c') === '300 K to \u00b0C',
  'a temperature conversion is rewritten whichever way it was spelled')
assert(menu.normalizeCalculationQuery('3 c to m') === '3 c to m'
  && menu.normalizeCalculationQuery('5 km to m') === '5 km to m'
  && menu.normalizeCalculationQuery('sin(30)') === 'sin(30)'
  && menu.normalizeCalculationQuery('time 3pm in tokyo') === 'time 3pm in tokyo',
  'a bare letter is only a temperature when both sides of the conversion are')
assert(menu.normalizeCalculationQuery('') === '' && menu.normalizeCalculationQuery(null) === '',
  'an empty query normalises to nothing')

// ---- a lone amount and unit implies its counterpart ----

assert(menu.implicitConversionTarget('1 inch') === 'cm'
  && menu.implicitConversionTarget('80 kg') === 'lb'
  && menu.implicitConversionTarget('5 km') === 'mi'
  && menu.implicitConversionTarget('60 mph') === 'km/h',
  'a lone amount and unit resolves to its cross-system counterpart')
assert(menu.implicitConversionTarget('1inch') === 'cm',
  'a multi-letter unit needs no space before it')
assert(menu.implicitConversionTarget('5g') === '' && menu.implicitConversionTarget('2l') === ''
  && menu.implicitConversionTarget('5m') === '',
  'a one-letter unit must be separated from the amount, so 5g and 4k stay searches')
assert(menu.implicitConversionTarget('500 g') === 'oz' && menu.implicitConversionTarget('2 l') === 'gal'
  && menu.implicitConversionTarget('5 m') === 'ft',
  'a one-letter unit still converts when it is separated')
assert(menu.implicitConversionTarget('4k') === '' && menu.implicitConversionTarget('1080p') === ''
  && menu.implicitConversionTarget('1password') === '' && menu.implicitConversionTarget('2fa') === '',
  'a query that only looks like an amount and unit is left alone')
assert(menu.implicitConversionTarget('1 inch to mm') === ''
  && menu.implicitConversionTarget('5 km to m') === '',
  'a stated target is never replaced by the implied one')
assert(menu.implicitConversionTarget('2 in') === 'cm',
  'a trailing conversion keyword with nothing after it is a unit, not a conversion')
assert(menu.implicitConversionTarget('2 in 1') === '',
  'a keyword with something after it is a conversion, so no target is implied')
assert(menu.implicitConversionTarget('25 * 4') === '' && menu.implicitConversionTarget('') === '',
  'arithmetic and empty input imply nothing')

assert(menu.normalizeCalculationQuery('1 inch') === '1 inch to cm'
  && menu.normalizeCalculationQuery('100 celsius') === '100 \u00b0C to \u00b0F',
  'the implied target is appended before temperature is rewritten')
assert(menu.normalizeCalculationQuery('180 lbs') === '180 lb to kg',
  'an alias is resolved before its counterpart is looked up')

assert(menu.formatCalculationValue('16.90701135 fl_oz') === '16.91 fl oz',
  'fluid ounces are spelled the way people write them')

const unitExtensions = menu.parseExtensions(JSON.stringify([{
  schemaVersion: 1, id: 'calc', mode: 'query', label: 'Calc',
  match: { all: ['\\d'] }, normalizeUnits: true, command: ['true']
}, {
  schemaVersion: 1, id: 'other', mode: 'query', label: 'Other',
  match: { all: ['\\d'] }, command: ['true']
}]))
assert(unitExtensions[0].normalizeUnits === true && unitExtensions[1].normalizeUnits === false,
  'unit rewriting is opt-in per extension, so a third-party provider is never rewritten')
assert(menu.openStateReset().extensionExpression === '',
  'a new launcher session drops the displayed expression')
assert(menu.formatCalculationValue('') === '' && menu.formatCalculationValue(null) === '',
  'an empty answer formats to nothing')
assert(menu.formatCalculationValue(' 42 ') === '42', 'answers are trimmed')

assert(menu.trimTrailingZeros('1.2300') === '1.23' && menu.trimTrailingZeros('5.000') === '5'
  && menu.trimTrailingZeros('700') === '700',
  'trailing-zero trimming leaves integers alone')
assert(menu.groupThousands('1234567.89') === '1,234,567.89'
  && menu.groupThousands('-1234.5') === '-1,234.5'
  && menu.groupThousands('999') === '999',
  'thousands grouping handles signs and short numbers')

assert(menu.isCurrencyResult('CAD 13.89') && !menu.isCurrencyResult('1000 m')
  && !menu.isCurrencyResult('20'),
  'only a leading three-letter code marks a currency answer')

assert(menu.calculationExpression('10 usd to cad', true) === '10 USD to CAD',
  'currency codes in the expression are uppercased')
assert(menu.calculationExpression('sin(30) + log(100)', false) === 'sin(30) + log(100)',
  'a non-currency expression is never uppercased, so function names survive')
assert(menu.calculationExpression('  25   *  4  ', false) === '25 * 4',
  'the expression is trimmed and its whitespace collapsed')
assert(menu.calculationExpression('', true) === '', 'an empty expression stays empty')

assert(menu.displayRow({}, [], {}, { id: 'x', kind: 'action' }, '', 0).value === '',
  'ordinary rows carry an empty value so the model role set stays uniform')

// ---------------------------------------------------------------- clipboard

const clipboardExtensions = menu.parseExtensions(JSON.stringify([{
  schemaVersion: 1, id: 'omalaunch.clipboard', capability: 'clipboard', mode: 'clipboard',
  label: 'Clipboard History', prefixes: ['clip'],
  command: ['omarchy-clipboard-paste-text', '--shift-insert', '--history-index', '{index}'],
  copyCommand: ['omarchy-clipboard-paste-text', '--copy-only', '--history-index', '{index}']
}]))
assert(clipboardExtensions.length === 1 && clipboardExtensions[0].mode === 'clipboard',
  'clipboard extensions are parsed')
assert(clipboardExtensions[0].history.join('|') === '{stateHome}/omarchy/clipboard-history.json',
  'clipboard extensions default to the history Omarchy writes')
assert(menu.extensionRootActivation(clipboardExtensions[0]) === 'clipboard',
  'clipboard extension roots open the history picker')
assert(menu.clipboardHistoryPaths(clipboardExtensions[0], '/home/u/.local/state', '/usr/share/omarchy')[0]
  === '/home/u/.local/state/omarchy/clipboard-history.json',
  '{stateHome} expands in the history path')
assert(menu.clipboardHistoryPaths(menu.parseExtensions(JSON.stringify([{
  schemaVersion: 1, id: 'bad', mode: 'clipboard', label: 'C', prefixes: ['c'],
  history: ['{stateHome}/../escape.json'], command: ['true']
}]))[0], '/home/u/.local/state', '/x').length === 0,
  'a history path cannot escape with ..')
assert(menu.clipboardHistoryPaths(extensions[0], '/s', '/o').length === 0,
  'a non-clipboard extension has no history path')
assert(menu.openStateReset().clipboardPickerActive === false
  && menu.openStateReset().clipboardExtension === null,
  'a new launcher session leaves the clipboard picker')

const clipboardHistory = menu.parseClipboardHistory(JSON.stringify([
  { type: 'text', text: 'hello world' },
  { type: 'text', text: 'one\ntwo\nthree' },
  { type: 'image', path: '/tmp/s.png', mime: 'image/png', capturedAt: '09:41' },
  { type: 'text', text: 'file:///home/u/a.txt\nfile:///home/u/b.txt' },
  { type: 'text', text: '   ' },
  { type: 'other', text: 'ignored' },
  'a bare string'
]))
assert(clipboardHistory.length === 5, 'blank and unknown-type entries are dropped')
assert(clipboardHistory.map(e => e.kind).join('|') === 'text|text|image|file|text',
  'each entry is classified by what it holds')
assert(clipboardHistory[4].index === 6,
  'an entry keeps its index in the original file, which is what the paste helper takes')
assert(menu.parseClipboardHistory('{nope').length === 0
  && menu.parseClipboardHistory('{}').length === 0
  && menu.parseClipboardHistory('').length === 0,
  'malformed history is ignored')

const hugeEntry = menu.parseClipboardHistory(JSON.stringify([{ type: 'text', text: 'x'.repeat(20000) }]))
assert(hugeEntry[0].text.length <= 8192,
  'a large entry is capped, because scanning them all on every keystroke stalls the shell')

assert(menu.clipboardFilePaths('file:///home/u/a.txt\nfile:///home/u/b.txt').length === 2
  && menu.clipboardFilePaths('not a uri').length === 0
  && menu.clipboardFilePaths('file://localhost/home/u/c.txt')[0] === '/home/u/c.txt',
  'file URIs are decoded, including the localhost form')

assert(menu.clipboardEntryPreview(clipboardHistory[1]) === 'one two three',
  'a multi-line preview collapses to one line for the row')
assert(menu.clipboardEntryPreview(clipboardHistory[2]) === 'Screenshot from 09:41',
  'an image preview names what it is and when')
assert(menu.clipboardEntryPreview(clipboardHistory[3]) === '2 files',
  'several files are counted rather than listed in the row')

assert(menu.clipboardEntryMetadata(clipboardHistory[1]).map(m => m.label).join('|')
  === 'Type|Characters|Words|Lines',
  'text metadata reads what it is then how big')
assert(menu.clipboardEntryMetadata(clipboardHistory[0]).map(m => m.label).join('|') === 'Type|Characters|Words',
  'a single-line entry has no line count')
assert(menu.clipboardEntryMetadata(clipboardHistory[2]).map(m => m.label).join('|')
  === 'Type|Format|Captured|Path',
  'image metadata carries its format and origin')
assert(menu.clipboardEntryMetadata(null).length === 0, 'no entry means no metadata')

assert(menu.clipboardEntryBody(clipboardHistory[1]) === 'one\ntwo\nthree',
  'the detail pane keeps the line breaks the row had to drop')
assert(menu.clipboardEntryBody(clipboardHistory[2]) === '',
  'an image has no text body; the pane shows the image itself')
assert(menu.clipboardEntryBody(clipboardHistory[3]) === '/home/u/a.txt\n/home/u/b.txt',
  'a file entry lists its paths in the pane')

const clipboardShown = menu.clipboardRows(clipboardHistory, '')
assert(clipboardShown.length === 5 && clipboardShown[0].index === 0, 'every entry becomes a row, newest first')
assert(menu.clipboardRows(clipboardHistory, 'two').map(r => r.index).join('|') === '1',
  'search is a plain substring, which is how a remembered fragment is found')
assert(menu.clipboardRows(clipboardHistory, 'SCREENSHOT').map(r => r.index).join('|') === '2',
  'search ignores case')
assert(menu.clipboardRows(clipboardHistory, 'nothing here').length === 0, 'a miss yields no rows')
assert(menu.clipboardRows(clipboardHistory, '', 2).length === 2, 'clipboard rows honour their limit')

const clipboardHints = menu.actionBarHints({ clipboardPickerActive: true, hasSelection: true })
assert(clipboardHints[0].label === 'Paste' && clipboardHints[0].shortcut === 'Enter',
  'the clipboard picker pastes on Enter')
assert(clipboardHints.some(h => h.label === 'Copy' && h.shortcut === 'Ctrl C'),
  'the clipboard picker copies on Ctrl+C')

// ---------------------------------------------------------------- emoji

const emojiExtensions = menu.parseExtensions(JSON.stringify([{
  schemaVersion: 1,
  id: 'omalaunch.emoji',
  capability: 'emoji',
  mode: 'emoji',
  label: 'Emoji',
  prefixes: ['emoji'],
  command: ['omarchy-menu-emoji-insert', '{emoji}']
}]))
assert(emojiExtensions.length === 1 && emojiExtensions[0].mode === 'emoji', 'emoji extensions are parsed')
assert(emojiExtensions[0].copyCommand.join(' ') === 'wl-copy -- {emoji}', 'emoji extensions default to a clipboard copy command')
assert(emojiExtensions[0].data.join('|') === '{omarchyPath}/shell/plugins/emojis/emojis.json|{extensionDir}/emojis.json',
  'emoji extensions default to Omarchy\'s dataset with a bundled fallback behind it')
assert(menu.extensionRootActivation(emojiExtensions[0]) === 'emoji', 'emoji extension roots open the picker')
assert(menu.parseExtensions(JSON.stringify([{
  schemaVersion: 1, id: 'no-prefix', mode: 'emoji', label: 'Emoji', command: ['true']
}])).length === 0, 'emoji extensions without a prefix are ignored')
assert(menu.parseExtensions(JSON.stringify([{
  schemaVersion: 1, id: 'no-command', mode: 'emoji', label: 'Emoji', prefixes: ['emoji']
}])).length === 0, 'emoji extensions without a command are ignored')
assert(menu.openStateReset().emojiPickerActive === false && menu.openStateReset().emojiExtension === null,
  'a new launcher session leaves the emoji picker')

assert(menu.extensionRouteCapability('emoji') === 'emoji', 'a summon can route to an extension capability')
assert(menu.extensionRouteCapability('  files  ') === 'files', 'routed capabilities are trimmed')
assert(menu.extensionRouteCapability('') === '' && menu.extensionRouteCapability('   ') === '',
  'an empty routed capability is ignored')
assert(menu.extensionRouteCapability(undefined) === '' && menu.extensionRouteCapability(null) === ''
  && menu.extensionRouteCapability(42) === '' && menu.extensionRouteCapability({}) === '',
  'a non-string routed capability is ignored')
assert(menu.extensionRouteCapability('x'.repeat(128)).length === 128
  && menu.extensionRouteCapability('x'.repeat(129)) === '',
  'routed capabilities are bounded')
assert(menu.openStateReset().pendingExtensionCapability === '',
  'a new launcher session drops a pending extension route')

assert(menu.emojiDataPaths(emojiExtensions[0], '/usr/share/omarchy')[0] === '/usr/share/omarchy/shell/plugins/emojis/emojis.json',
  '{omarchyPath} expands in the emoji dataset path')
assert(menu.emojiDataPaths(emojiExtensions[0], '/usr/share/omarchy').length === 2,
  'every readable dataset candidate is resolved in order')
assert(menu.emojiFileList(['a', 'a', 'b']).join('|') === 'a|b', 'duplicate dataset candidates collapse')
assert(menu.emojiFileList('one').join('|') === 'one', 'a single dataset path is still accepted')
assert(menu.emojiFileList(undefined, ['fallback']).join('|') === 'fallback',
  'an absent dataset falls back to the provider default')
assert(menu.emojiFileList(Array.from({ length: 12 }, (_, i) => `p${i}`)).length === 8,
  'dataset candidates are bounded')
assert(menu.emojiDataPaths(menu.parseExtensions(JSON.stringify([{
  schemaVersion: 1, id: 'mixed', mode: 'emoji', label: 'Emoji', prefixes: ['emoji'],
  data: ['relative.json', '{omarchyPath}/ok.json', '{extensionDir}/../escape.json'],
  command: ['true']
}]))[0], '/usr/share/omarchy').join('|') === '/usr/share/omarchy/ok.json',
  'unsafe dataset candidates are dropped without discarding the safe ones')
const relativeDataExtension = menu.parseExtensions(JSON.stringify([{
  schemaVersion: 1, id: 'relative', mode: 'emoji', label: 'Emoji', prefixes: ['emoji'],
  data: 'emojis.json', command: ['true']
}]))[0]
assert(menu.emojiDataPaths(relativeDataExtension, '/usr/share/omarchy').length === 0, 'relative emoji dataset paths are rejected')
const escapingDataExtension = menu.parseExtensions(JSON.stringify([{
  schemaVersion: 1, id: 'escaping', mode: 'emoji', label: 'Emoji', prefixes: ['emoji'],
  data: '{extensionDir}/../../etc/passwd', command: ['true']
}]))[0]
assert(menu.emojiDataPaths(escapingDataExtension, '/usr/share/omarchy').length === 0, 'emoji dataset paths cannot escape with ..')
assert(menu.emojiDataPaths(extensions[0], '/usr/share/omarchy').length === 0, 'non-emoji extensions have no dataset path')

const emojiData = menu.parseEmojiData(JSON.stringify([
  { e: '\u{1F600}', k: 'grinning face smile grinning happy' },
  { e: '\u{1F680}', k: 'ship rocket launch' },
  { e: '\u{1F600}', k: 'duplicate entry' },
  { e: '', k: 'missing glyph' },
  'not an object',
  { e: '\u{1F42C}', k: 'dolphin flipper' }
]))
assert(emojiData.length === 3, 'emoji datasets drop duplicates, empty glyphs, and non-objects')
assert(emojiData[0].caption === 'Grinning face smile happy', 'emoji captions deduplicate repeated keywords')
assert(menu.parseEmojiData('{bad json').length === 0, 'malformed emoji datasets are ignored')
assert(menu.parseEmojiData(JSON.stringify({ emojis: [{ emoji: '\u{1F680}', keywords: 'rocket' }] })).length === 1,
  'emoji datasets accept an object wrapper and long field names')

assert(menu.emojiMatchScore('ship rocket launch', ['rocket']) > 0, 'emoji keywords match by word')
assert(menu.emojiMatchScore('ship rocket launch', ['roc']) > 0, 'emoji keywords match by word prefix')
assert(menu.emojiMatchScore('ship rocket launch', ['ocket']) < 0, 'emoji keywords do not match mid-word')
assert(menu.emojiMatchScore('ship rocket launch', ['rocket', 'ship']) > 0, 'every emoji term must match')
assert(menu.emojiMatchScore('ship rocket launch', ['rocket', 'plane']) < 0, 'an unmatched emoji term rejects the entry')
assert(menu.emojiMatchScore('ship rocket launch', ['ship']) > menu.emojiMatchScore('ship rocket launch', ['launch']),
  'a leading emoji keyword outranks a trailing one')

const emojiCapabilityRows = menu.emojiRows(emojiData, 'rocket', { capability: 'emoji' })
assert(emojiCapabilityRows.length === 1 && emojiCapabilityRows[0].emoji === '\u{1F680}', 'emoji rows filter by query')
assert(menu.emojiUsageId('\u{1F680}', '') === '', 'a recents key requires a capability')
assert(menu.emojiUsageId('\u{1F680}', 'emoji') === 'emoji.favorite:["emoji","\u{1F680}"]',
  'the recents key keeps its historical prefix, so recents already recorded are not orphaned')
assert(menu.emojiRows(emojiData, '', { capability: 'emoji' }).map(row => row.emoji).join('') === emojiData.map(entry => entry.emoji).join(''),
  'an empty emoji query preserves dataset order')
assert(menu.emojiRows(emojiData, '', { capability: 'emoji', limit: 2 }).length === 2, 'emoji rows honor their limit')
assert(menu.emojiRows(emojiData, '', {}).every(row => row.itemId === ''),
  'emoji rows without a capability carry no recents key')

const usedEmojiId = menu.emojiUsageId('\u{1F680}', 'emoji')
const usedEmojiRows = menu.emojiRows(emojiData, '', {
  capability: 'emoji',
  usageCount: itemId => (itemId === usedEmojiId ? 4 : 0)
})
assert(usedEmojiRows[0].emoji === '\u{1F680}', 'frequently pasted emoji lead an unfiltered grid')
const searchedEmojiRows = menu.emojiRows(emojiData, 'dolphin', {
  capability: 'emoji',
  usageCount: itemId => (itemId === usedEmojiId ? 40 : 0)
})
assert(searchedEmojiRows.length === 1 && searchedEmojiRows[0].emoji === '\u{1F42C}',
  'history never promotes an emoji that does not match the query')
assert(menu.emojiRows(emojiData, '', { capability: 'emoji' }).every(row => row.starred === undefined),
  'rows carry no pinned flag now that the grid has no pinning')

// ---- a supplementary glyph set ----

const baseSet = menu.parseEmojiData(JSON.stringify([
  { e: '\u{1F600}', k: 'grinning' }, { e: '\u{1F680}', k: 'rocket' }
]))
const extraSet = menu.parseEmojiData(JSON.stringify([
  { e: '$', k: 'dollar sign usd' }, { e: '\u{20AC}', k: 'euro sign eur' },
  { e: '\u{1F600}', k: 'duplicate grinning' }
]))
const combined = menu.concatEmojiData(baseSet, extraSet)
assert(combined.length === 4, 'a supplementary set is appended, dropping glyphs the dataset already has')
assert(combined[0].emoji === '\u{1F600}' && combined[2].emoji === '$',
  'the dataset keeps its order and the supplement follows it')
assert(menu.concatEmojiData(baseSet, []) === baseSet,
  'an empty supplement returns the dataset untouched')
assert(menu.concatEmojiData(null, extraSet).length === 3 && menu.concatEmojiData(baseSet, null).length === 2,
  'a missing side is treated as empty, so nothing is deduplicated against it')

const supplementGroups = [
  { label: 'Faces', start: '\u{1F600}' },
  { label: 'Currency', start: '$' }
]
assert(menu.emojiGroupLabels(combined, supplementGroups).join('|') === 'Faces|Faces|Currency|Currency',
  'a supplement appended at the end becomes its own category with one more boundary')
const supplementSections = menu.emojiSections(combined, '', {
  capability: 'emoji', columns: 8, groups: supplementGroups
})
assert(supplementSections.rows.map(row => row.section).join('|') === 'Faces|Currency',
  'the supplementary category is laid out after the dataset categories')
assert(menu.emojiRows(combined, 'dollar', { capability: 'emoji' })[0].emoji === '$',
  'supplementary glyphs are searchable by their own keywords')

const extraExtension = menu.parseExtensions(JSON.stringify([{
  schemaVersion: 1, id: 'e', mode: 'emoji', label: 'Emoji', prefixes: ['emoji'],
  extraData: ['{extensionDir}/currency.json'], command: ['true'], _sourceDir: '/plugin/extensions/emoji'
}]))[0]
assert(menu.emojiExtraDataPaths(extraExtension, '/usr/share/omarchy')[0] === '/plugin/extensions/emoji/currency.json',
  'a supplementary path resolves under the same rules as the dataset')
assert(menu.emojiExtraDataPaths(emojiExtensions[0], '/usr/share/omarchy').length === 0,
  'an extension without a supplement has no supplementary path')

// ---- sections ----

const emojiGroups = menu.parseEmojiGroups(`{
  "version": 1,
  // Comments are accepted, like every other hand-authored file.
  "groups": [
    { "label": "Faces", "start": "\u{1F600}" },
    { "label": "Travel", "start": "\u{1F680}" },
  ],
}`)
assert(emojiGroups.length === 2 && emojiGroups[0].label === 'Faces', 'emoji group files accept JSONC')
assert(menu.parseEmojiGroups('{bad').length === 0, 'malformed emoji group files are ignored')
assert(menu.parseEmojiGroups('[{"label":"","start":"\u{1F600}"},{"label":"Ok"}]').length === 0,
  'emoji groups need both a label and a start glyph')
assert(menu.emojiGroupsPaths(emojiExtensions[0], '/usr/share/omarchy').length === 0,
  'an emoji extension without a groups file has no groups path')

const groupedData = menu.parseEmojiData(JSON.stringify([
  { e: '\u{1F600}', k: 'grinning' },
  { e: '\u{1F603}', k: 'smiley' },
  { e: '\u{1F680}', k: 'rocket' },
  { e: '\u{1F42C}', k: 'dolphin' }
]))
assert(menu.emojiGroupLabels(groupedData, emojiGroups).join('|') === 'Faces|Faces|Travel|Travel',
  'group boundaries label every emoji up to the next boundary')
assert(menu.emojiGroupLabels(groupedData, [{ label: 'Travel', start: '\u{1F680}' }]) === null,
  'boundaries that skip the start of the dataset abandon grouping')
assert(menu.emojiGroupLabels(groupedData, [
  { label: 'Faces', start: '\u{1F600}' }, { label: 'Missing', start: '\u{1F9E8}' }
]) === null, 'a boundary absent from the dataset abandons grouping')
assert(menu.emojiGroupLabels(groupedData, [
  { label: 'Travel', start: '\u{1F680}' }, { label: 'Faces', start: '\u{1F600}' }
]) === null, 'out-of-order boundaries abandon grouping')
assert(menu.emojiGroupLabels(groupedData, []) === null, 'no boundaries means no grouping')

const browseSections = menu.emojiSections(groupedData, '', {
  capability: 'emoji', columns: 2, groups: emojiGroups
})
assert(browseSections.sectioned && browseSections.rows.length === 2, 'browsing lays emoji out per category')
assert(browseSections.rows.map(row => row.section).join('|') === 'Faces|Travel', 'each row carries its category')
assert(browseSections.cells.length === 4, 'browsing shows every emoji')
assert(browseSections.cells[2].row === 1 && browseSections.cells[2].column === 0,
  'cells know the row and column they were laid out at')

const narrowSections = menu.emojiSections(groupedData, '', {
  capability: 'emoji', columns: 1, groups: emojiGroups
})
assert(narrowSections.rows.length === 4 && narrowSections.rows.every(row => row.count === 1),
  'a one-column layout gives every emoji its own row')

const searchedSections = menu.emojiSections(groupedData, 'rocket', {
  capability: 'emoji', columns: 8, groups: emojiGroups
})
assert(!searchedSections.sectioned && searchedSections.rows.length === 1
  && searchedSections.rows[0].section === '' && searchedSections.cells.length === 1,
  'a search answers with one unlabelled ranked section')

const frequentId = menu.emojiUsageId('\u{1F680}', 'emoji')
const historySections = menu.emojiSections(groupedData, '', {
  capability: 'emoji', columns: 2, groups: emojiGroups,
  usageCount: itemId => (itemId === frequentId ? 3 : 0)
})
assert(historySections.rows[0].section === 'Frequently Used'
  && historySections.cells[historySections.rows[0].start].emoji === '\u{1F680}',
  'frequently used emoji lead the grid in their own section')
assert(historySections.rows.slice(1).map(row => row.section).join('|') === 'Faces|Travel',
  'categories follow the frequently used section')
assert(!historySections.rows.some(row => row.section === 'Pinned'),
  'there is no pinned section')
assert(historySections.cells.filter(cell => cell.emoji === '\u{1F680}').length === 2,
  'a frequently used emoji stays listed in its category too, so browsing has no holes')
assert(historySections.cells.every(cell => cell.itemId === menu.emojiUsageId(cell.emoji, 'emoji')),
  'every laid-out cell carries its recents key')

const manyFrequent = menu.parseEmojiData(JSON.stringify(
  Array.from({ length: 40 }, (_, i) => ({ e: String.fromCodePoint(0x1F600 + i), k: `face-${i}` }))
))
const cappedSections = menu.emojiSections(manyFrequent, '', {
  capability: 'emoji', columns: 8, groups: [{ label: 'Faces', start: '\u{1F600}' }],
  usageCount: () => 5
})
const frequentRows = cappedSections.rows.filter(row => row.section === 'Frequently Used')
assert(frequentRows.reduce((total, row) => total + row.count, 0) === 16,
  'the frequently used section is capped at sixteen emoji')

const ungroupedSections = menu.emojiSections(groupedData, '', { capability: 'emoji', columns: 2 })
assert(ungroupedSections.rows.every(row => row.section === '') && ungroupedSections.cells.length === 4,
  'without usable boundaries the grid stays flat rather than mislabelled')

assert(menu.openStateReset().routedExtensionSession === false,
  'a new launcher session is not a routed extension session')

const emojiHints = menu.actionBarHints({ emojiPickerActive: true, hasSelection: true, canStar: false })
assert(emojiHints[0].label === 'Paste' && emojiHints[0].shortcut === 'Enter', 'the emoji picker pastes on Enter')
assert(emojiHints.some(hint => hint.label === 'Copy' && hint.shortcut === 'Ctrl C'), 'the emoji picker copies on Ctrl+C')
assert(!emojiHints.some(hint => hint.shortcut === 'Ctrl S'), 'the emoji picker offers no pinning')
assert(!menu.actionBarHints({ emojiPickerActive: true, hasSelection: false }).some(hint => hint.label === 'Copy'),
  'an empty emoji grid offers no copy hint')

const marker = path.join(os.tmpdir(), `omalaunch-guard-${process.pid}`)
const hostileId = `row; touch ${marker}; #`
const guardRun = childProcess.spawnSync('bash', ['-c', menu.guardScript({
  [hostileId]: { id: hostileId, when: 'true' }
})], { encoding: 'utf8' })
assert(guardRun.status === 0, 'guard scripts remain valid for shell metacharacters in ids')
assert(guardRun.stdout.trim() === `${hostileId}:w:1`, 'guard ids round-trip without shell interpretation')
assert(!fs.existsSync(marker), 'guard ids cannot inject shell commands')

const configuredProviderCatalog = menu.parseExtensionCatalog(JSON.stringify({
  extensions: [
    { schemaVersion: 1, id: 'default-files', capability: 'files', mode: 'files', label: 'Default', prefixes: ['default'], command: ['true'], _bundled: true },
    { schemaVersion: 1, id: 'chosen-files', capability: 'files', mode: 'files', label: 'Chosen', prefixes: ['chosen'], command: ['true'], priority: -10 }
  ], providerPreferences: { files: 'chosen-files' }, omalaunchConfig: { version: 1, menuItemFontClass: 'title', menuItemFontSize: 14 },
  providerConfig: { 'default-files': { includeGitIgnored: true }, 'chosen-files': { includeGitIgnored: false } }
}))
assert(configuredProviderCatalog.extensions[0].id === 'chosen-files' && configuredProviderCatalog.extensions[0].config.includeGitIgnored === false,
  'provider configuration selects an available id and configuration follows provider identity')
assert(configuredProviderCatalog.omalaunchConfig.menuItemFontClass === 'title'
  && configuredProviderCatalog.omalaunchConfig.menuItemFontSize === 14,
  'validated core launcher settings pass through the extension catalog')

// ---- switching a capability off from the Extensions row ----

const rowExtensions = [
  { capability: 'emoji', id: 'omalaunch.emoji', label: 'Emoji', available: true, rootDescription: 'Search and paste emoji', prefixes: ['emoji'], bundled: true },
  { capability: 'files', id: 'omalaunch.files', label: 'Files', available: true, rootDescription: 'Browse files', prefixes: ['files'], bundled: true }
]
const remaining = menu.enabledExtensions(rowExtensions, ['emoji'])
assert(remaining.length === 1 && remaining[0] === rowExtensions[1],
  'the enabled subset filters without copying, so extension identity survives a reload')
assert(menu.enabledExtensions(rowExtensions, []).length === 2, 'nothing is filtered without a disabled capability')
assert(menu.enabledExtensions(rowExtensions, 'emoji').length === 2, 'a non-array disabled list is ignored')

assert(menu.capabilityLockedByConfig('emoji', { emoji: { enabled: false } }),
  'an explicit enabled in configuration pins the capability')
assert(menu.capabilityLockedByConfig('emoji', { emoji: { enabled: true } }),
  'a pin holds whichever way it was written')
assert(!menu.capabilityLockedByConfig('emoji', { emoji: { provider: 'p' } }),
  'a provider selection alone does not pin the capability')
assert(!menu.capabilityLockedByConfig('emoji', {}) && !menu.capabilityLockedByConfig('emoji', null),
  'an unconfigured capability is not pinned')

assert(menu.extensionRootDetail(rowExtensions[0], false, false) === 'Search and paste emoji',
  'an enabled extension keeps its own description')
assert(menu.extensionRootDetail(rowExtensions[0], true, false) === 'Disabled · Press Delete to enable',
  'a disabled row says how to switch it back on')
assert(menu.extensionRootDetail(rowExtensions[0], true, true) === 'Disabled in configuration',
  'a config-pinned row does not promise a key that would not work')
assert(menu.extensionRootItem(rowExtensions[0], true, false).description === 'Disabled · Press Delete to enable',
  'the Extensions row carries the disabled detail')
assert(menu.extensionRootItem(rowExtensions[0]).description === 'Search and paste emoji',
  'omitting the disabled arguments keeps the previous behavior')

const toggleHints = menu.actionBarHints({ hasSelection: true, canToggleCapability: true, capabilityDisabled: false })
assert(toggleHints.some(hint => hint.label === 'Disable' && hint.shortcut === 'Del'),
  'an enabled extension row offers Disable')
assert(menu.actionBarHints({ hasSelection: true, canToggleCapability: true, capabilityDisabled: true })
  .some(hint => hint.label === 'Enable' && hint.shortcut === 'Del'),
  'a disabled extension row offers Enable')
assert(!menu.actionBarHints({ hasSelection: true }).some(hint => hint.shortcut === 'Del'),
  'rows that are not extensions offer no capability toggle')

const configuredCatalog = menu.parseExtensionCatalog(JSON.stringify({
  extensions: [{ schemaVersion: 1, id: 'keeper', capability: 'files', mode: 'files', label: 'Files', prefixes: ['files'], command: ['true'] }],
  omalaunchConfig: { version: 1, capabilities: { files: { enabled: true }, emoji: { provider: 'p' } } }
}))
assert(menu.capabilityLockedByConfig('files', configuredCatalog.configuredCapabilities)
  && !menu.capabilityLockedByConfig('emoji', configuredCatalog.configuredCapabilities),
  'the catalog reports which capabilities configuration pinned')
assert(Object.keys(menu.parseExtensionCatalog('[]').configuredCapabilities).length === 0,
  'a catalog without configuration reports no pinned capabilities')

// ---- disabling a capability ----

const disabledCatalog = menu.parseExtensionCatalog(JSON.stringify({
  extensions: [
    { schemaVersion: 1, id: 'bundled-emoji', capability: 'emoji', mode: 'emoji', label: 'Emoji', prefixes: ['emoji'], command: ['true'], _bundled: true },
    { schemaVersion: 1, id: 'external-emoji', capability: 'emoji', mode: 'emoji', label: 'Emoji', prefixes: ['emoji2'], command: ['true'] },
    { schemaVersion: 1, id: 'keeper', capability: 'files', mode: 'files', label: 'Files', prefixes: ['files'], command: ['true'], _bundled: true }
  ],
  disabledCapabilities: ['emoji']
}))
assert(disabledCatalog.extensions.map(value => value.capability).join('|') === 'files',
  'a disabled capability drops every provider of it, not just the selected one')
assert(disabledCatalog.diagnostics.filter(value => value.indexOf("Capability 'emoji' is disabled") >= 0).length === 1,
  'a disabled capability is diagnosed once, not once per provider')

assert(menu.parseExtensionCatalog(JSON.stringify({
  extensions: [{ schemaVersion: 1, id: 'keeper', capability: 'files', mode: 'files', label: 'Files', prefixes: ['files'], command: ['true'] }],
  disabledCapabilities: ['emoji']
})).extensions.length === 1, 'disabling a capability nothing provides changes nothing')

// A provider selection for a capability that is switched off is a leftover, not
// a misconfiguration, so it must not be reported as one.
const disabledWithProvider = menu.parseExtensionCatalog(JSON.stringify({
  extensions: [{ schemaVersion: 1, id: 'bundled-emoji', capability: 'emoji', mode: 'emoji', label: 'Emoji', prefixes: ['emoji'], command: ['true'], _bundled: true }],
  providerPreferences: { emoji: 'gone.away' },
  disabledCapabilities: ['emoji']
}))
assert(disabledWithProvider.extensions.length === 0
  && !disabledWithProvider.diagnostics.some(value => value.indexOf('is missing; normal provider resolution') >= 0),
  'a stale provider selection for a disabled capability is not reported as misconfigured')

assert(menu.parseExtensionCatalog(JSON.stringify({
  extensions: [{ schemaVersion: 1, id: 'bundled-emoji', capability: 'emoji', mode: 'emoji', label: 'Emoji', prefixes: ['emoji'], command: ['true'] }],
  disabledCapabilities: 'emoji'
})).extensions.length === 1, 'a non-array disabledCapabilities is ignored')
assert(Object.keys(menu.disabledCapabilitySet(['  emoji  ', '', null, 42, 'files'])).length === 2,
  'disabled capability names are trimmed and non-strings dropped')

const missingProviderCatalog = menu.parseExtensionCatalog(JSON.stringify({
  extensions: [{ schemaVersion: 1, id: 'fallback', capability: 'files', mode: 'files', label: 'Fallback', prefixes: ['fallback'], command: ['true'] }],
  providerPreferences: { files: 'missing' }
}))
assert(missingProviderCatalog.extensions[0].id === 'fallback' && missingProviderCatalog.diagnostics.some(value => value.indexOf("is missing; normal provider resolution was used") >= 0),
  'a missing configured provider falls back with a diagnostic')

// --- source rank -----------------------------------------------------------
//
// Two providers of one capability at equal priority are resolved by how
// specific their source is to this machine. Without a rank the winner would
// depend on catalog order, which a user can neither see nor control.
function rankedExtension(id, origin, priority) {
  return menu.normalizeExtension({
    schemaVersion: 1, id: id, capability: 'files', label: id, mode: 'prefix',
    prefixes: [id], command: ['true'], priority: priority || 0, _origin: origin,
  })
}

function resolvedIds(extensions, diagnostics) {
  return menu.resolveExtensions(extensions, {}, diagnostics || [], { count: 0 }, [])
    .map(function (extension) { return extension.id })
}

const userExt = rankedExtension('user', 'user')
const pluginExt = rankedExtension('plugin', 'plugin')
const bundledExt = rankedExtension('bundled', 'bundled')

assert(resolvedIds([pluginExt, userExt])[0] === 'user',
  'a user extension wins over a plugin at equal priority')
assert(resolvedIds([userExt, pluginExt])[0] === 'user',
  'the winner does not depend on catalog order')
assert(resolvedIds([bundledExt, pluginExt])[0] === 'plugin',
  'a plugin still wins over a bundled extension')
assert(resolvedIds([bundledExt, userExt])[0] === 'user',
  'a user extension wins over a bundled one')
assert(resolvedIds([rankedExtension('user', 'user', 0), rankedExtension('plugin', 'plugin', 10)])[0] === 'plugin',
  'an explicit priority still outranks the source')
assert(menu.resolveExtensions([pluginExt, userExt], { files: 'plugin' }, [], { count: 0 }, [])[0].id === 'plugin',
  'a configured provider still overrides the source rank')

// Shadowing is legitimate, but silent shadowing is a bug nobody can find: a
// user file left behind looks exactly like the plugin not working.
const shadowDiagnostics = []
resolvedIds([pluginExt, userExt], shadowDiagnostics)
assert(shadowDiagnostics.some(function (message) {
  return message.indexOf('your own extension') >= 0 && message.indexOf('plugin') >= 0
}), 'shadowing a plugin with a user extension is diagnosed')

const quietDiagnostics = []
resolvedIds([bundledExt, pluginExt], quietDiagnostics)
assert(quietDiagnostics.length === 0,
  'ordinary bundled-to-plugin replacement stays quiet')

// A catalog written before origins existed must still resolve.
const legacyBundled = menu.normalizeExtension({
  schemaVersion: 1, id: 'legacy', capability: 'files', label: 'legacy', mode: 'prefix',
  prefixes: ['legacy'], command: ['true'], _bundled: true,
})
assert(legacyBundled.origin === 'bundled' && menu.extensionOriginRank(legacyBundled) === 0,
  'a definition carrying only the bundled flag is ranked as bundled')

// --- action mode -----------------------------------------------------------
//
// A launcher entry that just runs something had no mode to be: prefix
// completes its prefix and waits for a prompt the command never wanted, and
// every other mode opens a picker first.
const action = menu.normalizeExtension({
  schemaVersion: 1, id: 'cam.front', label: 'Front Driveway', mode: 'action',
  command: ['mpv', '{extensionDir}/x'], prefixes: ['cam front driveway'],
})
assert(action !== null && action.mode === 'action', 'an action extension normalizes')
assert(menu.extensionRootActivation(action) === 'action',
  'an action activates by running rather than opening an input')

const bare = menu.normalizeExtension({
  schemaVersion: 1, id: 'bare', label: 'Bare', mode: 'action', command: ['true'],
})
assert(bare !== null, 'an action needs no prefix: its label is how it is found')
assert(bare.description === 'Press Enter to run',
  'an action says what Enter does rather than borrowing another mode\'s wording')

assert(menu.normalizeExtension({
  schemaVersion: 1, id: 'x', label: 'X', mode: 'action', command: [],
}) === null, 'an action without a command is rejected')

assert(menu.normalizeExtension({
  schemaVersion: 1, id: 'y', label: 'Y', mode: 'prefix', command: ['true'],
}) === null, 'a prefix extension still requires a prefix')
