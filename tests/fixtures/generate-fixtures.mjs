/**
 * Generates deterministic synthetic image fixtures used by the WebGL A/B
 * flip acceptance tests. Run via: node tests/fixtures/generate-fixtures.mjs
 */
import sharp from 'sharp'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, 'media')

const solid = (r, g, b) =>
  sharp({
    create: {
      width: 320,
      height: 240,
      channels: 3,
      background: { r, g, b },
    },
  }).png()

await solid(220, 30, 30).toFile(join(out, 'red.png'))
await solid(30, 40, 220).toFile(join(out, 'blue.png'))
await solid(30, 200, 40).toFile(join(out, 'green.png'))

// Half red (left) / half blue (right) for ROI-localized metric checks.
const raw = Buffer.alloc(320 * 240 * 3)
for (let y = 0; y < 240; y++) {
  for (let x = 0; x < 320; x++) {
    const i = (y * 320 + x) * 3
    if (x < 160) {
      raw[i] = 220
      raw[i + 1] = 30
      raw[i + 2] = 30
    } else {
      raw[i] = 30
      raw[i + 1] = 40
      raw[i + 2] = 220
    }
  }
}
await sharp(raw, { raw: { width: 320, height: 240, channels: 3 } })
  .png()
  .toFile(join(out, 'half-red-blue.png'))

// Second half image (inverted halves) so ROI metrics differ between sides.
const raw2 = Buffer.alloc(320 * 240 * 3)
for (let y = 0; y < 240; y++) {
  for (let x = 0; x < 320; x++) {
    const i = (y * 320 + x) * 3
    if (x < 160) {
      raw2[i] = 30
      raw2[i + 1] = 40
      raw2[i + 2] = 220
    } else {
      raw2[i] = 220
      raw2[i + 1] = 30
      raw2[i + 2] = 30
    }
  }
}
await sharp(raw2, { raw: { width: 320, height: 240, channels: 3 } })
  .png()
  .toFile(join(out, 'half-blue-red.png'))

console.log('fixtures written to', out)
