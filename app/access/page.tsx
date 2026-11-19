"use client";

import { useEffect, useState, type FormEvent } from "react";

import "./access.css";

function getSafeNextPath(): string {
  const requested = new URLSearchParams(window.location.search).get("next") || "/";
  if (!requested.startsWith("/") || requested.startsWith("//") || requested.startsWith("/\\")) {
    return "/";
  }
  return requested;
}

export default function AccessPage() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/access/verify", { cache: "no-store" })
      .then(async response => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "无法读取站点访问配置。");
        if (active) setConfigured(data.configured === true);
      })
      .catch(err => {
        if (active) setError(err instanceof Error ? err.message : "无法读取站点访问配置。");
      });
    return () => { active = false; };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || configured !== true) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/access/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || "访问口令不正确。");
      setPassword("");
      window.location.replace(getSafeNextPath());
    } catch (err) {
      setError(err instanceof Error ? err.message : "验证失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="site-access-root">
      <section className="site-access-card" aria-labelledby="site-access-title">
        <div className="site-access-mark">float</div>
        <div className="site-access-kicker">PRIVATE SPACE</div>
        <h1 id="site-access-title">输入访问口令</h1>
        <p className="site-access-description">
          此站点为单用户自部署空间。验证通过后即可进入，不需要注册或账号登录。
        </p>

        {configured === false ? (
          <div className="site-access-notice">
            站点访问口令尚未配置。请在托管平台添加服务端环境变量
            <code>SELF_HOSTED_ACCESS_PASSWORD</code> 和
            <code>SELF_HOSTED_ACCESS_SECRET</code>，然后重新部署。
          </div>
        ) : (
          <form className="site-access-form" onSubmit={submit}>
            <label htmlFor="site-access-password">访问口令</label>
            <input
              id="site-access-password"
              type="password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              placeholder="输入共享访问口令"
              autoComplete="current-password"
              maxLength={256}
              disabled={configured !== true || busy}
              autoFocus
            />
            <button type="submit" disabled={configured !== true || busy || !password}>
              {configured === null ? "正在检查配置…" : busy ? "验证中…" : "进入主页"}
            </button>
          </form>
        )}

        {error ? <div className="site-access-error" role="alert">{error}</div> : null}
        <div className="site-access-footnote">访问验证 · 不创建账号 · 数据身份保持 local_user</div>
      </section>
    </main>
  );
}
