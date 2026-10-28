export interface PathNamedItem {
  id: string
  name: string
  path: string
}

export function dedupeByPath<T extends PathNamedItem>(items: T[]): T[] {
  const byPath = new Map<string, T>()

  for (const item of items) {
    const key = item.path.replace(/[\\/]+/g, "/").replace(/\/$/, "")
    if (!byPath.has(key)) {
      byPath.set(key, item)
    }
  }

  return [...byPath.values()]
}

function getPathSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean)
}

function getShortestUniqueSuffix(paths: string[], selectedIndex: number): string {
  const segments = paths.map(getPathSegments)
  const minimumLength = Math.min(...segments.map((item) => item.length))
  let commonTailLength = 0

  while (commonTailLength < minimumLength) {
    const segment = segments[0]![segments[0]!.length - 1 - commonTailLength]
    const isCommon = segments.every(
      (item) => item[item.length - 1 - commonTailLength] === segment,
    )

    if (!isCommon) break
    commonTailLength += 1
  }

  const uniqueSegments = segments.map((item) =>
    item.slice(0, item.length - commonTailLength),
  )
  const maxLength = Math.max(...segments.map((item) => item.length))

  for (let length = 1; length <= maxLength; length += 1) {
    const suffixes = uniqueSegments.map((item) => item.slice(-length).join("/"))
    const suffix = suffixes[selectedIndex]

    if (suffix !== undefined && suffixes.filter((item) => item === suffix).length === 1) {
      return suffix
    }
  }

  return paths[selectedIndex]
}

export function getPathDeduplicatedNames(
  items: PathNamedItem[],
): Map<string, string> {
  const uniqueItems = dedupeByPath(items)
  const groups = new Map<string, PathNamedItem[]>()

  for (const item of uniqueItems) {
    const key = item.name.trim().toLowerCase()
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  }

  const names = new Map<string, string>()

  for (const group of groups.values()) {
    if (group.length === 1) {
      const item = group[0]
      names.set(item.id, item.name)
      continue
    }

    const paths = group.map((item) => item.path)

    group.forEach((item, index) => {
      names.set(
        item.id,
        `${item.name} · ${getShortestUniqueSuffix(paths, index)}`,
      )
    })
  }

  return names
}
