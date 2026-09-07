export type SearchEntityType = "task" | "group" | "session";

interface SearchEntity {
  type: SearchEntityType;
  text: string;
  agent?: string;
  status?: string;
  unread?: number;
  hasMention?: boolean;
}

export function matchesSearch(query: string, entity: SearchEntity) {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;

  const haystack = entity.text.toLowerCase();
  const agent = entity.agent?.toLowerCase();

  return tokens.every((token) => {
    if (token.startsWith("type:")) {
      return token.slice(5) === entity.type;
    }
    if (token.startsWith("agent:")) {
      return Boolean(agent?.includes(token.slice(6)));
    }
    if (token.startsWith("status:")) {
      return token.slice(7) === entity.status;
    }
    if (token === "has:unread") {
      return (entity.unread ?? 0) > 0;
    }
    if (token === "has:mention") {
      return Boolean(entity.hasMention);
    }
    return haystack.includes(token);
  });
}
