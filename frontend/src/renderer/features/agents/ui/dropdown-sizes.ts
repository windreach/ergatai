/**
 * Dropdown sizing constants with dynamic scaling support
 */

// Base sizes in pixels.
// Keep these aligned with the "Resume" message popover standard:
//   outer: w-80 (320px) p-1, inner list: max-h-72 (288px).
const BASE_DROPDOWN_WIDTH = 320
const BASE_ITEM_HEIGHT = 28
const BASE_HEADER_HEIGHT = 24
const BASE_MAX_HEIGHT = 288
const BASE_GAP = 8

/**
 * Get dropdown dimensions.
 * Fixed standard size matching the Resume popover; no dynamic scaling.
 */
export function getDropdownDimensions(_scale: number = 1) {
  return {
    width: BASE_DROPDOWN_WIDTH,
    itemHeight: BASE_ITEM_HEIGHT,
    headerHeight: BASE_HEADER_HEIGHT,
    maxHeight: BASE_MAX_HEIGHT,
    gap: BASE_GAP,
  }
}
