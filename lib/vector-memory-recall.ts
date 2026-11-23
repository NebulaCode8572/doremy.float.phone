import { estimateTokens } from "@/lib/token-counter";

type Match = { content: string; similarity: number; sourceKind?: string; createdAt?: string };

export async function retrieveVectorMemoryForPrompt(characterId: string, query: string): Promise<string> {
  if (!characterId || !query.trim()) return "";
  try {
    const response = await fetch("/api/vector-memory-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ characterId, query: query.slice(0, 5000) }),
    });
    if (!response.ok) return "";
    const payload = await response.json() as { matches?: Match[] };
    const matches = Array.isArray(payload.matches) ? payload.matches.slice(0, 8) : [];
    const selected: string[] = [];
    let usedTokens = 0;
    const budget = 1600;
    for (const match of matches) {
      const content = typeof match.content === "string" ? match.content.trim() : "";
      if (!content) continue;
      const cost = estimateTokens(content) + 4;
      if (usedTokens + cost > budget) continue;
      selected.push(content);
      usedTokens += cost;
    }
    return selected.length ? [
      "## 历史记忆参考（Vector Memory）",
      "以下内容是从过往记录中检索出的记忆，不是当前对话，也不代表用户刚刚说了这些。记忆可能不完整或已过时。",
      "仅在与当前话题相关时参考；不要将其当作正在发生的事件或当前状态。若与本轮对话中的明确新信息冲突，以当前对话为准；不确定时不要武断认定。",
      "<历史记忆>",
      ...selected.map(text => "- " + text),
      "</历史记忆>",
    ].join("\n") : "";
  } catch (error) {
    console.warn("[VectorMemory] Recall unavailable; chat proceeds without cloud vector context.", error);
    return "";
  }
}
