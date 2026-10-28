/**
 * Dropdown sizing constants with dynamic scaling support
 */

// Base sizes in pixels (will be converted to rem)
const BASE_DROPDOWN_WIDTH = 320
const BASE_ITEM_HEIGHT = 28
const BASE_HEADER_HEIGHT = 24
const BASE_MAX_HEIGHT = 200
const BASE_GAP = 8

/**
 * Get dropdown dimensions.
 * Scale factor is accepted for backwards compatibility but ignored —
 * CSS `transform: scale()` handles all visual scaling.
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
