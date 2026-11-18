import i18n from "@/lib/i18n"
"use client"

import React from "react"
import type { FileMentionOption } from "./agents-mentions-editor"
import {
  DropdownEmptyState,
  DropdownOption,
  DropdownPanel,
  DropdownSectionHeader,
} from "../discovery/dropdown-ui"

interface MentionTriggerDropdownProps {
  dropdownRef: React.RefObject<HTMLDivElement | null>
  finalTop: number
  finalLeft: number
  computedMaxHeight: number
  transformY: string
  containerWidth?: number
  dropdownWidth: number
  options: FileMentionOption[]
  selectedIndex: number
  setSelectedIndex: (index: number) => void
  onSelect: (mention: FileMentionOption) => void
  header: string
  prefix: string
  noun: string
  debouncedSearchText: string
}

export function MentionTriggerDropdown({
  dropdownRef,
  finalTop,
  finalLeft,
  computedMaxHeight,
  transformY,
  containerWidth,
  dropdownWidth,
  options,
  selectedIndex,
  setSelectedIndex,
  onSelect,
  header,
  prefix,
  noun,
  debouncedSearchText,
}: MentionTriggerDropdownProps) {
  return (
    <DropdownPanel
      dropdownRef={dropdownRef}
      finalTop={finalTop}
      finalLeft={finalLeft}
      computedMaxHeight={computedMaxHeight}
      transformY={transformY}
      containerWidth={containerWidth}
      dropdownWidth={dropdownWidth}
    >
      {options.length > 0 ? (
        <>
          <DropdownSectionHeader>{header}</DropdownSectionHeader>
          {options.map((option, index) => (
            <DropdownOption
              key={option.id}
              optionIndex={index}
              selected={selectedIndex === index}
              selectOnMouseDown
              onSelect={() => onSelect(option)}
              onMouseEnter={() => setSelectedIndex(index)}
            >
              <span className="shrink-0 whitespace-nowrap font-medium">
                {prefix}
                {option.label}
              </span>
              {option.description && (
                <span className="text-muted-foreground flex-1 min-w-0 ml-2 overflow-hidden text-[10px] truncate">
                  {option.description}
                </span>
              )}
            </DropdownOption>
          ))}
        </>
      ) : (
        <DropdownEmptyState>
          {debouncedSearchText
            ? i18n.t("No {{noun}} matching \"{{text}}\"", { noun, text: debouncedSearchText })
            : i18n.t("No {{noun}} available", { noun })}
        </DropdownEmptyState>
      )}
    </DropdownPanel>
  )
}