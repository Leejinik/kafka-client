import { useState } from "react";
import { Lang, t } from "../lib/i18n";
import { kafka } from "../../wailsjs/go/models";
import { saveMessage } from "../lib/savedMessages";
import { Modal } from "./Modal";

interface Props {
    lang: Lang;
    topic: string;
    message: kafka.Message;
    onClose: () => void;
    onSaved: (name: string) => void;
}

export function SaveMessageDialog({ lang, topic, message, onClose, onSaved }: Props) {
    const defaultName = `${topic} P${message.partition} @${message.offset}`;
    const [name, setName] = useState(defaultName);

    const handleSave = () => {
        const trimmed = name.trim() || defaultName;
        saveMessage({
            name: trimmed,
            topic,
            partition: message.partition,
            key: message.key,
            value: message.value,
            headers: message.headers || {},
        });
        onSaved(trimmed);
    };

    return (
        <Modal
            title={t(lang, "saved.save.title")}
            onClose={onClose}
            footer={
                <>
                    <button onClick={onClose}>{t(lang, "profile.cancel")}</button>
                    <button className="primary" onClick={handleSave}>{t(lang, "saved.save.submit")}</button>
                </>
            }
        >
                    <div className="form-row">
                        <label>{t(lang, "saved.name")}</label>
                        <input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            autoFocus
                            onKeyDown={(e) => {
                                if (e.key === "Enter") handleSave();
                            }}
                        />
                    </div>
                    <div className="muted" style={{ fontSize: 11 }}>
                        {t(lang, "saved.preview")}: <span className="mono">{topic}</span> · P{message.partition} · @{message.offset}
                    </div>
        </Modal>
    );
}
