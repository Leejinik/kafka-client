import { useEffect, useRef, useState } from "react";
import { Lang, t } from "../lib/i18n";
import { useBackdropClose } from "../lib/useBackdropClose";

interface Props {
    lang: Lang;
    onClose: () => void;
}

interface Section {
    id: string;
    title: string;
    body: React.ReactNode;
}

export function HelpDialog({ lang, onClose }: Props) {
    const sections = lang === "en" ? buildSectionsEn() : buildSectionsKo();
    const [active, setActive] = useState(sections[0].id);
    const bodyRef = useRef<HTMLDivElement>(null);
    const backdrop = useBackdropClose(onClose);

    useEffect(() => {
        const el = bodyRef.current;
        if (!el) return;
        const onScroll = () => {
            // Scrolled to (or near) the bottom → pin the last section.
            // Without this, short final sections never get to "scroll past the
            // top edge" so the nav never highlights them.
            if (el.scrollTop + el.clientHeight >= el.scrollHeight - 4) {
                setActive(sections[sections.length - 1].id);
                return;
            }
            const top = el.scrollTop + 8;
            let cur = sections[0].id;
            for (const s of sections) {
                const target = el.querySelector<HTMLDivElement>(`#help-${s.id}`);
                if (!target) continue;
                if (target.offsetTop - el.offsetTop <= top) cur = s.id;
                else break;
            }
            setActive(cur);
        };
        el.addEventListener("scroll", onScroll);
        return () => el.removeEventListener("scroll", onScroll);
    }, [sections]);

    const goTo = (id: string) => {
        const el = bodyRef.current?.querySelector<HTMLDivElement>(`#help-${id}`);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    };

    return (
        <div className="modal-backdrop" {...backdrop}>
            <div
                className="modal"
                style={{ width: 820, maxWidth: "96vw", height: "82vh", maxHeight: "82vh" }}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="modal-header">{t(lang, "help.dialog.title")}</div>
                <div className="modal-body" style={{ padding: 0, overflow: "hidden", flex: 1, minHeight: 0, display: "flex" }}>
                    <div
                        style={{
                            width: 180,
                            borderRight: "1px solid var(--border)",
                            overflow: "auto",
                            padding: "10px 0",
                            background: "var(--panel-2)",
                            flex: "0 0 auto",
                        }}
                    >
                        {sections.map((s) => (
                            <div
                                key={s.id}
                                onClick={() => goTo(s.id)}
                                style={{
                                    padding: "8px 14px",
                                    cursor: "pointer",
                                    fontSize: 12.5,
                                    fontWeight: active === s.id ? 600 : 400,
                                    color: active === s.id ? "var(--accent)" : undefined,
                                    borderLeft: active === s.id ? "2px solid var(--accent)" : "2px solid transparent",
                                }}
                            >
                                {s.title}
                            </div>
                        ))}
                    </div>

                    <div ref={bodyRef} style={{ flex: 1, overflow: "auto", padding: "16px 24px", fontSize: 13.5, lineHeight: 1.7 }}>
                        {sections.map((s) => (
                            <div key={s.id} id={`help-${s.id}`} style={{ marginBottom: 32 }}>
                                <h3 style={{ margin: "0 0 12px", fontSize: 16 }}>{s.title}</h3>
                                <div>{s.body}</div>
                            </div>
                        ))}
                    </div>
                </div>
                <div className="modal-footer">
                    <button onClick={onClose}>{t(lang, "help.close")}</button>
                </div>
            </div>
        </div>
    );
}

const Box: React.FC<{ kind: "tip" | "warn"; children: React.ReactNode }> = ({ kind, children }) => (
    <div
        style={{
            background: kind === "tip" ? "#eef4ff" : "#fff7ed",
            borderLeft: `3px solid ${kind === "tip" ? "var(--accent)" : "var(--warn)"}`,
            borderRadius: 4,
            padding: "8px 12px",
            margin: "10px 0",
        }}
    >
        {children}
    </div>
);

const M: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <code style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", background: "var(--panel-2)", padding: "1px 5px", borderRadius: 3, fontSize: 12 }}>
        {children}
    </code>
);

function buildSectionsKo(): Section[] {
    return [
        {
            id: "start",
            title: "1. 클러스터 추가",
            body: (
                <>
                    <p>좌측 사이드바 상단 <M>+ 추가</M> → 이름, Bootstrap servers 입력 → 저장.</p>
                    <p>등록 후 사이드바에서 클러스터 클릭 → 상단 <M>연결</M> 버튼.</p>
                    <p>브로커가 <M>broker-2:9093</M> 같이 hostname을 advertise하는데 PC에서 안 풀리면 Host alias에 <M>broker-2=192.0.2.20</M>를 적으세요.</p>
                </>
            ),
        },
        {
            id: "topics",
            title: "2. 토픽 탭",
            body: (
                <>
                    <p>토픽 행을 클릭하면 펼쳐져서 파티션 + 컨슈머 그룹이 보입니다.</p>
                    <p><b>우클릭으로 모든 작업</b>이 가능합니다:</p>
                    <ul>
                        <li>토픽 행 → 수정 / 파티션 재할당 / 삭제</li>
                        <li>빈 영역 → 토픽 생성</li>
                        <li>펼친 파티션 영역 → 파티션 재할당</li>
                        <li>펼친 그룹 카드 → Offset 변경 / 그룹 삭제</li>
                    </ul>
                </>
            ),
        },
        {
            id: "reassign",
            title: "3. 파티션 재할당",
            body: (
                <>
                    <p>chip 드래그로 replica 순서 변경. 첫 chip이 preferred leader.</p>
                    <p>chip 클릭하면 다른 broker로 교체 가능.</p>
                    <p>Execute는 변경된 파티션만 전송합니다.</p>
                    <p>진행 중인 토픽 옆에 <M>⟳ N</M> 배지가 뜹니다.</p>
                </>
            ),
        },
        {
            id: "groups",
            title: "4. Consumer Group",
            body: (
                <>
                    <p>그룹 카드 우클릭으로:</p>
                    <ul>
                        <li><b>Offset 변경</b> — earliest / latest / timestamp / 파티션별 수동</li>
                        <li><b>그룹 삭제</b></li>
                    </ul>
                    <Box kind="warn">
                        활성 그룹은 둘 다 불가합니다. 컨슈머를 모두 멈춰서 <M>Empty</M> 상태로 만든 뒤에 실행하세요.
                    </Box>
                </>
            ),
        },
        {
            id: "consume",
            title: "5. 조회",
            body: (
                <>
                    <p>모드: <b>처음부터 / 끝에서 / 오프셋 / 타임스탬프</b>.</p>
                    <p>Timestamp 컬럼:</p>
                    <ul>
                        <li><b>헤더 클릭</b> → 정렬 cycle (없음 → 내림차순 ▼ → 오름차순 ▲ → 없음)</li>
                        <li><b>헤더 우클릭</b> → 현지 시간 ↔ Unix ms 표시 전환</li>
                        <li><b>셀 hover</b> → 밀리초까지 풀 정밀도 시간 툴팁</li>
                    </ul>
                    <p><b>Value 안의 13자리 숫자</b>는 자동으로 unix ms로 인식되어 점선 밑줄 표시 + hover 시 사람 시간 툴팁 (그리드 + 디테일 패널 둘 다).</p>
                    <p>행 우클릭 → <b>저장하기</b> → 발행 탭에서 꺼내 씁니다.</p>
                    <p>디테일 패널 하단에 Unix ms ↔ 사람 시간 변환기 있음.</p>
                </>
            ),
        },
        {
            id: "produce",
            title: "6. 발행",
            body: (
                <>
                    <p>토픽 선택 → 키/값/헤더 입력 → [발행].</p>
                    <Box kind="tip">
                        <b>실수 줄이는 워크플로우</b>
                        <ol style={{ margin: "6px 0 0 18px" }}>
                            <li>조회 탭에서 비슷한 원본 메시지 찾기</li>
                            <li>우클릭 → 저장하기 (이름 지정)</li>
                            <li>발행 탭 [불러오기] → 항목 선택 → 모든 필드 자동 입력</li>
                            <li>바꿀 부분만 수정 → 발행</li>
                        </ol>
                    </Box>
                    <p><b>[불러오기]</b> 시 value가 JSON이면 자동으로 들여쓰기되어 수정하기 쉬워집니다. 저장 목록은 [내보내기]/[가져오기]로 백업·공유 가능.</p>
                    <p><b>[반복 발행]</b> — 현재 폼의 메시지를 반복 발행:</p>
                    <ul>
                        <li><b>최대 속도</b> — 가능한 한 빠르게 비동기 발행. 종료 조건은 건수 또는 시간. broker 가용 capacity 측정용</li>
                        <li><b>간격 발행</b> — N초/ms마다 1건. 컨슈머 트리거 / 흐름 확인용</li>
                        <li>다이얼로그 닫으면 자동 중지. 발행/실패/속도/경과 실시간 표시</li>
                    </ul>
                    <p>파티션 <M>-1</M>이면 키 해시 / 라운드로빈으로 자동 배정. 특정 파티션 강제 시 0, 1, 2 ...</p>
                </>
            ),
        },
        {
            id: "danger",
            title: "7. 되돌릴 수 없는 작업",
            body: (
                <>
                    <Box kind="warn">
                        실행 전에 <b>상단의 클러스터 이름</b>이 운영 환경이 아닌지 한 번 더 확인하세요.
                    </Box>
                    <ul>
                        <li><b>토픽 삭제</b> — 모든 메시지 영구 소실</li>
                        <li><b>그룹 삭제</b> — committed offsets 전부 사라짐</li>
                        <li><b>Offset → earliest/latest</b> — 누락 또는 재처리 발생</li>
                        <li><b>파티션 재할당</b> — 대용량 데이터 이동, 클러스터 부하</li>
                        <li><b>반복 발행 (최대 속도)</b> — 안전장치 없음. 운영 토픽에 무한히 폭주할 수 있음</li>
                    </ul>
                </>
            ),
        },
    ];
}

function buildSectionsEn(): Section[] {
    return [
        {
            id: "start",
            title: "1. Add a cluster",
            body: (
                <>
                    <p>Sidebar → <M>+ Add</M> → name + bootstrap servers → Save. Then click the cluster and press <M>Connect</M> in the top bar.</p>
                    <p>If brokers advertise hostnames your machine can't resolve, add Host aliases (e.g. <M>broker-2=192.0.2.20</M>).</p>
                </>
            ),
        },
        {
            id: "topics",
            title: "2. Topics tab",
            body: (
                <>
                    <p>Click a topic to expand it (partitions + consumer groups).</p>
                    <p>Every action lives behind right-click:</p>
                    <ul>
                        <li>Topic row → edit / reassign / delete</li>
                        <li>Empty area → create topic</li>
                        <li>Partition area in expanded view → reassign</li>
                        <li>Group card in expanded view → reset offsets / delete group</li>
                    </ul>
                </>
            ),
        },
        {
            id: "reassign",
            title: "3. Partition reassign",
            body: (
                <>
                    <p>Drag chips to reorder replicas. First chip = preferred leader. Click a chip to swap brokers. Execute sends only the changed partitions.</p>
                </>
            ),
        },
        {
            id: "groups",
            title: "4. Consumer groups",
            body: (
                <>
                    <p>Right-click a group card to reset offsets (earliest / latest / timestamp / per-partition) or delete.</p>
                    <Box kind="warn">
                        Kafka rejects both while consumers are live. Stop them first; the menu is disabled when the state is Stable / PreparingRebalance / CompletingRebalance.
                    </Box>
                </>
            ),
        },
        {
            id: "consume",
            title: "5. Consume",
            body: (
                <>
                    <p>Modes: <b>Beginning / End / Offset / Timestamp</b>.</p>
                    <p>Timestamp column:</p>
                    <ul>
                        <li><b>Click header</b> → sort cycle (none → desc ▼ → asc ▲ → none)</li>
                        <li><b>Right-click header</b> → toggle local time / Unix ms</li>
                        <li><b>Hover a cell</b> → full-precision time tooltip</li>
                    </ul>
                    <p>Any <b>13-digit number inside Value</b> is auto-detected as unix ms (dotted underline + hover tooltip), in both grid and detail panel.</p>
                    <p>Right-click a row → <b>Save</b>, then pull it from the Produce tab's Load button.</p>
                </>
            ),
        },
        {
            id: "produce",
            title: "6. Produce",
            body: (
                <>
                    <p>Pick a topic, fill key/value/headers, send.</p>
                    <Box kind="tip">
                        <b>Recommended workflow</b>
                        <ol style={{ margin: "6px 0 0 18px" }}>
                            <li>Find a real example in the Consume tab</li>
                            <li>Right-click → Save (give it a name)</li>
                            <li>In Produce, click <M>[Load]</M> → pick it → all fields auto-fill</li>
                            <li>Edit only what differs → Send</li>
                        </ol>
                    </Box>
                    <p><b>[Load]</b> auto-formats JSON values for easier editing. Saved list can be exported/imported.</p>
                    <p><b>[Loop produce]</b> — repeat the current form's message:</p>
                    <ul>
                        <li><b>Max throughput</b> — async firehose. Stop on count or duration. Measures broker capacity</li>
                        <li><b>Interval</b> — one message every N ms/sec. For triggering consumers</li>
                        <li>Closing the dialog auto-stops. Live counters: sent / failed / rate / elapsed</li>
                    </ul>
                    <p>Use partition <M>-1</M> for auto (key hash / round-robin), or a specific partition number to force placement.</p>
                </>
            ),
        },
        {
            id: "danger",
            title: "7. Irreversible actions",
            body: (
                <>
                    <Box kind="warn">
                        Re-check the cluster name in the top bar before any destructive action.
                    </Box>
                    <ul>
                        <li><b>Delete topic</b> — drops all messages</li>
                        <li><b>Delete group</b> — loses all committed offsets</li>
                        <li><b>Reset to earliest / latest</b> — gaps or re-processing</li>
                        <li><b>Reassignment</b> — heavy data movement</li>
                        <li><b>Loop produce (max throughput)</b> — no safety limit; can flood a prod topic</li>
                    </ul>
                </>
            ),
        },
    ];
}
