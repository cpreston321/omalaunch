#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const layout = require('../MenuLayout.js')

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`)
  console.log(`ok - ${message}`)
}

assertEqual(layout.imagePreviewRowsHeight(true, 92, 340, 480), 340,
  'few image rows use the theme-scaled preview minimum')
assertEqual(layout.imagePreviewRowsHeight(true, 430, 340, 480), 430,
  'many image rows keep their natural height')
assertEqual(layout.imagePreviewRowsHeight(true, 92, 340, 236), 236,
  'a small screen bounds the preview above the footer')
assertEqual(layout.imagePreviewRowsHeight(false, 92, 340, 480), 92,
  'a non-image selection keeps its compact natural height')

const qml = fs.readFileSync(path.join(__dirname, '..', 'Menu.qml'), 'utf8')
// This fork sizes the card from the configured launcher size rather than from
// row content, so rows already occupy every pixel the card leaves and the
// preview is never squeezed by a short list. imagePreviewRowsHeight stays
// exported and unit-tested above, but Menu.qml has no natural height to raise.
if (!qml.includes('readonly property int imagePreviewMinRowsHeight: Style.space(340)')
    || !qml.includes('readonly property int fixedCardHeight: Style.space(root.launcherSize.height)')
    || !qml.includes('Math.min(root.fixedCardHeight, panel.height - Style.gapsOut * 2)')) {
  throw new Error('Menu.qml does not size the card so image previews keep their room')
}
console.log('ok - the fixed card gives image previews the full rows area')
