"use client";

import { useState } from "react";
import { VECTOR_MEMORY_SETTINGS_UPDATED_EVENT } from "@/lib/vector-memory-generation";
import { X, Save, PlugZap, Loader2 } from "lucide-react";

type Settings = { configured: boolean; baseUrl: string; model: string; dimensions: number };
export function VectorMemorySettings() {
  const [open, setOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState("https://api.siliconflow.cn/v1");
  const [model, setModel] = useState("BAAI/bge-m3");
  const [apiKey, setApiKey] = useState("");
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState("");

  async function openSettings() {
    setOpen(true); setNotice(""); setLoading(true);
    try {
      const response = await fetch("/api/vector-memory-settings", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "配置加载失败");
      setBaseUrl(data.baseUrl || "https://api.siliconflow.cn/v1");
      setModel(data.model || "BAAI/bge-m3");
      setConfigured(Boolean(data.configured));
    } catch (e) { setNotice(e instanceof Error ? e.message : "读取配置失败"); }
    finally { setLoading(false); }
  }
  async function save() {
    setSaving(true); setNotice("");
    try {
      const response = await fetch("/api/vector-memory-settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseUrl, model, apiKey }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存失败");
      setConfigured(true); setApiKey(""); setNotice("配置已保存");
      window.dispatchEvent(new Event(VECTOR_MEMORY_SETTINGS_UPDATED_EVENT));
    } catch (e) { setNotice(e instanceof Error ? e.message : "保存失败"); }
    finally { setSaving(false); }
  }
  async function test() {
    setTesting(true); setNotice("");
    try {
      const response = await fetch("/api/vector-memory-settings/test", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "连接测试失败");
      setNotice(`Embedding 与向量数据库连接成功 · ${data.dimensions} 维`);
    } catch (e) { setNotice(e instanceof Error ? e.message : "连接测试失败"); }
    finally { setTesting(false); }
  }
  return <>
    <button type="button" className="ui-btn ui-btn-secondary ts-12" onClick={() => void openSettings()}>配置</button>
    {open ? <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={() => setOpen(false)}>
      <div className="modal-sheet" data-ui="modal-sheet" onClick={e => e.stopPropagation()}>
        <div className="modal-header" data-ui="modal-header">
          <span style={{ width: 28 }} />
          <h3 className="modal-title">Vector Memory 配置</h3>
          <button className="modal-header-btn modal-header-btn-muted" onClick={() => setOpen(false)}><X size={18}/></button>
        </div>
        <div className="modal-body modal-body-tight" data-ui="modal-body">
          {loading ? <div className="flex items-center justify-center py-8"><Loader2 size={18} className="animate-spin"/></div> : <>
            <div className="menu-group">
              <div className="px-4 py-3 flex flex-col gap-2">
                <label className="menu-label">Base URL</label>
                <input className="ui-input w-full" type="url" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://api.siliconflow.cn/v1"/>
                <label className="menu-label mt-2">Embedding Model</label>
                <input className="ui-input w-full" value={model} onChange={e => setModel(e.target.value)} placeholder="BAAI/bge-m3"/>
                <label className="menu-label mt-2">API Key {configured ? "(留空则保留已保存的 Key)" : ""}</label>
                <input className="ui-input w-full" type="password" autoComplete="off" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={configured ? "已配置 · 输入新 Key 可替换" : "输入 API Key"}/>
                <p className="menu-desc">向量维度固定为 1024。Key 加密后存储在服务器，读取时不会返回到前端。</p>
                {notice ? <p className="menu-desc">{notice}</p> : null}
                <div className="flex gap-2 mt-2">
                  <button type="button" className="ui-btn ui-btn-secondary flex-1" disabled={!configured || saving || testing} onClick={() => void test()}><PlugZap size={14} className="mr-1.5"/>{testing ? "测试中…" : "连接测试"}</button>
                  <button type="button" className="ui-btn ui-btn-primary flex-1" disabled={saving || testing || !baseUrl.trim() || !model.trim() || (!configured && !apiKey.trim())} onClick={() => void save()}><Save size={14} className="mr-1.5"/>{saving ? "保存中…" : "保存配置"}</button>
                </div>
              </div>
            </div>
          </>}
        </div>
      </div>
    </div> : null}
  </>;
}
