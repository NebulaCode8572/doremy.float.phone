"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { Activity, CheckCircle2, CircleAlert, LoaderCircle, Save, Wifi } from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";

type VectorMemorySettings = {
  configured: boolean;
  baseUrl: string;
  model: string;
  dimensions: 1024;
  updatedAt?: string;
};

type Props = { onClose: () => void; onNotice?: (message: string) => void };

const fieldStyle: CSSProperties = {
  width: "100%",
  minHeight: 46,
  boxSizing: "border-box",
  border: "1px solid var(--c-border, rgba(120,120,120,.24))",
  borderRadius: 12,
  background: "var(--c-card, rgba(128,128,128,.08))",
  color: "var(--c-text, inherit)",
  padding: "11px 13px",
  fontSize: 14,
  outline: "none",
};

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 7,
  color: "var(--c-text, inherit)",
};

export function VectorMemoryApp({ onClose, onNotice }: Props) {
  const [settings, setSettings] = useState<VectorMemorySettings>({
    configured: false,
    baseUrl: "",
    model: "BAAI/bge-m3",
    dimensions: 1024,
  });
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [testResult, setTestResult] = useState<"success" | "error" | null>(null);
  const [testMessage, setTestMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/vector-memory-settings", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.error || `读取配置失败（HTTP ${response.status}）`);
        if (!cancelled) setSettings(payload as VectorMemorySettings);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "读取向量记忆配置失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const saveSettings = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/vector-memory-settings", {
        method: "PUT",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: settings.baseUrl, model: settings.model, apiKey }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || `保存失败（HTTP ${response.status}）`);
      setSettings(payload as VectorMemorySettings);
      setApiKey("");
      setTestResult(null);
      setTestMessage("");
      onNotice?.("向量记忆配置已保存");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存向量记忆配置失败");
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    if (testing) return;
    setTesting(true);
    setError("");
    setTestResult(null);
    setTestMessage("正在请求 Embedding API，并验证 Vector Memory 数据库 RPC……");
    try {
      const response = await fetch("/api/vector-memory-settings/test", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || `连接测试失败（HTTP ${response.status}）`);
      setTestResult("success");
      setTestMessage(`Embedding API 已返回 ${payload.dimensions} 维向量；Vector Memory 数据库 RPC 连接成功。`);
    } catch (e) {
      setTestResult("error");
      setTestMessage(e instanceof Error ? e.message : "向量记忆连接测试失败");
    } finally {
      setTesting(false);
    }
  };

  return (
    <PageShell title="向量记忆" onBack={onClose}>
      <div style={{ padding: "16px 16px 32px", display: "flex", flexDirection: "column", gap: 18, maxWidth: 680, margin: "0 auto" }}>
        <section style={{ borderRadius: 16, padding: 16, background: "var(--c-card, rgba(128,128,128,.08))", border: "1px solid var(--c-border, rgba(120,120,120,.18))" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <Activity size={19} />
            <strong style={{ fontSize: 15 }}>Embedding 服务配置</strong>
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.65, opacity: .72 }}>
            向量记忆使用独立的 Embedding API，与聊天文本模型配置分开。模型必须返回 1024 维向量。
          </div>
          {loading ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "22px 0", fontSize: 13, opacity: .7 }}>
              <LoaderCircle size={16} className="animate-spin" /> 正在读取已保存配置…
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 18 }}>
              <label>
                <span style={labelStyle}>Base URL</span>
                <input
                  style={fieldStyle}
                  type="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="https://api.example.com/v1"
                  value={settings.baseUrl}
                  onChange={e => setSettings(prev => ({ ...prev, baseUrl: e.target.value }))}
                />
              </label>
              <label>
                <span style={labelStyle}>Embedding 模型</span>
                <input
                  style={fieldStyle}
                  type="text"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="BAAI/bge-m3"
                  value={settings.model}
                  onChange={e => setSettings(prev => ({ ...prev, model: e.target.value }))}
                />
              </label>
              <label>
                <span style={labelStyle}>API Key</span>
                <input
                  style={fieldStyle}
                  type="password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="new-password"
                  placeholder={settings.configured ? "已保存密钥；留空则继续使用当前密钥" : "填写 Embedding API Key"}
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                />
                <span style={{ display: "block", marginTop: 6, fontSize: 11, lineHeight: 1.5, opacity: .65 }}>
                  密钥只在服务端加密保存，不会回传到 App；修改 Base URL 或模型时无需重新填写已保存的密钥。
                </span>
              </label>
              <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, opacity: .78 }}>
                {settings.configured ? <CheckCircle2 size={15} /> : <CircleAlert size={15} />}
                {settings.configured ? "已存在已保存的配置" : "尚未配置 Embedding API"}
                <span style={{ marginLeft: "auto" }}>目标维度：1024</span>
              </div>
              <button
                type="button"
                onClick={() => void saveSettings()}
                disabled={saving || loading}
                style={{ minHeight: 46, border: 0, borderRadius: 12, background: "var(--c-primary, #526fbd)", color: "#fff", fontSize: 14, fontWeight: 650, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, opacity: saving || loading ? .6 : 1 }}
              >
                {saving ? <LoaderCircle size={17} className="animate-spin" /> : <Save size={17} />}
                {saving ? "正在保存…" : "保存配置"}
              </button>
            </div>
          )}
        </section>

        <section style={{ borderRadius: 16, padding: 16, background: "var(--c-card, rgba(128,128,128,.08))", border: "1px solid var(--c-border, rgba(120,120,120,.18))" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <Wifi size={19} />
            <strong style={{ fontSize: 15 }}>连接测试</strong>
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.65, opacity: .72, marginBottom: 14 }}>
            测试服务端当前已保存的配置：发起真实 Embedding 请求，并使用返回的向量调用测试数据库只读匹配 RPC；不会插入或删除聊天向量。修改配置后请先保存，再测试。
          </div>
          <button
            type="button"
            onClick={() => void testConnection()}
            disabled={testing || loading || !settings.configured}
            style={{ width: "100%", minHeight: 46, border: "1px solid var(--c-border, rgba(120,120,120,.24))", borderRadius: 12, background: "transparent", color: "var(--c-text, inherit)", fontSize: 14, fontWeight: 650, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, opacity: testing || loading || !settings.configured ? .55 : 1 }}
          >
            {testing ? <LoaderCircle size={17} className="animate-spin" /> : <Wifi size={17} />}
            {testing ? "正在测试连接…" : "测试 Embedding 与数据库"}
          </button>
          {testMessage ? (
            <div role="status" style={{ marginTop: 12, padding: 12, borderRadius: 10, background: testResult === "success" ? "rgba(38,150,95,.10)" : testResult === "error" ? "rgba(210,70,70,.10)" : "rgba(128,128,128,.08)", fontSize: 12, lineHeight: 1.65, overflowWrap: "anywhere" }}>
              {testMessage}
            </div>
          ) : null}
        </section>
        {error ? <div role="alert" style={{ padding: 12, borderRadius: 10, background: "rgba(210,70,70,.10)", color: "var(--c-danger, #c44)", fontSize: 12, lineHeight: 1.6, overflowWrap: "anywhere" }}>{error}</div> : null}
      </div>
    </PageShell>
  );
}
