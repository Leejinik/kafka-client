import { useEffect, useMemo, useRef, useState } from "react";
import { Lang, t } from "../lib/i18n";
import {
    FacetCounts,
    FieldFilter,
    FilterMode,
    LizFieldDef,
    LizFilterState,
    NULL_TOKEN,
} from "../lib/lizPipeline";

interface Props {
    fields: readonly LizFieldDef[];
    state: LizFilterState;
    onChange: (next: LizFilterState) => void;
    facets: FacetCounts;
    lang: Lang;
    open: boolean;
    onToggleOpen: () => void;
}

interface Option {
    token: string;
    label: string;
    count: number;
}

function tokenLabel(token: string, lang: Lang): string {
    return token === NULL_TOKEN ? t(lang, "liz.none") : token;
}

// The structured whitelist/blacklist filter for a JSON topic (currently only
// liz.message.pipeline). Each field gets an independent include/exclude mode +
// a multi-select of values; a message must satisfy every active field (AND).
export function LizFilterPanel({ fields, state, onChange, facets, lang, open, onToggleOpen }: Props) {
    const activeCount = fields.reduce((n, f) => n + ((state[f.key]?.values.length ?? 0) > 0 ? 1 : 0), 0);

    const setField = (key: string, next: FieldFilter) => {
        onChange({ ...state, [key]: next });
    };
    const resetAll = () => {
        const cleared: LizFilterState = { ...state };
        for (const f of fields) cleared[f.key] = { mode: "include", values: [] };
        onChange(cleared);
    };

    return (
        <div
            style={{
                border: "1px solid var(--border)",
                borderRadius: 8,
                background: "var(--panel)",
                marginBottom: 8,
            }}
        >
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 10px",
                    cursor: "pointer",
                    userSelect: "none",
                }}
                onClick={onToggleOpen}
            >
                <span style={{ fontSize: 12, transform: open ? "rotate(90deg)" : undefined, transition: "transform 0.1s" }}>▶</span>
                <strong style={{ fontSize: 13 }}>{t(lang, "liz.panel.title")}</strong>
                {activeCount > 0 && (
                    <span
                        className="count-pill"
                        style={{ color: "var(--accent)", borderColor: "var(--accent-soft-border)", background: "var(--accent-soft-bg)" }}
                    >
                        {t(lang, "liz.panel.activeN", { n: activeCount })}
                    </span>
                )}
                <span className="grow" style={{ flex: 1 }} />
                {activeCount > 0 && (
                    <button
                        className="small"
                        onClick={(e) => { e.stopPropagation(); resetAll(); }}
                    >
                        {t(lang, "liz.panel.reset")}
                    </button>
                )}
            </div>

            {open && (
                <div style={{ borderTop: "1px solid var(--border)", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
                    {fields.map((f) => (
                        <FieldRow
                            key={f.key}
                            field={f}
                            filter={state[f.key] ?? { mode: "include", values: [] }}
                            facet={facets[f.key] ?? {}}
                            lang={lang}
                            onChange={(next) => setField(f.key, next)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function FieldRow({
    field,
    filter,
    facet,
    lang,
    onChange,
}: {
    field: LizFieldDef;
    filter: FieldFilter;
    facet: Record<string, number>;
    lang: Lang;
    onChange: (next: FieldFilter) => void;
}) {
    const setMode = (mode: FilterMode) => onChange({ ...filter, mode });
    const toggleValue = (token: string) => {
        const has = filter.values.includes(token);
        const values = has ? filter.values.filter((v) => v !== token) : [...filter.values, token];
        onChange({ ...filter, values });
    };
    const clear = () => onChange({ ...filter, values: [] });

    return (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            <label style={{ width: 108, margin: 0, paddingTop: 5, flexShrink: 0 }} title={field.key}>
                {t(lang, field.labelKey)}
            </label>

            <div style={{ display: "inline-flex", flexShrink: 0 }}>
                <ModeButton active={filter.mode === "include"} onClick={() => setMode("include")} side="left">
                    {t(lang, "liz.mode.include")}
                </ModeButton>
                <ModeButton active={filter.mode === "exclude"} onClick={() => setMode("exclude")} side="right">
                    {t(lang, "liz.mode.exclude")}
                </ModeButton>
            </div>

            <div style={{ flex: 1, minWidth: 0, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                {filter.values.map((tok) => (
                    <span
                        key={tok}
                        onClick={() => toggleValue(tok)}
                        title={t(lang, "liz.chip.remove")}
                        style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                            padding: "2px 6px 2px 8px",
                            borderRadius: 12,
                            fontSize: 12,
                            cursor: "pointer",
                            background: filter.mode === "include" ? "var(--accent-soft-bg)" : "rgba(214, 69, 69, 0.12)",
                            border: `1px solid ${filter.mode === "include" ? "var(--accent-soft-border)" : "var(--danger)"}`,
                            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                        }}
                    >
                        {tokenLabel(tok, lang)}
                        <span style={{ fontWeight: 700, opacity: 0.7 }}>✕</span>
                    </span>
                ))}
                <ValueSelect
                    field={field}
                    facet={facet}
                    selected={filter.values}
                    onToggle={toggleValue}
                    lang={lang}
                />
                {filter.values.length > 0 && (
                    <button className="small" onClick={clear} title={t(lang, "liz.field.clear")} style={{ padding: "2px 8px" }}>
                        ✕
                    </button>
                )}
            </div>
        </div>
    );
}

function ModeButton({ active, onClick, side, children }: { active: boolean; onClick: () => void; side: "left" | "right"; children: React.ReactNode }) {
    return (
        <button
            onClick={onClick}
            className="small"
            style={{
                padding: "3px 10px",
                borderRadius: side === "left" ? "6px 0 0 6px" : "0 6px 6px 0",
                marginLeft: side === "right" ? -1 : 0,
                background: active ? "var(--accent)" : "var(--panel)",
                color: active ? "#fff" : "var(--text-dim)",
                borderColor: active ? "var(--accent)" : "var(--border)",
                position: "relative",
                zIndex: active ? 1 : 0,
                fontWeight: active ? 600 : 400,
            }}
        >
            {children}
        </button>
    );
}

// Multi-select dropdown: a "값 선택" button that opens a searchable checkbox
// list built from (static catalog ∪ observed values), each annotated with its
// live occurrence count in the current buffer. Number fields have no static
// catalog, so the search box doubles as a free-entry input (type a value +
// Enter to add it even if not yet observed).
function ValueSelect({
    field,
    facet,
    selected,
    onToggle,
    lang,
}: {
    field: LizFieldDef;
    facet: Record<string, number>;
    selected: string[];
    onToggle: (token: string) => void;
    lang: Lang;
}) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const boxRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        return () => document.removeEventListener("mousedown", onDown);
    }, [open]);

    const options = useMemo<Option[]>(() => {
        const opts: Option[] = [];
        const pushed = new Set<string>();
        const push = (token: string, label: string) => {
            if (pushed.has(token)) return;
            pushed.add(token);
            opts.push({ token, label, count: facet[token] ?? 0 });
        };
        if (field.nullable) push(NULL_TOKEN, tokenLabel(NULL_TOKEN, lang));
        if (field.catalog) {
            for (const v of field.catalog) push(v, v);
            // observed values outside the static catalog (unexpected / new codes)
            const extras = Object.keys(facet).filter((tok) => tok !== NULL_TOKEN && !field.catalog!.includes(tok));
            for (const tok of extras) push(tok, tok);
        } else {
            // number field: observed values only, sorted numerically
            const nums = Object.keys(facet).filter((tok) => tok !== NULL_TOKEN);
            nums.sort((a, b) => {
                const na = Number(a), nb = Number(b);
                if (Number.isNaN(na) || Number.isNaN(nb)) return a.localeCompare(b);
                return na - nb;
            });
            for (const tok of nums) push(tok, tok);
        }
        return opts;
    }, [field, facet, lang]);

    const q = query.trim().toLowerCase();
    const filtered = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
    const allowCustom = field.kind === "number";
    const customExists = query.trim() !== "" && !options.some((o) => o.token === query.trim());
    const showAddCustom = allowCustom && customExists;

    const addCustom = () => {
        const tok = query.trim();
        if (tok === "") return;
        if (!selected.includes(tok)) onToggle(tok);
        setQuery("");
    };

    return (
        <div ref={boxRef} style={{ position: "relative", display: "inline-block" }}>
            <button
                className="small"
                onClick={() => setOpen((o) => !o)}
                style={{ padding: "3px 10px", color: "var(--text-dim)" }}
            >
                {t(lang, "liz.select.add")} ▾
            </button>
            {open && (
                <div
                    style={{
                        position: "absolute",
                        top: "calc(100% + 4px)",
                        left: 0,
                        zIndex: 30,
                        width: field.kind === "enum" ? 340 : 220,
                        maxWidth: "80vw",
                        background: "var(--panel)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        boxShadow: "var(--shadow)",
                        padding: 6,
                    }}
                >
                    <input
                        autoFocus
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && showAddCustom) { e.preventDefault(); addCustom(); }
                            if (e.key === "Escape") setOpen(false);
                        }}
                        placeholder={allowCustom ? t(lang, "liz.select.searchOrType") : t(lang, "liz.select.search")}
                        style={{ marginBottom: 6 }}
                    />
                    <div style={{ maxHeight: 240, overflowY: "auto", display: "flex", flexDirection: "column" }}>
                        {showAddCustom && (
                            <button
                                className="small"
                                onClick={addCustom}
                                style={{ justifyContent: "flex-start", textAlign: "left", marginBottom: 4 }}
                            >
                                {t(lang, "liz.select.addValue", { v: query.trim() })}
                            </button>
                        )}
                        {filtered.length === 0 && !showAddCustom && (
                            <span className="muted" style={{ fontSize: 12, padding: "6px 4px" }}>
                                {t(lang, "liz.select.empty")}
                            </span>
                        )}
                        {filtered.map((o) => {
                            const checked = selected.includes(o.token);
                            return (
                                <label
                                    key={o.token}
                                    className="checkbox"
                                    style={{
                                        justifyContent: "space-between",
                                        padding: "3px 4px",
                                        borderRadius: 4,
                                        color: "var(--text)",
                                        cursor: "pointer",
                                    }}
                                >
                                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                                        <input type="checkbox" checked={checked} onChange={() => onToggle(o.token)} />
                                        <span
                                            className="mono"
                                            style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                                            title={o.label}
                                        >
                                            {o.label}
                                        </span>
                                    </span>
                                    {o.count > 0 && (
                                        <span className="muted" style={{ fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                                            {o.count}
                                        </span>
                                    )}
                                </label>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
