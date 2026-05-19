// Shared time formatting helpers. Local time, millisecond precision.

import { createElement, ReactNode } from "react";

function pad(n: number, w = 2): string {
    return String(n).padStart(w, "0");
}

// "YYYY-MM-DD HH:MM:SS.sss" in the user's local time.
export function formatLocalHuman(ms: number): string {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return "";
    return (
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
    );
}

// Split a string into React nodes, wrapping any 13-digit integer
// (a likely unix-ms timestamp) in a <span> with the human-readable time as a
// HTML title attribute. The dotted underline + help cursor signal that the
// number is interactive.
//
// 13 digits covers 2001-09-09 to 2286-11-20, so practically every plausible
// unix-ms value. Plain business numbers rarely happen to be exactly 13 digits.
export function withMsTooltips(text: string): ReactNode[] {
    const out: ReactNode[] = [];
    const re = /\b\d{13}\b/g;
    let last = 0;
    let key = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        if (m.index > last) out.push(text.slice(last, m.index));
        const ms = Number(m[0]);
        out.push(
            createElement(
                "span",
                {
                    key: `ms-${key++}`,
                    title: formatLocalHuman(ms),
                    style: {
                        borderBottom: "1px dotted var(--accent)",
                        cursor: "help",
                    },
                },
                m[0],
            ),
        );
        last = m.index + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
}

// Parses both "YYYY MM DD HH:MM:SS.sss" and "YYYY-MM-DD HH:MM:SS.sss",
// ISO with T, with or without milliseconds. Unqualified times are treated as
// local. Returns null on parse failure.
export function parseHuman(s: string): number | null {
    const t = s.trim();
    if (!t) return null;
    const norm = t.replace(
        /^(\d{4})[-\s/.](\d{1,2})[-\s/.](\d{1,2})([\sT]+)/,
        (_m, y, mo, d) => `${y}-${pad(Number(mo))}-${pad(Number(d))}T`,
    );
    const ms = Date.parse(norm);
    return Number.isNaN(ms) ? null : ms;
}
