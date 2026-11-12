"use client";

import { useEffect, useMemo, useState } from "react";
import { Clock, PhoneCall } from "lucide-react";
import { loadCharacters } from "@/lib/character-storage";
import { createOrGetSession, loadChatSessions } from "@/lib/chat-storage";
import {
    clearDailyAlarmConfig,
    loadDailyAlarmConfig,
    nextDailyAlarmAt,
    saveDailyAlarmConfig,
    type DailyAlarmConfig,
} from "@/lib/daily-alarm-storage";
import { armDailyAlarmBailout } from "@/lib/push-bailout-client";

export function DailyAlarmSettings({ onNotice }: { onNotice: (message: string) => void }) {
    const characters = useMemo(() => loadCharacters(), []);
    const [config, setConfig] = useState<DailyAlarmConfig | null>(() => loadDailyAlarmConfig());
    const [characterId, setCharacterId] = useState(() => loadDailyAlarmConfig()?.characterId || characters[0]?.id || "");
    const [localTime, setLocalTime] = useState(() => loadDailyAlarmConfig()?.localTime || "07:00");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const eligibleCharacters = useMemo(() => {
        const sessions = loadChatSessions();
        const ids = new Set(sessions.filter(session => !session.isGroup).map(session => session.contactId));
        return characters.filter(character => ids.has(character.id) || character.id === characterId);
    }, [characters, characterId]);

    useEffect(() => {
        const current = loadDailyAlarmConfig();
        if (current) {
            setConfig(current);
            setCharacterId(current.characterId);
            setLocalTime(current.localTime);
        }
    }, []);

    const enable = async () => {
        if (!characterId) { setError("请先选择一个角色。"); return; }
        setBusy(true);
        setError("");
        try {
            const session = createOrGetSession(characterId);
            const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
            const next = nextDailyAlarmAt(Date.now(), localTime, timeZone);
            const nextConfig: DailyAlarmConfig = {
                id: `daily_alarm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                enabled: true,
                sessionId: session.id,
                characterId,
                localTime,
                timeZone,
                updatedAt: Date.now(),
            };
            const result = await armDailyAlarmBailout(nextConfig);
            if (!result.ok) {
                setError(result.reason || "离线闹钟预约失败。");
                return;
            }
            saveDailyAlarmConfig(nextConfig);
            setConfig(nextConfig);
            onNotice(`AI 闹钟已开启，每天 ${localTime} 提醒`);
        } finally {
            setBusy(false);
        }
    };

    const disable = () => {
        clearDailyAlarmConfig();
        setConfig(null);
        onNotice("AI 闹钟已关闭");
    };

    const nextText = config?.enabled
        ? new Date(nextDailyAlarmAt(Date.now(), config.localTime, config.timeZone).fireAt).toLocaleString()
        : "";

    return (
        <div className="flex flex-col gap-4 p-1">
            <div className="rounded-2xl bg-[var(--c-card)] p-4">
                <div className="flex items-center gap-2 text-base font-semibold">
                    <Clock size={18} /> 每日 AI 闹钟
                </div>
                <p className="mt-2 text-sm leading-relaxed text-[var(--c-text-secondary)]">
                    每天按设定时间，由选定角色发送一条早安消息并发起语音来电。需要启用离线推送。
                </p>
                <div className="mt-4 flex flex-col gap-2">
                    <label className="text-sm font-medium">叫醒你的角色</label>
                    <select
                        value={characterId}
                        onChange={event => setCharacterId(event.target.value)}
                        className="w-full rounded-xl border border-[var(--c-border)] bg-[var(--c-input)] px-3 py-3 text-sm"
                    >
                        {eligibleCharacters.map(character => (
                            <option key={character.id} value={character.id}>{character.name}</option>
                        ))}
                    </select>
                    <label className="mt-2 text-sm font-medium">每天响起时间</label>
                    <input
                        type="time"
                        value={localTime}
                        onChange={event => setLocalTime(event.target.value)}
                        className="w-full rounded-xl border border-[var(--c-border)] bg-[var(--c-input)] px-3 py-3 text-sm"
                    />
                    <p className="text-xs leading-relaxed text-[var(--c-text-secondary)]">
                        使用当前设备时区：{Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"}
                    </p>
                </div>
                {error ? <p className="mt-3 text-sm text-red-500">{error}</p> : null}
                {config?.enabled ? (
                    <p className="mt-3 text-xs text-[var(--c-text-secondary)]">已开启 · 下一次：{nextText}</p>
                ) : null}
                <div className="mt-4 flex gap-2">
                    <button type="button" className="ui-btn ui-btn-primary flex-1" disabled={busy || !characterId} onClick={() => void enable()}>
                        <PhoneCall size={15} /> {busy ? "正在保存…" : config?.enabled ? "更新闹钟" : "开启每日闹钟"}
                    </button>
                    {config?.enabled ? (
                        <button type="button" className="ui-btn ui-btn-outline" disabled={busy} onClick={disable}>关闭</button>
                    ) : null}
                </div>
            </div>
            <p className="text-xs leading-relaxed text-[var(--c-text-secondary)]">
                当前版本先完成每日消息与来电的重复排期。未接重拨、第二次未接后的原生闹钟兜底，以及重启后的本机恢复将在后续阶段接入；现在不要把它当作唯一可靠的起床闹钟。
            </p>
        </div>
    );
}
