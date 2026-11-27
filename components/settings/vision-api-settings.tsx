"use client";

import { useContext, useEffect, useState } from "react";
import { SettingsContext } from "@/components/phone-settings-app";

type PublicSettings = { configured: boolean; provider: string; baseUrl: string; model: string };

export function VisionApiSettings() {
  const { setSubpageTitle } = useContext(SettingsContext);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setSubpageTitle("视觉模型 API");
    let active = true;
    void fetch("/api/vision-settings", { cache: "no-store" })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "读取配置失败");
        if (!active) return;
        const settings = data as PublicSettings;
        setConfigured(settings.configured);
        setBaseUrl(settings.baseUrl || "");
        setModel(settings.model || "");
      })
      .catch(error => { if (active) setMessage(error instanceof Error ? error.message : "读取配置失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; setSubpageTitle(null); };
  }, [setSubpageTitle]);

  const save = async () => {
    setSaving(true); setMessage("");
    try {
      const response = await fetch("/api/vision-settings", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "openai-compatible", baseUrl, model, apiKey }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存失败");
      setConfigured(true); setApiKey("");
      setMessage("配置已加密保存到服务端。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "保存失败"); }
    finally { setSaving(false); }
  };

  const test = async () => {
    setTesting(true); setMessage("");
    try {
      const response = await fetch("/api/vision-settings/test", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "连接测试失败");
      setMessage(data.message || "连接成功");
    } catch (error) { setMessage(error instanceof Error ? error.message : "连接测试失败"); }
    finally { setTesting(false); }
  };

  if (loading) return <div className="p-4 text-sm text-[var(--c-text-secondary)]">正在读取配置…</div>;
  return (
    <div className="flex flex-col gap-4 px-1 pb-8">
      <div className="rounded-2xl border border-[var(--c-border)] bg-[var(--c-card)] p-4">
        <div className="text-sm font-semibold text-[var(--c-text-title)]">全局图片理解模型</div>
        <p className="mt-2 text-xs leading-6 text-[var(--c-text-secondary)]">
          供严格模式及其他需要理解图片的功能共用。它与聊天文本模型、图像生成 API 相互独立。严格模式会先由视觉模型提取文字数据，再把文字交给当前 Char 的文本模型；不会把凭证图片直接发送给 DeepSeek。
        </p>
        <div className="mt-3 text-xs">
          <span className={configured ? "text-emerald-600" : "text-amber-600"}>{configured ? "已配置" : "尚未配置"}</span>
        </div>
      </div>
      <label className="flex flex-col gap-2 text-sm">
        <span className="font-medium">服务商协议</span>
        <input value="OpenAI 兼容接口" readOnly className="ui-input w-full opacity-75" />
      </label>
      <label className="flex flex-col gap-2 text-sm">
        <span className="font-medium">API Base URL</span>
        <input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" className="ui-input w-full" autoCapitalize="none" />
      </label>
      <label className="flex flex-col gap-2 text-sm">
        <span className="font-medium">模型名称</span>
        <input value={model} onChange={event => setModel(event.target.value)} placeholder="例如 gpt-4o" className="ui-input w-full" autoCapitalize="none" />
      </label>
      <label className="flex flex-col gap-2 text-sm">
        <span className="font-medium">API Key</span>
        <input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={configured ? "已保存；留空表示保持原 Key" : "填写视觉模型 API Key"} className="ui-input w-full" autoComplete="new-password" />
      </label>
      <div className="flex gap-2">
        <button type="button" onClick={() => void save()} disabled={saving || !baseUrl.trim() || !model.trim() || (!configured && !apiKey.trim())} className="ui-btn ui-btn-primary flex-1 disabled:opacity-50">{saving ? "保存中…" : "保存配置"}</button>
        <button type="button" onClick={() => void test()} disabled={testing || !configured} className="ui-btn flex-1 disabled:opacity-50">{testing ? "测试中…" : "测试连接"}</button>
      </div>
      {message ? <p role="status" className="text-xs leading-5 text-[var(--c-text-secondary)]">{message}</p> : null}
      <p className="text-[11px] leading-5 text-[var(--c-text-secondary)]">
        API Key 使用服务端 AES-256-GCM 加密后保存，不会返回到浏览器。部署环境需要配置 VISION_CREDENTIAL_ENCRYPTION_KEY（32 字节）及 Supabase 服务端环境变量，并先执行项目中的 docs/strict-learning-vision.sql。
      </p>
    </div>
  );
}
