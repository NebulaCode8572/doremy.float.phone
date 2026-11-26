"use client";

import { useContext, useEffect, useState } from "react";
import { SettingsContext } from "@/components/phone-settings-app";
import { Toggle } from "@/components/ui/form";
import { loadMemoryConfig, saveMemoryConfig } from "@/lib/memory-storage";

type PublicSettings = {
  configured: boolean;
  baseUrl: string;
  model: string;
  dimensions: 1024;
  updatedAt?: string;
};

export function VectorMemorySettings() {
  const { setSubpageTitle } = useContext(SettingsContext);
  const [enabled, setEnabled] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("BAAI/bge-m3");
  const [apiKey, setApiKey] = useState("");
  const [configured, setConfigured] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setSubpageTitle("向量记忆");
    let active = true;
    setEnabled(loadMemoryConfig().vectorMemoryEnabled);
    void fetch("/api/vector-memory-settings", { cache: "no-store" })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "读取向量记忆配置失败");
        if (!active) return;
        const settings = data as PublicSettings;
        setConfigured(settings.configured);
        setSaved(settings.configured);
        setBaseUrl(settings.baseUrl || "");
        setModel(settings.model || "BAAI/bge-m3");
      })
      .catch(error => {
        if (active) setMessage(error instanceof Error ? error.message : "读取向量记忆配置失败");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; setSubpageTitle(null); };
  }, [setSubpageTitle]);

  const changeEnabled = (next: boolean) => {
    setEnabled(next);
    saveMemoryConfig({ ...loadMemoryConfig(), vectorMemoryEnabled: next });
    setMessage(next ? "已在本设备开启向量记忆；需先完成 Embedding 配置才能正常同步。" : "已在本设备关闭向量记忆。");
  };

  const save = async () => {
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch("/api/vector-memory-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl, model, apiKey }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存配置失败");
      setConfigured(true);
      setSaved(true);
      setApiKey("");
      setMessage("配置已加密保存到服务端。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存配置失败");
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setMessage("");
    try {
      const response = await fetch("/api/vector-memory-settings/test", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Embedding 连接测试失败");
      setMessage(data.message || `Embedding 连接成功，向量维度：${data.dimensions ?? 1024}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Embedding 连接测试失败");
    } finally {
      setTesting(false);
    }
  };

  if (loading) return <div className="p-4 text-sm text-[var(--c-text-secondary)]">正在读取向量记忆配置…</div>;

  return (
    <div className="flex flex-col gap-4 px-1 pb-8">
      <div className="rounded-2xl border border-[var(--c-border)] bg-[var(--c-card)] p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-[var(--c-text-title)]">云端向量记忆</div>
            <p className="mt-1 text-xs leading-5 text-[var(--c-text-secondary)]">
              将长期记忆向量化后存入独立的向量记忆 Supabase 项目，用于跨会话语义检索。
            </p>
          </div>
          <Toggle checked={enabled} onChange={changeEnabled} />
        </div>
        <div className="mt-3 text-xs">
          <span className={configured ? "text-emerald-600" : "text-amber-600"}>
            {configured ? "Embedding 已配置" : "Embedding 尚未配置"}
          </span>
          <span className="ml-2 text-[var(--c-text-secondary)]">· 维度固定为 1024</span>
        </div>
      </div>

      <label className="flex flex-col gap-2 text-sm">
        <span className="font-medium">Embedding API Base URL</span>
        <input
          type="url"
          value={baseUrl}
          onChange={event => { setBaseUrl(event.target.value); setSaved(false); }}
          placeholder="https://api.example.com/v1"
          className="ui-input w-full"
          autoCapitalize="none"
          autoComplete="url"
        />
      </label>

      <label className="flex flex-col gap-2 text-sm">
        <span className="font-medium">向量模型名称</span>
        <input
          type="text"
          value={model}
          onChange={event => { setModel(event.target.value); setSaved(false); }}
          placeholder="BAAI/bge-m3"
          className="ui-input w-full"
          autoCapitalize="none"
          autoComplete="off"
        />
      </label>

      <label className="flex flex-col gap-2 text-sm">
        <span className="font-medium">Embedding API Key</span>
        <input
          type="password"
          value={apiKey}
          onChange={event => { setApiKey(event.target.value); setSaved(false); }}
          placeholder={configured ? "已保存；留空表示保留原 Key" : "填写 Embedding 服务 API Key"}
          className="ui-input w-full"
          autoComplete="new-password"
        />
      </label>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !baseUrl.trim() || !model.trim() || (!configured && !apiKey.trim())}
          className="ui-btn ui-btn-primary flex-1 disabled:opacity-50"
        >
          {saving ? "保存中…" : "保存配置"}
        </button>
        <button
          type="button"
          onClick={() => void test()}
          disabled={testing || !configured || !saved}
          className="ui-btn flex-1 disabled:opacity-50"
        >
          {testing ? "测试中…" : "测试连接"}
        </button>
      </div>

      {message ? <p role="status" aria-live="polite" className="text-xs leading-5 text-[var(--c-text-secondary)]">{message}</p> : null}

      <p className="text-[11px] leading-5 text-[var(--c-text-secondary)]">
        API Key 只发送到服务端，并使用 AES-256-GCM 加密保存；浏览器不会读取或回显已保存的密钥。此处开关仅控制本设备的向量记忆功能。
      </p>
    </div>
  );
}
