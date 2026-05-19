export function errString(e: unknown): string {
    if (e == null) return "";
    if (typeof e === "string") return e;
    if (e instanceof Error) return e.message;
    try { return JSON.stringify(e); } catch { return String(e); }
}
