import { useMemo, useState } from "react"

import { Input } from "../../../components/ui/input"

interface ModelAutocompleteInputProps {
  id?: string
  value: string
  onChange: (value: string) => void
  options: string[]
  placeholder?: string
}

/**
 * Free-text model input with keyword suggestions.
 *
 * There is deliberately no dropdown arrow or focus-triggered full list: a
 * suggestion panel only appears once the user has typed a non-empty query.
 */
export function ModelAutocompleteInput({
  id,
  value,
  onChange,
  options,
  placeholder,
}: ModelAutocompleteInputProps) {
  const [open, setOpen] = useState(false)
  const matches = useMemo(() => {
    const query = value.trim().toLowerCase()
    if (!query) return []
    return options
      .filter((option) => option.toLowerCase().includes(query))
      .slice(0, 50)
  }, [options, value])

  return (
    <div className="relative">
      <Input
        id={id}
        value={value}
        onChange={(event) => {
          onChange(event.target.value)
          setOpen(true)
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false)
        }}
        placeholder={placeholder}
        autoComplete="off"
      />
      {open && matches.length > 0 && (
        <div className="absolute inset-x-0 top-full z-50 mt-1 max-h-48 overflow-y-auto rounded-lg border border-border bg-background p-1 shadow-md">
          {matches.map((modelId) => (
            <button
              key={modelId}
              type="button"
              className="block w-full truncate rounded px-2 py-1 text-left font-mono text-xs text-foreground hover:bg-accent"
              // Keep focus so the click is not swallowed by onBlur.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(modelId)
                setOpen(false)
              }}
            >
              {modelId}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
