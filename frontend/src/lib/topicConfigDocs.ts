import { Lang } from "./i18n";

// Reference data for topic-level configs, taken from the Apache Kafka
// documentation ("Topic-Level Configs", 4.1 with the 3.9 page for the keys and
// ranges that changed). `desc.en` is the official text; `desc.ko` is a
// translation. `values` and `note` spell out what the docs only imply — what a
// given enum / sentinel value does and what to watch for when changing it.

type L = Record<Lang, string>;

export interface TopicConfigValue {
    value: string;
    meaning: L;
}

export interface TopicConfigDoc {
    type: string;
    def: string;
    range: L;
    // Broker property that supplies the value when the topic has no override.
    serverDefault: string;
    summary: L;
    desc: L;
    values?: TopicConfigValue[];
    note?: L;
    // Listed as deprecated in 3.9 and gone from 4.0 onwards.
    deprecated?: boolean;
}

const LONG_MAX = "9223372036854775807";
const INT_MAX = "2147483647";

const between = (min: string, max: string): L => ({ ko: `${min} ~ ${max}`, en: `${min} to ${max}` });
const BOOL_RANGE: L = { ko: "true 또는 false", en: "true or false" };
const bool = (onTrue: L, onFalse: L): TopicConfigValue[] => [
    { value: "true", meaning: onTrue },
    { value: "false", meaning: onFalse },
];
const THROTTLE_RANGE: L = {
    ko: "[파티션ID]:[브로커ID],[파티션ID]:[브로커ID],... 또는 *",
    en: "[partitionId]:[brokerId],[partitionId]:[brokerId],... or *",
};
const THROTTLE_VALUES: TopicConfigValue[] = [
    { value: "\"\"", meaning: { ko: "throttle 대상 없음.", en: "Empty — nothing is throttled." } },
    { value: "0:1,1:2", meaning: { ko: "파티션 0의 브로커 1 레플리카, 파티션 1의 브로커 2 레플리카만 throttle.", en: "Throttle only partition 0's replica on broker 1 and partition 1's replica on broker 2." } },
    { value: "*", meaning: { ko: "이 토픽의 모든 레플리카를 throttle.", en: "Throttle every replica of this topic." } },
];
const THROTTLE_NOTE: L = {
    ko: "실제 속도 제한값은 브로커 설정(leader/follower.replication.throttled.rate)에서 정합니다. 보통 파티션 재할당 도구가 자동으로 넣고 지우는 값입니다.",
    en: "The actual rate limit comes from the broker configs (leader/follower.replication.throttled.rate). Normally the partition reassignment tool sets and clears this for you.",
};
const NO_FSYNC_VALUE: TopicConfigValue = {
    value: LONG_MAX,
    meaning: { ko: "사실상 강제 fsync 없음 — OS의 백그라운드 flush에 맡김 (기본값).", en: "Effectively never force an fsync — leave it to the OS background flush (default)." },
};

export const TOPIC_CONFIG_DOCS: Record<string, TopicConfigDoc> = {
    "cleanup.policy": {
        type: "list",
        def: "delete",
        range: { ko: "delete, compact (쉼표로 둘 다 지정 가능)", en: "delete, compact (both allowed, comma-separated)" },
        serverDefault: "log.cleanup.policy",
        summary: {
            ko: "오래된 로그 세그먼트를 삭제할지, 키별 최신 값만 남길지(컴팩션) 정하는 정책.",
            en: "Whether old log segments are deleted or compacted down to the latest value per key.",
        },
        desc: {
            ko: "로그 세그먼트에 적용할 보존 정책입니다. \"delete\"(기본값)는 보존 시간이나 크기 한도에 도달한 오래된 세그먼트를 버립니다. \"compact\"는 로그 컴팩션을 켜서 키별 최신 값만 남깁니다. 쉼표로 두 정책을 함께 지정할 수도 있으며(예: \"delete,compact\"), 이 경우 보존 시간·크기 설정에 따라 오래된 세그먼트는 버리고 남은 세그먼트는 컴팩션합니다.",
            en: "This config designates the retention policy to use on log segments. The \"delete\" policy (which is the default) will discard old segments when their retention time or size limit has been reached. The \"compact\" policy will enable log compaction, which retains the latest value for each key. It is also possible to specify both policies in a comma-separated list (e.g. \"delete,compact\"). In this case, old segments will be discarded per the retention time and size configuration, while retained segments will be compacted.",
        },
        values: [
            { value: "delete", meaning: { ko: "retention.ms / retention.bytes 한도를 넘은 오래된 세그먼트를 삭제.", en: "Discard old segments once retention.ms / retention.bytes is exceeded." } },
            { value: "compact", meaning: { ko: "같은 키의 옛 레코드를 지우고 키별 최신 값만 유지. 시간·크기로는 지우지 않음.", en: "Drop older records for the same key, keeping only the latest value per key. Nothing is removed by time or size." } },
            { value: "delete,compact", meaning: { ko: "보존 한도를 넘은 세그먼트는 삭제하고, 남은 세그먼트는 컴팩션.", en: "Delete segments past the retention limits and compact the ones that remain." } },
        ],
        note: {
            ko: "compact가 포함된 토픽은 키가 없는(null key) 메시지 발행이 거부됩니다.",
            en: "A topic whose policy includes compact rejects records that have no key.",
        },
    },
    "compression.gzip.level": {
        type: "int",
        def: "-1",
        range: { ko: "1 ~ 9 또는 -1", en: "1 to 9, or -1" },
        serverDefault: "compression.gzip.level",
        summary: { ko: "compression.type이 gzip일 때 쓸 압축 레벨.", en: "Compression level used when compression.type is gzip." },
        desc: {
            ko: "compression.type이 gzip으로 설정된 경우 사용할 압축 레벨입니다.",
            en: "The compression level to use if compression.type is set to gzip.",
        },
        values: [
            { value: "-1", meaning: { ko: "gzip 라이브러리 기본 레벨 사용.", en: "Use the gzip library's default level." } },
            { value: "1 ~ 9", meaning: { ko: "숫자가 클수록 압축률은 높고 CPU 사용량·지연은 늘어남.", en: "Higher means a better ratio at the cost of more CPU and latency." } },
        ],
    },
    "compression.lz4.level": {
        type: "int",
        def: "9",
        range: between("1", "17"),
        serverDefault: "compression.lz4.level",
        summary: { ko: "compression.type이 lz4일 때 쓸 압축 레벨.", en: "Compression level used when compression.type is lz4." },
        desc: {
            ko: "compression.type이 lz4로 설정된 경우 사용할 압축 레벨입니다.",
            en: "The compression level to use if compression.type is set to lz4.",
        },
        values: [
            { value: "1 ~ 17", meaning: { ko: "숫자가 클수록 압축률은 높고 CPU 사용량·지연은 늘어남.", en: "Higher means a better ratio at the cost of more CPU and latency." } },
        ],
    },
    "compression.type": {
        type: "string",
        def: "producer",
        range: { ko: "uncompressed, zstd, lz4, snappy, gzip, producer", en: "uncompressed, zstd, lz4, snappy, gzip, producer" },
        serverDefault: "compression.type",
        summary: { ko: "이 토픽에 최종 저장될 때의 압축 코덱.", en: "The final compression codec for data stored in this topic." },
        desc: {
            ko: "토픽의 최종 압축 타입을 지정합니다. 표준 압축 코덱('gzip', 'snappy', 'lz4', 'zstd')을 쓸 수 있고, 압축하지 않는 'uncompressed'와 프로듀서가 설정한 원래 코덱을 그대로 유지하는 'producer'도 지정할 수 있습니다.",
            en: "Specify the final compression type for a given topic. This configuration accepts the standard compression codecs ('gzip', 'snappy', 'lz4', 'zstd'). It additionally accepts 'uncompressed' which is equivalent to no compression; and 'producer' which means retain the original compression codec set by the producer.",
        },
        values: [
            { value: "producer", meaning: { ko: "프로듀서가 보낸 코덱 그대로 저장 (기본값). 브로커는 재압축하지 않음.", en: "Store whatever codec the producer used (default). The broker does not recompress." } },
            { value: "uncompressed", meaning: { ko: "압축 없이 저장. 프로듀서가 압축해 보내도 브로커가 풀어서 저장.", en: "Store uncompressed, decompressing anything the producer compressed." } },
            { value: "gzip", meaning: { ko: "압축률 높음, CPU 사용량 큼.", en: "High ratio, high CPU cost." } },
            { value: "snappy", meaning: { ko: "압축률은 낮지만 빠름.", en: "Lower ratio, fast." } },
            { value: "lz4", meaning: { ko: "빠른 압축·해제, 중간 수준 압축률.", en: "Fast compression and decompression, moderate ratio." } },
            { value: "zstd", meaning: { ko: "gzip급 압축률에 더 빠른 속도.", en: "gzip-class ratio with better speed." } },
        ],
        note: {
            ko: "producer 외의 값을 지정하면 프로듀서가 보낸 코덱과 다를 때 브로커가 재압축하므로 브로커 CPU 사용량이 늘 수 있습니다.",
            en: "With anything other than producer, the broker recompresses batches whose codec differs, which costs broker CPU.",
        },
    },
    "compression.zstd.level": {
        type: "int",
        def: "3",
        range: between("-131072", "22"),
        serverDefault: "compression.zstd.level",
        summary: { ko: "compression.type이 zstd일 때 쓸 압축 레벨.", en: "Compression level used when compression.type is zstd." },
        desc: {
            ko: "compression.type이 zstd로 설정된 경우 사용할 압축 레벨입니다.",
            en: "The compression level to use if compression.type is set to zstd.",
        },
        values: [
            { value: "-131072 ~ 22", meaning: { ko: "숫자가 클수록 압축률은 높고 CPU 사용량·지연은 늘어남. 음수는 압축률을 낮추고 속도를 우선.", en: "Higher means a better ratio at the cost of more CPU and latency; negative levels trade ratio for speed." } },
        ],
    },
    "delete.retention.ms": {
        type: "long",
        def: "86400000 (1 day)",
        range: between("0", LONG_MAX),
        serverDefault: "log.cleaner.delete.retention.ms",
        summary: { ko: "컴팩션 토픽에서 삭제 표시(tombstone)를 보관하는 시간.", en: "How long delete tombstones are kept on compacted topics." },
        desc: {
            ko: "로그 컴팩션 토픽에서 삭제 tombstone 마커를 보관하는 시간입니다. 컨슈머가 offset 0부터 읽기 시작했을 때 최종 상태의 올바른 스냅샷을 얻으려면 이 시간 안에 읽기를 끝내야 한다는 한계이기도 합니다(그렇지 않으면 스캔이 끝나기 전에 tombstone이 정리될 수 있습니다).",
            en: "The amount of time to retain delete tombstone markers for log compacted topics. This setting also gives a bound on the time in which a consumer must complete a read if they begin from offset 0 to ensure that they get a valid snapshot of the final stage (otherwise delete tombstones may be collected before they complete their scan).",
        },
        note: {
            ko: "cleanup.policy에 compact가 포함된 토픽에서만 의미가 있습니다.",
            en: "Only meaningful when cleanup.policy includes compact.",
        },
    },
    "file.delete.delay.ms": {
        type: "long",
        def: "60000 (1 minute)",
        range: between("0", LONG_MAX),
        serverDefault: "log.segment.delete.delay.ms",
        summary: { ko: "삭제 대상 파일을 파일시스템에서 실제로 지우기 전 대기 시간.", en: "How long to wait before a file is actually removed from disk." },
        desc: {
            ko: "파일시스템에서 파일을 삭제하기 전에 기다리는 시간입니다.",
            en: "The time to wait before deleting a file from the filesystem",
        },
    },
    "flush.messages": {
        type: "long",
        def: LONG_MAX,
        range: between("1", LONG_MAX),
        serverDefault: "log.flush.interval.messages",
        summary: { ko: "메시지 몇 건마다 로그를 디스크에 강제 fsync할지.", en: "Force an fsync of the log every N messages." },
        desc: {
            ko: "로그에 쓴 데이터를 강제로 fsync하는 간격(메시지 수)을 지정합니다. 예를 들어 1이면 메시지마다, 5이면 다섯 건마다 fsync합니다. 일반적으로는 이 값을 설정하지 말고 내구성은 복제에 맡기며, 더 효율적인 OS의 백그라운드 flush를 쓰는 것을 권장합니다.",
            en: "This setting allows specifying an interval at which we will force an fsync of data written to the log. For example if this was set to 1 we would fsync after every message; if it were 5 we would fsync after every five messages. In general we recommend you not set this and use replication for durability and allow the operating system's background flush capabilities as it is more efficient. This setting can be overridden on a per-topic basis (see the per-topic configuration section).",
        },
        values: [
            { value: "1", meaning: { ko: "메시지마다 fsync — 가장 안전하지만 처리량이 크게 떨어짐.", en: "fsync after every message — safest, but throughput drops sharply." } },
            NO_FSYNC_VALUE,
        ],
    },
    "flush.ms": {
        type: "long",
        def: LONG_MAX,
        range: between("0", LONG_MAX),
        serverDefault: "log.flush.interval.ms",
        summary: { ko: "몇 ms마다 로그를 디스크에 강제 fsync할지.", en: "Force an fsync of the log every N milliseconds." },
        desc: {
            ko: "로그에 쓴 데이터를 강제로 fsync하는 시간 간격을 지정합니다. 예를 들어 1000이면 1000ms가 지날 때마다 fsync합니다. 이 설정은 flush 점검 주기를 정하는 브로커 설정 log.flush.scheduler.interval.ms의 영향을 받습니다. 일반적으로는 이 값을 설정하지 말고 내구성은 복제에 맡기며, 더 효율적인 OS의 백그라운드 flush를 쓰는 것을 권장합니다.",
            en: "This setting allows specifying a time interval at which we will force an fsync of data written to the log. For example if this was set to 1000 we would fsync after 1000 ms had passed. Note that this setting depends on the broker-level configuration log.flush.scheduler.interval.ms, which controls how frequently the flush check occurs. In general we recommend you not set this and use replication for durability and allow the operating system's background flush capabilities as it is more efficient.",
        },
        values: [NO_FSYNC_VALUE],
    },
    "follower.replication.throttled.replicas": {
        type: "list",
        def: "\"\"",
        range: THROTTLE_RANGE,
        serverDefault: "",
        summary: { ko: "팔로워 쪽에서 복제 속도를 제한(throttle)할 레플리카 목록.", en: "Replicas whose replication is throttled on the follower side." },
        desc: {
            ko: "팔로워 쪽에서 로그 복제를 throttle할 레플리카 목록입니다. [파티션ID]:[브로커ID],[파티션ID]:[브로커ID],... 형식으로 적거나, 와일드카드 '*'로 이 토픽의 모든 레플리카를 throttle할 수 있습니다.",
            en: "A list of replicas for which log replication should be throttled on the follower side. The list should describe a set of replicas in the form [PartitionId]:[BrokerId],[PartitionId]:[BrokerId]:... or alternatively the wildcard '*' can be used to throttle all replicas for this topic.",
        },
        values: THROTTLE_VALUES,
        note: THROTTLE_NOTE,
    },
    "index.interval.bytes": {
        type: "int",
        def: "4096 (4 KiB)",
        range: between("0", INT_MAX),
        serverDefault: "log.index.interval.bytes",
        summary: { ko: "오프셋 인덱스에 항목을 추가하는 간격(바이트).", en: "How many bytes between entries in the offset index." },
        desc: {
            ko: "Kafka가 오프셋 인덱스(조건부로 타임 인덱스에도)에 항목을 얼마나 자주 추가할지 정합니다. 기본값이면 대략 4096바이트마다 메시지 하나를 인덱싱합니다. 더 촘촘히 인덱싱하면 읽을 때 로그의 정확한 위치에 더 가깝게 이동할 수 있지만 인덱스 파일이 커집니다. 대부분 바꿀 필요가 없습니다. 참고: 타임 인덱스는 타임스탬프가 마지막으로 인덱싱된 타임스탬프보다 클 때만 추가됩니다.",
            en: "This setting controls how frequently Kafka adds entries to its offset index and, conditionally, to its time index. The default setting ensures that we index a message roughly every 4096 bytes. More frequent indexing allows reads to jump closer to the exact position in the log but results in larger index files. You probably don't need to change this. Note: the time index will be inserted only when the timestamp is greater than the last indexed timestamp.",
        },
    },
    "leader.replication.throttled.replicas": {
        type: "list",
        def: "\"\"",
        range: THROTTLE_RANGE,
        serverDefault: "",
        summary: { ko: "리더 쪽에서 복제 속도를 제한(throttle)할 레플리카 목록.", en: "Replicas whose replication is throttled on the leader side." },
        desc: {
            ko: "리더 쪽에서 로그 복제를 throttle할 레플리카 목록입니다. [파티션ID]:[브로커ID],[파티션ID]:[브로커ID],... 형식으로 적거나, 와일드카드 '*'로 이 토픽의 모든 레플리카를 throttle할 수 있습니다.",
            en: "A list of replicas for which log replication should be throttled on the leader side. The list should describe a set of replicas in the form [PartitionId]:[BrokerId],[PartitionId]:[BrokerId]:... or alternatively the wildcard '*' can be used to throttle all replicas for this topic.",
        },
        values: THROTTLE_VALUES,
        note: THROTTLE_NOTE,
    },
    "local.retention.bytes": {
        type: "long",
        def: "-2",
        range: between("-2", LONG_MAX),
        serverDefault: "log.local.retention.bytes",
        summary: { ko: "(Tiered Storage) 파티션의 로컬 로그가 이 크기를 넘으면 오래된 로컬 세그먼트를 삭제.", en: "(Tiered storage) Max size of a partition's local log before old local segments are deleted." },
        desc: {
            ko: "오래된 세그먼트를 삭제하기 전까지 파티션의 로컬 로그 세그먼트가 커질 수 있는 최대 크기입니다. 기본값 -2는 `retention.bytes` 값을 그대로 쓴다는 뜻입니다. 실제 적용값은 항상 `retention.bytes` 이하여야 합니다.",
            en: "The maximum size of local log segments that can grow for a partition before it deletes the old segments. Default value is -2, it represents `retention.bytes` value to be used. The effective value should always be less than or equal to `retention.bytes` value.",
        },
        values: [
            { value: "-2", meaning: { ko: "retention.bytes 값을 그대로 사용 (기본값).", en: "Use the retention.bytes value (default)." } },
            { value: "-1", meaning: { ko: "로컬 크기 제한 없음.", en: "No local size limit." } },
        ],
        note: {
            ko: "remote.storage.enable=true인 토픽에서만 의미가 있습니다.",
            en: "Only meaningful on topics with remote.storage.enable=true.",
        },
    },
    "local.retention.ms": {
        type: "long",
        def: "-2",
        range: between("-2", LONG_MAX),
        serverDefault: "log.local.retention.ms",
        summary: { ko: "(Tiered Storage) 로컬 로그 세그먼트를 삭제하기 전까지 보관하는 시간.", en: "(Tiered storage) How long local log segments are kept before deletion." },
        desc: {
            ko: "로컬 로그 세그먼트를 삭제하기 전까지 보관하는 시간(ms)입니다. 기본값 -2는 `retention.ms` 값을 그대로 쓴다는 뜻입니다. 실제 적용값은 항상 `retention.ms` 이하여야 합니다.",
            en: "The number of milliseconds to keep the local log segment before it gets deleted. Default value is -2, it represents `retention.ms` value is to be used. The effective value should always be less than or equal to `retention.ms` value.",
        },
        values: [
            { value: "-2", meaning: { ko: "retention.ms 값을 그대로 사용 (기본값).", en: "Use the retention.ms value (default)." } },
            { value: "-1", meaning: { ko: "로컬 보관 시간 제한 없음.", en: "No local time limit." } },
        ],
        note: {
            ko: "remote.storage.enable=true인 토픽에서만 의미가 있습니다.",
            en: "Only meaningful on topics with remote.storage.enable=true.",
        },
    },
    "max.compaction.lag.ms": {
        type: "long",
        def: LONG_MAX,
        range: between("1", LONG_MAX),
        serverDefault: "log.cleaner.max.compaction.lag.ms",
        summary: { ko: "메시지가 컴팩션되지 않은 채 남아 있을 수 있는 최대 시간.", en: "Max time a message may stay ineligible for compaction." },
        desc: {
            ko: "메시지가 로그에서 컴팩션 대상이 되지 않은 채 남아 있을 수 있는 최대 시간입니다. 컴팩션되는 로그에만 적용됩니다.",
            en: "The maximum time a message will remain ineligible for compaction in the log. Only applicable for logs that are being compacted.",
        },
    },
    "max.message.bytes": {
        type: "int",
        def: "1048588",
        range: between("0", INT_MAX),
        serverDefault: "message.max.bytes",
        summary: { ko: "이 토픽이 받아들이는 레코드 배치의 최대 크기.", en: "Largest record batch this topic accepts." },
        desc: {
            ko: "Kafka가 허용하는 레코드 배치의 최대 크기입니다(압축을 쓰는 경우 압축 후 크기 기준).",
            en: "The largest record batch size allowed by Kafka (after compression if compression is enabled).",
        },
        note: {
            ko: "이보다 큰 배치는 발행이 거부됩니다. 큰 메시지를 보내려면 프로듀서의 max.request.size도 함께 올려야 합니다.",
            en: "Larger batches are rejected on produce. To send bigger messages the producer's max.request.size must be raised as well.",
        },
    },
    "message.timestamp.after.max.ms": {
        type: "long",
        def: "3600000 (1 hour)",
        range: between("0", LONG_MAX),
        serverDefault: "log.message.timestamp.after.max.ms",
        summary: { ko: "메시지 타임스탬프가 브로커 시각보다 얼마나 미래여도 되는지.", en: "How far ahead of the broker's clock a message timestamp may be." },
        desc: {
            ko: "메시지 타임스탬프와 브로커 타임스탬프 사이에 허용되는 차이를 정합니다. 메시지 타임스탬프는 브로커 타임스탬프와 같거나 더 늦을(미래) 수 있고, 그 최대 허용 차이가 이 값입니다. message.timestamp.type=CreateTime이면 차이가 이 임계값을 넘는 메시지는 거부됩니다. message.timestamp.type=LogAppendTime이면 이 설정은 무시됩니다.",
            en: "This configuration sets the allowable timestamp difference between the message timestamp and the broker's timestamp. The message timestamp can be later than or equal to the broker's timestamp, with the maximum allowable difference determined by the value set in this configuration. If message.timestamp.type=CreateTime, the message will be rejected if the difference in timestamps exceeds this specified threshold. This configuration is ignored if message.timestamp.type=LogAppendTime.",
        },
        note: {
            ko: `기본값은 Kafka 4.0부터 1시간이고, 3.9까지는 ${LONG_MAX}(제한 없음)입니다.`,
            en: `The default is 1 hour from Kafka 4.0; up to 3.9 it is ${LONG_MAX} (no limit).`,
        },
    },
    "message.timestamp.before.max.ms": {
        type: "long",
        def: LONG_MAX,
        range: between("0", LONG_MAX),
        serverDefault: "log.message.timestamp.before.max.ms",
        summary: { ko: "메시지 타임스탬프가 브로커 시각보다 얼마나 과거여도 되는지.", en: "How far behind the broker's clock a message timestamp may be." },
        desc: {
            ko: "브로커 타임스탬프와 메시지 타임스탬프 사이에 허용되는 차이를 정합니다. 메시지 타임스탬프는 브로커 타임스탬프와 같거나 더 이를(과거) 수 있고, 그 최대 허용 차이가 이 값입니다. message.timestamp.type=CreateTime이면 차이가 이 임계값을 넘는 메시지는 거부됩니다. message.timestamp.type=LogAppendTime이면 이 설정은 무시됩니다.",
            en: "This configuration sets the allowable timestamp difference between the broker's timestamp and the message timestamp. The message timestamp can be earlier than or equal to the broker's timestamp, with the maximum allowable difference determined by the value set in this configuration. If message.timestamp.type=CreateTime, the message will be rejected if the difference in timestamps exceeds this specified threshold. This configuration is ignored if message.timestamp.type=LogAppendTime.",
        },
    },
    "message.timestamp.type": {
        type: "string",
        def: "CreateTime",
        range: { ko: "CreateTime, LogAppendTime", en: "CreateTime, LogAppendTime" },
        serverDefault: "log.message.timestamp.type",
        summary: { ko: "메시지 타임스탬프를 생성 시각으로 할지, 브로커 기록 시각으로 할지.", en: "Whether the message timestamp is the create time or the log append time." },
        desc: {
            ko: "메시지의 타임스탬프가 메시지 생성 시각인지 로그 추가(append) 시각인지를 정의합니다.",
            en: "Define whether the timestamp in the message is message create time or log append time.",
        },
        values: [
            { value: "CreateTime", meaning: { ko: "프로듀서가 메시지에 넣은 시각을 그대로 사용 (기본값).", en: "Keep the timestamp the producer put on the message (default)." } },
            { value: "LogAppendTime", meaning: { ko: "브로커가 로그에 기록한 시각으로 덮어씀. 프로듀서가 보낸 타임스탬프는 무시됨.", en: "Overwrite it with the time the broker appended the record; the producer's timestamp is ignored." } },
        ],
    },
    "min.cleanable.dirty.ratio": {
        type: "double",
        def: "0.5",
        range: between("0", "1"),
        serverDefault: "log.cleaner.min.cleanable.ratio",
        summary: { ko: "컴팩션을 시작하는 기준이 되는 미정리(dirty) 비율.", en: "Dirty ratio at which the log compactor starts cleaning." },
        desc: {
            ko: "로그 컴팩터가 로그 정리를 얼마나 자주 시도할지 정합니다(로그 컴팩션이 켜져 있는 경우). 기본적으로 로그의 50% 넘게 이미 컴팩션된 경우에는 정리를 하지 않습니다. 이 비율은 중복 때문에 낭비되는 로그 공간의 상한을 정합니다(50%면 로그의 최대 50%가 중복일 수 있음). 비율이 높을수록 정리 횟수는 줄고 효율적이지만 낭비되는 공간은 늘어납니다. max.compaction.lag.ms나 min.compaction.lag.ms가 함께 지정되어 있으면, (i) dirty 비율 임계값을 넘었고 dirty(미컴팩션) 레코드가 min.compaction.lag.ms 이상 있었거나, (ii) dirty 레코드가 max.compaction.lag.ms 기간에 도달한 경우 곧바로 컴팩션 대상으로 봅니다.",
            en: "This configuration controls how frequently the log compactor will attempt to clean the log (assuming log compaction is enabled). By default we will avoid cleaning a log where more than 50% of the log has been compacted. This ratio bounds the maximum space wasted in the log by duplicates (at 50% at most 50% of the log could be duplicates). A higher ratio will mean fewer, more efficient cleanings but will mean more wasted space in the log. If the max.compaction.lag.ms or the min.compaction.lag.ms configurations are also specified, then the log compactor considers the log to be eligible for compaction as soon as either: (i) the dirty ratio threshold has been met and the log has had dirty (uncompacted) records for at least the min.compaction.lag.ms duration, or (ii) if the log has had dirty (uncompacted) records for at most the max.compaction.lag.ms period.",
        },
    },
    "min.compaction.lag.ms": {
        type: "long",
        def: "0",
        range: between("0", LONG_MAX),
        serverDefault: "log.cleaner.min.compaction.lag.ms",
        summary: { ko: "메시지가 컴팩션되지 않고 남아 있도록 보장하는 최소 시간.", en: "Min time a message stays uncompacted." },
        desc: {
            ko: "메시지가 로그에서 컴팩션되지 않은 채 남아 있는 최소 시간입니다. 컴팩션되는 로그에만 적용됩니다.",
            en: "The minimum time a message will remain uncompacted in the log. Only applicable for logs that are being compacted.",
        },
    },
    "min.insync.replicas": {
        type: "int",
        def: "1",
        range: between("1", INT_MAX),
        serverDefault: "min.insync.replicas",
        summary: { ko: "acks=all 발행이 성공하려면 필요한 최소 in-sync 레플리카 수.", en: "Min in-sync replicas required for an acks=all write to succeed." },
        desc: {
            ko: "프로듀서가 acks를 \"all\"(또는 \"-1\")로 설정했을 때 쓰기가 성공하려면 필요한 최소 in-sync 레플리카 수(리더 포함)입니다. acks=all이면 모든 in-sync 레플리카가 쓰기를 확인해야 성공으로 봅니다. 예를 들어 replication factor가 3이고 ISR에 세 레플리카가 모두 있으면, min.insync.replicas가 3보다 작더라도 세 레플리카 모두 확인해야 합니다. acks=all인데 현재 ISR 수가 min.insync.replicas보다 적으면 프로듀서에 예외(NotEnoughReplicas 또는 NotEnoughReplicasAfterAppend)가 발생합니다. acks 설정과 무관하게, 메시지는 모든 in-sync 레플리카에 복제되고 min.insync.replicas 조건을 충족하기 전까지 컨슈머에게 보이지 않습니다. min.insync.replicas와 acks를 함께 쓰면 더 강한 내구성을 보장할 수 있습니다. 전형적인 구성은 replication factor 3, min.insync.replicas 2, acks=\"all\"이며, 이러면 과반수 레플리카에 기록되어야 프로듀서가 성공으로 보고 컨슈머에게도 보입니다. Eligible Leader Replicas(ELR) 기능이 켜져 있으면 이 설정의 의미가 달라지니 ELR 문서를 참고하세요.",
            en: "Specifies the minimum number of in-sync replicas (including the leader) required for a write to succeed when a producer sets acks to \"all\" (or \"-1\"). In the acks=all case, every in-sync replica must acknowledge a write for it to be considered successful. E.g., if a topic has replication.factor of 3 and the ISR set includes all three replicas, then all three replicas must acknowledge an acks=all write for it to succeed, even if min.insync.replicas happens to be less than 3. If acks=all and the current ISR set contains fewer than min.insync.replicas members, then the producer will raise an exception (either NotEnoughReplicas or NotEnoughReplicasAfterAppend). Regardless of the acks setting, the messages will not be visible to the consumers until they are replicated to all in-sync replicas and the min.insync.replicas condition is met. When used together, min.insync.replicas and acks allow you to enforce greater durability guarantees. A typical scenario would be to create a topic with a replication factor of 3, set min.insync.replicas to 2, and produce with acks of \"all\". This ensures that a majority of replicas must persist a write before it's considered successful by the producer and it's visible to consumers. Note that when the Eligible Leader Replicas feature is enabled, the semantics of this config changes. Please refer to the ELR section for more info.",
        },
        note: {
            ko: "replication factor보다 큰 값을 주면 acks=all 발행은 성공할 수 없습니다. 값을 올리면 브로커 한 대만 빠져도 발행이 막힐 수 있습니다.",
            en: "A value above the replication factor means acks=all writes can never succeed. Raising it can block produces as soon as a single broker is down.",
        },
    },
    "preallocate": {
        type: "boolean",
        def: "false",
        range: BOOL_RANGE,
        serverDefault: "log.preallocate",
        summary: { ko: "새 로그 세그먼트를 만들 때 디스크 공간을 미리 할당할지.", en: "Preallocate the file on disk when creating a new log segment." },
        desc: {
            ko: "새 로그 세그먼트를 만들 때 디스크에 파일을 미리 할당할지 여부입니다.",
            en: "True if we should preallocate the file on disk when creating a new log segment.",
        },
        values: bool(
            { ko: "세그먼트 생성 시 segment.bytes만큼 파일을 미리 할당.", en: "Preallocate the segment file up front." },
            { ko: "쓰는 만큼 파일이 커짐 (기본값).", en: "The file grows as data is written (default)." },
        ),
    },
    "remote.log.copy.disable": {
        type: "boolean",
        def: "false",
        range: BOOL_RANGE,
        serverDefault: "",
        summary: { ko: "(Tiered Storage) 원격 저장소로의 업로드를 멈추고 읽기 전용으로 둘지.", en: "(Tiered storage) Stop uploading and make the tiered data read-only." },
        desc: {
            ko: "토픽의 tiered 데이터를 읽기 전용으로 만들어 더 이상 업로드하지 않을지 결정합니다. true로 설정하면 로컬 보존 설정(local.retention.ms/bytes)은 의미가 없어지고, 모든 데이터 만료가 토픽 전체 보존 설정(retention.ms/bytes)을 따릅니다.",
            en: "Determines whether tiered data for a topic should become read only, and no more data uploading on a topic. Once this config is set to true, the local retention configuration (i.e. local.retention.ms/bytes) becomes irrelevant, and all data expiration follows the topic-wide retention configuration(i.e. retention.ms/bytes).",
        },
        values: bool(
            { ko: "원격 저장소 업로드 중단 (기존 원격 데이터는 읽기 전용).", en: "Stop uploading to remote storage (existing remote data stays readable)." },
            { ko: "원격 저장소로 계속 업로드 (기본값).", en: "Keep uploading to remote storage (default)." },
        ),
    },
    "remote.log.delete.on.disable": {
        type: "boolean",
        def: "false",
        range: BOOL_RANGE,
        serverDefault: "",
        summary: { ko: "(Tiered Storage) tiered storage를 끌 때 원격 데이터를 삭제할지.", en: "(Tiered storage) Delete tiered data when tiered storage is disabled." },
        desc: {
            ko: "토픽의 tiered storage를 비활성화한 뒤 tiered 데이터를 삭제할지 결정합니다. `remote.storage.enable`을 true에서 false로 바꾸려면 이 설정을 켜야 합니다.",
            en: "Determines whether tiered data for a topic should be deleted after tiered storage is disabled on a topic. This configuration should be enabled when trying to set `remote.storage.enable` from true to false",
        },
        values: bool(
            { ko: "tiered storage를 끄면 원격에 올라간 데이터도 삭제.", en: "Disabling tiered storage also deletes the remote data." },
            { ko: "원격 데이터 유지 (기본값).", en: "Keep the remote data (default)." },
        ),
    },
    "remote.storage.enable": {
        type: "boolean",
        def: "false",
        range: BOOL_RANGE,
        serverDefault: "",
        summary: { ko: "이 토픽에 tiered storage(원격 저장소)를 쓸지.", en: "Enable tiered storage for this topic." },
        desc: {
            ko: "토픽에 tiered storage를 쓰려면 true로 설정합니다. 이미 켜져 있는 토픽에서 끄려면 false로 설정하며, 끌 때는 remote.log.delete.on.disable도 true로 설정해야 합니다.",
            en: "To enable tiered storage for a topic, set this configuration to true. To disable tiered storage for a topic that has it enabled, set this configuration to false. When disabling, you must also set remote.log.delete.on.disable to true.",
        },
        values: bool(
            { ko: "오래된 세그먼트를 원격 저장소로 옮김. 브로커에 tiered storage가 구성되어 있어야 함.", en: "Move older segments to remote storage. Requires tiered storage to be configured on the brokers." },
            { ko: "로컬 디스크만 사용 (기본값).", en: "Local disk only (default)." },
        ),
    },
    "retention.bytes": {
        type: "long",
        def: "-1",
        range: { ko: "공식 문서에 범위 명시 없음 (long). -1 = 제한 없음", en: "No range listed in the docs (long). -1 = no limit" },
        serverDefault: "log.retention.bytes",
        summary: { ko: "파티션 하나가 이 크기를 넘으면 오래된 세그먼트를 삭제 (delete 정책).", en: "Max size a partition can reach before old segments are discarded (delete policy)." },
        desc: {
            ko: "\"delete\" 보존 정책을 쓸 때, 공간 확보를 위해 오래된 로그 세그먼트를 버리기 전까지 파티션(로그 세그먼트들로 구성)이 커질 수 있는 최대 크기를 정합니다. 기본적으로 크기 제한은 없고 시간 제한만 있습니다. 이 한도는 파티션 단위로 적용되므로, 토픽 전체의 보존 바이트는 파티션 수를 곱해 계산합니다. retention.bytes는 \"segment.ms\"·\"segment.bytes\" 설정과 독립적으로 동작하며, 0으로 설정하면 새 세그먼트 롤링을 유발합니다.",
            en: "This configuration controls the maximum size a partition (which consists of log segments) can grow to before we will discard old log segments to free up space if we are using the \"delete\" retention policy. By default there is no size limit only a time limit. Since this limit is enforced at the partition level, multiply it by the number of partitions to compute the topic retention in bytes. Additionally, retention.bytes configuration operates independently of \"segment.ms\" and \"segment.bytes\" configurations. Moreover, it triggers the rolling of new segment if the retention.bytes is configured to zero.",
        },
        values: [
            { value: "-1", meaning: { ko: "크기 제한 없음 — retention.ms(시간)로만 삭제 (기본값).", en: "No size limit — only retention.ms applies (default)." } },
        ],
        note: {
            ko: "파티션 단위 한도입니다(토픽 전체 = 값 × 파티션 수). 값을 줄이면 한도를 넘는 오래된 데이터가 다음 정리 주기에 삭제되며 되돌릴 수 없습니다.",
            en: "The limit is per partition (topic total = value × partitions). Lowering it deletes the excess old data on the next cleanup pass, irreversibly.",
        },
    },
    "retention.ms": {
        type: "long",
        def: "604800000 (7 days)",
        range: between("-1", LONG_MAX),
        serverDefault: "log.retention.ms",
        summary: { ko: "메시지를 보관하는 최대 시간. 지나면 오래된 세그먼트를 삭제 (delete 정책).", en: "Max time a log is retained before old segments are discarded (delete policy)." },
        desc: {
            ko: "\"delete\" 보존 정책을 쓸 때, 공간 확보를 위해 오래된 로그 세그먼트를 버리기 전까지 로그를 보관하는 최대 시간을 정합니다. 컨슈머가 데이터를 얼마나 빨리 읽어야 하는지에 대한 SLA이기도 합니다. -1로 설정하면 시간 제한이 없습니다. retention.ms는 \"segment.ms\"·\"segment.bytes\" 설정과 독립적으로 동작하며, retention.ms 조건이 충족되면 새 세그먼트 롤링을 유발합니다.",
            en: "This configuration controls the maximum time we will retain a log before we will discard old log segments to free up space if we are using the \"delete\" retention policy. This represents an SLA on how soon consumers must read their data. If set to -1, no time limit is applied. Additionally, retention.ms configuration operates independently of \"segment.ms\" and \"segment.bytes\" configurations. Moreover, it triggers the rolling of new segment if the retention.ms condition is satisfied.",
        },
        values: [
            { value: "-1", meaning: { ko: "시간 제한 없음 (무기한 보관).", en: "No time limit (keep forever)." } },
            { value: "604800000", meaning: { ko: "7일 (기본값).", en: "7 days (default)." } },
        ],
        note: {
            ko: "값을 줄이면 새 보존 기간보다 오래된 데이터가 다음 정리 주기에 삭제되며 되돌릴 수 없습니다.",
            en: "Lowering it deletes data older than the new period on the next cleanup pass, irreversibly.",
        },
    },
    "segment.bytes": {
        type: "int",
        def: "1073741824 (1 GiB)",
        range: { ko: `1048576 (1 MiB) ~ ${INT_MAX} (약 2 GiB)`, en: `1048576 (1 MiB) to ${INT_MAX} (~2 GiB)` },
        serverDefault: "log.segment.bytes",
        summary: { ko: "로그 세그먼트 파일 하나의 크기.", en: "Size of a single log segment file." },
        desc: {
            ko: "로그의 세그먼트 파일 크기를 정합니다. 보존(삭제)과 정리는 항상 파일 단위로 이뤄지므로, 세그먼트가 클수록 파일 수는 줄지만 보존을 세밀하게 제어하기 어려워집니다.",
            en: "This configuration controls the segment file size for the log. Retention and cleaning is always done a file at a time so a larger segment size means fewer files but less granular control over retention.",
        },
        note: {
            ko: "최솟값 1048576은 Kafka 4.1 기준이며, 4.0 이하 버전은 14까지 허용합니다.",
            en: "The 1048576 minimum is from Kafka 4.1; 4.0 and earlier accept values down to 14.",
        },
    },
    "segment.index.bytes": {
        type: "int",
        def: "10485760 (10 MiB)",
        range: between("4", INT_MAX),
        serverDefault: "log.index.size.max.bytes",
        summary: { ko: "오프셋 → 파일 위치를 매핑하는 인덱스 파일의 크기.", en: "Size of the index that maps offsets to file positions." },
        desc: {
            ko: "오프셋을 파일 위치에 매핑하는 인덱스의 크기를 정합니다. 이 인덱스 파일은 미리 할당해 두고 로그가 롤링된 뒤에만 줄입니다. 일반적으로 바꿀 필요가 없습니다.",
            en: "This configuration controls the size of the index that maps offsets to file positions. We preallocate this index file and shrink it only after log rolls. You generally should not need to change this setting.",
        },
    },
    "segment.jitter.ms": {
        type: "long",
        def: "0",
        range: between("0", LONG_MAX),
        serverDefault: "log.roll.jitter.ms",
        summary: { ko: "세그먼트 롤링 시각에서 빼는 무작위 지터의 최댓값.", en: "Max random jitter subtracted from the scheduled segment roll time." },
        desc: {
            ko: "세그먼트 롤링이 한꺼번에 몰리는 것(thundering herd)을 피하기 위해, 예정된 세그먼트 롤링 시각에서 빼는 무작위 지터의 최댓값입니다.",
            en: "The maximum random jitter subtracted from the scheduled segment roll time to avoid thundering herds of segment rolling",
        },
    },
    "segment.ms": {
        type: "long",
        def: "604800000 (7 days)",
        range: between("1", LONG_MAX),
        serverDefault: "log.roll.ms",
        summary: { ko: "세그먼트가 가득 차지 않아도 강제로 새 세그먼트로 넘기는 주기.", en: "Time after which the log is rolled even if the segment isn't full." },
        desc: {
            ko: "세그먼트 파일이 가득 차지 않았더라도 Kafka가 로그를 강제로 롤링하는 주기를 정합니다. 보존 정책이 오래된 데이터를 삭제하거나 컴팩션할 수 있도록 보장하기 위한 설정입니다.",
            en: "This configuration controls the period of time after which Kafka will force the log to roll even if the segment file isn't full to ensure that retention can delete or compact old data.",
        },
        note: {
            ko: "너무 작게 잡으면 작은 세그먼트 파일이 많이 생겨 열린 파일 수와 브로커 부하가 늘어납니다.",
            en: "A very small value produces many tiny segment files, raising open-file counts and broker load.",
        },
    },
    "unclean.leader.election.enable": {
        type: "boolean",
        def: "false",
        range: BOOL_RANGE,
        serverDefault: "unclean.leader.election.enable",
        summary: { ko: "ISR에 없는 레플리카도 최후의 수단으로 리더가 될 수 있게 할지 (데이터 유실 가능).", en: "Allow out-of-sync replicas to become leader as a last resort (may lose data)." },
        desc: {
            ko: "데이터 유실 가능성이 있더라도, 최후의 수단으로 ISR에 없는 레플리카가 리더로 선출되는 것을 허용할지 여부입니다. 참고: KRaft 모드에서 이 설정을 동적으로 켜면 unclean 리더 선출 스레드가 주기적으로(기본 5분) 선출을 수행할 때까지 기다려야 합니다. 즉시 수행하려면 `kafka-leader-election.sh`를 `unclean` 옵션으로 실행하세요.",
            en: "Indicates whether to enable replicas not in the ISR set to be elected as leader as a last resort, even though doing so may result in data loss. Note: In KRaft mode, when enabling this config dynamically, it needs to wait for the unclean leader election thread to trigger election periodically (default is 5 minutes). Please run `kafka-leader-election.sh` with `unclean` option to trigger the unclean leader election immediately if needed.",
        },
        values: bool(
            { ko: "가용성 우선 — ISR이 모두 죽으면 뒤처진 레플리카가 리더가 되며, 복제되지 않은 메시지는 유실됨.", en: "Availability first — if every ISR member is down a lagging replica takes over and unreplicated messages are lost." },
            { ko: "정합성 우선 — ISR 레플리카가 돌아올 때까지 파티션이 오프라인 상태로 남음 (기본값).", en: "Consistency first — the partition stays offline until an ISR replica comes back (default)." },
        ),
    },
    "message.downconversion.enable": {
        type: "boolean",
        def: "true",
        range: BOOL_RANGE,
        serverDefault: "log.message.downconversion.enable",
        deprecated: true,
        summary: { ko: "구버전 컨슈머를 위해 메시지 포맷 down-conversion을 할지.", en: "Whether message formats are down-converted for older consumers." },
        desc: {
            ko: "consume 요청을 처리하기 위한 메시지 포맷 down-conversion을 켤지 정합니다. false면 브로커는 옛 메시지 포맷을 기대하는 컨슈머를 위한 down-conversion을 하지 않고, 그런 구버전 클라이언트의 consume 요청에 UNSUPPORTED_VERSION 오류로 응답합니다. 팔로워 복제에 필요한 메시지 포맷 변환에는 적용되지 않습니다.",
            en: "This configuration controls whether down-conversion of message formats is enabled to satisfy consume requests. When set to false, broker will not perform down-conversion for consumers expecting an older message format. The broker responds with UNSUPPORTED_VERSION error for consume requests from such older clients. This configuration does not apply to any message format conversion that might be required for replication to followers.",
        },
        values: bool(
            { ko: "구버전 컨슈머에게 옛 포맷으로 변환해 전달 (기본값).", en: "Convert to the older format for old consumers (default)." },
            { ko: "변환하지 않음 — 구버전 컨슈머는 UNSUPPORTED_VERSION 오류를 받음.", en: "No conversion — old consumers get UNSUPPORTED_VERSION." },
        ),
    },
    "message.format.version": {
        type: "string",
        def: "3.0-IV1",
        range: { ko: "유효한 ApiVersion (예: 0.10.0, 1.1, 2.8, 3.0)", en: "A valid ApiVersion (e.g. 0.10.0, 1.1, 2.8, 3.0)" },
        serverDefault: "log.message.format.version",
        deprecated: true,
        summary: { ko: "브로커가 로그에 기록할 때 쓸 메시지 포맷 버전.", en: "Message format version the broker uses when appending to the log." },
        desc: {
            ko: "브로커가 로그에 메시지를 추가할 때 쓸 메시지 포맷 버전을 지정합니다. `inter.broker.protocol.version`이 3.0 이상이면 이 값은 항상 `3.0`으로 간주됩니다(실제 설정값은 무시). 그렇지 않으면 유효한 ApiVersion이어야 합니다(예: 0.10.0, 1.1, 2.8, 3.0). 특정 버전을 지정한다는 것은 디스크에 있는 기존 메시지가 모두 그 버전 이하임을 사용자가 보증한다는 뜻입니다. 잘못 설정하면 구버전 컨슈머가 이해하지 못하는 포맷의 메시지를 받아 동작이 깨집니다.",
            en: "Specify the message format version the broker will use to append messages to the logs. The value of this config is always assumed to be `3.0` if `inter.broker.protocol.version` is 3.0 or higher (the actual config value is ignored). Otherwise, the value should be a valid ApiVersion. Some examples are: 0.10.0, 1.1, 2.8, 3.0. By setting a particular message format version, the user is certifying that all the existing messages on disk are smaller or equal than the specified version. Setting this value incorrectly will cause consumers with older versions to break as they will receive messages with a format that they don't understand.",
        },
    },
    "message.timestamp.difference.max.ms": {
        type: "long",
        def: LONG_MAX,
        range: between("0", LONG_MAX),
        serverDefault: "log.message.timestamp.difference.max.ms",
        deprecated: true,
        summary: { ko: "브로커 수신 시각과 메시지 타임스탬프 사이에 허용되는 최대 차이.", en: "Max allowed difference between broker receive time and the message timestamp." },
        desc: {
            ko: "브로커가 메시지를 받은 시각과 메시지에 지정된 타임스탬프 사이에 허용되는 최대 차이입니다. message.timestamp.type=CreateTime이면 차이가 이 임계값을 넘는 메시지는 거부됩니다. message.timestamp.type=LogAppendTime이면 이 설정은 무시됩니다.",
            en: "The maximum difference allowed between the timestamp when a broker receives a message and the timestamp specified in the message. If message.timestamp.type=CreateTime, a message will be rejected if the difference in timestamp exceeds this threshold. This configuration is ignored if message.timestamp.type=LogAppendTime.",
        },
        note: {
            ko: "message.timestamp.before.max.ms / message.timestamp.after.max.ms로 대체되었습니다.",
            en: "Superseded by message.timestamp.before.max.ms / message.timestamp.after.max.ms.",
        },
    },
};

// Keys offered as suggestions when adding a config row. Deprecated ones are
// documented (an older broker still returns them) but not suggested.
export const TOPIC_CONFIG_KEYS: string[] = Object.keys(TOPIC_CONFIG_DOCS)
    .filter((k) => !TOPIC_CONFIG_DOCS[k].deprecated)
    .sort();

export function getTopicConfigDoc(key: string): TopicConfigDoc | undefined {
    const k = key.trim();
    return Object.prototype.hasOwnProperty.call(TOPIC_CONFIG_DOCS, k) ? TOPIC_CONFIG_DOCS[k] : undefined;
}
