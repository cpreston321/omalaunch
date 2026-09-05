#!/usr/bin/env node

// A routed session (summoned straight to an extension with {"extension": ...})
// has no launcher behind it, so leaveWorkflow closes when the user backs out.
// An extension-catalog reload re-enters the menu it is already showing through
// that same function; if it takes the routed exit, the reload tears down the
// session it just opened and the launcher vanishes moments after appearing.

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const qml = fs.readFileSync(path.join(__dirname, '..', 'Menu.qml'), 'utf8')
const start = qml.indexOf('  function leaveWorkflow(')
const end = qml.indexOf('\n  function ', start + 1)
assert.notStrictEqual(start, -1, 'leaveWorkflow exists')
assert.notStrictEqual(end, -1, 'leaveWorkflow has a complete body')

function makeRoot(routed) {
  const calls = []
  const root = {
    routedExtensionSession: routed,
    workflowActive: true,
    workflowExtension: { id: 'layouts' },
    workflowNode: { id: 'root', kind: 'menu' },
    workflowContext: { extensionDir: '/tmp' },
    workflowStack: [{}],
    workflowConfirmOpen: true,
    workflowConfirmNode: {},
    fileBrowserActive: true,
    directoryPickerActive: true,
    fileBrowserExtension: {},
    submenuLoading: true,
    documentLoading: true,
    documentError: 'old',
    dynamicMenuLoading: true,
    filterText: 'old',
    cancel: () => calls.push('cancel'),
    invalidateWorkflowAction: () => calls.push('workflow'),
    invalidateSubmenu: () => calls.push('submenu'),
    invalidateDocument: () => calls.push('document'),
    invalidateDynamicMenu: () => calls.push('dynamic'),
    resetFileIndex: () => calls.push('files'),
    rebuildDisplay: () => calls.push('rebuild')
  }
  const context = { root }
  vm.createContext(context)
  vm.runInContext(qml.slice(start, end), context)
  return { root, calls, leaveWorkflow: context.leaveWorkflow }
}

// The user backing out of a routed session still closes the launcher.
{
  const routed = makeRoot(true)
  routed.leaveWorkflow()
  assert.deepStrictEqual(routed.calls, ['cancel'],
    'backing out of a routed session closes the launcher')
  assert.strictEqual(routed.root.workflowActive, true,
    'the routed exit leaves teardown to cancel')
}

// A catalog reload rebuilding the same surface must not take that exit.
{
  const { root, calls, leaveWorkflow } = makeRoot(true)
  leaveWorkflow(true)
  assert(!calls.includes('cancel'),
    'an internal refresh of a routed session never closes the launcher')
  assert.strictEqual(root.workflowActive, false, 'the workflow is reset for re-entry')
  assert.strictEqual(root.workflowExtension, null, 'the stale extension is dropped')
  assert.strictEqual(root.workflowNode, null, 'the stale node is dropped')
  assert.strictEqual(root.workflowStack.length, 0, 'the stack is cleared')
  assert.strictEqual(root.dynamicMenuLoading, false, 'the loading flag is cleared')
  for (const name of ['workflow', 'submenu', 'document', 'dynamic', 'files', 'rebuild'])
    assert(calls.includes(name), `${name} state is invalidated before re-entry`)
}

// A normal session is unaffected either way.
{
  const plain = makeRoot(false)
  plain.leaveWorkflow()
  assert(!plain.calls.includes('cancel'), 'leaving a normal workflow stays open')
  assert.strictEqual(plain.root.workflowActive, false, 'the workflow is reset')

  const plainRefresh = makeRoot(false)
  plainRefresh.leaveWorkflow(true)
  assert(!plainRefresh.calls.includes('cancel'), 'an internal refresh stays open')
}

// Only `true` suppresses the routed exit, so a stray truthy argument from a
// signal handler cannot silently keep a session the user meant to close.
{
  const stray = makeRoot(true)
  stray.leaveWorkflow('reload')
  assert.deepStrictEqual(stray.calls, ['cancel'],
    'only an explicit true suppresses the routed exit')
}

// The reload path is the caller this guard exists for.
assert(/refreshedWorkflow\.mode === "menu"\) \{\s*\n\s*root\.leaveWorkflow\(true\)/.test(qml),
  'the catalog reload re-enters the menu through an internal refresh')

console.log('ok - routed sessions survive an extension-catalog reload')
