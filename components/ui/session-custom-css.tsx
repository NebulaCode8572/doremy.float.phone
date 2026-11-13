"use client";

import { useEffect, useMemo } from "react";
import { extractCssImports, scopeSessionCSS } from "@/lib/css-scoper";

/**
 * 会话自定义 CSS 注入器。
 *
 * 把用户 CSS 里的 @import（多为 Google Fonts）抽成独立的 <link rel="stylesheet">，
 * 其余规则加作用域后走内联 <style>。@import 若留在 <style> 里，iOS WebKit 在其
 * 加载/重试期间会挂起整张样式表，网络不通时页面会在有 CSS/无 CSS 之间反复闪烁
 * （剧情模式拉到顶/底时最明显）。
 *
 * <link> 带 precedence 属性由 React 19 提升进 <head> 并按 href 去重，跨重渲染
 * 保持稳定；字体加载失败只缺字体，不影响其余自定义样式。
 */
export function SessionCustomCSS({ css, scope, allowImports = true, injectToHead = false, boostSpecificity = false }: { css: string; scope: string; allowImports?: boolean; injectToHead?: boolean; boostSpecificity?: boolean }) {
    const { imports, body } = useMemo(() => {
        const extracted = extractCssImports(css || "");
        // 通话字幕样式必须严格留在通话页面内；@import 会把外部样式表挂到 document，无法做作用域隔离。
        return { imports: allowImports ? extracted.imports : [], body: extracted.css };
    }, [css, allowImports]);
    const scoped = useMemo(() => scopeSessionCSS(body, scope, boostSpecificity), [body, scope, boostSpecificity]);

    // 通话页 CSS 放到 head 末尾，确保它排在全局样式表之后；作用域仍限制在通话字幕容器内。
    useEffect(() => {
        if (!injectToHead || !scoped) return;
        const style = document.createElement("style");
        style.setAttribute("data-session-custom-css", scope);
        style.textContent = scoped;
        document.head.appendChild(style);
        return () => { style.remove(); };
    }, [injectToHead, scoped, scope]);

    return (
        <>
            {imports.map((href) => (
                <link key={href} rel="stylesheet" href={href} precedence="default" />
            ))}
            {!injectToHead && scoped ? <style dangerouslySetInnerHTML={{ __html: scoped }} /> : null}
        </>
    );
}
