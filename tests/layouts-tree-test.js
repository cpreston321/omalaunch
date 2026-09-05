/*
 * Split-tree bench for the layout designer.
 *
 * Pulls the real function bodies out of Designer.qml and exercises them in
 * plain JS, so the tiling invariants are checked against shipped code rather
 * than a copy: dragging any boundary must never overlap tiles, never leave a
 * gap in the partition, and never shrink a tile below the minimum.
 *
 *   node tests/layouts-tree-test.js
 */
const fs = require('fs');
const path = require('path');

// The designer is an optional companion plugin, not part of this repository,
// so skip rather than fail when it is not installed.
const QML = path.join(process.env.HOME, '.config', 'omarchy', 'plugins',
                      'cpreston.layout-designer', 'Designer.qml');
if (!fs.existsSync(QML)) {
  console.log('skip - layout-designer plugin not installed');
  process.exit(0);
}
const src = fs.readFileSync(QML, 'utf8');

function extract(name) {
  const marker = '  function ' + name + '(';
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('missing function ' + name + ' in Designer.qml');
  let depth = 0, end = -1;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) { end = j + 1; break; } }
  }
  return src.slice(start, end).trim();
}

const names = ['snap','usableFor','makeLeaf','makeSplit','flattenInto','flatten','tileFor',
               'tileAtPoint','rectSearch','rectOf','findLeafIn','findLeaf','pathToInto','pathTo',
               'replaceIn','replaceNode','minExtent','rebuildLeafIds','resizeEdge','splitSelected',
               'deleteSelected','swapTiles','presetTree','balancedTree','applyPreset',
               'serialiseTree','deserialiseTree'];

const root = {
  tree: null, leafIds: [], treeRevision: 0, selectedId: -1, nextLeafId: 1,
  statusText: '', snapEnabled: false, snapDivisions: 48, minSize: 0.06,
  monitorInfo: { width: 2048, height: 1152, reserved: [0, 0, 0, 0] },
};
root.usable = () => root.usableFor(root.monitorInfo);
for (const n of names) eval('root.' + n + ' = ' + extract(n).replace(/^function\s+\w+/, 'function') + ';');

let pass = 0, fail = 0;
const check = (l, c, d) => c ? (pass++, console.log('  PASS ' + l))
                             : (fail++, console.log('  FAIL ' + l + (d ? ' -> ' + d : '')));

function overlaps() {
  const t = root.flatten(), bad = [];
  for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) {
    const a = t[i], b = t[j];
    if (Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1e-9 &&
        Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1e-9) bad.push(`${i}/${j}`);
  }
  return bad;
}
const coverage = () => root.flatten().reduce((t, s) => t + s.w * s.h, 0);
const tiniest = () => Math.min(...root.flatten().flatMap(t => [t.w, t.h]));

const PRESETS = ['full', 'halves', 'thirds', 'quarters', 'main-stack'];

console.log('1. Every preset is a clean partition');
for (const p of PRESETS) {
  root.applyPreset(p);
  check(`${p}: no overlap, full coverage`,
        overlaps().length === 0 && Math.abs(coverage() - 1) < 1e-9,
        `overlaps=${overlaps()} area=${coverage()}`);
}

console.log('\n2. Dragging every edge of every tile, on every preset');
for (const p of PRESETS) {
  let worst = '';
  for (const target of [0.001, 0.999, 0.5, 0.13, 0.87, 0.33]) {
    root.applyPreset(p);
    for (const id of root.leafIds.slice())
      for (const e of ['l', 'r', 't', 'b']) root.resizeEdge(id, e, target);
    if (overlaps().length) { worst = `overlap at ${target}`; break; }
    if (Math.abs(coverage() - 1) > 1e-9) { worst = `coverage ${coverage()} at ${target}`; break; }
    if (tiniest() < root.minSize - 1e-9) { worst = `tile ${tiniest()} below minSize at ${target}`; break; }
  }
  check(`${p}: survives edge drags to extremes`, worst === '', worst);
}

console.log('\n3. Split and delete keep the partition intact');
root.applyPreset('full');
root.selectedId = root.leafIds[0];
for (let i = 0; i < 6; i++) {
  root.splitSelected(i % 2 === 0);
  root.selectedId = root.leafIds[root.leafIds.length - 1];
}
check('7 tiles after 6 splits', root.leafIds.length === 7, 'n=' + root.leafIds.length);
check('still a partition', overlaps().length === 0 && Math.abs(coverage() - 1) < 1e-9);
while (root.leafIds.length > 1) {
  root.selectedId = root.leafIds[0];
  root.deleteSelected();
  if (overlaps().length || Math.abs(coverage() - 1) > 1e-9) break;
}
check('deleting back down stays a partition',
      root.leafIds.length === 1 && Math.abs(coverage() - 1) < 1e-9, 'n=' + root.leafIds.length);

console.log('\n4. Reserved areas are excluded');
root.monitorInfo = { width: 2048, height: 1152, reserved: [0, 26, 0, 0] };
root.applyPreset('halves');
const t = root.flatten();
check('top starts below the bar', Math.abs(t[0].y - 26 / 1152) < 1e-9);
check('no overlap with reserved layout', overlaps().length === 0);

console.log('\n5. Tree survives serialisation');
root.monitorInfo = { width: 2048, height: 1152, reserved: [0, 0, 0, 0] };
root.applyPreset('main-stack');
root.resizeEdge(root.leafIds[0], 'r', 0.4);
const before = JSON.stringify(root.flatten().map(x => [x.x, x.y, x.w, x.h]));
root.tree = root.deserialiseTree(JSON.parse(JSON.stringify(root.serialiseTree(root.tree))));
root.rebuildLeafIds();
check('geometry identical after round trip',
      JSON.stringify(root.flatten().map(x => [x.x, x.y, x.w, x.h])) === before);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
