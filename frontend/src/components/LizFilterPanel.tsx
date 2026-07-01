import { useEffect, useMemo, useRef, useState } from "react";
import { Lang, t } from "../lib/i18n";
import {
    CustomRule,
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
    enumFacets: FacetCounts;
    observedKeys: string[];
    customFacets: FacetCounts;
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
// liz.message.pipeline): curated enum fields + user-defined key/value rules.
// A message must satisfy every active constraint (AND).
export function LizFilterPanel({ fields, state, onChange, enumFacets, observedKeys, customFacets, lang, open, onToggleOpen }: Props) {
    const enumActive = fields.reduce((n, f) => n + ((state.fields[f.key]?.values.length ?? 0) > 0 ? 1 : 0), 0);
    const customActive = state.custom.reduce((n, r) => n + (r.key.trim() !== "" && r.values.length > 0 ? 1 : 0), 0);
    const activeCount = enumActive + customActive;

    const nextId = useRef(1);
    useEffect(() => {
        nextId.current = Math.max(0, ...state.custom.map((r) => r.id)) + 1;
        // Only needs to seed once from persisted state.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const setField = (key: string, next: FieldFilter) => onChange({ ...state, fields: { ...state.fields, [key]: next } });
    const setCustom = (custom: CustomRule[]) => onChange({ ...state, custom });
    const addRule = () => setCustom([...state.custom, { id: nextId.current++, key: "", mode: "include", values: [] }]);
    const updateRule = (id: number, patch: Partial<CustomRule>) =>
        setCustom(state.custom.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    const removeRule = (id: number) => setCustom(state.custom.filter((r) => r.id !== id));
    const resetAll = () => {
        const fieldsCleared: Record<string, FieldFilter> = {};
        for (const f of fields) fieldsCleared[f.key] = { mode: "include", values: [] };
        onChange({ fields: fieldsCleared, custom: [] });
    };

    return (
        <div style={{ border: "1px solid var(--border)", borderRadius: 8, background: "var(--panel)", marginBottom: 8 }}>
            <div
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", cursor: "pointer", userSelect: "none" }}
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
                <span style={{ flex: 1 }} />
                {activeCount > 0 && (
                    <button className="small" onClick={(e) => { e.stopPropagation(); resetAll(); }}>
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
                            filter={state.fields[f.key] ?? { mode: "include", values: [] }}
                            facet={enumFacets[f.key] ?? {}}
                            lang={lang}
                            onChange={(next) => setField(f.key, next)}
                        />
                    ))}

                    <div style={{ borderTop: "1px dashed var(--border)", margin: "4px 0 2px", paddingTop: 6, display: "flex", alignItems: "center", gap: 8 }}>
                        <strong style={{ fontSize: 12, color: "var(--text-dim)" }}>{t(lang, "liz.custom.title")}</strong>
                        <span className="muted" style={{ fontSize: 11 }}>{t(lang, "liz.custom.help")}</span>
                    </div>

                    {state.custom.map((rule) => (
                        <CustomRuleRow
                            key={rule.id}
                            rule={rule}
                            facet={customFacets[rule.key.trim()] ?? {}}
                            observedKeys={observedKeys}
                            lang={lang}
                            onChange={(patch) => updateRule(rule.id, patch)}
                            onDelete={() => removeRule(rule.id)}
                        />
                    ))}

                    <div>
                        <button className="small" onClick={addRule}>+ {t(lang, "liz.custom.add")}</button>
                    </div>
                </div>
            )}
        </div>
    );
}

function ModeToggle({ mode, onChange, lang }: { mode: FilterMode; onChange: (m: FilterMode) => void; lang: Lang }) {
    return (
        <div style={{ display: "inline-flex", flexShrink: 0 }}>
            <ModeButton active={mode === "include"} onClick={() => onChange("include")} side="left">
                {t(lang, "liz.mode.include")}
            </ModeButton>
            <ModeButton active={mode === "exclude"} onClick={() => onChange("exclude")} side="right">
                {t(lang, "liz.mode.exclude")}
            </ModeButton>
        </div>
    );
}

function SelectedChips({ values, mode, lang, onRemove }: { values: string[]; mode: FilterMode; lang: Lang; onRemove: (t: string) => void }) {
    return (
        <>
            {values.map((tok) => (
                <span
                    key={tok}
                    onClick={() => onRemove(tok)}
                    title={t(lang, "liz.chip.remove")}
                    style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "2px 6px 2px 8px",
                        borderRadius: 12,
                        fontSize: 12,
                        cursor: "pointer",
                        background: mode === "include" ? "var(--accent-soft-bg)" : "rgba(214, 69, 69, 0.12)",
                        border: `1px solid ${mode === "include" ? "var(--accent-soft-border)" : "var(--danger)"}`,
                        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    }}
                >
                    {tokenLabel(tok, lang)}
                    <span style={{ fontWeight: 700, opacity: 0.7 }}>✕</span>
                </span>
            ))}
        </>
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
    const toggleValue = (token: string) => {
        const has = filter.values.includes(token);
        onChange({ ...filter, values: has ? filter.values.filter((v) => v !== token) : [...filter.values, token] });
    };

    return (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            <label style={{ width: 108, margin: 0, paddingTop: 5, flexShrink: 0 }} title={field.key}>
                {t(lang, field.labelKey)}
            </label>
            <ModeToggle mode={filter.mode} onChange={(mode) => onChange({ ...filter, mode })} lang={lang} />
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                <SelectedChips values={filter.values} mode={filter.mode} lang={lang} onRemove={toggleValue} />
                <ValueSelect
                    catalog={field.catalog}
                    nullable={field.nullable}
                    allowCustom={false}
                    wide
                    facet={facet}
                    selected={filter.values}
                    onToggle={toggleValue}
                    lang={lang}
                />
                {filter.values.length > 0 && (
                    <button className="small" onClick={() => onChange({ ...filter, values: [] })} title={t(lang, "liz.field.clear")} style={{ padding: "2px 8px" }}>
                        ✕
                    </button>
                )}
            </div>
        </div>
    );
}

function CustomRuleRow({
    rule,
    facet,
    observedKeys,
    lang,
    onChange,
    onDelete,
}: {
    rule: CustomRule;
    facet: Record<string, number>;
    observedKeys: string[];
    lang: Lang;
    onChange: (patch: Partial<CustomRule>) => void;
    onDelete: () => void;
}) {
    const toggleValue = (token: string) => {
        const has = rule.values.includes(token);
        onChange({ values: has ? rule.values.filter((v) => v !== token) : [...rule.values, token] });
    };
    const listId = `liz-keys-${rule.id}`;
    const hasKey = rule.key.trim() !== "";

    return (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            <input
                list={listId}
                value={rule.key}
                onChange={(e) => onChange({ key: e.target.value })}
                placeholder={t(lang, "liz.custom.keyPlaceholder")}
                spellCheck={false}
                style={{ width: 150, flexShrink: 0, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 }}
            />
            <datalist id={listId}>
                {observedKeys.map((k) => (
                    <option key={k} value={k} />
                ))}
            </datalist>
            <ModeToggle mode={rule.mode} onChange={(mode) => onChange({ mode })} lang={lang} />
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                <SelectedChips values={rule.values} mode={rule.mode} lang={lang} onRemove={toggleValue} />
                <ValueSelect
                    nullable
                    allowCustom
                    wide={false}
                    facet={facet}
                    selected={rule.values}
                    onToggle={toggleValue}
                    lang={lang}
                    disabled={!hasKey}
                />
            </div>
            <button className="small" onClick={onDelete} title={t(lang, "liz.custom.remove")} style={{ padding: "2px 8px", flexShrink: 0 }}>
                🗑
            </button>
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
// live occurrence count. When allowCustom is set (custom key/value rules), the
// search box doubles as a free-entry input — type a value + Enter to add it
// even if not yet observed.
function ValueSelect({
    catalog,
    nullable,
    allowCustom,
    wide,
    facet,
    selected,
    onToggle,
    lang,
    disabled,
}: {
    catalog?: readonly string[];
    nullable?: boolean;
    allowCustom: boolean;
    wide: boolean;
    facet: Record<string, number>;
    selected: string[];
    onToggle: (token: string) => void;
    lang: Lang;
    disabled?: boolean;
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
        if (nullable) push(NULL_TOKEN, tokenLabel(NULL_TOKEN, lang));
        if (catalog) {
            for (const v of catalog) push(v, v);
            for (const tok of Object.keys(facet)) if (tok !== NULL_TOKEN && !catalog.includes(tok)) push(tok, tok);
        } else {
            const observed = Object.keys(facet).filter((tok) => tok !== NULL_TOKEN);
            observed.sort((a, b) => {
                const na = Number(a), nb = Number(b);
                if (Number.isNaN(na) || Number.isNaN(nb)) return a.localeCompare(b);
                return na - nb;
            });
            for (const tok of observed) push(tok, tok);
        }
        return opts;
    }, [catalog, nullable, facet, lang]);

    const q = query.trim().toLowerCase();
    const filtered = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
    const customExists = allowCustom && query.trim() !== "" && !options.some((o) => o.token === query.trim());

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
                disabled={disabled}
                onClick={() => setOpen((o) => !o)}
                style={{ padding: "3px 10px", color: "var(--text-dim)" }}
            >
                {t(lang, "liz.select.add")} ▾
            </button>
            {open && !disabled && (
                <div
                    style={{
                        position: "absolute",
                        top: "calc(100% + 4px)",
                        left: 0,
                        zIndex: 30,
                        width: wide ? 340 : 220,
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
                            if (e.key === "Enter" && customExists) { e.preventDefault(); addCustom(); }
                            if (e.key === "Escape") setOpen(false);
                        }}
                        placeholder={allowCustom ? t(lang, "liz.select.searchOrType") : t(lang, "liz.select.search")}
                        style={{ marginBottom: 6 }}
                    />
                    <div style={{ maxHeight: 240, overflowY: "auto", display: "flex", flexDirection: "column" }}>
                        {customExists && (
                            <button className="small" onClick={addCustom} style={{ justifyContent: "flex-start", textAlign: "left", marginBottom: 4 }}>
                                {t(lang, "liz.select.addValue", { v: query.trim() })}
                            </button>
                        )}
                        {filtered.length === 0 && !customExists && (
                            <span className="muted" style={{ fontSize: 12, padding: "6px 4px" }}>{t(lang, "liz.select.empty")}</span>
                        )}
                        {filtered.map((o) => {
                            const checked = selected.includes(o.token);
                            return (
                                <label key={o.token} className="checkbox" style={{ justifyContent: "space-between", padding: "3px 4px", borderRadius: 4, color: "var(--text)", cursor: "pointer" }}>
                                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                                        <input type="checkbox" checked={checked} onChange={() => onToggle(o.token)} />
                                        <span className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={o.label}>
                                            {o.label}
                                        </span>
                                    </span>
                                    {o.count > 0 && (
                                        <span className="muted" style={{ fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{o.count}</span>
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
