import { useAtomValue } from "jotai"
import * as React from "react"
import { createContext, useContext, useMemo, useCallback, useRef } from "react"

import {
  chatSearchOpenAtom,
  chatSearchQueryAtom,
  chatSearchMatchesAtom,
  chatSearchCurrentMatchAtom,
  type SearchMatch,
  type HighlightRange,
} from "./chat-search-atoms"

// ============================================================================
// CONTEXT TYPES
// ============================================================================

interface SearchHighlightContextValue {
  query: string
  isSearchActive: boolean
  getHighlightRanges: (
    messageId: string,
    partIndex: number,
    partType: string
  ) => HighlightRange[]
}

const SearchHighlightContext = createContext<SearchHighlightContextValue | null>(
  null
)

// Separate context for currentMatch — changes on navigation but is isolated
// from the main context so consumers that only need query/matches don't
// re-render when the user presses Enter to jump between matches.
const SearchCurrentMatchContext = createContext<SearchMatch | null>(null)

// ============================================================================
// PROVIDER
// ============================================================================

interface SearchHighlightProviderProps {
  children: React.ReactNode
}

// Empty context value when search is closed - stable reference to avoid re-renders
const EMPTY_HIGHLIGHT_RANGES: HighlightRange[] = []
const emptyGetHighlightRanges = () => EMPTY_HIGHLIGHT_RANGES
const CLOSED_SEARCH_VALUE: SearchHighlightContextValue = {
  query: "",
  isSearchActive: false,
  getHighlightRanges: emptyGetHighlightRanges,
}

export function SearchHighlightProvider({
  children,
}: SearchHighlightProviderProps) {
  // Only subscribe to isOpen first - this is the gate
  const isOpen = useAtomValue(chatSearchOpenAtom)

  // When search is closed, render with static empty context
  // This prevents any subscriptions to query/matches/currentMatch
  if (!isOpen) {
    return (
      <SearchHighlightContext.Provider value={CLOSED_SEARCH_VALUE}>
        {children}
      </SearchHighlightContext.Provider>
    )
  }

  // Search is open - render the active provider
  return (
    <SearchHighlightProviderActive>
      {children}
    </SearchHighlightProviderActive>
  )
}

// Separate component for when search is active
// This isolates the subscriptions to query/matches/currentMatch
function SearchHighlightProviderActive({
  children,
}: SearchHighlightProviderProps) {
  const query = useAtomValue(chatSearchQueryAtom)
  const matches = useAtomValue(chatSearchMatchesAtom)
  const currentMatch = useAtomValue(chatSearchCurrentMatchAtom)

  // Keep currentMatch in a ref so getHighlightRanges doesn't need it as a
  // dependency. This keeps the main context value stable across navigation,
  // preventing a re-render cascade for all consumers.
  const currentMatchRef = useRef(currentMatch)
  currentMatchRef.current = currentMatch

  // Build lookup map for efficient highlight retrieval
  const matchesByKey = useMemo(() => {
    const map = new Map<string, SearchMatch[]>()
    for (const match of matches) {
      const key = `${match.messageId}:${match.partIndex}:${match.partType}`
      const existing = map.get(key) || []
      existing.push(match)
      map.set(key, existing)
    }
    return map
  }, [matches])

  // Per-key cache for highlight range arrays. Avoids creating a new array on
  // every call to getHighlightRanges (which previously produced unstable
  // references that defeated React.memo in consumers).
  const cacheRef = useRef<Map<string, HighlightRange[]>>(new Map())
  const prevMatchesByKeyRef = useRef(matchesByKey)

  // Invalidate the cache when the underlying matches change (new search).
  if (prevMatchesByKeyRef.current !== matchesByKey) {
    cacheRef.current.clear()
    prevMatchesByKeyRef.current = matchesByKey
  }

  const getHighlightRanges = useCallback(
    (messageId: string, partIndex: number, partType: string): HighlightRange[] => {
      const key = `${messageId}:${partIndex}:${partType}`
      const relevantMatches = matchesByKey.get(key)

      if (!relevantMatches || relevantMatches.length === 0) {
        // Stable empty constant — never a fresh array literal
        return EMPTY_HIGHLIGHT_RANGES
      }

      const currentMatchId = currentMatchRef.current?.id ?? null
      const cacheKey = `${key}:${currentMatchId}`

      let cached = cacheRef.current.get(cacheKey)
      if (!cached) {
        cached = relevantMatches.map((m, idx) => ({
          offset: m.offset,
          length: m.length,
          isCurrent: currentMatchId === m.id,
          indexInPart: idx,
        }))
        cacheRef.current.set(cacheKey, cached)
      }
      return cached
    },
    [matchesByKey]
  )

  // Main context value — stable wrt currentMatch changes because
  // getHighlightRanges reads currentMatch from a ref, not from its deps.
  const value = useMemo(
    () => ({
      query,
      isSearchActive: query.trim().length > 0,
      getHighlightRanges,
    }),
    [query, getHighlightRanges]
  )

  return (
    <SearchHighlightContext.Provider value={value}>
      <SearchCurrentMatchContext.Provider value={currentMatch}>
        {children}
      </SearchCurrentMatchContext.Provider>
    </SearchHighlightContext.Provider>
  )
}

// ============================================================================
// HOOKS
// ============================================================================

/**
 * Hook to access search highlight context
 */
export function useSearchHighlightContext() {
  return useContext(SearchHighlightContext)
}

/**
 * Hook to get highlight ranges for a specific message part
 * Returns empty array if search is not active or no matches
 */
export function useSearchHighlight(
  messageId: string,
  partIndex: number,
  partType: string
): HighlightRange[] {
  const context = useContext(SearchHighlightContext)
  // Subscribe to the isolated currentMatch context so this hook re-renders
  // when navigation happens (to update `isCurrent`). Because currentMatch is
  // in its own context, consumers of useSearchQuery / useIsSearchActive do
  // NOT re-render on navigation.
  useContext(SearchCurrentMatchContext)

  if (!context || !context.isSearchActive) {
    return EMPTY_HIGHLIGHT_RANGES
  }

  return context.getHighlightRanges(messageId, partIndex, partType)
}

/**
 * Hook to check if search is currently active
 */
export function useIsSearchActive(): boolean {
  const context = useContext(SearchHighlightContext)
  return context?.isSearchActive ?? false
}

/**
 * Hook to get the current search query
 */
export function useSearchQuery(): string {
  const context = useContext(SearchHighlightContext)
  return context?.query ?? ""
}
