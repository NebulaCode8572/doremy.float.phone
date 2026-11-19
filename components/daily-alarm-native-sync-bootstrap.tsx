"use client";

import { useEffect } from "react";
import { loadCharacters } from "@/lib/character-storage";
import { loadDailyAlarmConfig } from "@/lib/daily-alarm-storage";
import { hydrateKvDb } from "@/lib/kv-db";
import { scheduleNativeDailyAlarmWatchdog } from "@/lib/call-ringtone-sync";

/** Re-arm the persisted native watchdog from the web alarm config on app startup. */
export function DailyAlarmNativeSyncBootstrap() {
    useEffect(() => {
        let cancelled = false;
        void hydrateKvDb().then(() => {
            if (cancelled) return;
            const config = loadDailyAlarmConfig();
            if (!config?.enabled) return;
            const characterName = loadCharacters().find(character => character.id === config.characterId)?.name || "角色";
            const armed = scheduleNativeDailyAlarmWatchdog(config, characterName);
            if (armed === false) console.warn("[DailyAlarm] Native watchdog could not be restored from the saved config.");
        });
        return () => { cancelled = true; };
    }, []);
    return null;
}
