import { useEffect, useRef, useState } from "react";
import { Lang, t } from "../lib/i18n";
import { Modal } from "./Modal";

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
        <Modal
            title={t(lang, "help.dialog.title")}
            width={820}
            height="82vh"
            maxHeight="82vh"
            bodyStyle={{ padding: 0, overflow: "hidden", flex: 1, minHeight: 0, display: "flex" }}
            onClose={onClose}
            footer={<button onClick={onClose}>{t(lang, "help.close")}</button>}
        >
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
        </Modal>
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
            id: "layout",
            title: "1. 화면 구성",
            body: (
                <>
                    <p><b>사이드바</b> — 등록한 클러스터 목록. 우측 가장자리를 <b>드래그</b>해서 폭을 조절할 수 있고 값은 저장됩니다 (더블 클릭하면 초기화).</p>
                    <ul>
                        <li>상단 <M>+ 추가</M> 버튼으로 새 클러스터 등록</li>
                        <li>클러스터 항목 좌측 <span style={{color:"#16a34a"}}>●</span> 초록 = 연결됨, 회색 = 끊김</li>
                        <li>클러스터 행 <b>우클릭</b> → 수정 / 삭제</li>
                        <li>하단 <M>📖 도움말</M> 버튼이 이 다이얼로그를 다시 엽니다</li>
                    </ul>
                    <p><b>상단바(topbar)</b> — 현재 선택된 클러스터 이름 + <M>(controller: B<i>n</i>)</M> 표시 (연결되어 있을 때만). 우측 <M>연결</M> / <M>연결 끊기</M> 버튼.</p>
                    <p><b>탭</b> — 토픽 / 조회 / 발행 / 설정. 연결되지 않은 상태에서는 설정 외 탭은 잠깁니다.</p>
                    <p><b>Unix 타임스탬프 계산기 모드</b> — 클러스터에 연결하지 않은 빈 화면의 <M>Unix 타임스탬프 계산기</M> 버튼을 누르면 사이드바·상단바·탭 등 Kafka UI가 모두 사라지고, 창이 작게 줄어든 채 <b>Unix ms ↔ 사람 시간 변환기</b>만 단독으로 뜹니다. <b>항상 위</b> 체크박스로 다른 창 위에 고정할 수 있고, <M>Kafka Client 모드로 전환</M> 버튼을 누르면 원래 앱 화면과 창 크기로 돌아오면서 항상-위도 해제됩니다. (조회 탭 디테일 패널 하단에도 동일한 변환기가 있습니다 — 6번 참고.)</p>
                    <p><b>탭 상태 유지</b> — 탭을 옮겨도 각 탭의 상태가 그대로 보존됩니다. 조회 탭에 걸어둔 <M>tail -f</M>는 다른 탭에 있는 동안에도 계속 돌면서 메시지를 모으고, 조회 결과·검색·페이지 위치, 발행 폼의 키/값/헤더도 그대로 남아 있습니다. 예: 조회에서 tail 켜고 → 발행에서 메시지 보낸 뒤 → 조회로 돌아오면 그 사이 들어온 메시지까지 이어서 보입니다. (다른 클러스터로 전환하면 초기화. 토픽 탭은 숨겨진 동안 폴링을 멈췄다가 돌아오면 재개합니다.)</p>
                    <p><b>토픽 상태 공유</b> — 조회와 발행 탭은 같은 선택 토픽을 공유합니다. 한쪽에서 토픽을 바꾸면 다른 쪽도 따라옵니다 (단, 다른 클러스터로 전환하면 초기화). 조회 탭에서 tail이 도는 중에는 발행 쪽에서 토픽을 바꿔도 진행 중인 tail은 끊기지 않습니다.</p>
                    <p><b>모달(다이얼로그) 공통 조작</b> — 모든 팝업은 <b>헤더를 드래그</b>해 위치를 옮기고 <b>우하단 모서리</b>를 끌어 크기를 조절할 수 있습니다. 닫기는 <b>ESC</b> 또는 헤더 우측 <M>×</M>로만 가능 — <b>바깥의 어두운 영역을 클릭해도 닫히지 않습니다</b> (실수로 닫히는 것 방지). 저장/삭제 등 작업이 진행 중일 때는 닫기가 잠깁니다.</p>
                </>
            ),
        },
        {
            id: "start",
            title: "2. 클러스터 추가",
            body: (
                <>
                    <p>좌측 사이드바 상단 <M>+ 추가</M> → 다이얼로그에서 입력 후 저장.</p>
                    <ul>
                        <li><b>브로커 테이블</b> — 행 하나가 브로커 한 대이고 <b>호스트명 · IP(선택) · 포트</b>를 넣습니다. <M>+ 브로커 추가</M>로 여러 대 등록. 호스트명이 PC에서 안 풀리면 <b>IP 칸</b>에 실제 주소를 넣으면 됩니다(<M>/etc/hosts</M> 대신). 이 표에서 Bootstrap servers·Host alias가 자동 생성됩니다.</li>
                        <li><b>기본 토픽</b> (선택) — 연결 후 조회/발행 탭이 처음 열릴 때 자동 선택될 토픽</li>
                        <li><b>SSL 사용</b> (선택) — 체크하면 <b>인증서 팝업</b>이 떠서 인증서를 받습니다 (아래 참고)</li>
                        <li><b>Schema Registry URL</b> (선택)</li>
                        <li><b>연결 테스트</b> — 저장 전에 reach 확인 + <b>확인된 브로커 목록·controller</b>를 보여줍니다</li>
                    </ul>
                    <p>등록 후 사이드바에서 클릭 → 상단바 <M>연결</M>. 연결되면 controller broker 번호가 옆에 표시되고 토픽/조회/발행 탭이 열립니다.</p>
                    <Box kind="tip">
                        프로필은 <M>~/.kafka-client/profiles.json</M>에 저장됩니다. 설정 탭의 <b>프로필 가져오기/내보내기</b>로 PC 간 옮기거나 동료에게 공유할 수 있어요.
                    </Box>
                    <p style={{ marginTop: 16 }}><b>SSL 연결 (1-way)</b></p>
                    <p>브로커가 <M>SSL://…:9292</M> 같은 SSL 리스너로 열려 있을 때 씁니다. 서버 인증만 하는 1-way(<M>ssl.client.auth=none</M>)면 <b>CA 인증서 하나</b>면 됩니다.</p>
                    <ol>
                        <li><b>브로커 테이블</b> — <b>IP</b>(예: <M>192.168.1.171</M>)와 <b>포트</b>(SSL 포트, 예: <M>9292</M>)를 넣습니다. <b>호스트명은 인증서에서 자동으로 채워지니</b> 보통 비워둬도 됩니다. IP로 접속하되 인증서는 호스트명(CN)으로 검증합니다.</li>
                        <li><b>SSL 사용</b> 체크 → 뜨는 <b>인증서 팝업</b>에서 인증서를 받습니다. <b>CA 인증서</b>(예: <M>ca.xxx.crt</M>, 전체 검증)든 <b>브로커 인증서</b>(예: <M>kafka1.xxx.crt</M>, 핀닝)든 자동 판별합니다. <b>브로커 인증서를 받으면 그 안의 호스트명(CN)이 브로커 표에 자동 입력</b>됩니다. 파일·붙여넣기·<M>원격에서 가져오기(SSH)</M> 지원 — SSH는 브로커 테이블 IP를 드롭다운으로 골라 호스트별로 개별 접속합니다.</li>
                        <li><b>연결 테스트</b> → OK + 확인된 브로커가 뜨면 저장.</li>
                    </ol>
                    <Box kind="tip">
                        Kafka SSL 인증서는 보통 <b>SAN 없이 CN만</b> 들어 있습니다. 이 툴은 CA로 <b>체인은 정상 검증</b>하면서 호스트명은 CN으로 대조하므로 그런 레거시 인증서도 그대로 붙습니다 (MITM 방어 유지). <b>2-way mTLS</b>(<M>ssl.client.auth=required</M>)면 <M>고급</M>에서 클라이언트 인증서/키를 추가하세요. 검증 자체를 끄는 <b>인증서 검증 건너뛰기</b>는 테스트용이며 MITM에 노출됩니다.
                    </Box>
                </>
            ),
        },
        {
            id: "topics",
            title: "3. 토픽 탭",
            body: (
                <>
                    <p>상단 <M>토픽 검색</M> input으로 토픽 이름을 필터링 (대소문자 무시 substring).</p>
                    <p>토픽 행을 클릭하면 펼쳐져서 <b>파티션 상세 (Leader / Replicas / ISR / Offline)</b>와 <b>해당 토픽을 소비 중인 컨슈머 그룹 카드</b>가 모두 보입니다.</p>
                    <p><b>우클릭으로 모든 작업</b>이 가능합니다:</p>
                    <ul>
                        <li>토픽 행 → 수정 / 파티션 재할당 / 삭제</li>
                        <li>빈 영역 → 토픽 생성 (이름 / 파티션 수 / RF / 커스텀 configs)</li>
                        <li>펼친 파티션 영역 → 파티션 재할당</li>
                        <li>펼친 그룹 카드 → Offset 변경 / 그룹 삭제</li>
                    </ul>
                    <p><b>ms 단위 config 입력 (🧮)</b> — 토픽 생성/수정 다이얼로그에서 <M>retention.ms</M>·<M>segment.ms</M>처럼 <M>.ms</M>로 끝나는 항목 옆 <M>🧮</M> 버튼을 누르면 <b>일·시·분</b> ± 버튼으로 값을 쌓아 ms로 환산해 넣을 수 있습니다 (외부 계산기 불필요). 각 단위는 0 미만으로 내려가지 않으며 초·ms 단위는 제외됩니다.</p>
                    <p><b>msg/sec 컬럼</b> — 최근 60초 메시지 수 ÷ 60 (1초마다 갱신). End offset 변화량 기반.</p>
                    <p><b>그룹 카드 partition Lag 표</b>는 컨슈머 그룹별로 partition 단위 Committed / End / Lag를 보여줍니다. 멤버가 표시되며 partition 할당이 없는 멤버는 <M>(할당 없음 / standby)</M>로 표시됩니다.</p>
                    <p><b>Committed / End Offset / Lag 셀에 hover</b>하면 10초 간격으로 측정한 <b>초당 변화량</b>이 툴팁으로 표시됩니다. End Offset은 발행 속도(<M>publish/sec</M>), Committed는 소비 속도, Lag는 lag 증감 추이 파악용. 펼친 직후 첫 샘플은 기준값이라 두 번째 SLOW tick부터 값이 나옵니다.</p>
                    <p className="muted" style={{ fontSize: 12 }}>백그라운드 갱신: FAST 1초 (파티션 leader/ISR, msg/sec, 진행 중 재할당) / SLOW 10초 (토픽 목록, 그룹 lag).</p>
                </>
            ),
        },
        {
            id: "reassign",
            title: "4. 파티션 재할당",
            body: (
                <>
                    <p>partition 행마다 <b>RF만큼의 chip</b>이 broker 번호로 표시됩니다. 첫 chip이 <b>preferred leader</b>.</p>
                    <p><b>Leader 칼럼은 클러스터의 실제 live 리더</b>를 보여줍니다. 이게 preferred(replica[0])와 다르면 <M>≠Bn</M> 경고와 상단 <M>⚑ 리더 불일치</M>가 표시됩니다.</p>
                    <ul>
                        <li><b>chip 드래그</b> → replica 순서 변경 = <b>preferred leader 변경(재할당)</b></li>
                        <li><b>chip 클릭</b> → 다른 broker로 교체</li>
                        <li>행별 <M>↺</M> → <b>그 행의 편집만 원래대로 되돌리기</b> (편집했을 때만 표시되며 아무것도 실행하지 않음). 전체는 상단 <b>전체 초기화</b></li>
                        <li><b>변경된 행만 보기</b> 토글 — 큰 토픽에서 변경분만 확인할 때</li>
                        <li><M>Execute</M>는 <b>변경된 파티션만</b> Kafka에 전송</li>
                    </ul>
                    <div style={{ background: "var(--warn-soft-bg)", border: "1px solid var(--warn)", borderRadius: 6, padding: "8px 12px", margin: "10px 0" }}>
                        <b>리더가 안 바뀐다고요?</b> replica 순서를 바꾸는 재할당(Execute)은 <b>preferred</b> 리더만 지정합니다. 실제 리더를 옮기려면 <b>preferred leader election</b>이 필요합니다. replica가 이미 원하는 순서라면 재할당은 “0개 변경됨”이 되고 아무 일도 일어나지 않습니다.
                    </div>
                    <p><b>즉시 수정</b> 체크박스(기본 켜짐)가 Execute의 적용 범위를 정합니다:</p>
                    <ul>
                        <li><M>즉시 수정</M> 체크 + <M>Execute</M> → 재할당과 함께 preferred 리더를 <b>실제 리더로 즉시 선출</b>합니다. 리더만 불일치하면 변경분이 0이어도 처리됩니다. 실행 전 <b>리더 이동 경고</b>가 한 번 뜨고, <M>그래도 실행</M>을 다시 눌러야 적용됩니다 (연결된 producer/consumer가 잠깐 재연결될 수 있음).</li>
                        <li><M>즉시 수정</M> 해제 + <M>Execute</M> → 재할당만 (preferred만 변경, 실제 리더는 다음 리밸런스/선출 때까지 그대로).</li>
                        <li>선출은 해당 replica가 <b>ISR에 있어야 성공</b>합니다. ISR에 없으면 거부되고 사유가 표시됩니다 (다른 파티션은 계속 진행).</li>
                    </ul>
                    <p>진행 중인 토픽 옆에는 <M>⟳ N</M> 배지가 뜹니다 (FAST tick으로 자동 갱신).</p>
                </>
            ),
        },
        {
            id: "groups",
            title: "5. Consumer Group",
            body: (
                <>
                    <p>그룹 카드 우클릭 → <b>Offset 변경</b> 또는 <b>그룹 삭제</b>.</p>
                    <p><b>Offset 변경 모드 4종</b>:</p>
                    <ul>
                        <li><b>처음으로 (earliest)</b> — 모든 파티션을 가장 오래된 메시지 직전 offset으로</li>
                        <li><b>끝으로 (latest)</b> — 모든 파티션을 현재 log end로 (이전 메시지는 안 본다는 뜻)</li>
                        <li><b>특정 timestamp</b> — ISO 8601 또는 unix ms 입력. 각 partition에서 해당 시각 이후 첫 offset으로</li>
                        <li><b>파티션별 특정 offset</b> — partition마다 현재/End를 보여주는 표에 직접 새 offset 입력</li>
                    </ul>
                    <Box kind="warn">
                        활성 그룹은 둘 다 불가합니다. 컨슈머를 모두 멈춰서 <M>Empty</M>/<M>Dead</M> 상태로 만든 뒤에 실행하세요. 메뉴 자체가 비활성화됩니다.
                    </Box>
                </>
            ),
        },
        {
            id: "consume",
            title: "6. 조회",
            body: (
                <>
                    <p>상단 툴바: 토픽 / 모드 / (조건 입력) / 최대 메시지 수 / <b>페이지 단위</b> / 타임아웃(ms) / <M>가져오기</M>. 숫자 입력 칸(<M>최대 메시지 수</M>·<M>타임아웃 (ms)</M>) 앞에는 항목 이름 라벨이 항상 표시됩니다 — 더 이상 마우스를 올려야 보이는 툴팁이 아닙니다.</p>
                    <ul>
                        <li><b>tail -f</b> 모드에선 모든 보조 인풋이 숨겨집니다 (의미가 없으므로)</li>
                        <li><b>타임스탬프 범위</b> 모드에선 단일 페이지가 없으므로 최대 메시지 수 입력이 사라지고 <b>페이지 단위</b> 드롭다운만 노출</li>
                    </ul>
                    <p><b>최대 메시지 수 입력 규칙</b>:</p>
                    <ul>
                        <li><b>빈 칸 / 0</b> 으로 두고 <M>가져오기</M> 누르면 자동으로 <M>1000</M>(기본값)으로 보정</li>
                        <li><b>-1</b> = <b>커서 페이지네이션</b> (처음/끝/오프셋 이후/이전에서만 허용). 첫 [가져오기] 후 그리드 위에 <M>« 처음</M> / <M>← 이전</M> / <M>다음 →</M> 버튼이 나타나고, 받아온 건수가 페이지 단위 미만이 되는 순간(=로그 경계)까지 계속 다음 페이지로 이동 가능. 모드의 자연 방향대로 이어 받음 — 끝/오프셋 이전은 점점 오래된 메시지로, 처음/오프셋 이후는 점점 새 메시지로</li>
                        <li>최대 메시지 수 / 타임아웃 칸에서 <b>Enter</b> 키 = <M>가져오기</M> 클릭과 동일</li>
                    </ul>
                    <p><b>페이지 단위</b> 드롭다운 — <M>1000</M> / <M>10000</M> / <M>50000</M>:</p>
                    <ul>
                        <li>모든 페이지네이션(타임스탬프 · 커서)에서 한 페이지에 받아올 메시지 수</li>
                        <li>고급 검색은 현재 페이지 안에서만 동작 — 더 넓게 검색하려면 50000으로 키워서 한 번에 더 많이 받기</li>
                        <li>선택값은 localStorage에 저장. 이미 결과를 띄워둔 상태에서 단위를 바꾸면 1페이지로 <b>자동 재조회</b>됨</li>
                    </ul>
                    <p>모드: <b>Oldest / Newest / 오프셋 이후 / 오프셋 이전 / 타임스탬프 범위 / tail -f</b>.</p>
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
                                <li><M>« 처음</M> / <M>← 이전</M> / <M>페이지 N / 총M</M>(<b>드롭다운 클릭 = 임의 페이지로 한 번에 이동</b>) / <M>다음 →</M> / <M>마지막 »</M></li>
                                <li>오른쪽에 <M>범위 내 총 N건</M> 라벨로 윈도우 전체 건수 표시</li>
                            </ul>
                        </li>
                        <li><M>#</M> 컬럼은 페이지를 넘어가도 누적 증가 (페이지 2 = 1001 ~ ...)</li>
                        <li><M>마지막 »</M>으로 점프하면 중간 페이지 cursor가 없어 ← 이전이 잠깁니다. « 처음으로 돌아가서 순차 탐색 가능</li>
                    </ul>

                    <p><b>tail -f (실시간)</b> — 토픽의 현재 끝부터 새로 들어오는 메시지를 스트리밍.</p>
                    <ul>
                        <li>모드 선택 즉시 시작, limit / timeout 무시. 가져오기 버튼이 <b>중지</b>로 토글</li>
                        <li>중지 누르면 모드/limit/timeout이 기본값(Newest/1000/8000)으로 복원, 수신된 메시지는 그대로 유지</li>
                        <li><b>자동 스크롤</b> (follow): 새 메시지가 도착할 때마다 그리드 맨 아래를 따라감</li>
                        <li><b>마우스 휠</b> → follow 해제, 그 자리에 멈춤</li>
                        <li><b>Shift + G</b> → 다시 맨 아래로 점프 + follow 재개</li>
                        <li><b>Ctrl + C</b> (이스터에그) → SIGINT처럼 tail 종료. 텍스트 선택 중이거나 입력창 포커스 시엔 일반 복사로 동작</li>
                    </ul>

                    <p><b>liz.message.pipeline 필터</b> — 토픽으로 <M>liz.message.pipeline</M>을 고르면 검색줄 아래에 <b>필드 인지 필터 패널</b>이 뜹니다 (다른 토픽에선 숨김). tail -f로 흘려두고 원하는 메시지만 골라 볼 때 유용합니다.</p>
                    <ul>
                        <li><b>Enum 필드 (포함/제외 토글)</b> — <M>protocolCode</M> / <M>lizMessageType</M> / <M>senderType</M> 각각 [포함]/[제외] 모드로 값 다중선택. 값 목록은 liz 소스 정적 카탈로그(protocolCode 92종 등)와 현재 버퍼 관측값을 합쳐 제공하고 옆에 <b>관측 건수</b>를 표시. 안 나온 값도 검색창에 입력 후 Enter로 추가</li>
                        <li><b>커스텀 키/값 규칙</b> — <M>alarmId</M> / <M>deviceIds</M> / <M>senderId</M>처럼 값이 다양한 키는 규칙을 추가해 <b>키 이름과 값을 직접 입력</b>. 키는 header·최상위에서 자동 탐색(<M>header.senderId</M> 같은 점 경로도 가능)하고, <b>배열 값은 원소 단위로 매칭</b>(예: deviceIds에 특정 id 포함). 키 칸엔 관측된 키 이름이 자동완성으로 제안됨</li>
                        <li><b>(없음/null)</b> — <M>senderType</M>이 비어 있거나(MODULE_STARTED/STOPPED 등) 해당 키가 없는 메시지를 잡으려면 이 옵션 선택</li>
                        <li><b>조합</b> — 모든 enum 필드와 커스텀 규칙은 <b>AND</b>, 한 항목 안의 여러 값은 OR, 자유 텍스트 검색과도 AND. 부분일치가 필요하면 텍스트 검색을 사용</li>
                        <li><b>화면 표시 필터</b> — 메시지는 전량 보관하고 표시에만 적용(필터 변경 시 소급 반영), 가져오기 옆 카운트에도 반영. 설정은 localStorage에 저장, 패널 헤더 <b>전체 초기화</b>로 해제</li>
                    </ul>

                    <p><b>가져오기 / 중단</b> — 일반 조회 중에도 결과가 다 차기 전에 <b>중단</b> 버튼으로 취소 가능. 그때까지 모은 메시지가 그리드에 표시됩니다.</p>

                    <p><b>가져오기 옆 카운트</b> <M>{"{shown} / {total} 건"}</M> — 가져온 총 건수와 (검색/고급검색 시) 필터 후 표시 건수. limit이 1000이어도 989건만 있으면 989로 표시.</p>
                    <p><b>내보내기 (JSON)</b> 버튼 — 현재 그리드에 보이는 메시지(필터 적용 후)를 <M>{`{topic}_{timestamp}.json`}</M> 파일로 저장.</p>

                    <p><b>검색 행 (일반)</b>:</p>
                    <ul>
                        <li><b>검색 input</b> — 입력값이 들어간 메시지만 그리드에 남김</li>
                        <li><b>검색 대상</b> 드롭다운 — <M>값</M> / <M>키</M> / <M>헤더</M> (헤더는 <M>k=v</M>로 직렬화 후 매칭)</li>
                        <li><b>정규식</b> 체크 — input을 regex로 해석. invalid regex면 필터 미적용 (전체 표시)</li>
                        <li><b>대소문자 구분</b> 체크</li>
                    </ul>

                    <p>그리드 맨 왼쪽 <M>#</M> 컬럼은 1부터 시작하는 행 인덱스 (페이지네이션 모드에서는 페이지 누적).</p>
                    <p><b>컬럼 너비 조절</b> — 각 헤더 우측 가장자리를 드래그하면 폭 조절, <b>더블 클릭</b>으로 기본값 복원. 폭은 클러스터/페이지별로 localStorage에 저장.</p>
                    <p><b>헤더 클릭으로 정렬 cycle</b> (없음 → 내림차순 ▼ → 오름차순 ▲ → 없음):</p>
                    <ul>
                        <li><b>Offset 컬럼</b> — 같은 파티션 내에서 offset 순. 멀티 파티션이면 파티션 번호 우선</li>
                        <li><b>Timestamp 컬럼</b> — 타임스탬프 순</li>
                        <li>두 컬럼은 상호배타. 하나 클릭하면 다른 컬럼 정렬은 해제</li>
                    </ul>
                    <p>Timestamp 컬럼 기타:</p>
                    <ul>
                        <li><b>헤더 우클릭</b> → 현지 시간 ↔ Unix ms 표시 전환 (설정은 저장됨)</li>
                        <li><b>셀 hover</b> → 밀리초까지 풀 정밀도 시간 툴팁</li>
                    </ul>
                    <p><b>Value 안의 13자리 숫자</b>는 자동으로 unix ms로 인식되어 점선 밑줄 표시 + hover 시 사람 시간 툴팁 (그리드 + 디테일 패널 둘 다).</p>

                    <p><b>디테일 패널 (우측)</b> — 행을 클릭하면 partition / offset / timestamp / key / value(JSON 자동 들여쓰기) / headers를 한눈에 봅니다. 패널과 그리드 사이 splitter를 드래그해 폭 조절 (더블 클릭 = 기본값).</p>
                    <p>디테일 패널 하단에 <b>Unix ms ↔ 사람 시간 변환기</b> 있음. <M>지금</M> 버튼으로 현재 시각 채움.</p>

                    <p><b>행 우클릭 → 저장하기</b> → 이름을 붙여 저장. 발행 탭의 <M>[불러오기]</M>에서 꺼내 씁니다. 저장된 메시지 목록은 발행 탭에서 <b>내보내기/가져오기</b>로 백업·공유 가능.</p>

                    <p><b>고급 검색</b> — 검색 행 오른쪽 <M>고급 검색</M> 버튼:</p>
                    <ul>
                        <li>누르면 같은 줄의 검색 input / 정규식 / 대소문자 체크박스가 사라지고, 그 자리에 <b>토큰 카드</b>가 표시됩니다. 값/키/헤더 listbox는 유지</li>
                        <li>각 카드 = CSV로 입력한 토큰 묶음. 카드의 모든 토큰이 대상 필드에 <b>case-insensitive substring</b>으로 모두 포함된 메시지 수가 카드에 표시됩니다 (카드 내부 AND)</li>
                        <li>예: 값 모드 + 카드 토큰 <M>help, common</M> → <M>{`{"a":"help","b":"common"}`}</M>은 매치, <M>{`{"a":"hello","b":"common"}`}</M>는 help가 없으니 불매치</li>
                        <li><M>+ 카드 추가</M>로 최대 <b>5개</b>까지 추가 가능. 1번 카드는 테마 기본색, 이후 <span style={{color:"#dc2626"}}>빨강</span> / <span style={{color:"#2563eb"}}>파랑</span> / <span style={{color:"#16a34a"}}>초록</span> / <span style={{color:"#9333ea"}}>보라</span> 색이 부여됩니다</li>
                        <li>카드 클릭 → 팝업 다이얼로그에서 CSV 편집 (Ctrl+Enter로 확인). <M>×</M>로 카드 삭제 (마지막 카드까지 삭제 가능)</li>
                        <li><b>그리드 필터링</b> — 토큰이 있는 모든 카드의 합집합(OR)으로 그리드가 필터링되고, 매칭된 행은 해당 카드 색으로 음영 처리됩니다 (여러 카드에 매칭되면 더 앞쪽 카드 색 우선)</li>
                        <li>모든 카드가 비어있거나 카드를 전부 삭제하면 <M>가져오기</M> 결과 전체가 다시 표시됩니다</li>
                        <li><M>고급 검색 종료</M>로 일반 검색 모드 복귀, 카드는 메모리에 유지</li>
                    </ul>
                </>
            ),
        },
        {
            id: "produce",
            title: "7. 발행",
            body: (
                <>
                    <p>상단 툴바: 토픽 / 파티션 / [불러오기] / [반복 발행]. 본문에서 키, 값, 헤더 입력 후 <M>[발행]</M>. 파티션 입력 칸 앞에도 <M>파티션 (-1 = 자동)</M> 라벨이 함께 표시됩니다.</p>
                    <ul>
                        <li><b>파티션</b> — <M>-1</M>이면 키 해시 / 라운드로빈으로 자동 배정. 특정 파티션 강제 시 0, 1, 2 ...</li>
                        <li><b>헤더 입력 형식</b> — <M>key=value</M> 한 줄에 하나. 빈 줄 / <M>=</M> 없는 줄은 무시</li>
                        <li><b>발행 결과</b>는 폼 아래에 표시됨: <M>성공: 파티션 {`{p}`}, 오프셋 {`{o}`}</M> 또는 실패 메시지</li>
                    </ul>
                    <Box kind="tip">
                        <b>실수 줄이는 워크플로우</b>
                        <ol style={{ margin: "6px 0 0 18px" }}>
                            <li>조회 탭에서 비슷한 원본 메시지 찾기</li>
                            <li>우클릭 → 저장하기 (이름 지정)</li>
                            <li>발행 탭 <M>[불러오기]</M> → 항목 선택 → 모든 필드 자동 입력</li>
                            <li>바꿀 부분만 수정 → 발행</li>
                        </ol>
                    </Box>
                    <p><b>[불러오기]</b> 다이얼로그 — 이름/토픽/키로 검색, 행 선택 → 폼에 채워짐. value가 JSON이면 자동 들여쓰기로 펼쳐져 수정하기 쉬움. 다이얼로그 안에서 <M>내보내기</M>/<M>가져오기</M>로 저장 목록 자체를 JSON 파일로 백업·공유 가능.</p>
                    <p><b>[반복 발행]</b> — 현재 폼의 메시지를 반복 발행:</p>
                    <ul>
                        <li><b>최대 속도 (부하 테스트)</b> — 가능한 한 빠르게 비동기 발행. 종료 조건은 <M>건수 도달</M> 또는 <M>시간 경과</M></li>
                        <li><b>간격 발행</b> — N <M>ms</M>/<M>초</M>마다 1건. 총 건수 <M>0 = 무한</M>. 컨슈머 트리거 / 흐름 확인용</li>
                        <li>다이얼로그를 닫으면 자동 중지. 진행 중에는 <b>발행 / 실패 / 속도 / 경과 / 마지막 에러</b>가 200ms 간격으로 갱신</li>
                        <li><b>프로듀서 튜닝 (성능 테스트)</b> — 체크하면 <M>compression.type</M> / <M>acks</M> / <M>batch.size(KB)</M> / <M>linger.ms</M> / <M>buffer.memory(MB)</M>를 바꿔가며 최대 처리량을 측정. 이 설정으로 <b>전용 프로듀서</b>를 따로 띄우므로 조회/관리용 공유 연결은 영향 없음. 끄면 기본값(무압축). <M>acks=all</M>은 멱등 프로듀서 유지, 그 외(1/0)는 멱등 자동 해제</li>
                    </ul>
                    <p className="muted" style={{ fontSize: 12 }}>탭을 바꾸거나 클러스터를 끊어도 백엔드 loop는 계속 돌 수 있습니다 — 다이얼로그를 닫는 것이 안전한 정지 방법.</p>
                    <p className="muted" style={{ fontSize: 12 }}>팁: 숫자 문자열 값은 압축률이 높아 zstd/lz4를 켜면 네트워크 대비 처리량이 크게 오릅니다. batch.size↑·linger.ms↑는 처리량↑(지연↑), acks=1·0은 처리량↑(안정성↓).</p>
                </>
            ),
        },
        {
            id: "special",
            title: "8. 특수 발행",
            body: (
                <>
                    <p><b>특수 발행</b> 탭은 WebUI의 특정 조작을 대신 재현합니다. 첫 번째 작업은 <b>장치 모니터링 ON/OFF</b> — 관리 콘솔에서 장치 모니터링을 껐다 켤 때 나가는 Kafka 메시지를 그대로 모방합니다.</p>
                    <p>관측된 동작: 토글 한 번에 <M>liz.message.pipeline</M>로 두 메시지가 <b>같은 <M>time</M></b>으로 함께 나갑니다.</p>
                    <ul>
                        <li>① <M>DEVICE_UPDATED_NOTIFICATION</M> — <M>{`{ deviceIds:[...], restartService }`}</M></li>
                        <li>② <M>SPECIFY_RULE_UPDATED_NOTIFICATION</M> — <M>{`{ specifyRuleId: null }`}</M></li>
                    </ul>
                    <p><b>모니터링 재시작</b> — <M>restartService</M> 값을 라디오로 직접 고릅니다. <M>true</M> = 모니터링 켜기(대상 장치 수집 서비스 재시작), <M>false</M> = 모니터링 끄기 (실제 소스 확인).</p>
                    <Box kind="warn">
                        <b>restartService=true</b>는 대상 장치의 <b>수집 서비스를 실제로 재시작</b>합니다. 운영 환경에서 특히 주의하세요.
                    </Box>
                    <p><b>장치 ID 입력</b> — 현장에서 뽑아온 ID를 그대로 붙여넣습니다 (쉼표/공백/줄바꿈/세미콜론 구분, 수십~수천 개). 유효한 int32만 남기고 잘못된 토큰·중복은 걸러서 개수로 보여줍니다.</p>
                    <p><b>쪼개서 발행</b> — 큰 목록을 <M>묶음 크기</M>로 나눠 보냅니다. 한 묶음 = 한 번의 발행(그 묶음의 모든 ID가 하나의 DEVICE_UPDATED에 들어감).</p>
                    <ul>
                        <li><b>다음 N개 발행</b> — 한 묶음만 보내고 멈춤. <b>하나씩 확인하며</b> 진행할 때 (예: 1개 먼저 → 나머지 <M>남은 전체</M>).</li>
                        <li><b>자동 발행</b> — 남은 것을 묶음 크기로 <b>반복</b>해서 보냄. <M>묶음 간 간격(ms)</M>으로 서버 부하 조절 (예: 1000개를 50개씩 20회). 시작 시 범위 확인 창이 뜹니다.</li>
                        <li><b>오류 시 중지</b> (기본) — 실패하면 멈춤. 실패한 묶음은 커서를 넘기지 않아 <b>그대로 재시도</b> 가능.</li>
                    </ul>
                    <p><b>미리보기</b> — 다음에 나갈 두 메시지의 실제 JSON을 보여줍니다 (<M>uuid</M>·<M>time</M>은 발행 시각에 새로 생성). <b>발행 로그</b>에는 묶음별 성공/실패·파티션·오프셋이 남습니다.</p>
                    <Box kind="tip">
                        메시지는 <b>키 없이</b> 발행되고 파티션은 자동(-1)입니다 — 실제 콘솔과 동일. <M>SPECIFY_RULE 함께 발행</M> 체크를 끄면 DEVICE_UPDATED 하나만 보냅니다.
                    </Box>
                </>
            ),
        },
        {
            id: "danger",
            title: "9. 되돌릴 수 없는 작업",
            body: (
                <>
                    <Box kind="warn">
                        실행 전에 <b>상단의 클러스터 이름</b>이 운영 환경이 아닌지 한 번 더 확인하세요.
                    </Box>
                    <ul>
                        <li><b>토픽 삭제</b> — 모든 메시지 영구 소실</li>
                        <li><b>그룹 삭제</b> — committed offsets 전부 사라짐</li>
                        <li><b>Offset → earliest/latest/timestamp/explicit</b> — 누락 또는 재처리 발생</li>
                        <li><b>파티션 재할당</b> — 대용량 데이터 이동, 클러스터 부하</li>
                        <li><b>반복 발행 (최대 속도)</b> — 안전장치 없음. 운영 토픽에 무한히 폭주할 수 있음</li>
                        <li><b>특수 발행 (restartService=true)</b> — 대상 장치의 수집 서비스를 실제로 재시작. 자동 발행은 수백~수천 건을 한 번에 쏠 수 있음</li>
                    </ul>
                </>
            ),
        },
        {
            id: "settings",
            title: "10. 설정",
            body: (
                <>
                    <p>설정 탭에서 다음을 관리합니다.</p>
                    <p><b>언어</b> — 한국어 / English. 변경 즉시 모든 라벨·도움말이 전환됩니다.</p>
                    <p><b>테마</b> — 5가지 옵션, 선택값은 <M>localStorage</M>에 저장됩니다:</p>
                    <ul>
                        <li><b>시스템 따라가기</b> — OS의 다크/라이트 설정에 자동으로 맞춤 (<M>prefers-color-scheme</M> 변경도 실시간 반영)</li>
                        <li><b>Light</b> — 기본 밝은 테마</li>
                        <li><b>Dark</b> — 슬레이트 계열의 다크 테마</li>
                        <li><b>Onion</b> — 크림 배경 + ONION 브랜드 오렌지 (#FF9425) 액센트. 사이드바에 컬러 워드마크 표시</li>
                        <li><b>Dark Onion</b> — 거의 검정 (#0a0a0a) 표면 + 오렌지 액센트. 화이트 워드마크 사용</li>
                    </ul>
                    <p><b>설정 폴더</b> — 프로필이 저장되는 디렉터리 표시 (<M>~/.kafka-client</M>). 읽기 전용.</p>
                    <p><b>프로필 내보내기 / 가져오기</b> — 등록된 모든 클러스터 프로필을 JSON 파일로 백업·공유. 가져오기 후 사이드바에 자동 반영됩니다.</p>
                    <p><b>정보</b> — 현재 빌드 버전 / 핵심 라이브러리 표시.</p>
                </>
            ),
        },
        {
            id: "update",
            title: "11. 자동 업데이트",
            body: (
                <>
                    <p>앱을 켤 때마다 GitHub Releases를 확인해 새 버전이 있으면 <b>자동으로 조용히 업데이트</b>됩니다 — 따로 묻지 않습니다. 새 <M>kafka-client.exe</M>를 같은 폴더에 받아 두고, 작은 <M>update.cmd</M> 헬퍼가 앱이 종료된 직후 파일을 교체한 뒤 자동으로 다시 실행합니다. 시작 직후 "내려받는 중…" 토스트만 잠깐 보이고 곧 새 버전으로 재시작됩니다.</p>
                    <ul>
                        <li>업데이트 직후 처음 켜질 때 <b>릴리즈 노트</b>가 한 번만 팝업됩니다 (확인을 누르면 두 번째부터는 안 뜸).</li>
                        <li><b>설정 → 업데이트 확인</b>으로 수동 체크하면, 이때는 적용 전에 한 번 묻는 다이얼로그가 뜹니다.</li>
                    </ul>
                    <p><b>릴리즈는 태그 기반</b>입니다. <M>git tag vX.Y.Z && git push --tags</M>를 푸쉬하면 GitHub Actions가 Windows에서 <M>wails build</M>로 exe를 만들고, 이전 태그 이후의 커밋 메시지를 Release 본문에 자동으로 채워서 공개합니다.</p>
                    <Box kind="tip">
                        로컬에서 <M>wails build</M>만 돌리면 버전은 <M>dev</M>로 박혀 업데이트 알림이 뜨지 않습니다 — 평소 개발 빌드는 방해받지 않고 쓸 수 있어요.
                    </Box>
                    <p>설정 파일: <M>~/.kafka-client/pending-release-notes.json</M> (다음 실행 때 보여줄 릴리즈 노트 저장소, 확인 후 자동 삭제).</p>
                </>
            ),
        },
    ];
}

function buildSectionsEn(): Section[] {
    return [
        {
            id: "layout",
            title: "1. Layout",
            body: (
                <>
                    <p><b>Sidebar</b> — registered clusters. <b>Drag the right edge</b> to resize; the width is persisted (double-click to reset).</p>
                    <ul>
                        <li><M>+ Add</M> at the top registers a new cluster</li>
                        <li>Left dot: <span style={{color:"#16a34a"}}>●</span> green = connected, gray = disconnected</li>
                        <li><b>Right-click</b> a cluster row → edit / delete</li>
                        <li>Bottom <M>📖 Help</M> button reopens this dialog</li>
                    </ul>
                    <p><b>Top bar</b> — current cluster name + <M>(controller: B<i>n</i>)</M> when connected; right-side <M>Connect</M> / <M>Disconnect</M>.</p>
                    <p><b>Tabs</b> — Topics / Consume / Produce / Settings. Non-Settings tabs are locked until you connect.</p>
                    <p><b>Unix timestamp calculator mode</b> — on the empty (not-yet-connected) screen, the <M>Unix timestamp calculator</M> button drops the entire Kafka UI (sidebar / top bar / tabs) and shrinks the window down to a standalone <b>Unix ms ↔ human time converter</b>. An <b>Always on top</b> checkbox pins it above other windows; <M>Switch to Kafka Client mode</M> restores the full app and window size (and clears always-on-top). (The same converter also lives at the bottom of the Consume detail panel — see section 6.)</p>
                    <p><b>Tab state is preserved</b> — switching tabs no longer resets anything. A <M>tail -f</M> started on the Consume tab keeps running and collecting messages while you're on another tab, and the fetched rows / search / page position plus the Produce form (key, value, headers) all stay put. So: start a tail on Consume → publish from Produce → come back to Consume and you'll see the messages that arrived in the meantime, continued in place. (Cleared when you switch clusters. The Topics tab pauses its polling while hidden and resumes on return.)</p>
                    <p><b>Shared topic state</b> — Consume and Produce share the selected topic. Switching the topic on one auto-updates the other (cleared when you switch clusters). While a tail is running on Consume, changing the topic from Produce won't interrupt the live tail.</p>
                    <p><b>Dialog controls (all modals)</b> — every popup can be <b>moved by dragging its header</b> and <b>resized from the bottom-right corner</b>. Close with <b>ESC</b> or the <M>×</M> at the top-right only — <b>clicking the dark area outside does NOT close it</b> (prevents accidental dismissal). Closing is locked while a save/delete action is in progress.</p>
                </>
            ),
        },
        {
            id: "start",
            title: "2. Add a cluster",
            body: (
                <>
                    <p>Sidebar → <M>+ Add</M> → fill the dialog and save.</p>
                    <ul>
                        <li><b>Broker table</b> — one row per broker with <b>hostname · IP (optional) · port</b>. Use <M>+ Add broker</M> for multiple. If a hostname doesn't resolve on your PC, put the real address in the <b>IP column</b> (instead of <M>/etc/hosts</M>). Bootstrap servers and host aliases are generated from this table.</li>
                        <li><b>Default topic</b> (optional) — auto-selected the first time you open Consume/Produce after connecting</li>
                        <li><b>Use SSL</b> (optional) — checking it opens a <b>certificate popup</b> (see below)</li>
                        <li><b>Schema Registry URL</b> (optional)</li>
                        <li><b>Test connection</b> — checks reachability before saving and shows the <b>discovered brokers · controller</b></li>
                    </ul>
                    <p>Then select it in the sidebar and press <M>Connect</M> in the top bar. The controller broker shows next to the name once connected.</p>
                    <Box kind="tip">
                        Profiles live in <M>~/.kafka-client/profiles.json</M>. Use the Settings tab's <b>Import / Export</b> to share them across machines or teammates.
                    </Box>
                    <p style={{ marginTop: 16 }}><b>SSL connection (1-way)</b></p>
                    <p>Use this when the broker exposes an SSL listener such as <M>SSL://…:9292</M>. For server-auth-only 1-way SSL (<M>ssl.client.auth=none</M>) a single <b>CA certificate</b> is all you need.</p>
                    <ol>
                        <li><b>Broker table</b> — enter the <b>IP</b> (e.g. <M>192.168.1.171</M>) and <b>Port</b> (the SSL port, e.g. <M>9292</M>). The <b>hostname is auto-filled from the certificate</b>, so you can usually leave it blank. It dials by IP but verifies the cert by hostname (CN).</li>
                        <li>Check <b>Use SSL</b> → the <b>certificate popup</b> opens. Give it a <b>CA cert</b> (e.g. <M>ca.xxx.crt</M>, chain-verified) or a <b>broker cert</b> (e.g. <M>kafka1.xxx.crt</M>, pinned) — it's auto-detected. <b>A broker cert auto-fills its hostname (CN) into the broker table.</b> Supports file, paste, and <M>Fetch from remote (SSH)</M> — SSH picks a broker IP from the dropdown and connects per host.</li>
                        <li><b>Test connection</b> → save once it returns OK and shows the discovered brokers.</li>
                    </ol>
                    <Box kind="tip">
                        Kafka SSL certs usually carry the hostname in the <b>CN only, without SANs</b>. This tool still <b>verifies the full chain</b> against the CA while matching the hostname against the CN, so those legacy certs connect fine (MITM protection intact). For <b>2-way mTLS</b> (<M>ssl.client.auth=required</M>) add a client cert/key under <M>Advanced</M>. <b>Skip certificate verification</b> is for testing only — it exposes the connection to MITM.
                    </Box>
                </>
            ),
        },
        {
            id: "topics",
            title: "3. Topics tab",
            body: (
                <>
                    <p>Top <M>Search topics</M> input filters topic names (case-insensitive substring).</p>
                    <p>Click a topic to expand it — you'll see <b>partition detail (Leader / Replicas / ISR / Offline)</b> and the <b>consumer group cards</b> currently consuming this topic.</p>
                    <p>Every action lives behind right-click:</p>
                    <ul>
                        <li>Topic row → edit / reassign / delete</li>
                        <li>Empty area → create topic (name / partitions / RF / custom configs)</li>
                        <li>Partition area in expanded view → reassign</li>
                        <li>Group card in expanded view → reset offsets / delete group</li>
                    </ul>
                    <p><b>Entering ms configs (🧮)</b> — in the create/edit topic dialog, fields ending in <M>.ms</M> (<M>retention.ms</M>, <M>segment.ms</M>…) show a <M>🧮</M> button: add up <b>days / hours / minutes</b> with ± buttons and it fills in the millisecond value (no external calculator). Each unit can't go below zero, and seconds/ms are intentionally excluded.</p>
                    <p><b>msg/sec column</b> — messages in the last 60s ÷ 60 (refreshes every 1s), computed from end-offset deltas.</p>
                    <p><b>Group card partition lag table</b> shows per-partition Committed / End / Lag. Members are listed; members without an assignment show as <M>(no assignment / standby)</M>.</p>
                    <p><b>Hover the Committed / End Offset / Lag cells</b> on a group card to see the <b>per-second delta</b> measured over the 10s SLOW tick interval. End Offset shows publish rate (<M>publish/sec</M>), Committed shows consume rate, Lag shows whether lag is growing or shrinking. The first sample after expand is the baseline — values appear from the second SLOW tick onward.</p>
                    <p className="muted" style={{ fontSize: 12 }}>Background refresh: FAST 1s (partition leader/ISR, msg/sec, inflight reassignments) / SLOW 10s (topic list, group lag).</p>
                </>
            ),
        },
        {
            id: "reassign",
            title: "4. Partition reassign",
            body: (
                <>
                    <p>Each partition row shows <b>RF chips</b> (broker numbers). The first chip is the <b>preferred leader</b>.</p>
                    <p>The <b>Leader column shows the actual live leader</b> from the cluster. When it differs from the preferred replica (replica[0]) you'll see a <M>≠Bn</M> warning and a top <M>⚑ Leader mismatch</M> banner.</p>
                    <ul>
                        <li><b>Drag chips</b> to reorder replicas = <b>change the preferred leader (reassignment)</b></li>
                        <li><b>Click a chip</b> → swap broker</li>
                        <li>Per-row <M>↺</M> → <b>reverts that row's edits only</b> (shown only when edited; runs nothing). For everything, use <b>Reset all</b> at the top</li>
                        <li><b>Show only changed rows</b> toggle for big topics</li>
                        <li><M>Execute</M> sends <b>only changed partitions</b> to Kafka</li>
                    </ul>
                    <div style={{ background: "var(--warn-soft-bg)", border: "1px solid var(--warn)", borderRadius: 6, padding: "8px 12px", margin: "10px 0" }}>
                        <b>Leader won't change?</b> A reassignment (Execute) that reorders replicas only sets the <b>preferred</b> leader. To move the actual leader you need a <b>preferred leader election</b>. If the replicas are already in the desired order the reassignment shows “0 changed” and does nothing.
                    </div>
                    <p>The <b>Apply immediately</b> checkbox (on by default) decides what Execute applies:</p>
                    <ul>
                        <li><M>Apply immediately</M> checked + <M>Execute</M> → along with the reassignment, <b>elect the preferred replica as the live leader now</b>. Works even when 0 replicas changed but the leader is mismatched. A <b>leader-move warning</b> appears once first — click <M>Run anyway</M> to confirm (connected producers/consumers may briefly reconnect).</li>
                        <li><M>Apply immediately</M> unchecked + <M>Execute</M> → reassignment only (preferred changes, live leader stays until the next rebalance/election).</li>
                        <li>The election <b>succeeds only if that replica is in the ISR</b>. Otherwise it's rejected and the reason is shown (other partitions still proceed).</li>
                    </ul>
                    <p>An <M>⟳ N</M> badge appears next to topics with reassignments in flight (auto-refreshed by the FAST tick).</p>
                </>
            ),
        },
        {
            id: "groups",
            title: "5. Consumer groups",
            body: (
                <>
                    <p>Right-click a group card → <b>Reset offsets</b> or <b>Delete group</b>.</p>
                    <p><b>Reset modes (4)</b>:</p>
                    <ul>
                        <li><b>Earliest</b> — every partition to the start of retained log</li>
                        <li><b>Latest</b> — every partition to current log end (skips everything not yet committed)</li>
                        <li><b>Specific timestamp</b> — ISO 8601 or unix ms. Per partition, the first offset at/after that instant</li>
                        <li><b>Per-partition explicit</b> — table of current / End per partition, type the new offset directly</li>
                    </ul>
                    <Box kind="warn">
                        Kafka rejects both reset and delete while consumers are live. Stop them first; the menu is disabled when the state is Stable / PreparingRebalance / CompletingRebalance.
                    </Box>
                </>
            ),
        },
        {
            id: "consume",
            title: "6. Consume",
            body: (
                <>
                    <p>Top toolbar: topic / mode / (condition input) / Max messages / <b>Page size</b> / Timeout (ms) / <M>Fetch</M>. The number fields (<M>Max messages</M>, <M>Timeout (ms)</M>) carry an always-visible inline label — no longer a hover-only tooltip.</p>
                    <ul>
                        <li><b>tail -f</b> hides every supporting input (none of them apply)</li>
                        <li><b>Timestamp range</b> hides Max messages too — there's no single-shot fetch in that mode, only the <b>Page size</b> dropdown</li>
                    </ul>
                    <p><b>Max messages input rules</b>:</p>
                    <ul>
                        <li><b>Empty / 0</b> → auto-replaced with <M>1000</M> (default) on fetch or blur</li>
                        <li><b>-1</b> = <b>cursor pagination</b> (allowed only in Oldest / Newest / Offset modes). After the first Fetch, <M>« First</M> / <M>← Prev</M> / <M>Next →</M> buttons appear above the grid; click Next until a page returns fewer rows than the page size (= log boundary). Direction follows the mode — Newest / Offset (before) walks toward older records, Oldest / Offset (after) walks toward newer ones</li>
                        <li><b>Enter</b> while focused on Max messages / Timeout fires <M>Fetch</M> (same as clicking the button)</li>
                    </ul>
                    <p><b>Page size</b> dropdown — <M>1000</M> / <M>10000</M> / <M>50000</M>:</p>
                    <ul>
                        <li>Records per page for every paginated fetch (timestamp range + cursor pagination)</li>
                        <li>Advanced search works only within the current page — pick 50000 to scan a bigger window in one shot</li>
                        <li>Persisted in localStorage. Changing it while a result is on screen <b>auto-refetches</b> page 1 with the new size</li>
                    </ul>
                    <p>Modes: <b>Oldest / Newest / Offset (after) / Offset (before) / Timestamp range / tail -f</b>.</p>
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
                                <li><M>« First</M> / <M>← Prev</M> / <M>Page N / total</M> (<b>click the dropdown to jump to any page in one go</b>) / <M>Next →</M> / <M>Last »</M></li>
                                <li>A <M>N total in range</M> label on the right shows the window's total record count</li>
                            </ul>
                        </li>
                        <li>The <M>#</M> column keeps incrementing across page turns (page 2 starts at 1001…)</li>
                        <li>Jumping with <M>Last »</M> skips the cursor history of intermediate pages, so ← Prev is disabled. Use « First to start sequential pagination again</li>
                    </ul>

                    <p><b>tail -f (live)</b> — streams new records from the topic's current end.</p>
                    <ul>
                        <li>Starts the instant the mode is selected; limit / timeout are ignored. The Fetch button toggles to <b>Stop</b></li>
                        <li>Stop restores mode/limit/timeout to defaults (Newest / 1000 / 8000); received messages stay on screen</li>
                        <li><b>Auto-follow</b>: each new batch pins the view to the bottom</li>
                        <li><b>Mouse wheel</b> → pauses follow, freezes at that position</li>
                        <li><b>Shift + G</b> → snaps back to bottom and resumes follow</li>
                        <li><b>Ctrl + C</b> (easter egg) → stops tail like SIGINT. When text is selected or an input has focus it falls back to normal copy</li>
                    </ul>

                    <p><b>liz.message.pipeline filter</b> — pick <M>liz.message.pipeline</M> as the topic and a <b>field-aware filter panel</b> appears below the search bar (hidden for other topics). Handy for keeping a tail -f running and only watching the messages you care about.</p>
                    <ul>
                        <li><b>Enum fields (include/exclude toggle)</b> — multi-select values on <M>protocolCode</M> / <M>lizMessageType</M> / <M>senderType</M>, each in [Include]/[Exclude] mode. The list merges a static catalog from the liz source (e.g. 92 protocolCodes) with values observed in the current buffer, each showing its <b>observed count</b>; unseen values can be typed and added with Enter</li>
                        <li><b>Custom key/value rules</b> — for high-variety keys like <M>alarmId</M> / <M>deviceIds</M> / <M>senderId</M>, add a rule and <b>type the key name and value(s) yourself</b>. The key resolves in the top level and inside <M>header</M> (dot-paths like <M>header.senderId</M> work), and <b>array values match per-element</b> (e.g. a specific id inside deviceIds). The key box autocompletes from observed keys</li>
                        <li><b>(none/null)</b> — pick this to match messages whose <M>senderType</M> is empty (MODULE_STARTED/STOPPED, etc.) or that lack the custom key</li>
                        <li><b>Combining</b> — all enum fields and custom rules are <b>AND</b>; multiple values within one entry are OR; it also ANDs with the free-text search. Use text search when you need substring matching</li>
                        <li><b>View-layer filter</b> — every message is kept; the filter only affects display (changes re-evaluate history) and updates the count pill. Settings persist in localStorage; <b>Clear all</b> resets everything</li>
                    </ul>

                    <p><b>Fetch / Cancel</b> — for ordinary fetches you can also cancel mid-way with the <b>Cancel</b> button; whatever was collected so far still shows in the grid.</p>

                    <p><b>Count pill next to Fetch</b> <M>{"{shown} / {total}"}</M> — total records fetched and (when search/advanced is active) how many remain after filtering. If limit is 1000 but only 989 exist, the pill shows 989.</p>
                    <p><b>Export (JSON)</b> — writes the currently visible (post-filter) messages to <M>{`{topic}_{timestamp}.json`}</M>.</p>

                    <p><b>Basic search row</b>:</p>
                    <ul>
                        <li><b>Search input</b> — keeps only messages containing the query</li>
                        <li><b>Search target</b> dropdown — <M>Value</M> / <M>Key</M> / <M>Headers</M> (headers are serialised as <M>k=v</M> for matching)</li>
                        <li><b>Regex</b> checkbox — treats the input as a regular expression; an invalid pattern silently falls back to "no filter"</li>
                        <li><b>Case-sensitive</b> checkbox</li>
                    </ul>

                    <p>The leftmost <M>#</M> column is a 1-based row index (cumulative across pages in pagination mode).</p>
                    <p><b>Column resize</b> — drag the right edge of any header to resize; <b>double-click</b> to reset. Widths are persisted per cluster/page in localStorage.</p>
                    <p><b>Click a sortable header to cycle sort</b> (none → desc ▼ → asc ▲ → none):</p>
                    <ul>
                        <li><b>Offset column</b> — by offset within a partition. Multi-partition: partition first, then offset</li>
                        <li><b>Timestamp column</b> — by timestamp</li>
                        <li>The two columns are mutually exclusive; clicking one clears the other's sort</li>
                    </ul>
                    <p>Timestamp column extras:</p>
                    <ul>
                        <li><b>Right-click header</b> → toggle local time / Unix ms (persisted)</li>
                        <li><b>Hover a cell</b> → full-precision time tooltip</li>
                    </ul>
                    <p>Any <b>13-digit number inside Value</b> is auto-detected as unix ms (dotted underline + hover tooltip), in both grid and detail panel.</p>

                    <p><b>Detail panel (right)</b> — click a row to see partition / offset / timestamp / key / value (JSON auto-formatted) / headers in one view. Drag the splitter between the grid and the panel to resize (double-click = default).</p>
                    <p>The panel's footer hosts a <b>Unix ms ↔ human time converter</b>. The <M>Now</M> button fills in the current instant.</p>

                    <p><b>Right-click a row → Save</b>, give it a name, then pull it from the Produce tab's <M>[Load]</M> button. The saved list itself can be exported/imported from there.</p>

                    <p><b>Advanced search</b> — the <M>Advanced</M> button on the right side of the search row:</p>
                    <ul>
                        <li>Hides the search input and the regex / case-sensitive checkboxes on the same row; keeps the value/key/headers target dropdown. <b>Token cards</b> appear in their place</li>
                        <li>Each card is a CSV-parsed list of tokens. The card's count is the number of messages whose target field contains <b>every token</b> as a case-insensitive substring (AND inside a card)</li>
                        <li>Example: value mode + tokens <M>help, common</M> → matches <M>{`{"a":"help","b":"common"}`}</M>; <M>{`{"a":"hello","b":"common"}`}</M> doesn't match (no "help")</li>
                        <li><M>+ Add card</M> up to <b>5 cards</b>. Card #1 uses the theme default; the next four are <span style={{color:"#dc2626"}}>red</span> / <span style={{color:"#2563eb"}}>blue</span> / <span style={{color:"#16a34a"}}>green</span> / <span style={{color:"#9333ea"}}>purple</span></li>
                        <li>Click a card → dialog with a CSV textarea (Ctrl+Enter submits). <M>×</M> removes a card (all cards can be deleted)</li>
                        <li><b>Grid filtering</b> — the grid is filtered to the union (OR) of all non-empty cards; each matching row is tinted with its card's color (if a row matches multiple cards, the earliest card wins)</li>
                        <li>If every card is empty, or you delete all cards, the full <M>Fetch</M> result is shown again</li>
                        <li><M>Exit advanced</M> returns to the basic search mode; cards stay in memory</li>
                    </ul>
                </>
            ),
        },
        {
            id: "produce",
            title: "7. Produce",
            body: (
                <>
                    <p>Top toolbar: topic / partition / [Load] / [Loop produce]. Body: key, value, headers — then <M>[Send]</M>. The partition field also shows an inline <M>Partition (-1 = auto)</M> label.</p>
                    <ul>
                        <li><b>Partition</b> — <M>-1</M> auto-assigns (key hash / round-robin); set 0, 1, 2 ... to force a specific partition</li>
                        <li><b>Headers input format</b> — one <M>key=value</M> per line; blank lines and lines without <M>=</M> are ignored</li>
                        <li><b>Send result</b> shows under the form: <M>OK: partition {`{p}`}, offset {`{o}`}</M> or an error message</li>
                    </ul>
                    <Box kind="tip">
                        <b>Recommended workflow</b>
                        <ol style={{ margin: "6px 0 0 18px" }}>
                            <li>Find a real example in the Consume tab</li>
                            <li>Right-click → Save (give it a name)</li>
                            <li>In Produce, click <M>[Load]</M> → pick it → all fields auto-fill</li>
                            <li>Edit only what differs → Send</li>
                        </ol>
                    </Box>
                    <p><b>[Load]</b> dialog — search saved messages by name / topic / key. Selecting a row populates the form (JSON values are auto-formatted for easy editing). The saved list itself can be backed up or shared via <M>Export</M> / <M>Import</M> inside the dialog.</p>
                    <p><b>[Loop produce]</b> — repeat the current form's message:</p>
                    <ul>
                        <li><b>Max throughput (load test)</b> — async firehose. Stop on <M>count reached</M> or <M>duration elapsed</M></li>
                        <li><b>Interval</b> — one message every N <M>ms</M>/<M>s</M>; total count <M>0 = unlimited</M>. Good for triggering consumers</li>
                        <li>Closing the dialog auto-stops. While running: <b>sent / failed / rate / elapsed / last error</b> refresh every 200ms</li>
                        <li><b>Producer tuning (perf test)</b> — tick it to sweep <M>compression.type</M> / <M>acks</M> / <M>batch.size(KB)</M> / <M>linger.ms</M> / <M>buffer.memory(MB)</M> and measure max throughput. A <b>dedicated producer</b> is spun up with these settings, so the shared browse/admin connection is untouched. Off = default (no compression). <M>acks=all</M> keeps the idempotent producer; 1/0 disable idempotency automatically</li>
                    </ul>
                    <p className="muted" style={{ fontSize: 12 }}>The backend loop can keep running after switching tabs or disconnecting — closing the dialog is the safe way to stop it.</p>
                    <p className="muted" style={{ fontSize: 12 }}>Tip: numeric-string values compress well, so zstd/lz4 lifts throughput a lot vs. the network. Bigger batch.size / linger.ms → higher throughput (more latency); acks=1/0 → higher throughput (less durability).</p>
                </>
            ),
        },
        {
            id: "special",
            title: "8. Special Publish",
            body: (
                <>
                    <p>The <b>Special Publish</b> tab reproduces specific WebUI operations for you. The first operation is <b>Device monitoring ON/OFF</b> — it mimics the exact Kafka messages the Admin Console emits when you toggle device monitoring off/on.</p>
                    <p>Observed behavior: one toggle sends two messages to <M>liz.message.pipeline</M> sharing the <b>same <M>time</M></b>:</p>
                    <ul>
                        <li>① <M>DEVICE_UPDATED_NOTIFICATION</M> — <M>{`{ deviceIds:[...], restartService }`}</M></li>
                        <li>② <M>SPECIFY_RULE_UPDATED_NOTIFICATION</M> — <M>{`{ specifyRuleId: null }`}</M></li>
                    </ul>
                    <p><b>Monitoring restart</b> — pick <M>restartService</M> directly with the radios. <M>true</M> = monitoring ON (collector service restarts), <M>false</M> = monitoring OFF (source-confirmed).</p>
                    <Box kind="warn">
                        <b>restartService=true</b> actually <b>restarts the collector service</b> on the target devices. Take care on production.
                    </Box>
                    <p><b>Device IDs</b> — paste the IDs you pulled from the field as-is (comma / space / newline / semicolon separated, tens to thousands). Only valid int32s are kept; invalid tokens and duplicates are filtered and counted.</p>
                    <p><b>Batching</b> — split a big list by <M>batch size</M>. One batch = one publish (all its IDs go into a single DEVICE_UPDATED).</p>
                    <ul>
                        <li><b>Send next N</b> — send one batch and stop. For <b>reviewing one at a time</b> (e.g. 1 first → then <M>all remaining</M>).</li>
                        <li><b>Auto-run</b> — <b>repeat</b> over the remainder in batch-size chunks, with a <M>delay (ms)</M> between batches to pace server load (e.g. 1000 as 50×20). A scope-confirm dialog appears first.</li>
                        <li><b>Stop on error</b> (default) — halt on failure; a failed batch does not advance the cursor, so it can be <b>retried as-is</b>.</li>
                    </ul>
                    <p><b>Preview</b> shows the actual JSON of the next messages (<M>uuid</M>/<M>time</M> regenerate at send). The <b>publish log</b> records per-batch ok/fail, partition, and offset.</p>
                    <Box kind="tip">
                        Messages are produced <b>keyless</b> with auto partition (-1) — same as the real console. Uncheck <M>Also publish SPECIFY_RULE</M> to send DEVICE_UPDATED only.
                    </Box>
                </>
            ),
        },
        {
            id: "danger",
            title: "9. Irreversible actions",
            body: (
                <>
                    <Box kind="warn">
                        Re-check the cluster name in the top bar before any destructive action.
                    </Box>
                    <ul>
                        <li><b>Delete topic</b> — drops all messages</li>
                        <li><b>Delete group</b> — loses all committed offsets</li>
                        <li><b>Reset offsets (earliest / latest / timestamp / explicit)</b> — gaps or re-processing</li>
                        <li><b>Reassignment</b> — heavy data movement</li>
                        <li><b>Loop produce (max throughput)</b> — no safety limit; can flood a prod topic</li>
                        <li><b>Special Publish (restartService=true)</b> — actually restarts the collector service on target devices; auto-run can fire hundreds/thousands at once</li>
                    </ul>
                </>
            ),
        },
        {
            id: "settings",
            title: "10. Settings",
            body: (
                <>
                    <p>The Settings tab manages the following.</p>
                    <p><b>Language</b> — Korean / English. Switches all labels and help text immediately.</p>
                    <p><b>Theme</b> — 5 options, persisted in <M>localStorage</M>:</p>
                    <ul>
                        <li><b>Follow system</b> — tracks the OS light/dark setting and reacts to <M>prefers-color-scheme</M> changes live</li>
                        <li><b>Light</b> — the default bright palette</li>
                        <li><b>Dark</b> — slate-based dark surfaces</li>
                        <li><b>Onion</b> — cream background + ONION brand orange (#FF9425) accent. Color wordmark shown in the sidebar</li>
                        <li><b>Dark Onion</b> — near-black surface (#0a0a0a) + orange accent. White wordmark</li>
                    </ul>
                    <p><b>Config folder</b> — shows where profiles are stored (<M>~/.kafka-client</M>). Read-only display.</p>
                    <p><b>Export / Import profiles</b> — dump or load all registered clusters as a JSON file. Imports refresh the sidebar automatically.</p>
                    <p><b>About</b> — current build version and core libraries.</p>
                </>
            ),
        },
        {
            id: "update",
            title: "11. Auto-update",
            body: (
                <>
                    <p>On every launch the app checks GitHub Releases for a newer version and, if one exists, <b>updates silently</b> — no prompt. It downloads the new <M>kafka-client.exe</M> next to the current one; a tiny <M>update.cmd</M> helper waits for the app to exit, swaps the file, and re-launches it. You only see a brief "downloading…" toast at startup before it restarts on the new version.</p>
                    <ul>
                        <li>The first time the freshly-updated binary runs, the <b>release notes</b> pop up once and only once (clicking OK dismisses them for good).</li>
                        <li><b>Settings → Check for update</b> does a manual check, and that path still asks before applying.</li>
                    </ul>
                    <p><b>Releases are tag-driven.</b> Push <M>git tag vX.Y.Z && git push --tags</M> and GitHub Actions builds the exe on Windows via <M>wails build</M>, auto-fills the release body from commit messages since the previous tag, and publishes.</p>
                    <Box kind="tip">
                        A local <M>wails build</M> without ldflags stamps the version as <M>dev</M> and silently disables the update prompt — your dev builds stay undisturbed.
                    </Box>
                    <p>State file: <M>~/.kafka-client/pending-release-notes.json</M> (holds notes to show on next launch; deleted after the user dismisses).</p>
                </>
            ),
        },
    ];
}
