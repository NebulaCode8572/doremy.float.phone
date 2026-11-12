"use client";

import { useEffect } from "react";
import { hydrateChatStorage } from "@/lib/chat-storage";
import { syncNativeCallRingtones } from "@/lib/call-ringtone-sync";

/** Restore web-configured incoming-call audio into Android private storage after chat data hydration. */
export function CallRingtoneSyncBootstrap() {
    useEffect(() => {
        let cancelled = false;
        void hydrateChatStorage().then(() => {
            if (!cancelled) return syncNativeCallRingtones();
        }).catch(error => {
            console.warn("[CallRingtoneSync] Startup synchronization failed.", error);
        });
        return () => { cancelled = true; };
    }, []);
    return null;
}
