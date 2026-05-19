// Persists user-named message snippets across Consume → Produce. Stored in
// localStorage so it survives app restarts without round-tripping through the
// Go side (this is purely a frontend convenience).

const KEY = "kfc.produce.savedMessages";

export interface SavedMessage {
    id: string;
    name: string;
    topic: string;
    partition: number;
    key: string;
    value: string;
    headers: Record<string, string>;
    savedAt: number; // unix ms
}

export function listSaved(): SavedMessage[] {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}

export function saveMessage(input: Omit<SavedMessage, "id" | "savedAt">): SavedMessage {
    const all = listSaved();
    const m: SavedMessage = {
        ...input,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        savedAt: Date.now(),
    };
    all.push(m);
    localStorage.setItem(KEY, JSON.stringify(all));
    return m;
}

export function deleteSaved(id: string): void {
    const all = listSaved().filter((m) => m.id !== id);
    localStorage.setItem(KEY, JSON.stringify(all));
}

export function renameSaved(id: string, name: string): void {
    const all = listSaved().map((m) => (m.id === id ? { ...m, name } : m));
    localStorage.setItem(KEY, JSON.stringify(all));
}

export function headersToText(h: Record<string, string>): string {
    return Object.entries(h).map(([k, v]) => `${k}=${v}`).join("\n");
}

// Serialize the entire library to a pretty JSON string suitable for sharing
// across machines.
export function exportSaved(): string {
    return JSON.stringify({ version: 1, messages: listSaved() }, null, 2);
}

// Returns the number of messages added. Imports are append-only: each imported
// message gets a fresh ID so a re-import of the same file produces duplicates
// instead of overwriting existing entries. Caller may delete duplicates
// from the UI afterwards.
export function importSaved(jsonText: string): number {
    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonText);
    } catch (e) {
        throw new Error("Invalid JSON: " + (e as Error).message);
    }

    let incoming: SavedMessage[] = [];
    if (parsed && typeof parsed === "object") {
        const o = parsed as { messages?: unknown };
        if (Array.isArray(o.messages)) {
            incoming = o.messages as SavedMessage[];
        } else if (Array.isArray(parsed)) {
            incoming = parsed as SavedMessage[];
        }
    }
    if (!Array.isArray(incoming)) {
        throw new Error('Expected a "messages" array (or top-level array).');
    }

    const existing = listSaved();
    let added = 0;
    for (const raw of incoming) {
        if (!raw || typeof raw !== "object") continue;
        const r = raw as Partial<SavedMessage>;
        if (typeof r.name !== "string" || typeof r.topic !== "string") continue;
        existing.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: r.name,
            topic: r.topic,
            partition: typeof r.partition === "number" ? r.partition : -1,
            key: typeof r.key === "string" ? r.key : "",
            value: typeof r.value === "string" ? r.value : "",
            headers: r.headers && typeof r.headers === "object" ? (r.headers as Record<string, string>) : {},
            savedAt: typeof r.savedAt === "number" ? r.savedAt : Date.now(),
        });
        added++;
    }
    localStorage.setItem(KEY, JSON.stringify(existing));
    return added;
}
