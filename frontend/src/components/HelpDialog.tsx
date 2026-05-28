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
            background: kind === "tip" ? "var(--accent-soft-bg)" : "var(--warn-soft-bg)",
            borderLeft: `3px solid ${kind === "tip" ? "var(--accent)" : "var(--warn)"}`,
            color: "var(--text)",
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
                    <p><b>그룹 카드의 Committed / End Offset / Lag 셀에 hover</b>하면 10초 간격으로 측정한 <b>초당 변화량</b>이 툴팁으로 표시됩니다. End Offset은 발행 속도(<M>publish/sec</M>), Committed는 소비 속도, Lag는 lag 증감 추이 파악용. 펼친 직후 첫 샘플은 기준값이라 두 번째 SLOW tick부터 값이 나옵니다.</p>
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
                    <p>모드: <b>처음부터 / 끝에서 / 오프셋 이후 / 오프셋 이전 / 타임스탬프 범위 / tail -f</b>.</p>
                    <ul>
                        <li><b>오프셋 이후</b> — 입력한 오프셋부터 (포함) 그 이후로 limit개. 입력값이 그리드 첫 행에 노출됨</li>
                        <li><b>오프셋 이전</b> — 입력한 오프셋까지 (포함) 그 이전으로 limit개. 입력값은 그리드 마지막 행에 위치 (Kafka는 항상 offset 오름차순 반환). Offset 컬럼을 ▼ 정렬하면 입력값이 row 1로 옴</li>
                        <li>오프셋 두 모드 모두 입력값을 <b>모든 파티션</b>에 동일 적용. 멀티 파티션이면 limit이 파티션 수로 나뉘어 분배됨</li>
                    </ul>

                    <p><b>타임스탬프 범위</b> — 시작/종료 타임스탬프를 받아 그 사이 메시지를 가져옵니다. 종료는 비워두면 현재 log end까지.</p>
                    <ul>
                        <li>윈도우 내 메시지가 수억 건이어도 OK — <b>한 페이지에 {`최대 메시지 수`}만큼</b> (기본 1000건) 페이지네이션</li>
                        <li>입력 형식: Unix ms 숫자 또는 ISO 8601 문자열 (<M>2026-05-28T10:00:00</M>)</li>
                        <li>1페이지 가져온 직후 카운트 옆에 페이지 컨트롤 표시:
                            <ul>
                                <li><M>« 처음</M> / <M>← 이전</M> / <M>페이지 N / 총M</M> / <M>다음 →</M> / <M>마지막 »</M></li>
                                <li>오른쪽에 <M>범위 내 총 N건</M> 라벨로 윈도우 전체 건수 표시</li>
                            </ul>
                        </li>
                        <li><M>#</M> 컬럼은 페이지를 넘어가도 누적 증가 (페이지 2 = 1001 ~ ...)</li>
                        <li><M>마지막 »</M>으로 점프하면 중간 페이지 cursor가 없어 ← 이전이 잠깁니다. « 처음으로 돌아가서 순차 탐색 가능</li>
                    </ul>

                    <p><b>tail -f (실시간)</b> — 토픽의 현재 끝부터 새로 들어오는 메시지를 스트리밍.</p>
                    <ul>
                        <li>모드 선택 즉시 시작, limit / timeout 무시. 가져오기 버튼이 <b>중지</b>로 토글</li>
                        <li>중지 누르면 모드/limit/timeout이 기본값(끝에서/1000/8000)으로 복원, 수신된 메시지는 그대로 유지</li>
                        <li><b>자동 스크롤</b> (follow): 새 메시지가 도착할 때마다 그리드 맨 아래를 따라감</li>
                        <li><b>마우스 휠</b> → follow 해제, 그 자리에 멈춤</li>
                        <li><b>Shift + G</b> → 다시 맨 아래로 점프 + follow 재개</li>
                        <li><b>Ctrl + C</b> (이스터에그) → SIGINT처럼 tail 종료. 텍스트 선택 중이거나 입력창 포커스 시엔 일반 복사로 동작</li>
                    </ul>

                    <p><b>가져오기 / 중단</b> — 일반 조회 중에도 결과가 다 차기 전에 <b>중단</b> 버튼으로 취소 가능. 그때까지 모은 메시지가 그리드에 표시됩니다.</p>

                    <p><b>가져오기 옆 카운트</b> <M>{"{shown} / {total} 건"}</M> — 가져온 총 건수와 (검색 시) 필터 후 표시 건수. limit이 1000이어도 989건만 있으면 989로 표시.</p>
                    <p>그리드 맨 왼쪽 <M>#</M> 컬럼은 1부터 시작하는 행 인덱스 (페이지네이션 모드에서는 페이지 누적).</p>
                    <p><b>헤더 클릭으로 정렬 cycle</b> (없음 → 내림차순 ▼ → 오름차순 ▲ → 없음):</p>
                    <ul>
                        <li><b>Offset 컬럼</b> — 같은 파티션 내에서 offset 순. 멀티 파티션이면 파티션 번호 우선</li>
                        <li><b>Timestamp 컬럼</b> — 타임스탬프 순</li>
                        <li>두 컬럼은 상호배타. 하나 클릭하면 다른 컬럼 정렬은 해제</li>
                    </ul>
                    <p>Timestamp 컬럼 기타:</p>
                    <ul>
                        <li><b>헤더 우클릭</b> → 현지 시간 ↔ Unix ms 표시 전환</li>
                        <li><b>셀 hover</b> → 밀리초까지 풀 정밀도 시간 툴팁</li>
                    </ul>
                    <p><b>Value 안의 13자리 숫자</b>는 자동으로 unix ms로 인식되어 점선 밑줄 표시 + hover 시 사람 시간 툴팁 (그리드 + 디테일 패널 둘 다).</p>
                    <p>행 우클릭 → <b>저장하기</b> → 발행 탭에서 꺼내 씁니다.</p>
                    <p>디테일 패널 하단에 Unix ms ↔ 사람 시간 변환기 있음.</p>

                    <p><b>고급 검색</b> — 검색 행 오른쪽 <M>고급 검색</M> 버튼:</p>
                    <ul>
                        <li>누르면 같은 줄의 검색 input / 정규식 / 대소문자 체크박스가 사라지고, 그 자리에 <b>토큰 카드</b>가 표시됩니다. 값/키/헤더 listbox는 유지</li>
                        <li>각 카드 = CSV로 입력한 토큰 묶음. 카드의 모든 토큰이 대상 필드에 <b>case-insensitive substring</b>으로 모두 포함된 메시지 수가 카드에 표시됩니다</li>
                        <li>예: 값 모드 + 카드 토큰 <M>help, common</M> → <M>{`{"a":"help","b":"common"}`}</M>은 매치, <M>{`{"a":"hello","b":"common"}`}</M>는 help가 없으니 불매치</li>
                        <li><M>+ 카드 추가</M>로 최대 <b>5개</b>까지 추가 가능. 카드별로 독립 count — "조건 A vs B vs C" 비교 분석용</li>
                        <li>카드 클릭 → 팝업 다이얼로그에서 CSV 편집 (Ctrl+Enter로 확인). <M>×</M>로 카드 삭제 (마지막 1개는 삭제 불가)</li>
                        <li>고급 검색 중에는 그리드 필터링은 적용되지 않음 — 카드는 카운트만 표시</li>
                        <li><M>고급 검색 종료</M>로 일반 검색 모드 복귀, 카드는 메모리에 유지</li>
                    </ul>
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
        {
            id: "settings",
            title: "8. 설정 (언어 / 테마)",
            body: (
                <>
                    <p>좌측 사이드바 하단 <M>설정</M>에서 언어와 테마를 변경할 수 있습니다.</p>
                    <p><b>테마</b> — 5가지 옵션, 선택값은 <M>localStorage</M>에 저장됩니다:</p>
                    <ul>
                        <li><b>시스템 따라가기</b> — OS의 다크/라이트 설정에 자동으로 맞춤 (<M>prefers-color-scheme</M> 변경도 실시간 반영)</li>
                        <li><b>Light</b> — 기본 밝은 테마</li>
                        <li><b>Dark</b> — 슬레이트 계열의 다크 테마</li>
                        <li><b>Onion</b> — 크림 배경 + ONION 브랜드 오렌지 (#FF9425) 액센트. 사이드바에 컬러 워드마크 표시</li>
                        <li><b>Dark Onion</b> — 거의 검정 (#0a0a0a) 표면 + 오렌지 액센트. 화이트 워드마크 사용</li>
                    </ul>
                    <p><b>언어</b> — 한국어 / English. 변경 즉시 모든 라벨·도움말이 전환됩니다.</p>
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
                    <p><b>Hover the Committed / End Offset / Lag cells</b> on a group card to see the <b>per-second delta</b> measured over the 10s SLOW tick interval. End Offset shows publish rate (<M>publish/sec</M>), Committed shows consume rate, Lag shows whether lag is growing or shrinking. The first sample after expand is the baseline — values appear from the second SLOW tick onward.</p>
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
                    <p>Modes: <b>Beginning / End / Offset (after) / Offset (before) / Timestamp range / tail -f</b>.</p>
                    <ul>
                        <li><b>Offset (after)</b> — from the given offset inclusive, forward, up to limit. The input value shows up as row 1</li>
                        <li><b>Offset (before)</b> — up to the given offset inclusive, backward, up to limit. Since Kafka always returns records in ascending offset order, the input value ends up as the last row. Click the Offset header ▼ to bring it to row 1</li>
                        <li>Both offset modes apply the same offset to <b>every partition</b>. For multi-partition topics the limit is split evenly across partitions</li>
                    </ul>

                    <p><b>Timestamp range</b> — fetches messages whose timestamps fall between the start/end inputs. Leave end blank to mean "current log end".</p>
                    <ul>
                        <li>Window can hold hundreds of millions of records — results are <b>paginated by the Max-messages input</b> (default 1000 per page)</li>
                        <li>Input format: Unix ms or ISO 8601 (<M>2026-05-28T10:00:00</M>)</li>
                        <li>After the first page, pagination controls appear next to the count pill:
                            <ul>
                                <li><M>« First</M> / <M>← Prev</M> / <M>Page N / total</M> / <M>Next →</M> / <M>Last »</M></li>
                                <li>A <M>N total in range</M> label on the right shows the window's total record count</li>
                            </ul>
                        </li>
                        <li>The <M>#</M> column keeps incrementing across page turns (page 2 starts at 1001…)</li>
                        <li>Jumping with <M>Last »</M> skips the cursor history of intermediate pages, so ← Prev is disabled. Use « First to start sequential pagination again</li>
                    </ul>

                    <p><b>tail -f (live)</b> — streams new records from the topic's current end.</p>
                    <ul>
                        <li>Starts the instant the mode is selected; limit / timeout are ignored. The Fetch button toggles to <b>Stop</b></li>
                        <li>Stop restores mode/limit/timeout to defaults (End / 1000 / 8000); received messages stay on screen</li>
                        <li><b>Auto-follow</b>: each new batch pins the view to the bottom</li>
                        <li><b>Mouse wheel</b> → pauses follow, freezes at that position</li>
                        <li><b>Shift + G</b> → snaps back to bottom and resumes follow</li>
                        <li><b>Ctrl + C</b> (easter egg) → stops tail like SIGINT. When text is selected or an input has focus it falls back to normal copy</li>
                    </ul>

                    <p><b>Fetch / Cancel</b> — for ordinary fetches you can also cancel mid-way with the <b>Cancel</b> button; whatever was collected so far still shows in the grid.</p>

                    <p><b>Count pill next to Fetch</b> <M>{"{shown} / {total}"}</M> — total records fetched and (when search is active) how many remain after filtering. If limit is 1000 but only 989 exist, the pill shows 989.</p>
                    <p>The leftmost <M>#</M> column is a 1-based row index (cumulative across pages in pagination mode).</p>
                    <p><b>Click a sortable header to cycle sort</b> (none → desc ▼ → asc ▲ → none):</p>
                    <ul>
                        <li><b>Offset column</b> — by offset within a partition. Multi-partition: partition first, then offset</li>
                        <li><b>Timestamp column</b> — by timestamp</li>
                        <li>The two columns are mutually exclusive; clicking one clears the other's sort</li>
                    </ul>
                    <p>Timestamp column extras:</p>
                    <ul>
                        <li><b>Right-click header</b> → toggle local time / Unix ms</li>
                        <li><b>Hover a cell</b> → full-precision time tooltip</li>
                    </ul>
                    <p>Any <b>13-digit number inside Value</b> is auto-detected as unix ms (dotted underline + hover tooltip), in both grid and detail panel.</p>
                    <p>Right-click a row → <b>Save</b>, then pull it from the Produce tab's Load button.</p>

                    <p><b>Advanced search</b> — the <M>Advanced</M> button on the right side of the search row:</p>
                    <ul>
                        <li>Hides the search input and the regex / case-sensitive checkboxes on the same row; keeps the value/key/headers target dropdown. <b>Token cards</b> appear in their place</li>
                        <li>Each card is a CSV-parsed list of tokens. The card's count is the number of messages whose target field contains <b>every token</b> as a case-insensitive substring</li>
                        <li>Example: value mode + tokens <M>help, common</M> → matches <M>{`{"a":"help","b":"common"}`}</M>; <M>{`{"a":"hello","b":"common"}`}</M> doesn't match (no "help")</li>
                        <li><M>+ Add card</M> up to <b>5 cards</b>. Each card counts independently — useful for "A vs B vs C" comparisons</li>
                        <li>Click a card → dialog with a CSV textarea (Ctrl+Enter submits). <M>×</M> removes a card; the last one can't be deleted</li>
                        <li>In advanced mode the grid is NOT filtered — cards report counts only</li>
                        <li><M>Exit advanced</M> returns to the basic search mode; cards stay in memory</li>
                    </ul>
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
        {
            id: "settings",
            title: "8. Settings (language / theme)",
            body: (
                <>
                    <p>Open <M>Settings</M> at the bottom of the sidebar to change language and theme.</p>
                    <p><b>Theme</b> — 5 options, persisted in <M>localStorage</M>:</p>
                    <ul>
                        <li><b>Follow system</b> — tracks the OS light/dark setting and reacts to <M>prefers-color-scheme</M> changes live</li>
                        <li><b>Light</b> — the default bright palette</li>
                        <li><b>Dark</b> — slate-based dark surfaces</li>
                        <li><b>Onion</b> — cream background + ONION brand orange (#FF9425) accent. Color wordmark shown in the sidebar</li>
                        <li><b>Dark Onion</b> — near-black surface (#0a0a0a) + orange accent. White wordmark</li>
                    </ul>
                    <p><b>Language</b> — Korean / English. Switches all labels and help text immediately.</p>
                </>
            ),
        },
    ];
}
