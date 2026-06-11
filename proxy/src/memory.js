// Persistent cross-session memory backed by an Anthropic Managed Agents
// "memory store" (created in the console, e.g. "jarvis-memory"). We don't use the
// Managed Agents runtime — we keep our own streaming Messages-API loop and use
// the store's host-side CRUD API as the backend for a few memory tools.
//
// SDK: client.beta.memoryStores.* (auto-sends the managed-agents-2026-04-01 beta).

let cachedStoreId = null;

/** Resolve the store's `memstore_...` id from an override or by name. Cached. */
export async function resolveStoreId(anthropic, { idOverride, name }) {
  if (cachedStoreId) return cachedStoreId;
  if (idOverride) {
    cachedStoreId = idOverride;
    return cachedStoreId;
  }
  for await (const s of anthropic.beta.memoryStores.list()) {
    if (s.name === name) {
      cachedStoreId = s.id;
      return s.id;
    }
  }
  throw new Error(`Memory store named "${name}" not found (set JARVIS_MEMORY_STORE_ID to pin it).`);
}

function normPath(p) {
  if (!p || typeof p !== "string") throw new Error("path is required");
  let s = p.trim();
  if (!s.startsWith("/")) s = `/${s}`;
  if (s.includes("..")) throw new Error("path may not contain '..'");
  return s;
}

async function findByPath(anthropic, storeId, path) {
  for await (const m of anthropic.beta.memoryStores.memories.list(storeId, { view: "basic" })) {
    if (m.type === "memory" && m.path === path) return m;
  }
  return null;
}

/** Create or update a memory document at `path`. */
export async function memorySave(anthropic, storeId, path, content) {
  const p = normPath(path);
  const body = String(content ?? "");
  const existing = await findByPath(anthropic, storeId, p);
  if (existing) {
    await anthropic.beta.memoryStores.memories.update(existing.id, {
      memory_store_id: storeId,
      content: body,
    });
    return `Updated memory ${p}`;
  }
  await anthropic.beta.memoryStores.memories.create(storeId, { path: p, content: body });
  return `Saved memory ${p}`;
}

/** Read one memory document by `path`. */
export async function memoryRead(anthropic, storeId, path) {
  const p = normPath(path);
  const m = await findByPath(anthropic, storeId, p);
  if (!m) return `ERROR: no memory found at ${p}`;
  const full = await anthropic.beta.memoryStores.memories.retrieve(m.id, { memory_store_id: storeId });
  return full.content || "(empty)";
}

/** List memories, optionally filtered by a case-insensitive substring. */
export async function memoryRecall(anthropic, storeId, query) {
  const out = [];
  for await (const m of anthropic.beta.memoryStores.memories.list(storeId, { view: "full" })) {
    if (m.type !== "memory") continue;
    const hay = `${m.path}\n${m.content || ""}`.toLowerCase();
    if (!query || hay.includes(String(query).toLowerCase())) {
      const snippet = (m.content || "").replace(/\s+/g, " ").trim().slice(0, 140);
      out.push(`${m.path} — ${snippet}`);
    }
    if (out.length >= 50) break;
  }
  if (out.length) return out.join("\n");
  return query ? `No memories matching "${query}".` : "Memory is empty.";
}

/**
 * Append a <memory> block to a system prompt string.
 * Returns system unchanged if memText is blank.
 */
export function appendMemoryBlock(system, memText) {
  const trimmed = String(memText ?? "").trim();
  if (!trimmed) return system ?? "";
  const block = `<memory>\n${trimmed}\n</memory>`;
  return system ? `${system}\n\n${block}` : block;
}
