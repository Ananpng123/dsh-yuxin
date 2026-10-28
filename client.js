// 鱼信 · 界面层 v10（鱼信页签 + 好友列表 + 添加好友两入口弹层）
// 依据：im-prototypes/方案丁-落地总方案-v2.md 三·3.5 路线 P / 六 段 2-4 / 十六 添加好友
// 原则：不注册 main / rightbar / sidebar.panellist / conversation.chat.node；不写死任何好友行。
window.__ModuleLoader__.load({
  id: 'dsh-yuxin',
  factory: (require) => {
    const react = require('react');
    // 弹层必须挂到 document.body：会话栏这一列里某个祖先带 transform/filter，
    // 会成为 position:fixed 的包含块，留在原地就永远被框在 280px 那一列里（见 dsh-free-search 同款注释）。
    const reactDom = require('react-dom');
    const h = react.createElement;
    const { useState, useEffect, useRef } = react;

    // 两条 RPC 都落在本插件自己的 /api/dsh-im：
    // 0.4.16 之前「铸符/合符/好友地址」那半挂在第三方 /api/dsh-weave 上，现在自带。
    const API_IM = '/api/dsh-im';
    // 兼容舱：后端若是旧版（没重启，handlers 里还没有 endpoints），回退到第三方路由，
    // 免得界面直接红字。新版后端一旦起来，这条路就用不上了。
    const API_WEAVE_COMPAT = '/api/dsh-weave';
    const TAB_ID = 'yuxin';
    const TAB_LABEL = '鱼信';
    const POLL_MS = 15000;

    // ---------- 段 1 · 工具 ----------
    function probeService(ctx, name) {
      try { const s = ctx.reflect?.get?.(name); if (s) return s; } catch { /* 某些构建没有 reflect */ }
      return ctx[name];
    }

    // 传输层端点由 index.js 的 createHandler 提供，形状与旧路由逐字一致：
    // ticket / trust / untrust / peers / endpoints / status。
    // 铸符只读（ticket）；合符是本插件唯一的写动作（trust → 落 transport/peers.json）。
    async function weave(endpoint, args, signal) {
      const init = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ endpoint, args: args ?? {} }),
      };
      if (signal) init.signal = signal;
      let res = await fetch(API_IM, init);
      let envelope = await res.json().catch(() => null);
      // 旧后端会说「unknown dsh-im endpoint」；那一句就是该换路的信号，只回退一次。
      if (!envelope || envelope.ok !== true) {
        const msg = String(envelope?.error?.message || '');
        if (/unknown dsh-im endpoint/i.test(msg)) {
          res = await fetch(API_WEAVE_COMPAT, init);
          envelope = await res.json().catch(() => null);
        }
      }
      if (!envelope || envelope.ok !== true) {
        throw new Error(envelope?.error?.message || `${endpoint} 调用失败（${res.status}）`);
      }
      return envelope.value;
    }

    // 本插件自己的 host 半挂的第三条路由（index.js 里 connection.fetch.register 的 /api/dsh-im）。
    // 目前只有一个端点 botSession：给智能体建一条真实 DSH 会话，返回 { sessionId }。
    async function imApi(endpoint, args, signal) {
      const init = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ endpoint, args: args ?? {} }),
      };
      if (signal) init.signal = signal;
      const res = await fetch(API_IM, init);
      const envelope = await res.json().catch(() => null);
      if (!envelope || envelope.ok !== true) {
        throw new Error(envelope?.error?.message || `${endpoint} 调用失败（${res.status}）`);
      }
      return envelope.value;
    }

    const COLORS = ['#4a86ff', '#e0704a', '#3fa87a', '#a06ae0', '#c9a227', '#4aa8c0'];    function identityColor(name) {
      const s = String(name || '');
      let hash = 0;
      for (let i = 0; i < s.length; i += 1) hash = (hash * 31 + s.charCodeAt(i)) % 100000;
      return COLORS[hash % COLORS.length];
    }
    function initial(name) {
      const s = String(name || '?').trim();
      return s ? Array.from(s)[0] : '?';
    }

    const CSS = `
.yx-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary,#e6e9ef);font:inherit}
.yx-list{flex:1 1 auto;min-height:0;overflow:auto;padding:0 6px 12px}
.yx-row{display:flex;align-items:center;gap:8px;height:42px;padding:0 8px;border-radius:8px;cursor:pointer}
.yx-row:hover{background:var(--dsw-alias-surface-hover,rgba(255,255,255,.06))}
.yx-av{flex:0 0 auto;width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;color:#f2f6ff}
.yx-nm{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.yx-sub{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b93a3)}
.yx-dot{flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#8b93a3)}
.yx-dot.on{background:var(--dsw-alias-state-success-primary,#35c07f);box-shadow:0 0 0 2px rgba(53,192,127,.16)}
.yx-dot.off{background:transparent;border:1px solid var(--dsw-alias-border-l3,#6b7280)}
.yx-dot.unk{background:var(--dsw-alias-state-warn-primary,#c08a2e)}
.yx-item{display:flex;flex-direction:column}
.yx-av-img{object-fit:cover;padding:0;border:0}
.yx-more{flex:0 0 auto;width:22px;height:22px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#8b93a3);cursor:pointer;opacity:0;font-size:14px;line-height:1}
.yx-row:hover .yx-more{opacity:1}
.yx-more:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1));color:var(--dsw-alias-label-primary,#e6e9ef)}
.yx-edit{margin:2px 8px 8px;padding:8px;border:1px solid var(--dsw-alias-border-l2,#3a4252);border-radius:8px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.03))}
.yx-edit-row{display:flex;align-items:center;gap:8px}
.yx-input{flex:1 1 auto;min-width:0;height:26px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#3a4252);background:transparent;color:inherit;font-size:12px}
.yx-edit-acts{display:flex;gap:6px;flex-wrap:wrap}
.yx-edit-err{font-size:11px;color:var(--dsw-alias-state-error-primary,#f08080)}
.yx-edit-danger{margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-secondary,rgba(255,255,255,.08))}
.yx-edit-confirm{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:11px;color:var(--dsw-alias-text-secondary,#8a9099);line-height:1.5}
.yx-edit-confirm>span{flex:1 1 100%}
.yx-ann{display:flex;gap:6px;align-items:flex-start;margin:8px 0 2px}
.yx-ann-ta{flex:1 1 auto;min-height:46px;resize:vertical;font:inherit;line-height:1.55;padding:8px 10px}
.yx-gi-list{display:flex;flex-direction:column;gap:6px;margin:10px 0 4px;max-height:220px;overflow:auto}
.yx-gi-mem{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-primary,#e6e9ef)}
.yx-gi-nm{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.yx-gi-kick{display:flex;gap:4px;flex:0 0 auto}
.yx-shell{display:flex;flex-direction:column;height:100%;min-height:0}
.yx-strip{flex:0 0 auto;display:flex;gap:4px;margin:8px 8px 6px;padding:3px;border-radius:10px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.06)}
.yx-strip-btn{flex:1 1 0;height:26px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#b9c0cd);font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px}
.yx-strip-btn.on{background:var(--dsw-alias-interactive-bg-active,rgba(255,255,255,.12));color:var(--dsw-alias-label-primary,#fff)}
.yx-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.yx-state{padding:18px 14px;font-size:12px;line-height:1.8;color:var(--dsw-alias-label-tertiary,#8b93a3)}
/* 智能体 */
.yx-sec-add{flex:0 0 auto;margin-left:auto;width:20px;height:20px;padding:0;display:flex;align-items:center;justify-content:center;border-radius:6px;border:1px dashed var(--dsw-alias-border-l2,#333a48);background:none;color:var(--dsw-alias-label-tertiary,#8b93a3);font-size:12px;line-height:1;cursor:pointer;transition:border-color .12s,color .12s,background .12s}
.yx-sec-add:hover{border-color:var(--dsw-alias-brand-primary,#7aa2ff);color:var(--dsw-alias-label-primary,#e6e9ef);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))}
.yx-tag{flex:0 0 auto;font-size:10px;padding:1px 5px;border-radius:4px;background:rgba(122,162,255,.16);color:#9dbaff}
.yx-tag-dim{background:rgba(139,147,163,.16);color:var(--dsw-alias-label-tertiary,#8b93a3)}
.yx-un{flex:0 0 auto;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--dsw-alias-state-error-primary,#e5484d);color:#fff;font-size:11px;font-weight:600;line-height:18px;text-align:center}
.yx-avas{display:flex;gap:8px;flex-wrap:wrap}
.yx-ava-btn{width:34px;height:34px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2,#3a4252);background:transparent;font-size:15px;cursor:pointer;color:inherit}
.yx-ava-btn.on{border-color:var(--dsw-alias-brand-primary,#7aa2ff);box-shadow:0 0 0 2px rgba(122,162,255,.2)}
.yx-chips{display:flex;flex-wrap:wrap;gap:6px}
.yx-sel{width:100%;height:32px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#3a4252);background:var(--dsw-alias-bg-base,#11141a);color:var(--dsw-alias-label-primary,#e6e9ef);font:inherit;font-size:12.5px;cursor:pointer}
.yx-sel:focus{outline:0;border-color:var(--dsw-alias-brand-primary,#7aa2ff);box-shadow:0 0 0 3px rgba(122,162,255,.14)}
.yx-chip{border:1px solid var(--dsw-alias-border-l2,#3a4252);border-radius:999px;padding:4px 10px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#b9c0cd);background:transparent;cursor:pointer}
.yx-chip.on{border-color:rgba(122,162,255,.6);background:rgba(122,162,255,.14);color:#bfd3ff}
.yx-k-i{font-style:normal;font-weight:400;letter-spacing:0;color:var(--dsw-alias-label-dimmed,#6b7382)}
.yx-muted{font-size:11px;line-height:1.65;color:var(--dsw-alias-label-tertiary,#8b93a3)}
.yx-bad{color:var(--dsw-alias-state-error-primary,#f08080)}
/* ===== 段 6 · 鱼信自己的会话界面（方案 B 全接管） ===== */
/* 根节点必须带 data-dsh-chat-room-timeline：dsh-chat 注入的 CSS 里有
 
   一条 :has(...) > *:not(:has([data-dsh-chat-room-timeline])) 的 display:none!important 规则，
   我们没这个属性就会在官方聊天视图里被整块隐藏。 */
.yx-chat{display:flex;flex-direction:column;height:100%;min-height:0;width:min(780px,calc(100% - 32px));margin:0 auto;padding:18px 0 8px}
.yx-chat-hd{flex:0 0 auto;display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:0 2px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,transparent)}
.yx-chat-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e9ef);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.yx-chat-sub{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b93a3)}
.yx-chat-err{margin:10px 0 0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));color:var(--dsw-alias-state-error-primary,#f08080);font-size:12px}
.yx-chat-note{margin:8px 0 0;padding:4px 10px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04));color:var(--dsw-alias-text-secondary,#8a9099);font-size:11px;text-align:center}
.yx-chat-body{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:16px;padding:18px 2px 20px}
.yx-msg{display:flex;flex-direction:column;align-items:flex-start;max-width:78%}
.yx-msg.mine{align-self:flex-end;align-items:flex-end}
.yx-msg-meta{display:flex;align-items:baseline;gap:7px;margin-bottom:5px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b93a3)}
.yx-msg.mine .yx-msg-meta{flex-direction:row-reverse}
.yx-msg-who{font-weight:500}
.yx-bubble{padding:9px 13px;border-radius:14px;border-top-left-radius:5px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));color:var(--dsw-alias-label-primary,#e6e9ef);font-size:14px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}
.yx-msg.mine .yx-bubble{border-top-left-radius:14px;border-top-right-radius:5px;background:var(--dsw-alias-button-primary-fill,#3d76ee);color:#fff}
/* 一块地方只留一套输入框：这条会话里我们已经画了（.yx-comp 在场），
   dsh-chat 的 RoomComposer 就整块让位 —— 它的 select 在 chain 槽里跟我们同时命中，
   不靠 CSS 拦就只能两套叠着（用户看到「发送消息至…」窄卡 + 我们那块）。 */
[data-slot="conversation.composer"]:has(.yx-comp) .dshChatRoom{display:none!important}
[data-slot="conversation.composer"]:has(.yx-comp) .dshChatComposer{display:none!important}
.yx-comp ~ .dshChatRoom{display:none!important}
.dshChatRoom:has(~ .yx-comp){display:none!important}
.yx-comp{flex:0 0 auto;width:min(780px,calc(100% - 32px));margin:0 auto;padding:10px 0 18px;display:flex;flex-direction:column;gap:7px}
/* 外框照官方那套：19px 圆角、layer-1 底、一级描边 */
.yx-comp-card{display:flex;flex-direction:column;gap:2px;padding:12px 12px 9px;border:1px solid var(--dsw-alias-border-l2,#3a4252);border-radius:19px;background:var(--dsw-alias-bg-layer-1,#161a22);box-shadow:var(--dsw-shadow-lv1,0 2px 10px rgba(0,0,0,.28));transition:border-color .15s ease}
.yx-comp-card:focus-within{border-color:var(--dsw-alias-state-business-primary,#4a86ff)}
.yx-comp-err{padding:7px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));color:var(--dsw-alias-state-error-primary,#f08080);font-size:12px}
.yx-comp-ta{width:100%;box-sizing:border-box;min-height:44px;max-height:160px;padding:2px 4px 8px;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary,#e6e9ef);font:inherit;font-size:14px;line-height:1.45;resize:vertical}
.yx-comp-ta::placeholder{color:var(--dsw-alias-label-tertiary,#8b93a3)}
.yx-comp-ta:disabled{opacity:.6;cursor:default}
.yx-comp-ft{display:flex;align-items:center;justify-content:space-between;gap:12px}
.yx-comp-hint{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#8b93a3)}
.yx-comp-at{width:25px;height:25px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));font-weight:500}
.yx-comp-send{width:36px;height:36px;flex:0 0 auto;border:0;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.1));color:var(--dsw-alias-label-tertiary,#8b93a3);font:inherit;font-size:19px;line-height:1;cursor:default;transition:background .15s ease,color .15s ease,transform .15s ease}
.yx-comp-send.on{background:var(--dsw-alias-button-primary-fill,#3d76ee);color:#fff;cursor:pointer}
.yx-comp-send.on:hover{filter:brightness(1.08)}
/* ---------- 段 7 · 浮层聊天窗：点好友直接开小窗，不占主区 ---------- */
.yx-float{position:fixed;z-index:3000;display:flex;flex-direction:column;min-width:300px;min-height:340px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,#3a4252);border-radius:14px;background:var(--dsw-alias-bg-layer-1,#161a22);box-shadow:0 18px 48px rgba(0,0,0,.45),0 2px 8px rgba(0,0,0,.3);overflow:hidden;font-size:13px}
.yx-float.min{min-height:0}
.yx-float-hd{flex:0 0 auto;display:flex;align-items:center;gap:9px;padding:9px 8px 9px 11px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.07));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04));cursor:grab;user-select:none;touch-action:none}
.yx-float-hd:active{cursor:grabbing}
.yx-ann-bar{flex:0 0 auto;display:flex;gap:7px;align-items:baseline;padding:7px 12px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#8b93a3);background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04));border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.07));cursor:pointer}
.yx-ann-bar:hover{background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.09))}
.yx-ann-k{flex:0 0 auto;font-weight:600;color:var(--dsw-alias-state-warning-primary,#e5b567)}
.yx-ann-tx{min-width:0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;white-space:pre-wrap;word-break:break-word}
.yx-float-nm{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;color:var(--dsw-alias-label-primary,#e6e9ef)}
.yx-float-sub{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b93a3)}
.yx-float-link{border:0;background:transparent;font:inherit;font-size:11px;padding:0 4px;cursor:pointer;border-radius:4px}
.yx-float-link:hover{color:var(--dsw-alias-label-primary,#e6e9ef);background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.1))}
.yx-float-btn{flex:0 0 auto;width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#8b93a3);font:inherit;font-size:14px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0}
.yx-float-btn:hover{background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.1));color:var(--dsw-alias-label-primary,#e6e9ef)}
.yx-float .yx-chat{width:100%;margin:0;padding:0;height:auto;flex:1 1 auto;min-height:0}
.yx-float .yx-chat-body{padding:12px 12px 6px;gap:12px}
.yx-float .yx-bubble{font-size:13px;padding:8px 11px;line-height:1.55}
.yx-float .yx-msg{max-width:84%}
.yx-float .yx-comp{width:100%;margin:0;padding:6px 12px 12px;gap:0}
.yx-float .yx-comp-card{border-radius:14px;padding:9px 10px 7px}
.yx-float .yx-comp-ta{min-height:34px;max-height:120px;font-size:13px}
.yx-float .yx-comp-hint,.yx-float .yx-comp-at{display:none}
.yx-float .yx-comp-ft{justify-content:flex-end}
.yx-float .yx-comp-send{width:30px;height:30px;font-size:16px}
.yx-float-rz{position:absolute;right:0;bottom:0;width:18px;height:18px;cursor:nwse-resize;touch-action:none;background:linear-gradient(135deg,transparent 52%,var(--dsw-alias-border-l2,#3a4252) 52%);border-bottom-right-radius:14px}
.yx-float-o{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden}
/* ===== 列表页（好友） ===== */
.yx-me{flex:0 0 auto;display:flex;align-items:center;gap:7px;margin:10px 10px 6px;padding:6px 8px;border-radius:8px;cursor:pointer;background:rgba(255,255,255,.03)}
.yx-me:hover{background:rgba(255,255,255,.06)}
.yx-me-nm{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;color:var(--dsw-alias-label-primary,#e6e9ef)}
.yx-me-tag{flex:0 0 auto;font-size:10.5px;padding:1px 5px;border-radius:4px;color:var(--dsw-alias-label-secondary,#9aa3b2);background:rgba(255,255,255,.06)}
.yx-me .yx-av{width:21px;height:21px;font-size:10px}
.yx-acts{display:flex;gap:6px}
.yx-btn{height:26px;padding:0 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,#3a4252);background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.02));color:var(--dsw-alias-label-secondary,#b9c0cd);font-size:12px;cursor:pointer;white-space:nowrap;transition:border-color .12s,background .12s,color .12s}
.yx-btn:hover:not(:disabled){border-color:rgba(74,134,255,.6);background:rgba(74,134,255,.12);color:var(--dsw-alias-label-primary,#dbe7ff)}
.yx-btn:disabled{opacity:.45;cursor:default}
.yx-btn-primary{border-color:rgba(74,134,255,.85);background:var(--dsw-alias-button-primary-fill,#3d76ee);color:#fff;font-weight:600;box-shadow:0 1px 0 rgba(255,255,255,.18) inset}
.yx-btn-primary:hover:not(:disabled){filter:brightness(1.08);color:#fff}
.yx-btn-danger{color:var(--dsw-alias-state-error-primary,#f08080);border-color:rgba(240,128,128,.4)}
.yx-btn-danger:hover:not(:disabled){background:rgba(240,128,128,.12);color:var(--dsw-alias-state-error-primary,#f08080)}
.yx-sec{display:flex;align-items:center;gap:6px;padding:14px 12px 6px;font-size:12.5px;font-weight:600;letter-spacing:0;color:var(--dsw-alias-label-primary,#e6e9ef)}
.yx-sec-n{flex:0 0 auto;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.09));color:var(--dsw-alias-label-secondary,#aab3c2);font-size:10px;line-height:16px;text-align:center}
/* 空态：虚线引导卡，不是一句灰字 */

/* ===== 添加好友弹层（原型 im-prototypes/14-添加好友流程-方案丁-fu.html） ===== */
.yx-ov{position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;padding:28px;overflow:auto;background:rgba(6,9,16,.62);backdrop-filter:blur(6px)}
.yx-ask{width:min(560px,100%);max-height:min(88vh,780px);display:flex;flex-direction:column;overflow:hidden;border-radius:16px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1));background:var(--dsw-alias-bg-layer-2,#222837);box-shadow:0 1px 0 rgba(255,255,255,.07) inset,0 32px 80px rgba(0,0,0,.62);animation:yx-in .16s ease-out}
@keyframes yx-in{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.yx-ask{animation:none}.yx-pick{transition:none}}
.yx-ask-hd{flex:0 0 auto;display:flex;align-items:flex-start;gap:10px;padding:16px 18px 13px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.07))}
.yx-hd-tx{flex:1 1 auto;min-width:0}
.yx-ask-title{font-size:14px;font-weight:600;letter-spacing:.01em;color:var(--dsw-alias-label-primary,#eef2f9)}
.yx-ask-sub{margin-top:3px;font-size:11.5px;line-height:1.62;color:var(--dsw-alias-text-secondary,#99a3b4)}
.yx-ask-x{flex:0 0 auto;width:26px;height:26px;margin:-3px -4px 0 0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary,#8b93a3);cursor:pointer;font-size:13px;line-height:1;transition:background .12s,color .12s}
.yx-ask-x:hover{background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.09));color:#fff}
.yx-ask-bd{flex:1 1 auto;min-height:0;overflow:auto;padding:16px 18px}
.yx-ask-ft{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:12px 18px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.07));background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.14))}
.yx-ask-ft .yx-hint{flex:1 1 auto}
.yx-ft-btn{height:30px;padding:0 14px;border-radius:8px;font-size:12.5px}
/* 首屏：两个入口卡 */
.yx-picks{display:flex;flex-direction:column;gap:10px}
.yx-pick{display:flex;align-items:center;gap:12px;padding:13px 14px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1));background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.03));color:inherit;text-align:left;cursor:pointer;transition:border-color .14s,background .14s,transform .14s}
.yx-pick:hover{border-color:rgba(74,134,255,.55);background:rgba(74,134,255,.1);transform:translateX(2px)}
.yx-pick-ic{flex:0 0 auto;width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;background:rgba(74,134,255,.15);color:var(--dsw-alias-state-business-primary,#8fb4ff)}
.yx-pick-tx{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px}
.yx-pick-k{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e9eef7)}
.yx-pick-d{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#98a0b0)}
.yx-pick-ar{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,#7d8698);font-size:15px;line-height:1}
/* 票据卡 */
.yx-lb{margin-bottom:6px;font-size:10.5px;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary,#7d8698)}
.yx-tk-card{padding:12px;border-radius:12px;border:1px solid rgba(255,255,255,.12);background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.28))}
.yx-tk{max-height:74px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:1.7;word-break:break-all;color:var(--dsw-alias-label-secondary,#b6c8e4)}
.yx-tk-tail{padding:0 3px;border-radius:4px;background:rgba(74,134,255,.2);color:#fff;font-weight:600}
.yx-tk-empty{color:var(--dsw-alias-label-tertiary,#7d8698)}
.yx-copy{display:inline-flex;align-items:center;gap:5px;height:27px;padding:0 10px;border-radius:7px;border:1px solid rgba(74,134,255,.5);background:rgba(74,134,255,.16);color:var(--dsw-alias-label-primary,#cfe0ff);font-size:11.5px;cursor:pointer;transition:background .12s,border-color .12s}
.yx-copy:hover{background:rgba(74,134,255,.26)}
.yx-copy.ok{border-color:rgba(34,197,94,.6);background:rgba(34,197,94,.18);color:var(--dsw-alias-state-success-primary,#6fd39a)}
.yx-chips{display:flex;gap:6px;flex-wrap:wrap}
.yx-chip{height:26px;padding:0 11px;border-radius:13px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.03));color:var(--dsw-alias-label-secondary,#b9c0cd);font-size:11.5px;cursor:pointer;transition:border-color .12s,background .12s,color .12s}
.yx-chip:hover:not(:disabled){border-color:rgba(74,134,255,.55);background:rgba(74,134,255,.12);color:var(--dsw-alias-label-primary,#fff)}
.yx-chip:disabled{opacity:.45;cursor:default}
/* 说明块 */
/* 合符：输入 + 三件事 */
.yx-ta{width:100%;min-height:76px;resize:vertical;padding:10px 11px;border-radius:10px;border:1px solid rgba(255,255,255,.13);background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.26));color:var(--dsw-alias-label-primary,#dbe4f2);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:1.65;outline:none;transition:border-color .12s,box-shadow .12s}
.yx-ta:focus{border-color:rgba(74,134,255,.7);box-shadow:0 0 0 3px rgba(74,134,255,.14)}
.yx-ta::placeholder{color:rgba(255,255,255,.26)}
.yx-paste{display:flex;justify-content:flex-end;margin-top:6px}
.yx-err{margin-top:8px;padding:7px 10px;border-radius:7px;border-left:2px solid rgba(236,19,19,.55);background:rgba(236,19,19,.07);font-size:11.5px;line-height:1.6;color:var(--dsw-alias-state-error-primary,#eab0b0)}
/* 成功屏 */
.yx-ok-hero{display:flex;flex-direction:column;align-items:center;text-align:center;gap:7px;padding:8px 0 14px}
.yx-ok-badge{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(34,197,94,.16);border:1px solid rgba(34,197,94,.4);color:var(--dsw-alias-state-success-primary,#7ee2a0)}
.yx-ok-h{font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary,#eaf1fb)}
.yx-ok-p{font-size:11.5px;line-height:1.7;color:var(--dsw-alias-label-tertiary,#8b93a3)}
.yx-ok{display:flex;align-items:center;gap:9px;margin-top:7px;padding:9px 11px;border-radius:9px;font-size:12px;background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.24);color:var(--dsw-alias-state-success-primary,#8fe0b0)}
.yx-ok.wait{background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.05));border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.1));color:var(--dsw-alias-label-tertiary,#98a0b0)}
.yx-ok-mark{flex:0 0 auto;width:16px;text-align:center}
.yx-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b93a3)}
/* 区块节奏：标签(10px) → 内容 → 动作(11px)；说明一律走 .yx-muted，不铺底色 */
.yx-sec2{margin-top:18px}.yx-sec2:first-child{margin-top:0}
.yx-k{margin-bottom:7px;font-size:10px;font-weight:600;letter-spacing:.08em;color:var(--dsw-alias-label-tertiary,#7d8698)}
.yx-rule{height:1px;margin:16px 0;background:var(--dsw-alias-border-l1,rgba(255,255,255,.08))}
.yx-muted{font-size:11px;line-height:1.7;color:var(--dsw-alias-label-tertiary,#7d8698)}
.yx-tk-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:9px}
.yx-alert{display:flex;gap:9px;margin-top:11px;padding-left:10px;border-left:2px solid var(--dsw-alias-border-l2,#3a4252);font-size:11px;line-height:1.7;color:var(--dsw-alias-label-secondary,#a9b2c1)}
.yx-alert>i{flex:0 0 auto;font-style:normal;font-weight:600;color:var(--dsw-alias-label-primary,#e6e9ef)}
.yx-alert.warn{border-left-color:rgba(245,158,11,.55)}.yx-alert.warn>i{color:var(--dsw-alias-state-warn-primary,#e0b070)}
.yx-alert.danger{border-left-color:rgba(236,19,19,.5)}.yx-alert.danger>i{color:var(--dsw-alias-state-error-primary,#dfa6a6)}
.yx-checks{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:7px}
.yx-check{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.04));font-size:11px;color:var(--dsw-alias-label-secondary,#b9c0cd)}
.yx-check::before{content:'';width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#4bb27a)}
.yx-row-between{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:7px}
/* 列表行的高亮与勾选沿用原型里的强调色 */
.yx-row.hl{background:rgba(74,134,255,.12);box-shadow:inset 0 0 0 1px rgba(74,134,255,.55)}
.yx-ck{flex:0 0 auto;width:15px;height:15px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2,#4a5468);display:flex;align-items:center;justify-content:center;font-size:10px;line-height:1;color:transparent}
.yx-ck.on{background:var(--dsw-alias-button-primary-fill,#3d76ee);border-color:var(--dsw-alias-button-primary-fill,#3d76ee);color:#fff}
.yx-ws{flex:0 0 auto;font-size:10px;padding:1px 5px;border-radius:5px;background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.07));color:var(--dsw-alias-label-tertiary,#8b93a3)}
.yx-inv{margin:8px 8px 4px;padding:10px;border-radius:10px;border:1px solid rgba(74,134,255,.45);background:rgba(74,134,255,.1)}
.yx-inv-h{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#cfe0ff)}
.yx-inv-b{margin-top:3px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b93a3)}
.yx-inv-a{display:flex;gap:6px;margin-top:8px}
.yx-tst{margin:8px 8px 0;padding:7px 10px;border-radius:8px;border:1px dashed rgba(74,134,255,.5);background:rgba(74,134,255,.1);font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary,#a9c6ff)}
.yx-hint{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#8b93a3)}
.yx-gav{display:grid;overflow:hidden}
.yx-gpick{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:9px;cursor:pointer;transition:background .12s}
.yx-gpick:hover{background:rgba(255,255,255,.05)}
.yx-gpick.on{background:rgba(74,134,255,.14)}
.yx-gpick-box{flex:0 0 16px;width:16px;height:16px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2,#3a4252);display:grid;place-items:center;font-size:11px;line-height:1;color:#fff}
.yx-gpick.on .yx-gpick-box{background:var(--dsw-alias-button-primary-fill,#3d76ee);border-color:transparent}
.yx-gpick-tx{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
.yx-gpick-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#98a0b0);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.yx-ask-wide{width:min(420px,calc(100vw - 40px))}
.yx-ask-err{margin:0 18px 8px;padding:7px 10px;border-radius:7px;background:rgba(220,80,80,.12);color:#ffb0b0;font-size:12px}
.yx-pick-sec{margin:12px 0 4px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary,#8b93a3)}
.yx-msg-av{display:inline-grid;place-items:center;width:15px;height:15px;margin-right:5px;border-radius:5px;font-size:8px;font-style:normal;font-weight:600;line-height:1;color:#eef2fa;vertical-align:-3px}
`;

    function injectStyle() {
      const id = 'dsh-yuxin-style';
      let el = document.getElementById(id);
      if (!el) {
        el = document.createElement('style');
        el.id = id;
        document.head.appendChild(el);
      }
      // CSS 变了就原地替换。原来「有同名元素就 return」会让插件热重载后
      // 一直用旧规则 —— 新加的样式（比如浮层那一组）永远进不来。
      if (el.textContent !== CSS) el.textContent = CSS;
    }

    // ---------- 段 2 · 数据层（全动态，代码里不出现任何好友名字） ----------
    // 字段以 dsh-weave/lib/index.js:261→270 + dsh-chat/lib/room-store.js:187 为准：
    // host = { hostId, hostName, state, workspaces[] }，state ∈ online / offline / unknown / unpaired
    // workspace = { id, title, sessions[] }；session = { id, title, state, running, updatedAt }
    // 机器名取不到时退成 hostId 前 8 位，避免行右边空一块。
    function hostTag(host) {
      const name = String(host?.hostName ?? host?.hostname ?? '').trim();
      if (name) return name;
      const id = String(host?.hostId ?? host?.peerId ?? '');
      return id ? id.slice(0, 8) : '';
    }

    function hostState(host, sessions) {
      const raw = String(host?.state ?? host?.status ?? '').toLowerCase();
      if (raw === 'online') return { dot: 'on', label: '在线' };
      if (raw === 'offline') return { dot: 'off', label: '离线' };
      if (raw === 'unpaired') return { dot: 'unk', label: '还没合过符' };
      if (raw === 'unknown') return { dot: 'unk', label: '状态未知' };
      const list = Array.isArray(sessions) ? sessions : [];
      if (list.some((one) => one?.state === 'host-offline')) return { dot: 'off', label: '离线' };
      if (list.some((one) => one?.running)) return { dot: 'on', label: '在线' };
      return { dot: 'unk', label: '状态未知' };
    }

    // 好友 = 一台机器（传输层的一个 peer），不是对方开的会话。
    // 正门：POST /api/dsh-im {endpoint:'endpoints'} → transport.hosts() =
    // [{hostId, addressKnown, state}]（lib/transport.js 的 hosts()）：只给身份和在线态，不带任何会话信息。
    // ---------- 未读角标：本机记账，不进协议 ----------
    // 只记「读到第几条」，不存消息 id。host 半给的是对方的入站总条数（单调递增），
    // 角标 = 总数 - 水位。重复投递、乱序到达都算不错，也不用为已读再走一次网络。
    const READ_KEY = 'dsh-yuxin:read';

    function loadRead() {
      try {
        const one = JSON.parse(localStorage.getItem(READ_KEY) || '{}');
        return one && typeof one === 'object' ? one : {};
      } catch { return {}; }
    }

    function saveRead(map) {
      try { localStorage.setItem(READ_KEY, JSON.stringify(map)); } catch { /* 隐私模式忽略 */ }
    }

    /** 第一次见到这个会话不弹未读 —— 刚装好就一屏红点是自己吓自己。 */
    function unreadOf(read, key, total) {
      const seen = read[key];
      if (!Number.isFinite(seen)) return 0;
      return Math.max(0, total - seen);
    }

    async function loadFriends(signal) {
      const res = await weave('endpoints', {}, signal);
      const hosts = Array.isArray(res?.endpoints) ? res.endpoints : [];
      // 对端名片（对方自己填的、或账号带过来的名字头像）。一次全拿，拿不到也不影响列表。
      const cards = await imApi('cards', {}, signal).catch(() => ({}));
      return hosts.map((host) => {
        const hostId = String(host.hostId || '');
        const state = host.state === 'online' ? { dot: 'on', label: '在线' }
          : host.state === 'offline' ? { dot: 'off', label: '离线' }
          : (host.addressKnown === false || host.state === 'unpaired') ? { dot: 'unk', label: '还没合过符' }
          : { dot: 'unk', label: '状态未知' };
        return {
          kind: 'peer',
          key: 'peer:' + hostId,
          hostId,
          name: '好友 ' + hostId.slice(0, 8),
          card: (cards && cards[hostId]) || null,
          sub: '',
          dot: state.dot,
          stateLabel: state.label,
        };
      });
    }

    // 收件口一律用固定 id `dsh-im-inbox`（对方宿主半会自动建那条会话）。
    // 早期版本会去翻对方 remoteSessions 挑「最近活跃会话」当收件口，那等于替用户
    // 选了一个可能不存在、也可能被删的会话，还会把对方的会话标题暴露到我们这边 ——
    // 整段已删。现在两端约好同一个 id，不依赖对方开着什么。
    // 依据：room-store.js:409 成员 sessionId 只用于投递定位；:577 #acceptInvite 把
    // payload.recipient 存成 linkedSessionId，投递时按它对齐（:569）。

    // ---------- 投递原语：直连对端 hostId，不再有「塘/房间」这一层 ----------
    // 两人聊不再落任何本机会话：界面是侧栏里弹的浮层聊天窗，
    // 消息走本插件自己的 /api/dsh-im（底下是自带传输层的点对点）。
    // 不建塘、不邀请、不建会话，也不再碰上游的 dsh-chat。
    // 下面两个是兼容早期 `dsh-im-chat-<hostId>` 会话 id 用的，老会话仍能被认出来。
    const CHAT_PREFIX = 'dsh-im-chat-';

    /** 会话 id → 对端 hostId；不是私聊会话就返回空串。 */
    function peerOfSession(sessionId) {
      const id = String(sessionId || '');
      if (!id.startsWith(CHAT_PREFIX)) return '';
      return id.slice(CHAT_PREFIX.length).replace(/[^A-Za-z0-9_-]/g, '');
    }

    function openSession(ctx, sessionId) {
      const workspace = probeService(ctx, 'uiWorkspace');
      if (workspace && typeof workspace.openSession === 'function') {
        workspace.openSession(sessionId);
        return true;
      }
      console.warn('[yuxin] uiWorkspace.openSession 不可用，会话未打开：', sessionId);
      return false;
    }

    // 点智能体 = 打开它的真实会话。第一次点才建（host 半建会话要落盘，别在创建弹框里提前做）。
    // 人设/开场白只在第一次建会话时写进种子；之后聊天全走官方。
    async function ensureBotSession(bot) {
      if (bot.sessionId) return bot.sessionId;
      const value = await imApi('botSession', {
        botId: bot.id,
        name: bot.name,
        persona: bot.desc,
        hi: bot.hi,
      });
      return value?.sessionId || '';
    }

    // ---------- 段 3 · UI（页签内容整栏） ----------
    // 本地备注名 / 本地头像：只存本机，不依赖对端，也不回写 rooms.json
    const PROFILE_KEY = 'dsh-yuxin:profiles';
    // 我的名片：加好友之后，对端看到的名字和头像就是它。
    // 跟 PROFILE_KEY 分开存 —— 那份是「别人在我这儿怎么显示」，这份是「我在别人那儿怎么显示」。
    const ME_KEY = 'dsh-yuxin:me';
    const AVATAR_MAX = 48 * 1024;
    function loadProfiles() {
      try {
        const parsed = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch { return {}; }
    }

    function saveProfiles(map) {
      try { localStorage.setItem(PROFILE_KEY, JSON.stringify(map)); }
      catch (err) { console.warn('[yuxin] 本地备注存不下', err); }
    }

    /**
     * 我的名片。auto=true 表示这张脸是从 DSH 登录账号自动填的（还没被用户改过），
     * 账号信息一刷新就可以覆盖；用户一动手改成 false，从此只认用户填的。
     */
    function loadMe() {
      try {
        const parsed = JSON.parse(localStorage.getItem(ME_KEY) || 'null');
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch { return {}; }
    }

    function saveMe(me) {
      try { localStorage.setItem(ME_KEY, JSON.stringify(me || {})); }
      catch (err) { console.warn('[yuxin] 名片存不下', err); }
    }

    // ---------- 智能体（本机创建，不走配对符、不出网络） ----------
    // 依据 im-prototypes/17-智能体-添加-fu.html：名字 / 人设 / 模型 / 开场白 / 工具。
    const BOTS_KEY = 'dsh-yuxin:bots';
    function loadBots() {
      try {
        const parsed = JSON.parse(localStorage.getItem(BOTS_KEY) || '[]');
        return Array.isArray(parsed) ? parsed.filter((bot) => bot && bot.id && bot.name) : [];
      } catch { return []; }
    }
    function saveBots(list) {
      try { localStorage.setItem(BOTS_KEY, JSON.stringify(list)); } catch { /* 隐私模式忽略 */ }
    }

    // 选图后压成 64×64 JPEG，避免把几 MB 的原图塞进 localStorage
    function shrinkImage(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('读图失败'));
        reader.onload = () => {
          const img = new Image();
          img.onerror = () => reject(new Error('这不是有效图片'));
          img.onload = () => {
            const side = Math.min(img.width, img.height);
            const canvas = document.createElement('canvas');
            canvas.width = 64; canvas.height = 64;
            const g = canvas.getContext('2d');
            g.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 64, 64);
            resolve(canvas.toDataURL('image/jpeg', 0.82));
          };
          img.src = String(reader.result);
        };
        reader.readAsDataURL(file);
      });
    }

    /**
     * 发消息、推票时顺手带上的「我的名片」。
     * 没设过就返回 undefined，对端继续按 hostId 占位显示，不会凭空多个名字。
     */
    function cardForSend() {
      const me = loadMe();
      const name = String(me.name || '').trim();
      const avatar = String(me.avatar || '').trim();
      return (name || avatar) ? { name, avatar } : undefined;
    }

    /**
     * 名字三级优先级：本地备注 > 对端自报名片 > hostId 占位。
     * 为什么分三层：远端名片对方随时能改，本地备注是用户自己的决定，前者不许覆盖后者。
     * 头像同一套优先级，只是没有占位（空就是首字母色块）。
     */
    function faceOf(row, profile) {
      const local = profile && typeof profile === 'object' ? profile : {};
      const card = row && row.card && typeof row.card === 'object' ? row.card : {};
      return {
        name: String(local.name || card.name || '').trim() || String((row && row.name) || ''),
        avatar: String(local.avatar || card.avatar || '').trim(),
      };
    }

    function displayName(row, profile) {
      return faceOf(row, profile).name;
    }

    function Avatar({ name, avatar }) {
      if (avatar) return h('img', { className: 'yx-av yx-av-img', src: avatar, alt: '' });
      return h('span', { className: 'yx-av', style: { background: identityColor(name) } }, initial(name));
    }

    /** 名字 + 头像编辑器。「备注」和「我的名片」共用同一套，省一份重复实现。 */
    function FaceEditor({ name: initName, avatar: initAvatar, fallbackName, onSave, onClose }) {
      const [name, setName] = useState(initName || '');
      const [avatar, setAvatar] = useState(initAvatar || '');
      const [busy, setBusy] = useState(false);
      const [err, setErr] = useState('');
      const fileRef = useRef(null);

      const pick = async (event) => {
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        setBusy(true); setErr('');
        try {
          const dataUrl = await shrinkImage(file);
          if (dataUrl.length > AVATAR_MAX) setErr('图太大，换一张小点的');
          else setAvatar(dataUrl);
        } catch (e) {
          setErr(e?.message || '读图失败');
        } finally {
          setBusy(false);
          if (fileRef.current) fileRef.current.value = '';
        }
      };

      return h('div', { className: 'yx-edit' },
        h('div', { className: 'yx-edit-row' },
          h(Avatar, { name: name || fallbackName, avatar }),
          h('input', {
            className: 'yx-input',
            value: name,
            maxLength: 24,
            placeholder: fallbackName,
            onChange: (e) => setName(e.target.value),
          }),
        ),
        err ? h('div', { className: 'yx-edit-err' }, err) : null,
        h('div', { className: 'yx-edit-acts' },
          h('input', { ref: fileRef, type: 'file', accept: 'image/*', style: { display: 'none' }, onChange: pick }),
          h('button', { className: 'yx-btn', disabled: busy, onClick: () => fileRef.current && fileRef.current.click() }, busy ? '处理中…' : '选头像图'),
          avatar ? h('button', { className: 'yx-btn', onClick: () => setAvatar('') }, '去掉头像') : null,
          h('button', { className: 'yx-btn yx-btn-primary', onClick: () => { onSave({ name: name.trim(), avatar }); onClose(); } }, '保存'),
          h('button', { className: 'yx-btn', onClick: onClose }, '取消'),
        ),
      );
    }

    /**
     * 好友的备注编辑器 = FaceEditor + 两条危险操作（清空记录 / 删好友）。
     * 删好友只影响本机：点对点没有服务器，删不掉对方电脑上那份。
     */
    function RowEditor({ row, profile, onClose, onChange, onDeleted }) {
      const [confirm, setConfirm] = useState('');
      const [busy, setBusy] = useState(false);
      const [err, setErr] = useState('');
      const hostId = String(row?.key || '').replace(/^peer:/, '');

      const act = async (what) => {
        if (!hostId) return;
        setBusy(true); setErr('');
        try {
          if (what === 'clear') await imApi('clearChat', { hostId });
          else await imApi('friendRemove', { hostId });
          setConfirm('');
          onDeleted?.(what);
          onClose();
        } catch (e) {
          setErr(e?.message || '没成功');
        } finally { setBusy(false); }
      };

      return h('div', { className: 'yx-edit-wrap' },
        h(FaceEditor, {
          name: profile.name || '',
          avatar: profile.avatar || '',
          fallbackName: row.name,
          onSave: (value) => {
            const next = {};
            if (value.name) next.name = value.name;
            if (value.avatar) next.avatar = value.avatar;
            onChange(row.key, Object.keys(next).length ? next : null);
          },
          onClose,
        }),
        hostId ? h('div', { className: 'yx-edit-danger' },
          err ? h('div', { className: 'yx-edit-err' }, err) : null,
          confirm
            ? h('div', { className: 'yx-edit-confirm' },
              h('span', null, confirm === 'remove'
                ? '删掉这个好友？对方电脑上那份删不了，此后你俩互相看不到。'
                : '清空跟这个人的聊天记录？只清本机这一份。'),
              h('button', { className: 'yx-btn yx-btn-danger', disabled: busy, onClick: () => act(confirm) }, busy ? '…' : '确定'),
              h('button', { className: 'yx-btn', disabled: busy, onClick: () => setConfirm('') }, '取消'),
            )
            : h('div', { className: 'yx-edit-acts' },
              h('button', { className: 'yx-btn', onClick: () => setConfirm('clear') }, '清空聊天'),
              h('button', { className: 'yx-btn yx-btn-danger', onClick: () => setConfirm('remove') }, '删除好友'),
            ),
        ) : null,
      );
    }

    /** 「我的名片」弹窗。跟备注编辑共用 FaceEditor，只是落到 ME_KEY。 */
    function MeCardModal({ me, onSave, onClose }) {
      const overlay = h('div', {
        className: 'yx-ov',
        onClick: (e) => { if (e.target === e.currentTarget) onClose(); },
      },
        h('div', { className: 'yx-ask' },
          h('div', { className: 'yx-ask-hd' },
            h('div', { className: 'yx-hd-tx' },
              h('div', { className: 'yx-ask-title' }, '我的名片'),
              h('div', { className: 'yx-ask-sub' }, '加成功的好友看到的就是这个名字和头像'),
            ),
            h('button', { className: 'yx-ask-x', title: '关闭', onClick: onClose }, '✕'),
          ),
          h('div', { className: 'yx-ask-bd' },
            h(FaceEditor, {
              name: me.name || '',
              avatar: me.avatar || '',
              fallbackName: '我的名字',
              onSave,
              onClose,
            }),
          ),
        ),
      );
      if (typeof document === 'undefined' || !reactDom?.createPortal) return overlay;
      return reactDom.createPortal(overlay, document.body);
    }

    /**
     * 群详情：改名 / 看成员 / 踢人 / 清空 / 退群 / 解散。
     * 「删」这一档只动本机 + 广播一条帧 —— 没有服务器，删不掉别人电脑上的记录。
     */
    function GroupInfoModal({ groupId, onClose, onChanged }) {
      const [g, setG] = useState(null);
      const [name, setName] = useState('');
      const [announce, setAnnounce] = useState('');
      const [busy, setBusy] = useState('');
      const [err, setErr] = useState('');
      const [confirm, setConfirm] = useState('');   // ''|'clear'|'leave'|'dissolve'|'kick:<id>'
      const [pick, setPick] = useState(false);
      const [pool, setPool] = useState({ friends: [], bots: [] });

      useEffect(() => {
        if (!groupId) return undefined;
        let alive = true;
        const ctrl = new AbortController();
        imApi('group', { groupId }, ctrl.signal)
          .then((one) => { if (alive) { setG(one); setName(one?.name || ''); setAnnounce(one?.announce || ''); } })
          .catch((e) => { if (alive) setErr(e?.message || '群信息读不出来'); });
        return () => { alive = false; try { ctrl.abort(); } catch { /* ignore */ } };
      }, [groupId]);

      // 拉人面板打开时才去读好友和智能体 —— 不开就一直不读，省一次网络。
      useEffect(() => {
        if (!pick) return undefined;
        const ctrl = new AbortController();
        Promise.all([
          loadFriends(ctrl.signal).catch(() => []),
          Promise.resolve(loadBots()),
        ]).then(([fs, bs]) => {
          if (!ctrl.signal.aborted) setPool({ friends: fs, bots: bs });
        }).catch(() => { /* 拉不到就空着 */ });
        return () => { try { ctrl.abort(); } catch { /* ignore */ } };
      }, [pick]);

      const run = async (endpoint, args) => {
        setBusy(endpoint); setErr('');
        try { await imApi(endpoint, args); }
        catch (e) { setErr(e?.message || '没成功'); setBusy(''); return; }
        setBusy(''); setConfirm('');
        onChanged?.();
        onClose();
      };

      // 拉人成功后留在弹层里，方便接着拉下一个（新建的小群往往要连拉几个人）。
      const invite = async (who) => {
        setBusy('invite'); setErr('');
        try {
          await imApi('groupInvite', { groupId, member: who });
          const one = await imApi('group', { groupId }).catch(() => null);
          if (one) setG(one);
          onChanged?.();
        } catch (e) {
          setErr(e?.message || '没拉上');
        } finally {
          setBusy('');
        }
      };

      const members = Array.isArray(g?.members) ? g.members : [];
      const isOwner = String(g?.owner) === 'me';
      const dirty = Boolean(name.trim()) && name.trim() !== (g?.name || '');
      const annDirty = announce.trim() !== (g?.announce || '');
      const busyNow = Boolean(busy);

      // 公告单独存：改完留在弹层里，能立刻看到群里的横幅变了，不用关了再开。
      const saveAnnounce = async () => {
        setBusy('ann'); setErr('');
        try {
          const one = await imApi('groupAnnounce', { groupId, announce: announce.trim() });
          if (one) setG(one);
          onChanged?.();
        } catch (e) {
          setErr(e?.message || '公告没存上');
        } finally {
          setBusy('');
        }
      };

      const ask = (key, text, endpoint, args) => (confirm === key
        ? h('div', { className: 'yx-edit-confirm' },
          h('span', null, text),
          h('button', { className: 'yx-btn yx-btn-danger', disabled: busyNow, onClick: () => run(endpoint, args) }, busyNow ? '…' : '确定'),
          h('button', { className: 'yx-btn', disabled: busyNow, onClick: () => setConfirm('') }, '取消'),
        )
        : null);

      const overlay = h('div', {
        className: 'yx-ov',
        onClick: (e) => { if (e.target === e.currentTarget) onClose(); },
      },
        h('div', { className: 'yx-ask' },
          h('div', { className: 'yx-ask-hd' },
            h('div', { className: 'yx-hd-tx' },
              h('div', { className: 'yx-ask-title' }, '群详情'),
              h('div', { className: 'yx-ask-sub' }, `${members.length} 人 · 点对点直连`),
            ),
            h('button', { className: 'yx-ask-x', title: '关闭', onClick: onClose }, '✕'),
          ),
          h('div', { className: 'yx-ask-bd' },
            h('div', { className: 'yx-edit-row' },
              h('input', {
                className: 'yx-input',
                value: name,
                maxLength: 20,
                placeholder: '群名',
                onChange: (e) => setName(e.target.value),
              }),
            ),
            h('div', { className: 'yx-ann' },
              h('textarea', {
                className: 'yx-input yx-ann-ta',
                value: announce,
                maxLength: 200,
                rows: 2,
                placeholder: isOwner ? '群公告：写一句要让所有人都知道的话' : '群主还没写公告',
                disabled: !isOwner,
                onChange: (e) => setAnnounce(e.target.value),
              }),
              isOwner
                ? h('button', {
                  className: 'yx-btn' + (annDirty ? ' yx-btn-primary' : ''),
                  disabled: busyNow || !annDirty,
                  onClick: saveAnnounce,
                }, busy === 'ann' ? '…' : '存公告')
                : null,
            ),
            h('div', { className: 'yx-gi-list' },
              members.map((m) => {
                const mine = String(m.id) === 'me';
                const label = mine ? '我' : (m.name || String(m.id).slice(0, 8));
                const kicking = confirm === 'kick:' + m.id;
                return h('div', { key: m.id, className: 'yx-gi-mem' },
                  h(Avatar, { name: label, avatar: m.avatar }),
                  h('span', { className: 'yx-gi-nm' }, label),
                  m.kind === 'agent' ? h('span', { className: 'yx-tag' }, '智能体') : null,
                  String(m.id) === String(g?.owner) ? h('span', { className: 'yx-tag' }, '群主') : null,
                  !mine && isOwner
                    ? (kicking
                      ? h('span', { className: 'yx-gi-kick' },
                        h('button', { className: 'yx-btn yx-btn-danger', disabled: busyNow, onClick: () => run('groupKick', { groupId, memberId: m.id }) }, '移出'),
                        h('button', { className: 'yx-btn', disabled: busyNow, onClick: () => setConfirm('') }, '算了'))
                      : h('button', { className: 'yx-btn', onClick: () => setConfirm('kick:' + m.id) }, '移出'))
                    : null,
                );
              }),
            ),
            pick ? h('div', { className: 'yx-gi-list' }, (() => {
              const cand = [
                ...pool.friends.map((row) => ({
                  id: String(row.key || '').replace(/^peer:/, ''),
                  name: (row.card && row.card.name) || row.name,
                  kind: 'peer',
                })),
                ...pool.bots.map((b) => ({ id: String(b.id || ''), name: b.name, kind: 'agent' })),
              ].filter((one) => one.id && !members.some((m) => String(m.id) === one.id));
              if (!cand.length) return h('div', { className: 'yx-state' }, '没有能拉的人了');
              return cand.map((one) => h('div', { key: one.id, className: 'yx-gi-mem' },
                h(Avatar, { name: one.name }),
                h('span', { className: 'yx-gi-nm' }, one.name),
                one.kind === 'agent' ? h('span', { className: 'yx-tag' }, '智能体') : null,
                h('button', { className: 'yx-btn', disabled: busyNow, onClick: () => invite(one) }, '拉进来'),
              ));
            })()) : null,
            err ? h('div', { className: 'yx-edit-err' }, err) : null,
            ask('clear', '清空这个群的本地记录？别人那边不动。', 'clearGroup', { groupId }),
            ask('leave', '退出这个群？退了就收不到群消息了，再想回来要别人重新拉。', 'groupLeave', { groupId }),
            isOwner ? ask('dissolve', '解散这个群？所有成员那边都会删掉这个群。', 'groupDissolve', { groupId }) : null,
            h('div', { className: 'yx-edit-acts' },
              dirty ? h('button', { className: 'yx-btn yx-btn-primary', disabled: busyNow, onClick: () => run('groupRename', { groupId, name: name.trim() }) }, '保存群名') : null,
              h('button', { className: 'yx-btn', disabled: busyNow, onClick: () => setPick((v) => !v) }, pick ? '收起拉人' : '＋ 拉人'),
              confirm ? null : h('button', { className: 'yx-btn', disabled: busyNow, onClick: () => setConfirm('clear') }, '清空记录'),
              confirm ? null : h('button', { className: 'yx-btn', disabled: busyNow, onClick: () => setConfirm('leave') }, '退出群聊'),
              confirm || !isOwner ? null : h('button', { className: 'yx-btn yx-btn-danger', disabled: busyNow, onClick: () => setConfirm('dissolve') }, '解散群'),
            ),
          ),
        ),
      );
      if (typeof document === 'undefined' || !reactDom?.createPortal) return overlay;
      return reactDom.createPortal(overlay, document.body);
    }

    // ---------- 段 5.5 · 群聊 ----------
    /** 群头像：成员首字母拼 2x2，人少就少几格。 */
    function GroupAvatar({ members, size = 26 }) {
      const list = (Array.isArray(members) ? members : []).slice(0, 4);
      if (!list.length) return h('span', { className: 'yx-av', style: { background: identityColor('群') } }, '群');
      const one = list.length === 1;
      return h('span', {
        className: 'yx-gav',
        style: {
          width: size + 'px', height: size + 'px', flex: '0 0 ' + size + 'px',
          borderRadius: '7px', gap: '1px',
          gridTemplateColumns: one ? '1fr' : '1fr 1fr',
          gridTemplateRows: one ? '1fr' : '1fr 1fr',
          background: 'var(--dsw-alias-bg-layer-2,#242a34)',
        },
      },
        list.map((m) => h('i', {
          key: m.id,
          style: {
            display: 'grid', placeItems: 'center', fontStyle: 'normal',
            fontSize: (one ? 11 : 8) + 'px', fontWeight: 600, color: '#eef2fa',
            background: identityColor(m.name || m.id),
          },
        }, initial(m.name || m.id))),
      );
    }

    /** 群列表：侧栏只要名字、人数、最后一条。读不到就当没群，不挡别的功能。 */
    async function loadGroups(signal) {
      try {
        const list = await imApi('groups', {}, signal);
        return Array.isArray(list) ? list : [];
      } catch {
        return [];
      }
    }

    /** 发起群聊：勾好友（和我的智能体），群名留空就按成员拼。 */
    function CreateGroupModal({ friends, bots, onClose, onCreated }) {
      const [name, setName] = useState('');
      const [picked, setPicked] = useState({});
      const [busy, setBusy] = useState(false);
      const [err, setErr] = useState('');
      const count = Object.values(picked).filter(Boolean).length;
      const toggle = (key) => setPicked((prev) => ({ ...prev, [key]: !prev[key] }));

      const submit = async (event) => {
        if (event) event.preventDefault();
        if (!count || busy) return;
        setBusy(true); setErr('');
        try {
          const members = [];
          for (const f of friends) {
            if (!picked['peer:' + f.hostId]) continue;
            const face = faceOf(f, null);
            members.push({ id: f.hostId, kind: 'peer', name: face.name, avatar: face.avatar });
          }
          for (const b of bots) {
            if (!picked['bot:' + b.id]) continue;
            members.push({ id: 'agent:' + b.id, kind: 'agent', name: b.name, avatar: b.avatar || '' });
          }
          const g = await imApi('groupCreate', { name: name.trim(), members, card: cardForSend() });
          onCreated(g);
        } catch (error) {
          setErr(error?.message || '建群失败');
        } finally {
          setBusy(false);
        }
      };

      const rowOf = (key, avatar, label, sub) => h('div', {
        key,
        className: 'yx-gpick' + (picked[key] ? ' on' : ''),
        onClick: () => toggle(key),
      },
        h('span', { className: 'yx-gpick-box' }, picked[key] ? '✓' : ''),
        avatar,
        h('span', { className: 'yx-gpick-tx' },
          h('span', { className: 'yx-nm' }, label),
          sub ? h('span', { className: 'yx-gpick-sub' }, sub) : null,
        ),
      );

      const overlay = h('div', {
        className: 'yx-ov',
        onClick: (e) => { if (e.target === e.currentTarget) onClose(); },
      },
        h('form', { className: 'yx-ask yx-ask-wide', onSubmit: submit },
          h('div', { className: 'yx-ask-hd' },
            h('div', { className: 'yx-hd-tx' },
              h('div', { className: 'yx-ask-title' }, '发起群聊'),
              h('div', { className: 'yx-ask-sub' }, `已选 ${count} 人 · 一个群最多 10 人`),
            ),
            h('button', { type: 'button', className: 'yx-ask-x', title: '关闭', onClick: onClose }, '✕'),
          ),
          err ? h('div', { className: 'yx-ask-err' }, err) : null,
          h('div', { className: 'yx-ask-bd' },
            h('input', {
              className: 'yx-input',
              value: name,
              placeholder: '群名（不填就按成员拼）',
              maxLength: 20,
              onChange: (e) => setName(e.target.value),
            }),
            friends.length ? h('div', { className: 'yx-pick-sec' }, '好友') : null,
            friends.map((f) => {
              const face = faceOf(f, null);
              return rowOf('peer:' + f.hostId, h(Avatar, { name: face.name, avatar: face.avatar }), face.name, f.hostId.slice(0, 8));
            }),
            bots.length ? h('div', { className: 'yx-pick-sec' }, '我的智能体') : null,
            bots.map((b) => rowOf('bot:' + b.id, h(Avatar, { name: b.name, avatar: b.avatar || '' }), b.name, '跑在你这台电脑上')),
            !friends.length && !bots.length
              ? h('div', { className: 'yx-state' }, '还没有可以拉的人，先加个好友。')
              : null,
          ),
          h('div', { className: 'yx-ask-ft' },
            h('button', { type: 'button', className: 'yx-btn', onClick: onClose }, '取消'),
            h('button', { type: 'submit', className: 'yx-btn yx-btn-primary', disabled: !count || busy },
              busy ? '建群中…' : '建群'),
          ),
        ),
      );
      if (typeof document === 'undefined' || !reactDom?.createPortal) return overlay;
      return reactDom.createPortal(overlay, document.body);
    }

    function Row({ ctx, row, profile, editing, onEdit, onProfile, onOpen, onDeleted }) {
      const face = faceOf(row, profile);
      const name = face.name;
      return h('div', { className: 'yx-item' },
        h('div', {
          className: 'yx-row' + (row.hl ? ' hl' : ''),
          title: [name, row.sub, row.stateLabel].filter(Boolean).join(' · '),
          onClick: () => onOpen(row),
        },
          h(Avatar, { name, avatar: face.avatar }),
          h('span', { className: 'yx-nm' }, name),
          row.tag ? h('span', { className: 'yx-tag yx-tag-dim' }, row.tag) : null,
          row.sub ? h('span', { className: 'yx-sub' }, row.sub) : null,
          row.dot ? h('span', { className: `yx-dot ${row.dot}`, title: row.stateLabel || '' }) : null,
          row.unread ? h('span', { className: 'yx-un', title: `${row.unread} 条未读` }, row.unread > 99 ? '99+' : String(row.unread)) : null,
          h('button', {
            className: 'yx-more',
            title: '备注名 / 头像',
            onClick: (e) => { e.stopPropagation(); onEdit(editing ? null : row.key); },
          }, '⋯'),
        ),
        editing ? h(RowEditor, {
          row,
          profile: profile || {},
          onClose: () => onEdit(null),
          onChange: onProfile,
          onDeleted,
        }) : null,
      );
    }

    // ---------- 添加智能体弹层（表单式，对应 17 号原型） ----------
    const BOT_AVATARS = ['🐟', '🦈', '🐳', '🐙', '✦', '🐠'];

    // harness 里配了哪些模型，就从 modelDirectories 服务读；服务不在或形状变了就返回空，
    // 弹层里仍然能「跟随系统」或手填一个 id —— 宁可少列，不能列假的。
    // harness 里配了哪些模型，问官方 RPC 要（client 侧同款：ctx.remote.session.modelCatalog()）。
    // 返回 { groups: [{ id: provider, models: [{ id, name }] }] }，按 provider 分组喂给下拉的 optgroup。
    // 官方模型选择器自己是 inject: ['remote', 'remote.session'] 再 this.ctx.remote.session.modelCatalog()。
    // 我们不敢把 remote 写进 entry 的 inject（拿不到就整条插件失活、页签跟着消失），改成可选注入：
    // 注入了就记在 REMOTE，注入不到只是少一项「模型」，别的都不受影响。
    let REMOTE = null;

    async function listModels(ctx) {
      try {
        const remote = REMOTE
          || (typeof ctx?.get === 'function' ? ctx.get('remote') : null)
          || ctx?.remote;
        const session = remote?.session
          || (typeof ctx?.get === 'function' ? ctx.get('remote.session') : null);
        if (!session || typeof session.modelCatalog !== 'function') return [];
        const res = await session.modelCatalog();
        if (!res || res.ok !== true) return [];
        const groups = (res.value && res.value.groups) || [];
        const seen = {};
        const out = [];
        for (const group of groups) {
          const gid = String(group.id || '');
          // 官方分组标题用 group.name（deepseek-account 那组它自己换成本地化的「DeepSeek Account」）
          const glabel = gid === 'deepseek-account' ? 'DeepSeek Account' : String(group.name || gid);
          for (const model of group.models || []) {
            const id = model && model.id;
            if (!id || seen[id]) continue;
            seen[id] = true;
            out.push({ group: gid, groupLabel: glabel, value: String(id), label: String(model.name || model.label || id) });
          }
        }
        return out;
      } catch { return []; }
    }
    const BOT_TOOLS = ['读写文件', '执行命令', '联网搜索', '发消息给好友'];

    function groupByProvider(options) {
      const buckets = [];
      const index = {};
      for (const item of options) {
        const key = item.group || '';
        if (!(key in index)) { index[key] = buckets.length; buckets.push({ group: key, label: item.groupLabel || key, items: [] }); }
        buckets[index[key]].items.push(item);
      }
      return buckets;
    }

    function AddBotModal({ ctx, bots, onClose, onCreated }) {
      const [avatar, setAvatar] = useState(BOT_AVATARS[0]);
      const [name, setName] = useState('');
      const [desc, setDesc] = useState('');
      const [modelOptions, setModelOptions] = useState([]);
      const [model, setModel] = useState('跟随系统');
      const [customModel, setCustomModel] = useState('');
      const [hi, setHi] = useState('');
      const [tools, setTools] = useState(['读写文件']);
      const [err, setErr] = useState('');

      useEffect(() => {
        let alive = true;
        listModels(ctx).then((list) => { if (alive) setModelOptions(list); });
        return () => { alive = false; };
      }, []);

      const toggleTool = (tool) => setTools((list) => (list.includes(tool) ? list.filter((one) => one !== tool) : list.concat(tool)));

      const commit = () => {
        const trimmed = name.trim();
        if (!trimmed) { setErr('先给它一个名字。'); return; }
        if (bots.some((bot) => bot.name === trimmed)) { setErr(`已经有叫「${trimmed}」的智能体了，换个名字。`); return; }
        if (!desc.trim()) { setErr('人设是空的 —— 它会变成一个什么都干、也干不好的家伙。'); return; }
        const bot = {
          id: 'bot-' + Date.now().toString(36),
          name: trimmed,
          avatar,
          desc: desc.trim(),
          model: model === '自定义…' ? (customModel.trim() || '跟随系统') : model,
          hi: hi.trim(),
          tools,
          createdAt: Date.now(),
        };
        onCreated(bot);
      };

      const overlay = h('div', { className: 'yx-ov', onClick: (e) => { if (e.target === e.currentTarget) onClose(); } },
        h('div', { className: 'yx-ask' },
          h('div', { className: 'yx-ask-hd' },
            h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
              h('div', { className: 'yx-ask-title' }, '添加智能体'),
              h('div', { className: 'yx-ask-sub' }, '给它一个名字和一段人设，它就会出现在「智能体」这一组里。'),
            ),
            h('button', { className: 'yx-ask-x', onClick: onClose, title: '关闭' }, '✕'),
          ),
          h('div', { className: 'yx-ask-bd' },
            h('div', { className: 'yx-sec2' },
              h('div', { className: 'yx-k' }, '头像'),
              h('div', { className: 'yx-avas' }, BOT_AVATARS.map((one) => h('button', {
                key: one,
                className: 'yx-ava-btn' + (avatar === one ? ' on' : ''),
                onClick: () => setAvatar(one),
              }, one))),
            ),
            h('div', { className: 'yx-sec2' },
              h('div', { className: 'yx-k' }, '名字'),
              h('input', { className: 'yx-input', value: name, maxLength: 16, placeholder: '比如：报单助手', onChange: (e) => setName(e.target.value) }),
            ),
            h('div', { className: 'yx-sec2' },
              h('div', { className: 'yx-k' }, '人设 · ' + (name.trim() || '未命名'), h('span', { className: 'yx-k-i' }, '它是什么样的人，怎么说话、只干哪些事')),
              h('textarea', { className: 'yx-ta', value: desc, placeholder: '比如：你只负责盯报单。每天 10 点把没交的人列出来，语气简短，不写解释。', onChange: (e) => setDesc(e.target.value) }),
            ),
            h('div', { className: 'yx-sec2' },
              h('div', { className: 'yx-k' }, '模型', h('span', { className: 'yx-k-i' }, modelOptions.length ? '和官方模型选择器同一份清单' : '没读到配置，可手填')),
              h('select', {
                className: 'yx-sel',
                value: model,
                onChange: (e) => setModel(e.target.value),
              },
                h('option', { value: '跟随系统' }, '跟随系统'),
                ...groupByProvider(modelOptions).map((bucket) => h('optgroup', { key: bucket.group, label: bucket.label || '其他' },
                  bucket.items.map((item) => h('option', { key: item.value, value: item.value }, item.label)),
                )),
                h('option', { value: '自定义…' }, '自定义…'),
              ),
              model === '自定义…'
                ? h('input', { className: 'yx-input', value: customModel, placeholder: '填模型 id，比如 deepseek-v3.2', onChange: (e) => setCustomModel(e.target.value) })
                : null,
            ),
            h('div', { className: 'yx-sec2' },
              h('div', { className: 'yx-k' }, '开场白', h('span', { className: 'yx-k-i' }, '可空')),
              h('input', { className: 'yx-input', value: hi, maxLength: 60, placeholder: '第一句话说什么', onChange: (e) => setHi(e.target.value) }),
            ),
            h('div', { className: 'yx-sec2' },
              h('div', { className: 'yx-k' }, '工具', h('span', { className: 'yx-k-i' }, '勾了它才能用')),
              h('div', { className: 'yx-chips' }, BOT_TOOLS.map((one) => h('button', {
                key: one,
                className: 'yx-chip' + (tools.includes(one) ? ' on' : ''),
                onClick: () => toggleTool(one),
              }, one))),
              h('div', { className: 'yx-muted' }, '没勾的工具它看不见，也就不会去用 —— 这是给它划边界的地方。'),
            ),
            err ? h('div', { className: 'yx-err' }, err) : null,
          ),
          h('div', { className: 'yx-ask-ft' },
            h('div', { className: 'yx-hint yx-muted' }, '创建后可以改名、换头像，人设随时可改。'),
            h('button', { className: 'yx-btn', onClick: onClose }, '取消'),
            h('button', { className: 'yx-btn yx-btn-primary', onClick: commit }, '创建'),
          ),
        ),
      );
      if (typeof document === 'undefined' || !reactDom?.createPortal) return overlay;
      return reactDom.createPortal(overlay, document.body);
    }

    // ---------- 添加好友弹层（两入口：铸符 / 合符） ----------
    // 依据 im-prototypes/14-添加好友流程-方案丁-fu.html + 方案文档第十六节。
    // 铸符只读 weave.ticket()；合符是本插件唯一写动作 weave.trust(ticket) → 落 peers.json。
    const ASK_TITLES = ['添加好友', '铸符 · 我的配对票', '合符 · 验对方的票', '合符成功'];
    const ASK_SUBS = [
      '挑一个入口开始。两个都只动本机的信任名单，不经过任何服务器。',
      '把这张票发给对方，他合上之后你就是他的好友。',
      '把对方发来的票粘进来，验过就写进本机信任名单。',
      '对方已写进本机。等他合上你的票，两边就通了。',
    ];

    const ICON_CHEV = 'M9 6l6 6-6 6';
    const ICON_SEAL = ['M12 3l7 4v4.6c0 4-2.9 7-7 9.4-4.1-2.4-7-5.4-7-9.4V7l7-4z', 'M9 12l2 2 4-4'];
    const ICON_LINK = ['M9.5 14.5a3.5 3.5 0 010-5l2-2a3.5 3.5 0 015 5l-1 1', 'M14.5 9.5a3.5 3.5 0 010 5l-2 2a3.5 3.5 0 01-5-5l1-1'];
    const ICON_CHECK = 'M4 12.5l5 5L20 6.5';

    // 内联小图标：不引第三方图标库，也不占体积
    function SvgIcon({ d, size = 16 }) {
      const paths = Array.isArray(d) ? d : [d];
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
      }, paths.map((p, i) => h('path', { key: i, d: p })));
    }

    function AddFriendModal({ onClose, onAdded }) {
      const [pane, setPane] = useState(0);   // 0 首屏 / 1 铸符 / 2 合符 / 3 成功
      const [ticket, setTicket] = useState('');
      const [text, setText] = useState('');
      const [peer, setPeer] = useState('');
      const [err, setErr] = useState('');
      const [note, setNote] = useState('');
      const [busy, setBusy] = useState(false);
      const [copied, setCopied] = useState(false);

      // Esc 关闭：弹层挂在 body 上，用户的心智是「按 Esc 退出」
      useEffect(() => {
        const onKey = (e) => {
          if (e.key !== 'Escape') return;
          if (pane > 0 && pane < 3) { setErr(''); setNote(''); setPane(0); } else onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [pane]);

      // 票随 Weave 重启而变，所以每次进「铸符」都现取一张，不做缓存
      useEffect(() => {
        if (pane !== 1 || ticket) return undefined;
        let alive = true;
        setBusy(true); setErr('');
        weave('ticket', {})
          .then((value) => { if (alive) setTicket(String(value?.ticket || '')); })
          .catch((e) => { if (alive) setErr(e?.message || '取票失败'); })
          .finally(() => { if (alive) setBusy(false); });
        return () => { alive = false; };
      }, [pane, ticket]);

      // 分享入口：微信 / 邮件 / 其他都只能做同一件事 —— 把票复制走
      const copy = async (to) => {
        if (!ticket) return;
        try {
          await navigator.clipboard.writeText(ticket);
          setCopied(true);
          setNote(to ? '已复制 · 去' + to + '粘给他' : '');
          setTimeout(() => setCopied(false), 1800);
        } catch { setNote('复制失败：手动选中上面的票复制吧'); }
      };

      const paste = async () => {
        try {
          const value = await navigator.clipboard.readText();
          if (!value || !value.trim()) { setErr('剪贴板是空的'); return; }
          setText(value.trim()); setErr('');
        } catch { setErr('读不到剪贴板，手动粘一下（Ctrl+V）'); }
      };

      const join = async () => {
        const value = text.trim();
        if (!value) { setErr('先把对方的配对票粘进来'); return; }
        if (ticket && value === ticket) { setErr('这是你自己的票，换对方发来的那张'); return; }
        setBusy(true); setErr(''); setNote('');
        try {
          const res = await weave('trust', { ticket: value });
          const peer = String(res?.peerId || '');
          setPeer(peer);
          setPane(3);
          onAdded?.();
          // 单向加好友：我合了对方的符，就顺手把我的票推给对方，
          // 他那头收到后自动把我加进信任名单 —— 不用他再合一次。
          if (peer) void imApi('announce', { hostId: peer, card: cardForSend() }).catch(() => { /* 对方离线，下次点好友再补 */ });
        } catch (e) {
          setErr(e?.message || '验证没过：票可能坏了，或者对方已经重启换票了');
        } finally {
          setBusy(false);
        }
      };

      let body;
      if (pane === 0) {
        body = h('div', null,
          h('div', { className: 'yx-picks' },
            h('button', { className: 'yx-pick', onClick: () => { setNote(''); setErr(''); setPane(1); } },
              h('span', { className: 'yx-pick-ic' }, h(SvgIcon, { d: ICON_SEAL })),
              h('span', { className: 'yx-pick-tx' },
                h('span', { className: 'yx-pick-k' }, '铸符 · 我加别人'),
                h('span', { className: 'yx-pick-d' }, '生成本机的配对票发给对方。票里只有公开地址和公钥，私钥不出这台机器。'),
              ),
              h('span', { className: 'yx-pick-ar' }, h(SvgIcon, { d: ICON_CHEV, size: 15 })),
            ),
            h('button', { className: 'yx-pick', onClick: () => { setErr(''); setPane(2); } },
              h('span', { className: 'yx-pick-ic' }, h(SvgIcon, { d: ICON_LINK })),
              h('span', { className: 'yx-pick-tx' },
                h('span', { className: 'yx-pick-k' }, '合符 · 别人加我'),
                h('span', { className: 'yx-pick-d' }, '拿到对方发来的票，粘进来验一下，通过就进好友列表。'),
              ),
              h('span', { className: 'yx-pick-ar' }, h(SvgIcon, { d: ICON_CHEV, size: 15 })),
            ),
          ),
          h('div', { className: 'yx-muted', style: { marginTop: '4px' } }, '一次添加 = 你铸他合 + 他铸你合，两边都做完才互通，谁先谁后都行。'),
        );
      } else if (pane === 1) {
        body = h('div', null,
          h('div', { className: 'yx-sec2' },
            h('div', { className: 'yx-k' }, '你的配对票'),
            h('div', { className: 'yx-tk-card' },
              h('div', { className: 'yx-tk' + (ticket ? '' : ' yx-tk-empty') }, busy ? '正在取票…' : (ticket || '（没取到票）')),
              h('div', { className: 'yx-tk-meta' },
                h('span', { className: 'yx-tk-tail' }, ticket ? '尾号 ' + ticket.slice(-8) : ''),
                h('button', {
                  className: 'yx-copy' + (copied ? ' ok' : ''),
                  disabled: !ticket,
                  onClick: () => copy(),
                },
                  h(SvgIcon, { d: copied ? ICON_CHECK : 'M9 9V5h10v10h-4M5 9h10v10H5z', size: 13 }),
                  copied ? ' 已复制' : ' 复制',
                ),
              ),
            ),
          ),
          h('div', { className: 'yx-rule' }),
          h('div', { className: 'yx-sec2' },
            h('div', { className: 'yx-k' }, '发给他'),
            h('div', { className: 'yx-chips' },
              ['微信', '邮件', '其他'].map((to) => h('button', {
                key: to, className: 'yx-chip', disabled: !ticket, onClick: () => copy(to),
              }, to)),
            ),
            h('div', { className: 'yx-muted', style: { marginTop: '8px' } }, '点一下就是复制；别截图发，少一个字符就合不上。'),
            note ? h('div', { className: 'yx-muted', style: { marginTop: '4px', color: 'var(--dsw-alias-state-success-primary,#7ee2a0)' } }, note) : null,
          ),
          err ? h('div', { className: 'yx-err' }, err) : null,
          h('div', { className: 'yx-alert warn' },
            h('i', null, '票会变'),
            h('span', null, '本机 Weave 一重启就换新票，现铸现发，别存着改天用。'),
          ),
          h('div', { className: 'yx-alert danger' },
            h('i', null, '只发信得过的人'),
            h('span', null, '这不等于授权他操作你的机器，但等于他知道怎么找到你。'),
          ),
        );
      } else if (pane === 2) {
        body = h('div', null,
          h('div', { className: 'yx-sec2' },
            h('div', { className: 'yx-k' }, '对方发来的票'),
            h('textarea', {
              className: 'yx-ta',
              placeholder: '把对方的配对票整段粘到这里',
              value: text,
              onChange: (e) => { setText(e.target.value); setErr(''); },
            }),
            h('div', { className: 'yx-row-between' },
              h('span', { className: 'yx-muted' }, '整段粘进来，别加空格或换行'),
              h('button', { className: 'yx-btn', onClick: paste }, '从剪贴板粘贴'),
            ),
            err ? h('div', { className: 'yx-err' }, err) : null,
          ),
          h('div', { className: 'yx-rule' }),
          h('div', { className: 'yx-sec2' },
            h('div', { className: 'yx-k' }, '合之前会验三件事'),
            h('div', { className: 'yx-checks' },
              ['签名真伪', '票据有效期', '门牌是对方'].map((t) => h('span', { key: t, className: 'yx-check' }, t)),
            ),
            h('div', { className: 'yx-muted' }, '任一项不过，就不会写进本机信任名单。'),
          ),
          h('div', { className: 'yx-alert warn' },
            h('i', null, '会自动通知对方'),
            h('span', null, '合完就把你的票推给他，他那边落库后自动加你；他离线的话，下次你再点他的好友行会自动补推。'),
          ),
        );
      } else {
        body = h('div', null,
          h('div', { className: 'yx-ok-hero' },
            h('span', { className: 'yx-ok-badge' }, h(SvgIcon, { d: ICON_CHECK, size: 22 })),
            h('span', { className: 'yx-ok-h' }, '对方的符已合上'),
            peer ? h('span', { className: 'yx-mono' }, '对方身份 ' + peer.slice(0, 16)) : null,
          ),
          h('div', { className: 'yx-ok' },
            h('span', { className: 'yx-ok-mark' }, '✓'),
            h('span', null, '我已合他：对方的票已写进本机信任名单'),
          ),
          h('div', { className: 'yx-ok wait' },
            h('span', { className: 'yx-ok-mark' }, '…'),
            h('span', null, '已自动通知对方：他开着 DSH 就会收到并加你；他离线就下次点他好友行时补推'),
          ),
          h('div', { className: 'yx-muted', style: { marginTop: '4px' } }, '对方一加回来，就会出现在「好友」里（列表每 15 秒自己刷新）。'),
        );
      }

      let primary = null;
      if (pane === 1) primary = h('button', { className: 'yx-btn yx-btn-primary yx-ft-btn', onClick: () => { setErr(''); setPane(2); } }, '去合符');
      else if (pane === 2) primary = h('button', { className: 'yx-btn yx-btn-primary yx-ft-btn', disabled: busy, onClick: join }, busy ? '验证中…' : '验证并添加');
      else if (pane === 3) primary = h('button', { className: 'yx-btn yx-btn-primary yx-ft-btn', onClick: onClose }, '完成');

      const overlay = h('div', {
        className: 'yx-ov',
        onClick: (e) => { if (e.target === e.currentTarget) onClose(); },
      },
        h('div', { className: 'yx-ask' },
          h('div', { className: 'yx-ask-hd' },
            h('div', { className: 'yx-hd-tx' },
              h('div', { className: 'yx-ask-title' }, ASK_TITLES[pane]),
              h('div', { className: 'yx-ask-sub' }, ASK_SUBS[pane]),
            ),
            h('button', { className: 'yx-ask-x', title: '关闭', onClick: onClose }, '✕'),
          ),
          h('div', { className: 'yx-ask-bd' }, body),
          pane === 0 ? null : h('div', { className: 'yx-ask-ft' },
            pane < 3
              ? h('button', { className: 'yx-btn', onClick: () => { setErr(''); setNote(''); setPane(0); } }, '返回')
              : null,
            h('span', { className: 'yx-hint' }, pane === 3 ? '随时可以在面板里再点一次' : ''),
            primary,
          ),
        ),
      );

      if (typeof document === 'undefined' || !reactDom?.createPortal) return overlay;
      return reactDom.createPortal(overlay, document.body);
    }

    /** 侧栏里的群行：群头像 + 群名 + 人数。 */
    function GroupRow({ group, onOpen }) {
      const members = Array.isArray(group.members) ? group.members : [];
      const last = group.last;
      const who = last ? (last.mine ? '我' : (last.fromName || '有人')) : '';
      const preview = last ? `${who}：${last.text}` : '还没有消息';
      return h('div', { className: 'yx-item' },
        h('div', {
          className: 'yx-row',
          title: `${group.name} · ${members.length} 人\n${preview}`,
          onClick: () => onOpen(group),
        },
          h(GroupAvatar, { members }),
          h('span', { className: 'yx-nm' }, group.name),
          h('span', { className: 'yx-tag' }, `${members.length} 人`),
          group.unread ? h('span', { className: 'yx-un', title: `${group.unread} 条未读` }, group.unread > 99 ? '99+' : String(group.unread)) : null,
        ),
      );
    }

    function FriendList({ ctx }) {
      const [state, setState] = useState({ loading: true, error: '', friends: [] });
      const [hint, setHint] = useState('');
      const [profiles, setProfiles] = useState(loadProfiles);
      const [editingKey, setEditingKey] = useState(null);
      const [addOpen, setAddOpen] = useState(false);
      const [botOpen, setBotOpen] = useState(false);
      const [bots, setBots] = useState(() => loadBots());
      const [seq, setSeq] = useState(0);   // 合符成功后 +1，立刻重读一次列表
      const [me, setMe] = useState(loadMe);
      const [meOpen, setMeOpen] = useState(false);
      const [groups, setGroups] = useState([]);
      const [groupOpen, setGroupOpen] = useState(false);

      // 账号兜底：没设过名片（或只自动填过、用户没动过），就拿 DSH 登录账号的名字头像填上。
      // 只读一次，失败了就一直用 hostId 占位，不影响任何功能。
      useEffect(() => {
        let alive = true;
        void imApi('accountCard').then((card) => {
          if (!alive || !card || (!card.name && !card.avatar)) return;
          setMe((prev) => {
            if (prev.name && prev.auto !== true) return prev;   // 用户自己填过，不覆盖
            const next = {
              name: card.name || prev.name || '',
              avatar: card.avatar || prev.avatar || '',
              auto: true,
            };
            if (next.name === prev.name && next.avatar === prev.avatar) return prev;
            saveMe(next);
            return next;
          });
        }).catch(() => { /* 没登录账号就退回占位 */ });
        return () => { alive = false; };
      }, []);

      const putMe = (value) => {
        const next = { name: value.name || '', avatar: value.avatar || '', auto: false };
        setMe(next);
        saveMe(next);
      };

      const setProfile = (key, value) => {
        setProfiles((prev) => {
          const next = { ...prev };
          if (value) next[key] = value; else delete next[key];
          saveProfiles(next);
          return next;
        });
      };

      useEffect(() => {
        let alive = true;
        let controller = null;
        const load = async () => {
          try { controller?.abort(); } catch { /* ignore */ }
          controller = new AbortController();
          try {
            const [friends, gs, digest] = await Promise.all([
              loadFriends(controller.signal),
              loadGroups(controller.signal),
              imApi('digest', {}, controller.signal).catch(() => null),
            ]);
            if (!alive) return;
            const peers = digest?.peers || {};
            const gboxes = digest?.groups || {};
            const read = loadRead();
            let dirty = false;
            // 第一次见到的会话，水位直接对齐当前条数（不补历史红点）
            for (const [id, one] of Object.entries(peers)) {
              const key = 'peer:' + id;
              if (!Number.isFinite(read[key])) { read[key] = Number(one?.total) || 0; dirty = true; }
            }
            for (const [id, one] of Object.entries(gboxes)) {
              const key = 'group:' + id;
              if (!Number.isFinite(read[key])) { read[key] = Number(one?.total) || 0; dirty = true; }
            }
            // 浮层正开着的那个算已读 —— 消息就在眼前，再标红没道理
            if (floatWin) {
              const isGroup = floatWin.kind === 'group';
              const key = isGroup ? 'group:' + floatWin.group : 'peer:' + floatWin.peer;
              const box = isGroup ? gboxes[floatWin.group] : peers[floatWin.peer];
              const total = Number(box?.total);
              if (Number.isFinite(total) && read[key] !== total) { read[key] = total; dirty = true; }
            }
            if (dirty) saveRead(read);
            const withUnread = (list, kind) => list.map((one) => {
              const id = kind === 'peer' ? one.hostId : one.id;
              const box = kind === 'peer' ? peers[id] : gboxes[id];
              const n = box ? unreadOf(read, kind + ':' + id, Number(box.total) || 0) : 0;
              return n > 0 ? { ...one, unread: n } : one;
            });
            setState({ loading: false, error: '', friends: withUnread(friends, 'peer') });
            setGroups(withUnread(gs, 'group'));
            // 聊天窗指着的会话已经不在了（自己解散 / 群主踢人 / 好友删了 / 对方解散）——
            // 浮层立刻收回，别在右下角留一个对着空气说话的窗口。
            if (floatWin) {
              const gone = floatWin.kind === 'group'
                ? !gs.some((one) => String(one?.id) === floatWin.group)
                : !friends.some((one) => String(one?.hostId) === floatWin.peer);
              if (gone) closeFloatChat();
            }
          } catch (err) {
            if (!alive || controller.signal.aborted) return;
            setState((prev) => ({ ...prev, loading: false, error: err?.message || '读取失败' }));
          }
        };
        load();
        const timer = setInterval(load, POLL_MS);
        return () => { alive = false; clearInterval(timer); try { controller?.abort(); } catch { /* ignore */ } };
      }, [seq]);

      // 群里改完东西（解散 / 踢人 / 改名）立刻重读一次，别让旧条目赖在列表上。
      useEffect(() => {
        const fn = () => setSeq((n) => n + 1);
        listSubs.add(fn);
        return () => { listSubs.delete(fn); };
      }, []);

      const { loading, error, friends } = state;

      // 点好友 = 弹一个浮层聊天窗，不再抢主区。
      // 消息走 weave 点对点（dsh-im/1），不需要建塘、不需要邀请、不需要成员表，
      // 也就不需要为了聊天专门建一条 DSH 会话。
      const openPeer = async (row) => {
        setHint('');
        // 每次点好友都补推一次我的票：上次对方可能离线，单向加好友没落地。
        void imApi('announce', { hostId: row.hostId, card: cardForSend() }).catch(() => { /* 离线就算了 */ });
        openFloatChat(row.hostId, displayName(row, profiles[row.key]));
        setSeq((n) => n + 1);   // 打开就算读过，角标立刻清
      };

      // 点群 = 同一个浮层，只是换成群聊形态（气泡带头像昵称）。
      const openGroup = (g) => {
        setHint('');
        openGroupChat(g.id, g.name || '群聊');
        setSeq((n) => n + 1);
      };

      // 点智能体 = 打开它的真实会话（第一次点才建）。会话落在「智能体」工作区，聊天全走官方界面。
      const openBot = async (bot) => {
        setHint('');
        try {
          const sessionId = await ensureBotSession(bot);
          if (!sessionId) { setHint('会话没建起来，看终端有没有报错。'); return; }
          if (!bot.sessionId) {
            const next = bots.map((one) => (one.id === bot.id ? { ...one, sessionId } : one));
            setBots(next);
            saveBots(next);
          }
          openSession(ctx, sessionId);
        } catch (err) {
          setHint(err?.message || '会话没建起来');
        }
      };

      let body;
      if (loading) body = h('div', { className: 'yx-state' }, '正在读取好友…');
      else if (error) body = h('div', { className: 'yx-state yx-bad' }, `读取失败：${error}`);
      else {
        body = h('div', { className: 'yx-list' },
          // 智能体永远在最上面：本机的东西，不走配对符、不出网络
          h('div', { className: 'yx-sec' }, '智能体',
            bots.length ? h('span', { className: 'yx-sec-n' }, String(bots.length)) : null,
            h('button', { className: 'yx-sec-add', title: '添加智能体', onClick: () => setBotOpen(true) }, '＋')),
          bots.map((bot) => h('div', { key: bot.id, className: 'yx-item' },
            h('div', {
              className: 'yx-row',
              title: bot.name + ' · 智能体 · 点开跟它聊',
              onClick: () => openBot(bot),
            },
              h(Avatar, { name: bot.name, avatar: bot.avatar || '' }),
              h('span', { className: 'yx-nm' }, bot.name),
              h('span', { className: 'yx-tag' }, '智能体'),
            ),
          )),
          h('div', { className: 'yx-sec' }, '群聊',
            groups.length ? h('span', { className: 'yx-sec-n' }, String(groups.length)) : null,
            h('button', { className: 'yx-sec-add', title: '发起群聊', onClick: () => setGroupOpen(true) }, '＋')),
          groups.length
            ? groups.map((g) => h(GroupRow, { key: g.id, group: g, onOpen: openGroup }))
            : h('div', { className: 'yx-state' }, '还没有群。点「群聊」右边的 ＋ 拉几个人。'),
          h('div', { className: 'yx-sec' }, '好友',
            friends.length ? h('span', { className: 'yx-sec-n' }, String(friends.length)) : null,
            h('button', { className: 'yx-sec-add', title: '添加好友', onClick: () => setAddOpen(true) }, '＋')),
          friends.length
            ? friends.map((row) => h(Row, {
              key: row.key, ctx, row,
              profile: profiles[row.key], editing: editingKey === row.key,
              onEdit: setEditingKey, onProfile: setProfile, onOpen: openPeer,
              onDeleted: () => setSeq((n) => n + 1),
            }))
            : h('div', { className: 'yx-state' }, '还没有好友。点「好友」右边的 ＋，铸一张符发给对方。'),
        );
      }

      return h('div', { className: 'yx-root' },
        // 「我」：加好友之后，对端看到的名字头像就是这张名片。
        h('div', {
          className: 'yx-me',
          title: '点一下改我的名字和头像 —— 加成功的好友看到的就是它',
          onClick: () => setMeOpen(true),
        },
          h(Avatar, { name: me.name || '我', avatar: me.avatar || '' }),
          h('span', { className: 'yx-me-nm' }, me.name || '我'),
          me.auto && (me.name || me.avatar)
            ? h('span', { className: 'yx-me-tag' }, '账号')
            : (me.name || me.avatar) ? null : h('span', { className: 'yx-me-tag' }, '去设置'),
        ),
        meOpen
          ? h(MeCardModal, {
            me,
            onSave: putMe,
            onClose: () => setMeOpen(false),
          })
          : null,
        hint ? h('div', { className: 'yx-tst' }, hint) : null,
        body,
        groupOpen
          ? h(CreateGroupModal, {
            friends,
            bots,
            onClose: () => setGroupOpen(false),
            onCreated: (g) => {
              setGroupOpen(false);
              setSeq((n) => n + 1);
              setHint(`「${g.name}」建好了，点它开聊。`);
              openGroupChat(g.id, g.name);
            },
          })
          : null,
        botOpen
          ? h(AddBotModal, {
            ctx,
            bots,
            onClose: () => setBotOpen(false),
            onCreated: (bot) => {
              const next = bots.concat([bot]);
              setBots(next);
              saveBots(next);
              setBotOpen(false);
              setHint(`「${bot.name}」建好了，点它就能开聊。`);
            },
          })
          : null,
        addOpen
          ? h(AddFriendModal, {
            onClose: () => setAddOpen(false),
            onAdded: () => setSeq((n) => n + 1),
          })
          : null,
      );
    }

    // ---------- 段 6 · 方案 B：鱼信自己的会话界面（正文 + 输入框全接管） ----------
    // 为什么必须自己画：点好友进的那条会话 id 是 dsh-im-chat-<hostId>，我们建的，
    // 会话体内没有 chat/room-link 事件，官方 dsh-chat 的 roomNode() 认不出来，
    // 它的 RoomTimeline / RoomComposer 都不会挂上来 —— 用户看到的就是一个空会话。
    //
    // 注册方式照抄官方 dsh-chat/lib/client.js:526-546 的两处：
    //   ① conversation.chat.node（keyed）→ 正文
    //   ② conversation.composer（chain, priority, select）→ 输入框
    // 两个槽都由官方声明（conversation.content / conversation.chat.flow），
    // 我们 inject 只为等槽出现，槽一旦就绪就挂上自己的正文与输入框。
    const NODE_KEY = 'dsh-im-chat';
    // 聊天成员名：官方会话行的标题（本地备注名已经在列表里改过，这里读官方的显示名）
    function sessionTitle(ctx, sessionId) {
      try {
        const row = ctx?.sessions?.list?.getSnapshot?.()?.byId?.[sessionId];
        return row?.displayTitle ?? row?.title ?? '';
      } catch { return ''; }
    }

    /**
     * 把新拉到的消息并进旧列表。
     * 增量拉是为了少传数据，但 since 用的是 >=（同一毫秒两条时宁可多传一条），
     * 所以合并本身必须按 id 去重。
     */
    function mergeMessages(oldList, addList) {
      const list = Array.isArray(oldList) ? oldList.slice() : [];
      const seen = new Set(list.map((m) => m?.id));
      for (const m of Array.isArray(addList) ? addList : []) {
        if (!m || seen.has(m.id)) continue;
        seen.add(m.id);
        list.push(m);
      }
      list.sort((a, b) => (Number(a?.at) || 0) - (Number(b?.at) || 0));
      return list;
    }

    function clockOf(ts) {
      const n = Number(ts);
      if (!Number.isFinite(n)) return '';
      const d = new Date(n);
      const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      // 今天只给时间，跨天补日期 —— 否则隔夜翻记录分不清哪天说的。
      const now = new Date();
      const sameDay = d.getFullYear() === now.getFullYear()
        && d.getMonth() === now.getMonth()
        && d.getDate() === now.getDate();
      if (sameDay) return hm;
      const md = `${d.getMonth() + 1}月${d.getDate()}日`;
      return d.getFullYear() === now.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}年${md} ${hm}`;
    }

    // 正文：气泡流。自己的消息靠右，对方靠左。
    // 数据源是本插件自己的 store（index.js 落盘 messages.json），走 weave 点对点，
    // 不再读上游房间，也不需要成员表。
    function YuxinTimeline({ sessionId, ctx, peerOverride, peerLabel, headless }) {
      const [state, setState] = useState({ messages: [], loaded: false, error: '', dropped: 0 });
      const me = String(sessionId || '');
      const peer = peerOverride || peerOfSession(me);

      useEffect(() => {
        if (!peer) return undefined;
        const controller = new AbortController();
        const signal = controller.signal;
        let timer = null;
        let since = 0;
        setState((prev) => ({ ...prev, messages: [], loaded: false, error: '', dropped: 0 }));

        const poll = async () => {
          try {
            const box = await imApi('messages', { hostId: peer, since }, signal);
            if (!signal.aborted) {
              const fresh = Array.isArray(box?.messages) ? box.messages : [];
              setState((prev) => ({
                messages: since > 0 ? mergeMessages(prev.messages, fresh) : fresh,
                loaded: true,
                error: '',
                dropped: Number(box?.dropped) || 0,
              }));
              // 首轮是全量，把水位顶到最新一条；之后每秒只拉新增的几条。
              const lastAt = Number(fresh[fresh.length - 1]?.at) || 0;
              if (!since) since = lastAt;
              else if (lastAt > since) since = lastAt;
            }
          } catch (err) {
            if (!signal.aborted) setState((prev) => ({ ...prev, loaded: true, error: err?.message || '消息读不出来' }));
          } finally {
            if (!signal.aborted) timer = setTimeout(poll, 1000);
          }
        };

        void poll();
        return () => { controller.abort(); if (timer) clearTimeout(timer); };
      }, [peer]);

      const peerName = peerLabel || (peer ? '好友 ' + peer.slice(0, 8) : '对方');
      const title = sessionTitle(ctx, me) || peerName;

      const rows = state.messages.map((message) => {
        const mine = Boolean(message?.mine);
        const at = Number(message?.at) || 0;
        return h('div', { key: message?.id || `${at}:${message?.text}`, className: 'yx-msg' + (mine ? ' mine' : '') },
          h('div', { className: 'yx-msg-meta' },
            h('span', { className: 'yx-msg-who' }, mine ? '我' : peerName),
            h('time', { dateTime: new Date(at).toISOString() }, clockOf(at)),
          ),
          h('div', { className: 'yx-bubble' }, String(message?.text ?? '')),
        );
      });

      return h('div', { className: 'yx-chat', 'data-dsh-chat-room-timeline': '', 'data-session': me },
        headless ? null : h('div', { className: 'yx-chat-hd' },
          h('div', { className: 'yx-chat-title' }, title),
          h('div', { className: 'yx-chat-sub' },
            peer ? `点对点 · 对端 ${peer.slice(0, 8)}` : '这不是鱼信的对话会话',
          ),
        ),
        state.error ? h('div', { className: 'yx-chat-err' }, state.error) : null,
        state.dropped ? h('div', { className: 'yx-chat-note' }, `更早的 ${state.dropped} 条已自动清理`) : null,
        h('div', { className: 'yx-chat-body' },
          rows.length
            ? rows
            : h('div', { className: 'yx-state' },
              !state.loaded ? '正在读消息…'
                : peer ? '还没有消息。说句话试试，对方在线就能收到。'
                  : '这不是鱼信的对话会话。回鱼信列表点一下好友重开。'),
        ),
      );
    }

    /**
     * 群聊正文。和私聊不同：气泡旁边要带上说话人，不然一群人说话分不清谁是谁。
     * 数据只读本机 groups.json —— 群消息是各自存的，本机这个群没有的消息就是没有。
     */
    function GroupTimeline({ groupId, headless }) {
      const [state, setState] = useState({ group: null, loaded: false, error: '', dropped: 0 });

      useEffect(() => {
        if (!groupId) return undefined;
        const controller = new AbortController();
        let timer = null;
        let since = 0;
        setState({ group: null, loaded: false, error: '', dropped: 0 });

        const poll = async () => {
          try {
            const g = await imApi('group', { groupId, since }, controller.signal);
            if (!controller.signal.aborted) {
              const fresh = Array.isArray(g?.messages) ? g.messages : [];
              const inc = since > 0;
              setState((prev) => ({
                group: inc && prev.group
                  ? { ...g, messages: mergeMessages(prev.group.messages, fresh) }
                  : g,
                loaded: true,
                error: '',
                dropped: Number(g?.dropped) || 0,
              }));
              // 首轮全量，之后只拉新增 —— 群里消息多了以后每秒重传整串太浪费。
              const lastAt = Number(fresh[fresh.length - 1]?.at) || 0;
              if (!since) since = lastAt;
              else if (lastAt > since) since = lastAt;
            }
          } catch (err) {
            if (!controller.signal.aborted) {
              setState((prev) => ({ ...prev, loaded: true, error: err?.message || '群消息读不出来' }));
            }
          } finally {
            if (!controller.signal.aborted) timer = setTimeout(poll, 1000);
          }
        };

        void poll();
        return () => { controller.abort(); if (timer) clearTimeout(timer); };
      }, [groupId]);

      const g = state.group;
      const members = Array.isArray(g?.members) ? g.members : [];
      const msgs = Array.isArray(g?.messages) ? g.messages : [];

      const rows = msgs.map((m) => {
        const mine = Boolean(m.mine);
        const known = members.find((one) => one.id === m.from);
        const who = mine ? '我'
          : String(m.fromName || '').trim()
            || (known ? (known.name || known.id.slice(0, 8)) : '')
            || (m.from ? String(m.from).slice(0, 8) : '有人');
        const at = Number(m.at) || 0;
        return h('div', { key: m.id || `${at}:${m.text}`, className: 'yx-msg' + (mine ? ' mine' : '') },
          h('div', { className: 'yx-msg-meta' },
            mine ? null : h('i', {
              className: 'yx-msg-av',
              style: { background: identityColor(who) },
            }, initial(who)),
            h('span', { className: 'yx-msg-who' }, who),
            h('time', { dateTime: new Date(at).toISOString() }, clockOf(at)),
          ),
          h('div', { className: 'yx-bubble' }, String(m.text ?? '')),
        );
      });

      return h('div', { className: 'yx-chat', 'data-dsh-chat-room-timeline': '', 'data-group': groupId },
        headless ? null : h('div', { className: 'yx-chat-hd' },
          h('div', { className: 'yx-chat-title' }, g?.name || '群聊'),
          h('div', { className: 'yx-chat-sub' }, `${members.length} 人 · 点对点直连`),
        ),
        state.error ? h('div', { className: 'yx-chat-err' }, state.error) : null,
        state.dropped ? h('div', { className: 'yx-chat-note' }, `更早的 ${state.dropped} 条已自动清理`) : null,
        h('div', { className: 'yx-chat-body' },
          rows.length
            ? rows
            : h('div', { className: 'yx-state' },
              !state.loaded ? '正在读群消息…' : '还没有消息。说句话试试，在线的人都能收到。'),
        ),
      );
    }

    // 输入框：全接管。发送直接走本插件的 /api/dsh-im → weave 点对点，
    // 不需要房间、不需要 mentions、不需要先解出 roomId。
    function YuxinComposer({ matched, peerOverride, peerLabel, groupId, groupName }) {
      const [draft, setDraft] = useState('');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const sessionId = String(matched?.sessionId || '');
      const me = sessionId;
      const peer = peerOverride || peerOfSession(me);
      const isGroup = Boolean(groupId);

      const send = async (event) => {
        if (event) event.preventDefault();
        const text = draft.trim();
        if (!text || busy) return;
        if (!isGroup && !peer) return;
        setBusy(true); setError('');
        try {
          if (isGroup) await imApi('groupSend', { groupId, text, card: cardForSend() });
          else await imApi('send', { hostId: peer, text, card: cardForSend() });
          setDraft('');
        } catch (err) {
          setError(err?.message || '没发出去');
        } finally {
          setBusy(false);
        }
      };

      // 占位按「对方是谁」来说，不拿会话标题当名字 ——
      // 会话标题是「与 X 的对话」，直接塞进会变成「发送消息至 与 X 的对话」。
      const whoLabel = isGroup
        ? (groupName || '群聊')
        : peerLabel || sessionTitle(matched?.ctx, me) || (peer ? '好友 ' + peer.slice(0, 8) : '');
      const ready = isGroup || Boolean(peer);
      const canSend = ready && !busy && Boolean(draft.trim());

      return h('form', { className: 'yx-comp', onSubmit: send },
        error ? h('div', { className: 'yx-comp-err' }, error) : null,
        h('div', { className: 'yx-comp-card' },
          h('textarea', {
            className: 'yx-comp-ta',
            value: draft,
            rows: 2,
            'aria-label': `发消息给 ${whoLabel || '对方'}`,
            placeholder: ready ? `发消息给 ${whoLabel || '对方'}` : '这不是鱼信的对话会话',
            disabled: !ready || busy,
            onChange: (e) => setDraft(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent?.isComposing) { e.preventDefault(); void send(); }
            },
          }),
          h('div', { className: 'yx-comp-ft' },
            h('span', { className: 'yx-comp-hint' },
              h('span', { className: 'yx-comp-at', 'aria-hidden': true }, '@'),
              'Enter 发送 · Shift+Enter 换行'),
            h('button', {
              type: 'submit',
              className: 'yx-comp-send' + (canSend ? ' on' : ''),
              'aria-label': '发送',
              disabled: !canSend,
            }, busy ? '…' : '↑'),
          ),
        ),
      );
    }

    // ---------- 段 7 · 浮层聊天窗：点好友直接开小窗，主区不动 ----------
    // 和主区那条会话共用同一份数据（imApi messages/send → weave 点对点），
    // 两边同时开着看到的也是一样的消息。
    const FLOAT_GEO_KEY = 'dsh-yuxin.float-geo';
    const FLOAT_W = 384;
    const FLOAT_H = 540;
    const FLOAT_MIN_W = 300;
    const FLOAT_MIN_H = 340;

    let floatWin = null;                       // { kind:'peer'|'group', peer?, group?, name } | null
    // 列表刷新订阅：群操作改完立即重读，不等 15 秒轮询。
    const listSubs = new Set();
    const listNotify = () => {
      listSubs.forEach((fn) => { try { fn(); } catch (err) { console.warn('[yuxin] 列表刷新回调出错', err); } });
    };
    const floatSubs = new Set();
    const floatNotify = () => {
      floatSubs.forEach((fn) => { try { fn(); } catch (err) { console.warn('[yuxin] 浮层订阅回调出错', err); } });
    };
    function openFloatChat(peer, name) {
      if (!peer) return;
      floatWin = { kind: 'peer', peer: String(peer), name: String(name || '').trim() };
      floatNotify();
    }
    function openGroupChat(groupId, name) {
      if (!groupId) return;
      floatWin = { kind: 'group', group: String(groupId), name: String(name || '').trim() };
      floatNotify();
    }
    function closeFloatChat() { floatWin = null; floatNotify(); }

    function useFloatWin() {
      const [win, setWin] = useState(() => floatWin);
      useEffect(() => {
        const fn = () => setWin(floatWin);
        floatSubs.add(fn); fn();
        return () => { floatSubs.delete(fn); };
      }, []);
      return win;
    }

    function loadGeo() {
      try {
        const raw = localStorage.getItem(FLOAT_GEO_KEY);
        const one = raw ? JSON.parse(raw) : null;
        if (one && Number.isFinite(one.w) && Number.isFinite(one.h)) {
          return {
            w: Math.max(FLOAT_MIN_W, Number(one.w)),
            h: Math.max(FLOAT_MIN_H, Number(one.h)),
            x: Number.isFinite(one.x) ? Number(one.x) : null,
            y: Number.isFinite(one.y) ? Number(one.y) : null,
          };
        }
      } catch { /* 隐私模式忽略 */ }
      return { w: FLOAT_W, h: FLOAT_H, x: null, y: null };
    }
    function saveGeo(geo) {
      try { localStorage.setItem(FLOAT_GEO_KEY, JSON.stringify(geo)); } catch { /* ignore */ }
    }

    function YuxinFloat({ win }) {
      const [geo, setGeo] = useState(loadGeo);
      const [min, setMin] = useState(false);
      const [drag, setDrag] = useState(null);
      const [infoOpen, setInfoOpen] = useState(false);
      const [bump, setBump] = useState(0);      // 群详情里改完东西 +1，让时间线重读

      // 群公告：只读一次，详情页改完（bump+1）再读。since=now 是为了只要公告，
      // 别把整条群历史又拉一遍 —— readGroup 的 since 只过滤消息，别的字段照回。
      const [ann, setAnn] = useState('');
      useEffect(() => {
        const gid = win?.kind === 'group' ? win.group : '';
        if (!gid) { setAnn(''); return undefined; }
        let alive = true;
        const ctrl = new AbortController();
        imApi('group', { groupId: gid, since: Date.now() }, ctrl.signal)
          .then((one) => { if (alive) setAnn(String(one?.announce || '')); })
          .catch(() => { /* 读不到就不显示，不打扰 */ });
        return () => { alive = false; try { ctrl.abort(); } catch { /* ignore */ } };
      }, [win?.kind, win?.group, bump]);

      // 拖动：只在标题栏按下才动。第一次拖动时把 right/bottom 定位换成 left/top。
      const onHeadDown = (event) => {
        if (event.button !== 0) return;
        if (event.target && event.target.closest && event.target.closest('.yx-float-btn')) return;
        const box = event.currentTarget.parentElement?.getBoundingClientRect?.();
        if (!box) return;
        event.preventDefault();
        setDrag({ dx: event.clientX - box.left, dy: event.clientY - box.top });
      };

      useEffect(() => {
        if (!drag) return undefined;
        const move = (event) => {
          const x = Math.max(0, Math.min(window.innerWidth - 120, event.clientX - drag.dx));
          const y = Math.max(0, Math.min(window.innerHeight - 60, event.clientY - drag.dy));
          setGeo((prev) => ({ ...prev, x, y }));
        };
        const up = () => {
          setDrag(null);
          setGeo((prev) => { saveGeo(prev); return prev; });
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        return () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
      }, [drag]);

      // 右下角改大小
      const onResizeDown = (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const sx = event.clientX;
        const sy = event.clientY;
        const sw = geo.w;
        const sh = geo.h;
        const move = (e) => {
          setGeo((prev) => ({
            ...prev,
            w: Math.max(FLOAT_MIN_W, sw + (e.clientX - sx)),
            h: Math.max(FLOAT_MIN_H, sh + (e.clientY - sy)),
          }));
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          setGeo((prev) => { saveGeo(prev); return prev; });
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      };

      if (!win) return null;

      const isGroup = win.kind === 'group';
      const name = win.name || (isGroup ? '群聊' : '好友 ' + String(win.peer || '').slice(0, 8));
      // 骨架走内联：样式表万一没跟上（插件热重载），浮层至少还是个正经的浮动卡片，
      // 不会塌成文档流里的一坨贴在左上角。
      const box = {
        position: 'fixed',
        zIndex: 3000,
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        minWidth: FLOAT_MIN_W + 'px',
        border: '1px solid var(--dsw-alias-border-l2,#3a4252)',
        borderRadius: '14px',
        background: 'var(--dsw-alias-bg-layer-1,#161a22)',
        boxShadow: '0 18px 48px rgba(0,0,0,.45), 0 2px 8px rgba(0,0,0,.3)',
        overflow: 'hidden',
        fontSize: '13px',
      };
      if (geo.x == null) { box.right = '24px'; box.bottom = '24px'; }
      else { box.left = geo.x + 'px'; box.top = geo.y + 'px'; }
      if (min) { box.minHeight = '0' } else { box.width = geo.w + 'px'; box.height = geo.h + 'px'; box.minHeight = FLOAT_MIN_H + 'px'; }

      return h('div', {
        className: 'yx-float' + (min ? ' min' : ''),
        style: box,
        role: 'dialog',
        'aria-label': isGroup ? '群聊 ' + name : '与 ' + name + ' 的对话',
        'data-peer': isGroup ? undefined : win.peer,
        'data-group': isGroup ? win.group : undefined,
      },
        h('div', {
          className: 'yx-float-hd',
          onPointerDown: onHeadDown,
          style: {
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'center',
            gap: '9px',
            padding: '9px 8px 9px 11px',
            borderBottom: '1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.07))',
            background: 'var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04))',
            cursor: 'grab',
            userSelect: 'none',
            touchAction: 'none',
          },
        },
          h('span', { className: 'yx-float-nm' }, name),
          isGroup
            ? h('button', {
              type: 'button',
              className: 'yx-float-sub yx-float-link',
              title: '群详情 · 成员 · 退群',
              onClick: () => setInfoOpen(true),
            }, '详情')
            : h('span', { className: 'yx-float-sub' }, String(win.peer || '').slice(0, 8)),
          h('button', {
            type: 'button',
            className: 'yx-float-btn',
            title: min ? '展开' : '收起',
            'aria-label': min ? '展开' : '收起',
            onClick: () => setMin((v) => !v),
          }, min ? '▫' : '—'),
          h('button', {
            type: 'button',
            className: 'yx-float-btn',
            title: '关闭',
            'aria-label': '关闭',
            onClick: () => closeFloatChat(),
          }, '✕'),
        ),
        min ? null : h('div', {
          className: 'yx-float-o',
          style: { flex: '1 1 auto', minHeight: '0', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
        },
          isGroup && ann
            ? h('div', {
              className: 'yx-ann-bar',
              title: '群公告 · 点开看详情',
              onClick: () => setInfoOpen(true),
            },
              h('span', { className: 'yx-ann-k' }, '公告'),
              h('span', { className: 'yx-ann-tx' }, ann),
            )
            : null,
          isGroup
            ? h(GroupTimeline, { key: bump, groupId: win.group, headless: true })
            : h(YuxinTimeline, { sessionId: '', ctx: null, peerOverride: win.peer, peerLabel: name, headless: true }),
          isGroup
            ? h(YuxinComposer, { groupId: win.group, groupName: name })
            : h(YuxinComposer, { matched: { sessionId: '', ctx: null }, peerOverride: win.peer, peerLabel: name }),
        ),
        min ? null : h('div', { className: 'yx-float-rz', onPointerDown: onResizeDown, 'aria-hidden': true }),
        infoOpen && isGroup
          ? h(GroupInfoModal, {
            groupId: win.group,
            onClose: () => setInfoOpen(false),
            // 浮层里重读时间线与公告，同时把外面的列表也刷一遍（解散后要立即消失）
            onChanged: () => { setBump((n) => n + 1); listNotify(); },
          })
          : null,
      );
    }

    // 浮层宿主：挂到 shell.overlay（root 级浮动层），切页签、收侧栏都不影响它。
    function YuxinFloatHost() {
      const win = useFloatWin();
      return h(YuxinFloat, { win });
    }

    // 会话 id → 输入框需要的信息。只能同步拿 sessionId；
    // 房间、成员、收件人全部在 YuxinComposer 里异步补齐。
    function matchComposer(ctx, owner) {
      const sessionId = String(owner?.sessionId || '');
      if (!sessionId.startsWith(CHAT_PREFIX)) return null;
      return { sessionId, ctx };
    }

    // ---------- 段 4 · 独立页签：自己包官方会话栏，产出「任务 | 鱼信」 ----------
    // 不依赖任何第三方插件：官方本身没有左栏页签机制，我们自己在 sidebar.workspaces 上造一条。
    const TAB_KEY = 'dsh-yuxin.sidebar-tab';
    const TASKS_ID = 'tasks';

    let mountedShell = null;    // { entry, original, shell, registry }
    let ownTabRemove = null;    // 插到别家注册表里的自己的页签
    let foreignRegistry = null;

    function workspacesEntries(ctx) {
      const read = ctx.slots.entriesOfSlot || ctx.slots.entries;
      return (read && read.call(ctx.slots, 'sidebar.workspaces')) || [];
    }

    function registryOf(entry) {
      const target = entry && (entry.component ?? entry);
      const registry = target && target.__dshNativeTabs;
      if (registry && registry.version === 1
        && typeof registry.insert === 'function'
        && typeof registry.getTabs === 'function'
        && typeof registry.subscribe === 'function') return registry;
      return null;
    }

    // 只认没被任何插件包过的官方组件，绝不包在别人的壳外面
    function pickOfficial(ctx) {
      return workspacesEntries(ctx).find((entry) => {
        const component = entry && entry.component;
        return !!component
          && !component.__dshNativeTabHost
          && !component.__dshNativeTabWrapped
          && !component.__imConnectWrapped;
      }) || null;
    }

    // 与既有预览版同构（version 1）：别家插件插进来也能正常跑
    function createRegistry(officialTree) {
      const tabs = new Map();
      const listeners = new Set();
      const sessionFilters = [];
      const sessionOpeners = [];
      let cached = [];
      let revision = 0;
      const rebuild = () => { cached = [...tabs.values()].sort((a, b) => (a.order || 0) - (b.order || 0)); };
      const emit = () => {
        revision += 1;
        listeners.forEach((fn) => { try { fn(); } catch (err) { console.warn('[yuxin] 页签订阅回调出错', err); } });
      };
      return {
        version: 1,
        officialTree,
        sessionFilters,
        sessionOpeners,
        getTabs: () => cached,
        getRevision: () => revision,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        insert(tab) {
          if (!tab || !tab.id) return () => {};
          tabs.set(tab.id, tab);
          rebuild(); emit();
          return () => {
            if (tabs.get(tab.id) !== tab) return;
            tabs.delete(tab.id); rebuild(); emit();
          };
        },
        addSessionFilter(filter) {
          sessionFilters.push(filter); emit();
          return () => { const i = sessionFilters.indexOf(filter); if (i >= 0) sessionFilters.splice(i, 1); emit(); };
        },
        addSessionOpener(opener) {
          sessionOpeners.push(opener); emit();
          return () => { const i = sessionOpeners.indexOf(opener); if (i >= 0) sessionOpeners.splice(i, 1); emit(); };
        },
      };
    }

    function TabStrip({ tabs, value, onChange }) {
      return h('div', { className: 'yx-strip', role: 'tablist', 'aria-label': '任务与鱼信' },
        tabs.map((item) => h('button', {
          key: item.id,
          type: 'button',
          role: 'tab',
          'aria-selected': value === item.id,
          className: value === item.id ? 'yx-strip-btn on' : 'yx-strip-btn',
          onClick: () => onChange(item.id),
        }, item.label || item.id)),
      );
    }

    function makeShell(officialTree, registry, ctx) {
      function YuxinWorkspaces(props) {
        const [tab, setTab] = useState(() => {
          try { return localStorage.getItem(TAB_KEY) || TASKS_ID; } catch { return TASKS_ID; }
        });
        const [tabs, setTabs] = useState(() => registry.getTabs());

        useEffect(() => registry.subscribe(() => setTabs(registry.getTabs())), []);
        useEffect(() => { try { localStorage.setItem(TAB_KEY, tab); } catch { /* 隐私模式忽略 */ } }, [tab]);

        // 侧栏收起成窄条时交回官方，别把官方布局挤坏
        if (props.wide === false) return h(officialTree, props);

        const list = tabs.length ? tabs : [{ id: TASKS_ID, label: '任务', order: 10 }];
        const active = list.find((item) => item.id === tab) || list[0];

        let body;
        if (active.id === TASKS_ID) body = h(officialTree, props);
        else if (typeof active.render === 'function') body = active.render(props);
        else body = h('div', { className: 'yx-state' }, '这个页签没有内容');

        return h('div', { className: 'yx-shell' },
          h(TabStrip, { tabs: list, value: active.id, onChange: setTab }),
          h('div', { className: 'yx-body' }, body),
        );
      }
      YuxinWorkspaces.__dshNativeTabHost = true;
      YuxinWorkspaces.__dshNativeTabWrapped = true;
      YuxinWorkspaces.__dshNativeTabOwner = 'dsh-yuxin';
      YuxinWorkspaces.__dshNativeTabs = registry;
      return YuxinWorkspaces;
    }

    function install(ctx) {
      // A. 已经有别家造的页签条（例如预览版）→ 只往里插一个自己的页签，不抢壳
      const foreign = workspacesEntries(ctx).map(registryOf).find(Boolean);
      if (foreign) {
        if (foreignRegistry !== foreign) {
          try { ownTabRemove?.(); } catch { /* ignore */ }
          ownTabRemove = null;
          foreignRegistry = foreign;
        }
        if (!foreign.getTabs().some((item) => item.id === TAB_ID)) {
          ownTabRemove = foreign.insert({
            id: TAB_ID,
            label: TAB_LABEL,
            order: 30,
            matchSession: () => false,
            render: () => h(FriendList, { ctx }),
          });
          console.info('[yuxin] 已并入既有页签条');
        }
        return true;
      }

      // B. 没人造 → 我们自己造
      if (mountedShell) {
        const still = workspacesEntries(ctx).some((entry) => entry.component === mountedShell.shell);
        if (still) return true;
        mountedShell = null;
      }
      const occupant = pickOfficial(ctx);
      if (!occupant) return false;

      const original = occupant.component;
      const registry = createRegistry(original);
      registry.insert({ id: TASKS_ID, label: '任务', order: 10 });
      registry.insert({
        id: TAB_ID,
        label: TAB_LABEL,
        order: 30,
        matchSession: () => false,
        render: () => h(FriendList, { ctx }),
      });
      const shell = makeShell(original, registry, ctx);
      try { occupant.component = shell; } catch (err) { console.warn('[yuxin] 接管会话栏失败', err); return false; }
      mountedShell = { entry: occupant, original, shell, registry };
      console.info('[yuxin] 已自建「任务 | 鱼信」页签条');
      return true;
    }

    function uninstall() {
      try { ownTabRemove?.(); } catch { /* ignore */ }
      ownTabRemove = null;
      foreignRegistry = null;
      if (mountedShell) {
        try {
          if (mountedShell.entry.component === mountedShell.shell) {
            mountedShell.entry.component = mountedShell.original;
          }
        } catch { /* ignore */ }
        mountedShell = null;
      }
    }

    return {
      name: 'dsh-yuxin',
      // 只依赖 slots：整条链路都在槽上完成，不碰 layout，少一个激活条件就少一种装不上的可能
      inject: ['slots'],
      apply(ctx) {
        injectStyle();

        // 段 6 · 接管鱼信会话的正文与输入框（方案 B）。
        // 两个槽都由官方 conversation.content / conversation.chat.flow 声明，
        // 直接挂上去即可；inject 只为等槽出现。
        try {
          ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
            { name: 'conversation.chat.node', key: NODE_KEY },
            (props) => h(YuxinTimeline, { sessionId: props?.sessionId, ctx }),
          ));
        } catch (err) { console.warn('[yuxin] 正文槽没接上', err); }
        try {
          ctx.slots.inject('conversation.composer', () => ctx.slots.register({
            name: 'conversation.composer',
            // 比 dsh-chat 的 -20 更靠前：同一会话两家都命中时以我们为准
            priority: -10,
            select: (owner) => matchComposer(ctx, owner),
          }, (props) => h(YuxinComposer, { matched: props?.matched ?? props })));
        } catch (err) { console.warn('[yuxin] 输入框槽没接上', err); }

        // 段 7 · 浮层聊天窗挂到 root 级浮动层（shell.overlay）：
        // 换页签、收起侧栏、切会话都不会把它带走。
        try {
          ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay',
            id: 'dsh-yuxin-float',
            order: 60,
          }, () => h(YuxinFloatHost, null)));
        } catch (err) { console.warn('[yuxin] 浮层槽没接上', err); }

        // 模型清单要 remote.session：官方那套是用 entry 级 inject 声明的，
        // 我们改成可选注入 —— 注不到就少一项「模型」，页签照常出现。
        try {
          ctx.inject?.(['remote', 'remote.session'], (scope) => {
            try { REMOTE = (scope && (scope.remote || (typeof scope.get === 'function' ? scope.get('remote') : null))) || null; } catch { REMOTE = null; }
          });
        } catch { REMOTE = null; }

        const tryInstall = () => {
          try { return install(ctx); } catch (err) { console.error('[yuxin] 造页签异常', err); return true; }
        };

        let stopRetry = null;
        if (!tryInstall()) {
          let ticks = 0;
          const timer = setInterval(() => {
            ticks += 1;
            if (tryInstall() || ticks >= 40) { clearInterval(timer); stopRetry = null; }
          }, 250);
          stopRetry = () => clearInterval(timer);
        }

        const onChange = () => tryInstall();
        window.addEventListener('dsh-native-sidebar-change', onChange);

        ctx.effect?.(() => () => {
          stopRetry?.();
          window.removeEventListener('dsh-native-sidebar-change', onChange);
          uninstall();
        }, 'dsh-yuxin: 鱼信页签');
      },
    };
  },
});
