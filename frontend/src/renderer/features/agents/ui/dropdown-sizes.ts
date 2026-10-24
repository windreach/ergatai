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
 * Get dropdown dimensions with optional scale factor
 * Scale factor can come from user preferences or zoom settings
 */
export function getDropdownDimensions(scale: number = 1) {
  return {
    width: Math.round(BASE_DROPDOWN_WIDTH * scale),
    itemHeight: Math.round(BASE_ITEM_HEIGHT * scale),
    headerHeight: Math.round(BASE_HEADER_HEIGHT * scale),
    maxHeight: Math.round(BASE_MAX_HEIGHT * scale),
    gap: Math.round(BASE_GAP * scale),
  }
}
