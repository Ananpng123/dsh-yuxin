# 鱼信 · dsh-yuxin

把 DSH 左侧「工作区」那一列借来当好友栏：**好友是另一台机器**，点开就是一个小聊天窗。

私聊走插件自带的点对点传输层（QUIC 打洞 + 中继兜底），消息只在两台机器之间走，
本机落盘，**不经过任何服务器**。不需要第三方插件，装这一个包就够。

## 特性

- **零插件依赖**：配对票、信任名单、点对点收发全部内置，不用先装 `dsh-weave`
- **消息不过服务器**：两端直连，服务器顶多看到你在活动，看不到内容
- **好友 = 一台机器**：身份在本机，换电脑就是换一个人；把身份文件拷过去还是你
- **群里也能聊**：建群、拉人、踢人、公告、解散
- **智能体也是好友**：面板上一行智能体点开就是一条真实 DSH 会话

## 装之前需要什么

| 依赖 | 说明 |
|---|---|
| DSH Desktop 0.1.7-alpha.1 以上 | 插件靠 `dsh.client` / `dsh.bundle.patch` 装载 |
| Node 22 以上 | 传输引擎要求 |
| 网络 | 首次安装会拉一个约 16 MB 的原生引擎包（按你的系统自动选对应的） |

可选：`@michengai/dsh-im-connect`（提供「任务 / 频道」页签条，没有也能用，只是页签样式朴素些）。

## 安装

编辑你的 profile 的 `package.json`：

- Windows：`C:\Users\<你>\.dsh\profiles\desktop\package.json`
- macOS / Linux：`~/.dsh/profiles/desktop/package.json`

加两处：

```json
{
  "dependencies": {
    "dsh-yuxin": "github:Ananpng123/dsh-yuxin"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-yuxin"
      ]
    }
  }
}
```

`dependencies` 让它能被解析并装上依赖，`bundles` 让它被装载——**两处都要加**。

然后在 profile 目录里装一次依赖：

```bash
cd ~/.dsh/profiles/desktop   # Windows 是 C:\Users\<你>\.dsh\profiles\desktop
pnpm install
```

最后**完全退出 DSH Desktop 再启动**（关窗口不算，要从托盘退出）。插件只在启动时装载。

## 装完怎么确认

1. 左侧会话列顶部出现「鱼信」页签
2. 点「鱼信」→ 面板分两段：智能体 / 好友
3. 好友是空的 → 正常，说明还没人和你合过符
4. 点「＋ 添加好友」→ 弹出「铸符 / 合符」两个入口，点「铸符」能立刻出一张票

## 加好友（两台机器）

1. 你点「＋ 添加好友」→「铸符」→ 复制那串票，发给对方（微信、邮件都行；**别截图**，少一个字符就合不上）
2. 对方在他的机器上「合符」，贴上你的票 → 他那边先认识你
3. 他再「铸符」把票发回来，你「合符」→ 双向完成，两边好友列表各多一台机器

只做一半时好友列表能看到对方，但发消息会报「没有可用地址」，把另一半补完就好。

## 数据存在哪

| 内容 | 位置 |
|---|---|
| 身份私钥 | `DSH_HOME/dsh-im/transport/identity.json`（**别外传**，等同账号密码） |
| 好友与地址 | `DSH_HOME/dsh-im/transport/peers.json` |
| 聊天记录 | `DSH_HOME/dsh-im/messages.json` |
| 群 | `DSH_HOME/dsh-im/groups.json` |
| 备注名 / 头像 / 已读 | 浏览器 localStorage（绑端口，桌面端口每次启动会变，这些会丢） |

`DSH_HOME` 默认是 `~/.dsh`。

## 已知限制

- **好友 = 一台机器**，不是一个人。同一台机器换账号还是同一个人。
- **在线状态是「上次联系还通不通」**，不是实时。纯点对点没有在线登记处，只有发消息、收消息时才顺便更新一次，重启后全变「状态未知」。
- **对方不在线时消息发不出去**（没有服务器帮你暂存）。
- 智能体的「模型 / 工具 / 开场白」目前只是记录，选中不改变实际会话。
- 只带当前平台的原生引擎；跨平台靠 `pnpm install` 自动选。
- 从 0.4.16 之前的版本升级：会自动读取 `DSH_HOME/dsh-weave/` 里的老身份和好友名单，源文件保留不动。

## 卸载

1. profile 的 `package.json` 里删掉 `dependencies["dsh-yuxin"]` 和 `bundles` 里的 `"dsh-yuxin"`
2. `pnpm install` 一次，或直接删掉 `node_modules/dsh-yuxin`
3. 重启。聊天记录和好友名单在 `DSH_HOME/dsh-im/` 下，删不删随你

## 本地开发

```bash
git clone https://github.com/Ananpng123/dsh-yuxin
cd dsh-yuxin
pnpm install          # 拉当前平台的原生引擎
node --check index.js && node --check client.js && node --check lib/transport.js
```

然后 profile 里用 `"dsh-yuxin": "link:<这个目录的绝对路径>"` 挂上去，改完重启生效。

传输层在 `lib/transport.js`：身份票据、信任名单、点对点收发、入站监听都在里面，
线协议（ALPN `dsh-weave/1` + 帧格式）与旧版 `dsh-weave` 兼容，所以两边的版本不必同步升级。

## 许可

MIT
