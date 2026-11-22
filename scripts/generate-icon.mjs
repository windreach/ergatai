#!/usr/bin/env node

/**
 * Build frontend/build/icon.icns from the composed 1024x1024 master icon.
 *
 * frontend/build/icon.png is the master art: a white rounded-square tile with
 * the black Ergatai mark, transparent padding around it. The internal UI logo
 * intentionally uses a separate transparent mask (ergatai-mark.png) and must
 * not reuse this app-icon tile.
 *
 * Requires macOS (sips + iconutil).
 */

import { existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BUILD_DIR = join(__dirname, '../frontend/build');
const INPUT_ICON = join(BUILD_DIR, 'icon.png');
const ICONSET_DIR = join(BUILD_DIR, 'icon.iconset');
const OUTPUT_ICON = join(BUILD_DIR, 'icon.icns');

// Sizes expected by iconutil. @2x files are the Retina variants.
const ICON_SIZES = [
  { size: 16, scale: 1 },
  { size: 16, scale: 2 },
  { size: 32, scale: 1 },
  { size: 32, scale: 2 },
  { size: 128, scale: 1 },
  { size: 128, scale: 2 },
  { size: 256, scale: 1 },
  { size: 256, scale: 2 },
  { size: 512, scale: 1 },
  { size: 512, scale: 2 },
];

function main() {
  if (process.platform !== 'darwin') {
    console.error('❌ icon.icns generation requires macOS (sips + iconutil).');
    console.error('   On Linux, use png2icns or icnsutil with frontend/build/icon.png.');
    process.exit(1);
  }

  if (!existsSync(INPUT_ICON)) {
    console.error(`❌ Error: Input icon not found at ${INPUT_ICON}`);
    process.exit(1);
  }

  console.log('🎨 Generating macOS icon from composed master...\n');
  console.log(`📂 Input:  ${INPUT_ICON}`);
  console.log(`📂 Output: ${OUTPUT_ICON}\n`);

  if (existsSync(ICONSET_DIR)) {
    rmSync(ICONSET_DIR, { recursive: true });
  }
  mkdirSync(ICONSET_DIR, { recursive: true });

  for (const { size, scale } of ICON_SIZES) {
    const actualSize = size * scale;
    const filename =
      scale === 1
        ? `icon_${size}x${size}.png`
        : `icon_${size}x${size}@${scale}x.png`;
    const outputPath = join(ICONSET_DIR, filename);

    execFileSync('sips', [
      '-z',
      String(actualSize),
      String(actualSize),
      INPUT_ICON,
      '--out',
      outputPath,
    ], { stdio: 'ignore' });

    console.log(`   ✓ ${filename} (${actualSize}x${actualSize})`);
  }

  console.log('\nCreating .icns file...');
  execFileSync('iconutil', ['-c', 'icns', ICONSET_DIR, '-o', OUTPUT_ICON]);
  rmSync(ICONSET_DIR, { recursive: true });

  console.log(`\n✅ Created ${OUTPUT_ICON}`);
  console.log('   The master icon.png already includes macOS-style rounded corners');
  console.log('   and transparent padding; do not apply another rounded mask.');
}

try {
  main();
} catch (error) {
  console.error('❌ Fatal error:', error instanceof Error ? error.message : error);
  process.exit(1);
}
