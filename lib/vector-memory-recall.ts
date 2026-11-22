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
    return selected.length ? "### Vector Memory（语义回忆）\n" + selected.map(text => "- " + text).join("\n") : "";
  } catch (error) {
    console.warn("[VectorMemory] Recall unavailable; chat proceeds without cloud vector context.", error);
    return "";
  }
}
