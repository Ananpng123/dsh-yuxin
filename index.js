/**
 * dsh-yuxin · host 半 —— 「智能体好友」的会话工厂
 *
 * 只做一件事：把面板上的一行智能体，变成一条真实的 DSH 会话，让点击那一刻
 * 能用官方会话界面跟它聊。聊天界面、消息流、输入框全部复用官方，本插件不画。
 *
 * 依据（全部为官方契约，非私有字段）：
 * - 建会话/落盘：`dsh-chat/lib/room-store.js:198-245` 的 ensureRoomSessions 同款做法 ——
 *   `sessions.create(id, { meta:{cwd}, seed })` 先发布活会话，
 *   再用 `sessionPersistence.create(header)` + `append` + `flush` + `close` 把种子写进存储。
 *   注释原话：「sessions.create publishes a live Session; only the storage handle persists
 *   its seed. A plain room has no AgentLoop to own that write.」—— 我们没有 AgentLoop，同一个道理。
 * - 工作区：`workspaceRegistry.create(path, title)`（跟 room-store.js:204 建 Chatrooms 是同一套调用）。
 * - 标题：`sessionTitle.rename(session, title)`。
 * - 人设：种子里的 `system/message` 事件，字段形状取自真实会话日志
 *   （{ role:'system', source:{kind:'system-prompt'}, content:[{type:'text',text}] } + surfaceOp:'append'）。
 * - 路由：`connection.fetch.register({ path:'/api/dsh-im' })`，与 dsh-chat 的 /api/dsh-chat 同款；
 *   信封 `{ ok:true, value }` / `{ ok:false, error:{code,message,details} }` 见 dsh-chat/lib/index.js:36-63,86-107。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DshImTransport } from './lib/transport.js';

export const name = 'dsh-yuxin';

/** 服务在调用时才探测，避免缺实现把 fiber 打成 INACTIVE。 */
export const inject = [];

/**
 * 传输层来源
 * ------------------------------------------------------------------
 * 0.4.17 起不再依赖第三方 dsh-weave 插件：apply 里就地建一个自研的
 * `DshImTransport` 并注册为 `dshImTransport` 服务。它对界面层暴露的方法名
 * 与旧的 dshWeave 一致（ticket / trust / untrust / identify / subscribe /
 * sendTo / send / peers / endpoints / hosts），所以下面的 `weave` 变量仍叫
 * weave——它指的是"线协议客户端"，不是那个旧插件。
 */

const ROUTE = '/api/dsh-im';
const SESSION_PREFIX = 'dsh-im-bot-';
const WORKSPACE_TITLE = '智能体';

/**
 * 单向加好友的握手通道。
 *
 * 背景：合符（`weave.trust`）只写本机 `peers.json`，不会通知对方，
 * 于是「我合了你」之后你还得再合我一次，两边才对得上。
 *
 * 做法：我合完对方，立刻把**我的票**推给他；他的 host 半收到后自己调一次
 * `weave.trust(票)` —— 单向操作就把好友加完了。
 *
 * 依据（均为官方契约）：`dsh-weave/lib/index.js:201` `subscribe(listener)`
 * 注册入站处理器（listener 返回 true 表示这个帧被我认领），
 * `:194` `hosts()` 只列已信任的机器，`:180` `trust(ticket)` 写信任名单。
 */
const WEAVE_TARGET = 'dsh-im/1';
const WEAVE_PROTOCOL = 'dsh-im/1';

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function rpcFailure(code, message) {
  return { ok: false, error: { code, message, details: {} } };
}

function envelopeResponse(envelope) {
  return new Response(JSON.stringify(envelope), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** 把表单里的名字/人设/开场白拼成一段系统提示。 */
function personaText({ name: botName, persona, hi }) {
  const lines = [];
  const called = String(botName || '').trim();
  lines.push(called ? `你是「${called}」。` : '你是一个被用户加进好友列表的智能体。');
  const body = String(persona || '').trim();
  if (body) lines.push(`你的人设：${body}`);
  const opening = String(hi || '').trim();
  if (opening) lines.push(`你第一次被叫到时，先原样说这句开场白：「${opening}」。`);
  lines.push('用户在鱼信的会话界面里跟你说话。回答要短、具体、能落地，别寒暄，别复述问题。');
  return lines.join('\n');
}

/**
 * 确保某条会话存在并落盘（幂等）。存储里已有就直接返回。
 * 依据 room-store.js:198-245：sessions.create 先发布活会话，落盘只认 storage handle。
 */
async function materializeSession(ctx, { sessionId, dir, workspaceTitle, title, systemText }) {
  const sessions = ctx.get('sessions');
  const registry = ctx.get('workspaceRegistry');
  const persistence = ctx.get('sessionPersistence');
  const titles = ctx.get('sessionTitle');
  if (!sessions || typeof sessions.create !== 'function') throw new Error('sessions 服务不可用');
  if (!registry || typeof registry.create !== 'function') throw new Error('workspaceRegistry 服务不可用');

  await mkdir(dir, { recursive: true });
  if (workspaceTitle) await registry.create(dir, workspaceTitle);

  if (persistence?.stat && (await persistence.stat(sessionId))) {
    return { sessionId, cwd: dir, existed: true };
  }

  let session = sessions.get?.(sessionId);
  if (!session) {
    const time = Date.now();
    session = sessions.create(sessionId, {
      meta: { cwd: dir },
      seed: [
        { type: 'turn/start', seq: 0, time, data: { turn: 1 } },
        {
          type: 'system/message', seq: 1, time: time + 1, surfaceOp: 'append',
          data: {
            turn: 1, step: 1,
            message: {
              id: randomUUID(),
              role: 'system',
              source: { kind: 'system-prompt' },
              content: [{ type: 'text', text: systemText }],
            },
          },
        },
        { type: 'turn/end', seq: 2, time: time + 2, data: { turn: 1, reason: { kind: 'completed' } } },
      ],
    });
  }

  const cleanTitle = String(title || '').trim();
  if (cleanTitle) titles?.rename?.(session, cleanTitle);

  const events = (typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : session.events) ?? [];
  if (!events.length) throw new Error('会话种子为空，没能落盘');
  if (persistence?.create) {
    const handle = await persistence.create(session.header, {
      inheritedEventCount: session.inheritedEventCount ?? 0,
    });
    try {
      await handle.append(events);
      await handle.flush();
    } finally {
      await handle.close();
    }
  } else {
    await sessions.flush?.(session);
  }

  return { sessionId, cwd: dir, existed: false };
}

/** 为一个智能体确保存在一条真实会话。 */
async function ensureBotSession(ctx, args) {
  const rawId = String(args?.botId || '').trim();
  if (!rawId) throw new Error('botId 不能为空');
  const safeId = rawId.replace(/[^A-Za-z0-9_-]/g, '');
  if (!safeId) throw new Error('botId 只允许字母、数字、下划线、短横线');
  return materializeSession(ctx, {
    sessionId: SESSION_PREFIX + safeId,
    dir: join(dshHome(), 'dsh-im', 'agents'),
    workspaceTitle: WORKSPACE_TITLE,
    title: String(args?.name || '').trim(),
    systemText: personaText(args),
  });
}

/**
 * 把「我的票」推给某个 hostId，让对方那边的收帧器自动把我加进信任名单。
 * 对方离线会抛错，由调用方决定忽略还是下次再补。
 */
async function announceFriend(ctx, args) {
  const hostId = String(args?.hostId ?? '').trim();
  if (!hostId) throw new Error('hostId 不能为空');
  const weave = ctx.get('dshImTransport');
  if (!weave) throw new Error('weave 服务不可用');
  const ticket = await weave.ticket();
  const card = await resolveCard(ctx, args?.card);
  await sendOnce(weave, {
    hostId,
    from: 'dsh-im:hello',
    to: WEAVE_TARGET,
    text: JSON.stringify({
      protocol: WEAVE_PROTOCOL,
      kind: 'friend.hello',
      ticket,
      card: cardForWire(hostId, card),
    }),
  });
  return { sent: true };
}

// ---------- 消息层：本机落盘 + weave 直传（不依赖 dsh-chat） ----------
/**
 * 为什么自己扛：dsh-chat 不是传输层，它只是 dsh-weave 上的一个应用协议
 * （room-store.js:465/475 调 `weave.sendTo`，:92 用 `weave.subscribe` 收）。
 * 我们照同一个法子，在 weave 上占自己的 `to: dsh-im/1` 命名空间：
 * dsh-chat 的收帧器第一行就是 `if (frame.to !== 'dsh-chat/2') return false`，
 * 两套协议各认各的帧，可以同时在线，也可以把它整个卸掉。
 *
 * 存储：~/.dsh/dsh-im/messages.json
 * 形状：{ [peerHostId]: { alias, messages: [{ id, text, at, mine }] } }
 * 为什么只存本机：weave 是点对点，没有中心节点；两端各存一份，靠消息 id 去重。
 */
// ---------- 名片：我的身份怎么让对端看见 ----------
/**
 * 账号名片：DSH 登录账号的 name / avatarUrl。
 * 为什么只有这里能读：deepseekAccount 是 Host 侧服务，client 半拿不到，只能由这层转发。
 * 为什么要缓存：getProfile 会打平台接口，一次几百毫秒，不该每条消息都等它。
 * 未登录 / 接口抽风一律返回 null，调用方退回本地自设名片，再退回主机名。
 */
const CARD_TTL = 10 * 60 * 1000;
let accountCardCache = { at: 0, value: null };

async function accountCard(ctx) {
  if (Date.now() - accountCardCache.at < CARD_TTL) return accountCardCache.value;
  const account = ctx.get('deepseekAccount');
  if (!account || typeof account.getProfile !== 'function') return null;
  let value = null;
  try {
    const profile = await account.getProfile({
      version: '0.4.8',
      locale: 'zh-CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    });
    if (profile?.status === 'ready') {
      const name = String(profile.value?.name ?? '').trim();
      const avatar = String(profile.value?.avatarUrl ?? '').trim();
      if (name || avatar) value = { name, avatar };
    }
  } catch (error) {
    ctx.logger?.warn?.(`dsh-yuxin 账号名片读不到：${String(error?.message ?? error)}`);
  }
  accountCardCache = { at: Date.now(), value };
  return value;
}

/** 本地自设 > 账号 > 空。自设优先，因为用户手动改过就是想要它。 */
async function resolveCard(ctx, local) {
  const own = local && typeof local === 'object' ? local : {};
  const account = await accountCard(ctx);
  const name = String(own.name ?? '').trim() || String(account?.name ?? '').trim();
  const avatar = String(own.avatar ?? '').trim() || String(account?.avatar ?? '').trim();
  if (!name && !avatar) return null;
  return { name, avatar };
}

function cardHash(card) {
  const text = `${card?.name ?? ''}|${card?.avatar ?? ''}`;
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

/**
 * 头像体积闸门：账号头像是外链（几十字节），自己传的是 dataURL（几 KB～几十 KB）。
 * 只对 dataURL 做「hash 没变就不再发」的省略，否则每条消息都白扛一张图。
 */
const cardSent = new Map();
function cardForWire(hostId, card) {
  if (!card) return null;
  const hash = cardHash(card);
  const wire = { name: card.name, avatar: card.avatar, hash };
  if (cardSent.get(hostId) === hash && String(card.avatar || '').startsWith('data:')) delete wire.avatar;
  cardSent.set(hostId, hash);
  return wire;
}

/** 收下对端名片。只存不覆盖：本地备注永远比远端名片优先（见 client 的 displayName）。 */
async function rememberCard(peerHostId, card, logger) {
  const peer = String(peerHostId || '').trim();
  if (!peer || !card || typeof card !== 'object') return;
  const name = String(card.name ?? '').trim();
  const avatar = String(card.avatar ?? '').trim();
  if (!name && !avatar) return;
  const store = await loadMessages();
  const box = store[peer] && typeof store[peer] === 'object' ? store[peer] : {};
  const prev = box.card && typeof box.card === 'object' ? box.card : {};
  const next = { name: name || prev.name || '', avatar: avatar || prev.avatar || '', at: Date.now() };
  if (next.name === (prev.name || '') && next.avatar === (prev.avatar || '')) return;
  store[peer] = {
    alias: box.alias || '',
    messages: Array.isArray(box.messages) ? box.messages : [],
    card: next,
  };
  await persistMessages(logger);
}

const MAX_MESSAGES_PER_PEER = 2000;

function messagesPath() {
  return join(dshHome(), 'dsh-im', 'messages.json');
}

let messageStore = null;
let messageWrite = Promise.resolve();

async function loadMessages() {
  if (messageStore) return messageStore;
  try {
    const raw = await readFile(messagesPath(), 'utf8');
    const parsed = JSON.parse(raw);
    messageStore = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    messageStore = {};
  }
  return messageStore;
}

function persistMessages(logger) {
  const snapshot = JSON.stringify(messageStore ?? {});
  messageWrite = messageWrite.then(async () => {
    const file = messagesPath();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, snapshot, 'utf8');
  }).catch((error) => {
    logger?.warn?.(`dsh-yuxin messages.json: ${String(error?.message ?? error)}`);
  });
  return messageWrite;
}

/** 追加一条消息（幂等：同 id 不重复写）。返回该对端的完整消息列表。 */
async function appendMessage(peerHostId, entry, logger) {
  const peer = String(peerHostId || '').trim();
  if (!peer) return [];
  const store = await loadMessages();
  const box = store[peer] && typeof store[peer] === 'object' ? store[peer] : {};
  const list = Array.isArray(box.messages) ? box.messages : [];
  if (list.some((one) => one?.id === entry.id)) return list;
  list.push({ id: entry.id, text: entry.text, at: entry.at, mine: Boolean(entry.mine) });
  let dropped = Number(box.dropped) || 0;
  if (list.length > MAX_MESSAGES_PER_PEER) {
    const cut = list.length - MAX_MESSAGES_PER_PEER;
    list.splice(0, cut);
    dropped += cut;   // 累计丢掉多少条：界面上要能说「更早的 N 条已清理」，不能悄悄扔
  }
  store[peer] = {
    alias: entry.alias || box.alias || '',
    messages: list,
    ...(dropped ? { dropped } : {}),
    ...(box.card ? { card: box.card } : {}),
  };
  await persistMessages(logger);
  return list;
}

/** 发一条消息给对端。发不出去也让本机先存着 —— 用户至少看得见自己说了什么。 */
async function sendMessage(ctx, args) {
  const hostId = String(args?.hostId ?? '').trim();
  const text = String(args?.text ?? '').trim();
  if (!hostId) throw new Error('hostId 不能为空');
  if (!text) throw new Error('消息不能为空');
  const weave = ctx.get('dshImTransport');
  if (!weave || typeof weave.sendTo !== 'function') throw new Error('weave 服务不可用');
  const id = randomUUID();
  const at = Date.now();
  const alias = String(args?.alias ?? '').trim();
  const card = await resolveCard(ctx, args?.card);
  await appendMessage(hostId, { id, text, at, mine: true, alias }, ctx.logger);
  let delivered = true;
  try {
    await sendOnce(weave, {
      hostId,
      from: 'dsh-im:msg',
      to: WEAVE_TARGET,
      id,
      text: JSON.stringify({
        protocol: WEAVE_PROTOCOL,
        kind: 'msg.text',
        id,
        text,
        at,
        alias,
        card: cardForWire(hostId, card),
      }),
    });
  } catch (error) {
    delivered = false;
    ctx.logger?.warn?.(`dsh-yuxin msg → ${hostId.slice(0, 8)} 没发出去：${String(error?.message ?? error)}`);
  }
  return { id, at, delivered };
}

/**
 * 读某位好友的全部消息（本机这一份）。
 *
 * since > 0 时只回这批之后的消息 —— 浮层每秒拉一次，全量重发太浪费。
 * 用 >= 而不是 >：同一毫秒发两条时不会漏，重复的那条客户端按 id 去重。
 */
async function readMessages(args) {
  const hostId = String(args?.hostId ?? '').trim();
  if (!hostId) throw new Error('hostId 不能为空');
  const since = Number(args?.since) || 0;
  const store = await loadMessages();
  const box = store[hostId];
  const all = Array.isArray(box?.messages) ? box.messages : [];
  return {
    alias: box?.alias || '',
    card: box?.card || null,
    messages: since > 0 ? all.filter((m) => (Number(m?.at) || 0) >= since) : all,
    total: all.length,
    dropped: Number(box?.dropped) || 0,
  };
}

/** 所有对端名片的字典 { hostId: { name, avatar, at } }，给好友列表一次性取。 */
async function readCards() {
  const store = await loadMessages();
  const out = {};
  for (const [peer, box] of Object.entries(store)) {
    if (box && typeof box === 'object' && box.card && (box.card.name || box.card.avatar)) {
      out[peer] = box.card;
    }
  }
  return out;
}

/**
 * 未读账本：每个好友、每个群「别人发来的条数 + 最后一条的时间」。
 *
 * 已读水位记在 client 半的 localStorage 里 —— 「读到哪了」是这台机器的行为，
 * 不是数据的一部分，跟着消息一起同步反而会把对方的已读状态带过来。
 * 这里只给单调递增的入站总数：client 拿它减自己的水位就是角标数字，
 * 重复投递、乱序到达都不会把数字算错，也不需要存每条消息的 id。
 */
async function readDigest() {
  const out = { peers: {}, groups: {} };
  const tally = (list) => {
    let total = 0;
    let last = 0;
    for (const m of list) {
      if (!m || typeof m !== 'object' || m.mine) continue;
      total += 1;
      if (Number(m.at) > last) last = Number(m.at);
    }
    return { total, last };
  };
  const msgStore = await loadMessages();
  for (const [peer, box] of Object.entries(msgStore)) {
    if (!peer || !box || typeof box !== 'object') continue;
    out.peers[peer] = tally(Array.isArray(box.messages) ? box.messages : []);
  }
  const groupStore = await loadGroups();
  for (const [id, g] of Object.entries(groupStore)) {
    if (!id || !g || typeof g !== 'object') continue;
    out.groups[id] = tally(Array.isArray(g.messages) ? g.messages : []);
  }
  return out;
}

/**
 * 群聊：一份共享成员表 + 各自一份消息。
 * 没有服务器，所以「群」不是对象而是约定 —— 成员表靠 group.sync 帧互相同步，
 * 消息靠给每个能直连的成员各发一份。谁离线，谁那一份就到不了（这是点对点的物理事实）。
 */
const MAX_MESSAGES_PER_GROUP = 2000;
const MAX_GROUP_MEMBERS = 10;

function groupsPath() {
  return join(dshHome(), 'dsh-im', 'groups.json');
}

let groupStore = null;
let groupWrite = Promise.resolve();

async function loadGroups() {
  if (groupStore) return groupStore;
  try {
    const raw = await readFile(groupsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    groupStore = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    groupStore = {};
  }
  return groupStore;
}

function persistGroups(logger) {
  const snapshot = JSON.stringify(groupStore ?? {});
  groupWrite = groupWrite.then(async () => {
    const file = groupsPath();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, snapshot, 'utf8');
  }).catch((error) => {
    logger?.warn?.(`dsh-yuxin groups.json: ${String(error?.message ?? error)}`);
  });
  return groupWrite;
}

/** 成员归一化：'me' 代表自己，别人的 id 就是对方 hostId。 */
function normMember(raw) {
  const id = String(raw?.id ?? '').trim();
  if (!id) return null;
  return {
    id,
    kind: id === 'me' ? 'me' : raw?.kind === 'agent' ? 'agent' : 'peer',
    name: String(raw?.name || '').trim(),
    avatar: String(raw?.avatar || ''),
    addedBy: String(raw?.addedBy || ''),
    at: Number(raw?.at) || Date.now(),
  };
}

/** 走网线的成员表：头像只带前 4 个（群头像最多就拼 4 格），省流量也省 ack 时间。 */
function membersForWire(members) {
  return (Array.isArray(members) ? members : []).map((m, i) => ({
    id: m.id,
    kind: m.kind,
    name: m.name,
    ...(i < 4 && m.avatar ? { avatar: m.avatar } : {}),
  }));
}

/**
 * 成员表的瘦身版：只留 id / kind / name，不带头像。
 *
 * 群消息每条都捎一份成员表，是为了「收到一个陌生群的消息时也能把群建起来」。
 * 但头像动辄几十 KB（自传的头像是 dataURL），跟着每条「在」字消息飞一趟纯属浪费。
 * 头像只在 group.sync 时传一次就够了。
 */
function membersBrief(members) {
  return (Array.isArray(members) ? members : []).map((m) => ({
    id: m.id,
    kind: m.kind,
    name: m.name,
  }));
}

/**
 * 收到别人广播的成员表：对方的 'me' 是对方自己（对方也不知道我们是谁），
 * 所以先把 'me' 换成它的 hostId，再补上我自己那一项。
 */
function adoptMembers(members, peer) {
  const out = [];
  for (const m of Array.isArray(members) ? members : []) {
    const id = String(m?.id || '');
    if (!id) continue;
    out.push(id === 'me' ? { ...m, id: peer, kind: 'peer' } : m);
  }
  if (peer && !out.some((one) => String(one.id) === peer)) {
    out.unshift({ id: peer, kind: 'peer', name: '', avatar: '' });
  }
  return out;
}

/** 群归一化：成员去重、自己永远在、上限 10 人、没名字就按成员拼。 */
function normGroup(raw) {
  const id = String(raw?.id ?? '').trim();
  if (!id) return null;
  const seen = new Set();
  const members = [];
  for (const one of Array.isArray(raw?.members) ? raw.members : []) {
    const m = normMember(one);
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id);
    members.push(m);
    if (members.length >= MAX_GROUP_MEMBERS) break;
  }
  if (!members.some((m) => m.kind === 'me')) members.unshift(normMember({ id: 'me', addedBy: 'me' }));
  const auto = '我、' + members.filter((m) => m.kind !== 'me').map((m) => m.name || m.id.slice(0, 6)).join('、');
  return {
    id,
    name: String(raw?.name || '').trim().slice(0, 20) || auto.slice(0, 20),
    owner: String(raw?.owner || 'me'),
    at: Number(raw?.at) || Date.now(),
    announce: String(raw?.announce || '').trim().slice(0, 200),
    members,
    messages: Array.isArray(raw?.messages) ? raw.messages : [],
  };
}

/** 写一个群。同一条群按 at 比新旧：旧的来了就丢掉（成员表冲突就靠这个判）。 */
async function upsertGroup(raw, logger) {
  const g = normGroup(raw);
  if (!g) return null;
  const store = await loadGroups();
  const old = store[g.id];
  if (old && Number(old.at) > g.at) return old;
  g.messages = Array.isArray(old?.messages) ? old.messages : g.messages;
  store[g.id] = g;
  await persistGroups(logger);
  return g;
}

/** 追加一条群消息（同 id 不重复）。群不存在就返回 null。 */
async function appendGroupMessage(groupId, entry, logger) {
  const key = String(groupId || '').trim();
  if (!key) return null;
  const store = await loadGroups();
  const g = store[key];
  if (!g) return null;
  const list = Array.isArray(g.messages) ? g.messages : [];
  const id = String(entry?.id || '').trim() || randomUUID();
  if (list.some((one) => one?.id === id)) return list;
  list.push({
    id,
    from: String(entry?.from || ''),
    fromName: String(entry?.fromName || '').trim(),
    text: String(entry?.text ?? ''),
    at: Number(entry?.at) || Date.now(),
    mine: Boolean(entry?.mine),
  });
  if (list.length > MAX_MESSAGES_PER_GROUP) {
    const cut = list.length - MAX_MESSAGES_PER_GROUP;
    list.splice(0, cut);
    g.dropped = (Number(g.dropped) || 0) + cut;
  }
  g.messages = list;
  await persistGroups(logger);
  return list;
}

/**
 * 等对方回执最多等这么久。
 *
 * weave 的默认值是 10 秒 —— 对「发一条消息」来说太长了：对方机器没开的时候，
 * 一次发送就要干等满 10 秒才放弃。3 秒够走完局域网往返，也够公网打洞的正常情况；
 * 真送了不到，下次 group.sync / 下一条消息会把它补齐，不值得让用户陪着等。
 */
const SEND_TIMEOUT = 3_000;

/** 所有出站消息走这一个口子，超时统一。 */
function sendOnce(weave, args) {
  return weave.sendTo({ ...args, timeoutMs: SEND_TIMEOUT });
}

/**
 * 广播是「尽力而为」，不是事务。
 *
 * 建群 / 拉人 / 踢人 / 改名 / 改公告，本机落盘成功就算成功 ——
 * 把最新成员表推给每个成员是后台的事。以前这里 await 全部 ack 才返回，
 * 群里只要有一个人的机器没开，用户点一下就要等满整个超时。
 * 对方晚几秒知道完全无害：下次 group.sync 会带上整张表，是最新状态就够。
 */
function background(ctx, task, label) {
  void Promise.resolve()
    .then(task)
    .catch((error) => {
      ctx.logger?.warn?.(`dsh-yuxin ${label} 后台没完成：${String(error?.message ?? error)}`);
    });
}

/** 把整张成员表推给群里每个能直连的人。拉人、改名、退群都走它。 */
async function broadcastGroup(ctx, group) {
  const weave = ctx.get('dshImTransport');
  if (!weave || typeof weave.sendTo !== 'function') return 0;
  const wire = JSON.stringify({
    protocol: WEAVE_PROTOCOL,
    kind: 'group.sync',
    group: { id: group.id, name: group.name, owner: group.owner, at: group.at, announce: group.announce || '', members: membersForWire(group.members) },
  });
  const targets = (group.members || []).filter((m) => m.kind === 'peer');
  if (!targets.length) return 0;
  const results = await Promise.allSettled(targets.map((m) => sendOnce(weave, {
    hostId: m.id, from: 'dsh-im:group', to: WEAVE_TARGET, text: wire,
  })));
  let ok = 0;
  results.forEach((one, i) => {
    if (one.status === 'fulfilled') ok += 1;
    else ctx.logger?.warn?.(`dsh-yuxin group.sync → ${targets[i].id.slice(0, 8)} 没发出去：${String(one.reason?.message ?? one.reason)}`);
  });
  return ok;
}

/** 群列表：不带消息体，只给侧栏要用的最后一条和条数。 */
async function readGroups() {
  const store = await loadGroups();
  const out = [];
  for (const g of Object.values(store)) {
    if (!g || typeof g !== 'object') continue;
    const msgs = Array.isArray(g.messages) ? g.messages : [];
    const last = msgs[msgs.length - 1] || null;
    out.push({
      id: g.id,
      name: g.name,
      owner: g.owner,
      at: g.at,
      members: (g.members || []).map((m) => ({ id: m.id, kind: m.kind, name: m.name })),
      count: msgs.length,
      last: last ? { text: last.text, from: last.from, fromName: last.fromName, at: last.at, mine: last.mine } : null,
    });
  }
  out.sort((a, b) => (Number(b.last?.at) || Number(b.at) || 0) - (Number(a.last?.at) || Number(a.at) || 0));
  return out;
}

/** 单个群的完整内容（含消息），浮层聊天窗用。since 语义同 readMessages。 */
async function readGroup(args) {
  const groupId = String(args?.groupId || '').trim();
  if (!groupId) throw new Error('groupId 不能为空');
  const since = Number(args?.since) || 0;
  const store = await loadGroups();
  const g = store[groupId];
  if (!g) return null;
  const all = Array.isArray(g.messages) ? g.messages : [];
  return {
    ...g,
    messages: since > 0 ? all.filter((m) => (Number(m?.at) || 0) >= since) : all,
    total: all.length,
    dropped: Number(g.dropped) || 0,
  };
}

/** 建群：自己的名片当成员之一，其余按传入的成员表，建完广播整张表。 */
async function createGroup(ctx, args) {
  const card = await resolveCard(ctx, args?.card);
  const now = Date.now();
  const members = [normMember({ id: 'me', name: card?.name || '', avatar: card?.avatar || '', addedBy: 'me', at: now })];
  for (const one of Array.isArray(args?.members) ? args.members : []) {
    const m = normMember({ ...one, addedBy: 'me', at: now });
    if (m && m.id !== 'me') members.push(m);
  }
  if (members.length < 2) throw new Error('至少拉一个人进群');
  if (members.length > MAX_GROUP_MEMBERS) throw new Error(`一个群最多 ${MAX_GROUP_MEMBERS} 个成员`);
  const g = await upsertGroup({
    id: randomUUID(),
    name: String(args?.name || '').trim(),
    owner: 'me',
    at: now,
    members,
    messages: [],
  }, ctx.logger);
  background(ctx, () => broadcastGroup(ctx, g), 'group.sync');
  return g;
}

/** 发一条群消息：本机先落一份，然后给每个能直连的成员各发一份。 */
async function sendGroupMessage(ctx, args) {
  const groupId = String(args?.groupId || '').trim();
  const text = String(args?.text ?? '').trim();
  if (!groupId) throw new Error('groupId 不能为空');
  if (!text) throw new Error('消息不能为空');
  const store = await loadGroups();
  const g = store[groupId];
  if (!g) throw new Error('群不存在');
  const card = await resolveCard(ctx, args?.card);
  const id = randomUUID();
  const at = Date.now();
  await appendGroupMessage(groupId, { id, from: 'me', fromName: card?.name || '', text, at, mine: true }, ctx.logger);

  const weave = ctx.get('dshImTransport');
  const targets = (g.members || []).filter((m) => m.kind === 'peer');
  let delivered = 0;
  if (weave && typeof weave.sendTo === 'function' && targets.length) {
    const wire = JSON.stringify({
      protocol: WEAVE_PROTOCOL,
      kind: 'group.msg',
      groupId,
      groupName: g.name,
      id,
      text,
      at,
      fromName: card?.name || '',
      card,
      members: membersBrief(g.members),
    });
    // 同时发给所有人，只等最慢那个。原来是串行 await —— 一个人关机就要白等一次 10 秒超时，
    // 10 人群里有 3 个人关机，发一条消息就要卡 30 秒，按钮一直转圈。
    const results = await Promise.allSettled(targets.map((m) => sendOnce(weave, {
      hostId: m.id, from: 'dsh-im:group', to: WEAVE_TARGET, id: randomUUID(), text: wire,
    })));
    results.forEach((one, i) => {
      if (one.status === 'fulfilled') delivered += 1;
      else ctx.logger?.warn?.(`dsh-yuxin group.msg → ${targets[i].id.slice(0, 8)} 没发出去：${String(one.reason?.message ?? one.reason)}`);
    });
  }
  return { id, at, delivered, total: targets.length };
}

/** 拉一个人进群。满了就报错，重复拉直接返回。 */
async function inviteToGroup(ctx, args) {
  const groupId = String(args?.groupId || '').trim();
  const store = await loadGroups();
  const g = store[groupId];
  if (!g) throw new Error('群不存在');
  const m = normMember({ ...args?.member, addedBy: 'me', at: Date.now() });
  if (!m) throw new Error('要拉谁？');
  if (m.kind === 'me') throw new Error('你自己已经在群里了');
  if ((g.members || []).some((one) => one.id === m.id)) return g;
  if ((g.members || []).length >= MAX_GROUP_MEMBERS) throw new Error(`一个群最多 ${MAX_GROUP_MEMBERS} 个成员`);
  const next = await upsertGroup({
    ...g,
    at: Date.now(),
    members: [...g.members, m],
  }, ctx.logger);
  background(ctx, () => broadcastGroup(ctx, next), 'group.sync');
  return next;
}

/** 改群名。 */
async function renameGroup(ctx, args) {
  const groupId = String(args?.groupId || '').trim();
  const name = String(args?.name || '').trim().slice(0, 20);
  if (!name) throw new Error('群名不能为空');
  const store = await loadGroups();
  const g = store[groupId];
  if (!g) throw new Error('群不存在');
  const next = await upsertGroup({ ...g, at: Date.now(), name }, ctx.logger);
  background(ctx, () => broadcastGroup(ctx, next), 'group.sync');
  return next;
}

/**
 * 改群公告。跟改名一样走 broadcastGroup —— 那帧本来就带整张成员表，
 * 顺手捎上公告，一次往返把「成员+群名+公告」全同步过去，不用单开一种帧。
 * 只有群主能改：点对点没有服务器替我们执法，这条限制写在两端各自的服务端方法里。
 */
async function setAnnounce(ctx, args) {
  const groupId = String(args?.groupId || '').trim();
  const announce = String(args?.announce ?? '').trim().slice(0, 200);
  const store = await loadGroups();
  const g = store[groupId];
  if (!g) throw new Error('群不存在');
  if (String(g.owner) !== 'me') throw new Error('只有群主能改群公告');
  if ((g.announce || '') === announce) return g;
  const next = await upsertGroup({ ...g, at: Date.now(), announce }, ctx.logger);
  background(ctx, () => broadcastGroup(ctx, next), 'group.sync');
  return next;
}

/**
 * 退群 / 踢人 / 解散，三件事都是「广播一条 group.leave」，差别只在帧里带什么标记、
 * 以及本机要不要顺手把群删掉。
 */
async function sendLeaveFrame(ctx, group, members, extra) {
  const weave = ctx.get('dshImTransport');
  if (!weave || typeof weave.sendTo !== 'function') return 0;
  const targets = (members || []).filter((m) => m.kind === 'peer');
  if (!targets.length) return 0;
  const wire = JSON.stringify({ protocol: WEAVE_PROTOCOL, kind: 'group.leave', groupId: group.id, ...extra });
  const results = await Promise.allSettled(targets.map((m) => sendOnce(weave, {
    hostId: m.id, from: 'dsh-im:group', to: WEAVE_TARGET, text: wire,
  })));
  return results.filter((one) => one.status === 'fulfilled').length;
}

/** 退群：先告诉其他人我走了（不然对方会把「表里没我」当成漏项补回来），再从本机删掉。 */
async function leaveGroup(ctx, args) {
  const groupId = String(args?.groupId || '').trim();
  if (!groupId) throw new Error('groupId 不能为空');
  const store = await loadGroups();
  const g = store[groupId];
  if (!g) return { ok: true };
  background(ctx, () => sendLeaveFrame(ctx, g, g.members, {}), 'group.leave');
  delete store[groupId];
  await persistGroups(ctx.logger);
  return { ok: true };
}

/** 群主踢人：剩下的人整表覆盖，被踢的那位单独收一条带 kicked 的帧好把群删掉。 */
async function kickFromGroup(ctx, args) {
  const groupId = String(args?.groupId || '').trim();
  const memberId = String(args?.memberId || '').trim();
  if (!groupId || !memberId) throw new Error('groupId / memberId 不能为空');
  if (memberId === 'me') throw new Error('退自己的群请用「退出群聊」');
  const store = await loadGroups();
  const g = store[groupId];
  if (!g) throw new Error('群不存在');
  if (String(g.owner) !== 'me') throw new Error('只有群主能踢人');
  const who = (g.members || []).find((m) => String(m.id) === memberId);
  if (!who) throw new Error('这个人不在群里');
  const next = await upsertGroup({
    ...g, at: Date.now(), members: (g.members || []).filter((m) => String(m.id) !== memberId),
  }, ctx.logger);
  background(ctx, () => broadcastGroup(ctx, next), 'group.sync');
  background(ctx, () => sendLeaveFrame(ctx, next, [who], { kicked: memberId }), 'group.leave');
  return next;
}

/** 群主解散：所有人收到的帧带 dissolved，各自把群删掉。 */
async function dissolveGroup(ctx, args) {
  const groupId = String(args?.groupId || '').trim();
  if (!groupId) throw new Error('groupId 不能为空');
  const store = await loadGroups();
  const g = store[groupId];
  if (!g) return { ok: true };
  if (String(g.owner) !== 'me') throw new Error('只有群主能解散');
  background(ctx, () => sendLeaveFrame(ctx, g, g.members, { dissolved: true }), 'group.leave');
  delete store[groupId];
  await persistGroups(ctx.logger);
  return { ok: true };
}

/** 删好友：从信任列表摘掉，本机存的那箱消息一起清。对方电脑上那份删不了 —— 点对点没有服务器。 */
async function friendRemove(ctx, args) {
  const hostId = String(args?.hostId || '').trim();
  if (!hostId) throw new Error('hostId 不能为空');
  const weave = ctx.get('dshImTransport');
  if (weave && typeof weave.untrust === 'function') {
    try { await weave.untrust(hostId); }
    catch (error) { ctx.logger?.warn?.(`dsh-yuxin untrust: ${String(error?.message ?? error)}`); }
  }
  const store = await loadMessages();
  if (store[hostId]) {
    delete store[hostId];
    await persistMessages(ctx.logger);
  }
  return { ok: true };
}

/** 清空和某人的聊天记录。对方那份不动。 */
async function clearChat(ctx, args) {
  const hostId = String(args?.hostId || '').trim();
  if (!hostId) throw new Error('hostId 不能为空');
  const store = await loadMessages();
  const box = store[hostId];
  if (!box) return { ok: true };
  store[hostId] = { ...box, messages: [], dropped: 0 };
  await persistMessages(ctx.logger);
  return { ok: true };
}

/** 清空某个群的本地记录。 */
async function clearGroupChat(ctx, args) {
  const groupId = String(args?.groupId || '').trim();
  if (!groupId) throw new Error('groupId 不能为空');
  const store = await loadGroups();
  const g = store[groupId];
  if (!g) return { ok: true };
  store[groupId] = { ...g, messages: [], dropped: 0 };
  await persistGroups(ctx.logger);
  return { ok: true };
}

/** 本机的 EndpointId（hostId）。用来判断「被踢的人是不是我」这类跟自己有关的事。 */
async function myHostId(weave) {
  if (!weave || typeof weave.ticket !== 'function' || typeof weave.identify !== 'function') return '';
  try { return String(weave.identify(await weave.ticket()) || ''); } catch { return ''; }
}

/**
 * 收帧器：一个订阅管两件事。
 * ① friend.hello —— 别人把票推过来，本机自动加为好友（等价于「我已合符」）。
 * ② msg.text    —— 对端发来的聊天消息，落本机 store。
 * 只认领 `to: dsh-im/1` 的帧，别的一律 return false 交给别人处理。
 */
function attachReceiver(ctx) {
  const weave = ctx.get('dshImTransport');
  if (!weave || typeof weave.subscribe !== 'function') return false;
  ctx.effect(() => {
    const off = weave.subscribe(async (frame) => {
      if (!frame || frame.to !== WEAVE_TARGET || typeof frame.text !== 'string') return false;
      let payload;
      try { payload = JSON.parse(frame.text); } catch { return false; }
      if (payload?.protocol !== WEAVE_PROTOCOL) return false;

      if (payload.kind === 'friend.hello') {
        const ticket = typeof payload.ticket === 'string' ? payload.ticket.trim() : '';
        const peer = String(frame.peerId || '').trim();
        if (payload.card) await rememberCard(peer, payload.card, ctx.logger);
        if (!ticket) return true;
        try {
          const mine = await weave.ticket();
          if (ticket === mine) return true; // 自己的票，忽略
          await weave.trust(ticket);
        } catch (error) {
          ctx.logger?.warn?.(`dsh-yuxin friend.hello: ${String(error?.message ?? error)}`);
        }
        return true;
      }

      if (payload.kind === 'msg.text') {
        const id = String(payload.id || '').trim();
        const text = String(payload.text || '');
        const peer = String(frame.peerId || '').trim();
        if (!id || !text || !peer) return true;
        try {
          if (payload.card) await rememberCard(peer, payload.card, ctx.logger);
          await appendMessage(peer, {
            id,
            text,
            at: Number(payload.at) || Number(frame.receivedAt) || Date.now(),
            mine: false,
            alias: String(payload.alias || '').trim(),
          }, ctx.logger);
        } catch (error) {
          ctx.logger?.warn?.(`dsh-yuxin msg.in: ${String(error?.message ?? error)}`);
        }
        return true;
      }

      // 成员表同步：拉人 / 改名 / 有人退群，都以这条为准（新的整表覆盖旧的）。
      if (payload.kind === 'group.sync') {
        const raw = payload.group;
        const peer = String(frame.peerId || '').trim();
        if (!raw || !raw.id) return true;
        try {
          // 别人把整张表推过来时，'me' 是对方 —— adoptMembers 会换掉，再补我自己的。
          const meCard = await accountCard(ctx);
          const merged = [
            { id: 'me', kind: 'me', name: meCard?.name || '', avatar: meCard?.avatar || '', addedBy: peer, at: Date.now() },
            ...adoptMembers(raw.members, peer),
          ];
          await upsertGroup({ ...raw, members: merged }, ctx.logger);
        } catch (error) {
          ctx.logger?.warn?.(`dsh-yuxin group.sync 收不进来：${String(error?.message ?? error)}`);
        }
        return true;
      }

      // 群消息：一条消息一个帧。本地没有这个群就先按帧里带的成员表建个壳。
      if (payload.kind === 'group.msg') {
        const groupId = String(payload.groupId || '').trim();
        const peer = String(frame.peerId || '').trim();
        if (!groupId || !peer) return true;
        try {
          if (payload.card) await rememberCard(peer, payload.card, ctx.logger);
          const store = await loadGroups();
          if (!store[groupId]) {
            const meCard = await accountCard(ctx);
            await upsertGroup({
              id: groupId,
              name: String(payload.groupName || '').slice(0, 20),
              owner: peer,
              at: Date.now(),
              members: [
                { id: 'me', kind: 'me', name: meCard?.name || '', avatar: meCard?.avatar || '', addedBy: peer, at: Date.now() },
                ...adoptMembers(payload.members, peer),
              ],
            }, ctx.logger);
          }
          await appendGroupMessage(groupId, {
            id: String(payload.id || '').trim(),
            from: peer,
            fromName: String(payload.fromName || '').trim(),
            text: String(payload.text || ''),
            at: Number(payload.at) || Number(frame.receivedAt) || Date.now(),
            mine: false,
          }, ctx.logger);
        } catch (error) {
          ctx.logger?.warn?.(`dsh-yuxin group.msg.in: ${String(error?.message ?? error)}`);
        }
        return true;
      }

      // 退群 / 被踢 / 群解散，三条都走这一帧，靠标记区分。
      if (payload.kind === 'group.leave') {
        const groupId = String(payload.groupId || '').trim();
        const peer = String(frame.peerId || '').trim();
        if (!groupId) return true;
        try {
          const store = await loadGroups();
          const g = store[groupId];
          if (!g) return true;
          // 群解散：本机这份也删掉。
          if (payload.dissolved === true) {
            delete store[groupId];
            await persistGroups(ctx.logger);
            return true;
          }
          // 被踢的是我：同样删群，不然留一个自己不在里面的壳。
          if (payload.kicked) {
            const mine = await myHostId(weave);
            if (mine && String(payload.kicked) === mine) {
              delete store[groupId];
              await persistGroups(ctx.logger);
              return true;
            }
          }
          if (peer) {
            await upsertGroup({
              ...g,
              at: Date.now(),
              members: (g.members || []).filter((m) => String(m.id) !== peer),
            }, ctx.logger);
          }
        } catch (error) {
          ctx.logger?.warn?.(`dsh-yuxin group.leave: ${String(error?.message ?? error)}`);
        }
        return true;
      }

      return false;
    });
    return () => { try { off?.(); } catch { /* 已卸载 */ } };
  }, 'dsh-yuxin: weave receiver');
  return true;
}

/** 取本插件的传输层服务；没就绪就明确报错，别让前端拿到 undefined 后瞎猜。 */
function transportOf(ctx) {
  const transport = ctx.get('dshImTransport');
  if (!transport) throw new Error('鱼信传输层未就绪，重启一次 DSH Desktop 就好');
  return transport;
}

function createHandler(ctx) {
  const handlers = {
    // 传输层：铸符 / 合符 / 好友地址。
    // 0.4.16 之前这几号挂在第三方的 /api/dsh-weave 上，现在由本插件自带，
    // 前端只走 /api/dsh-im 一条路。返回值形状与旧路由逐字一致，前端不用改。
    // 注意 endpoints 给的是 hosts()（带 hostId/addressKnown/state），不是 endpoints()。
    ticket: () => transportOf(ctx).ticket().then((ticket) => ({ ticket })),
    trust: (args) => transportOf(ctx).trust(args?.ticket).then((peerId) => ({ peerId })),
    untrust: (args) => transportOf(ctx).untrust(args?.peerId).then((removed) => ({ removed })),
    peers: () => ({ peers: transportOf(ctx).peers() }),
    endpoints: () => ({ endpoints: transportOf(ctx).hosts() }),
    status: () => ({ relayMode: 'default', peerCount: transportOf(ctx).peers().length }),
    botSession: (args) => ensureBotSession(ctx, args),
    announce: (args) => announceFriend(ctx, args),
    send: (args) => sendMessage(ctx, args),
    messages: (args) => readMessages(args),
    cards: () => readCards(),
    // 我的默认名片：client 半读不到 deepseekAccount，只能从这里取。
    accountCard: () => accountCard(ctx),
    // 未读账本：角标数字用
    digest: () => readDigest(),
    // 收拾残局
    friendRemove: (args) => friendRemove(ctx, args),
    clearChat: (args) => clearChat(ctx, args),
    // 群聊
    groups: () => readGroups(),
    group: (args) => readGroup(args),
    groupCreate: (args) => createGroup(ctx, args),
    groupSend: (args) => sendGroupMessage(ctx, args),
    groupInvite: (args) => inviteToGroup(ctx, args),
    groupRename: (args) => renameGroup(ctx, args),
    groupAnnounce: (args) => setAnnounce(ctx, args),
    groupLeave: (args) => leaveGroup(ctx, args),
    groupKick: (args) => kickFromGroup(ctx, args),
    groupDissolve: (args) => dissolveGroup(ctx, args),
    clearGroup: (args) => clearGroupChat(ctx, args),
  };
  return async (endpoint, payload, options) => {
    const handler = Object.hasOwn(handlers, endpoint) ? handlers[endpoint] : undefined;
    if (!handler) return rpcFailure('bad-request', `unknown dsh-im endpoint: ${endpoint}`);
    const args = payload?.args;
    if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
      return rpcFailure('bad-request', `dsh-im endpoint ${endpoint} requires an args object`);
    }
    try {
      options?.signal?.throwIfAborted?.();
      return { ok: true, value: await handler(args ?? {}, options) };
    } catch (error) {
      return rpcFailure('internal', error?.message ?? String(error));
    }
  };
}

async function handleRequest(handler, request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return envelopeResponse(rpcFailure('bad-request', 'request body is not JSON'));
  }
  const endpoint = payload?.endpoint;
  if (typeof endpoint !== 'string' || endpoint === '') {
    return envelopeResponse(rpcFailure('bad-request', 'endpoint must be a non-empty string'));
  }
  try {
    return envelopeResponse(await handler(endpoint, payload, { signal: request.signal }));
  } catch (error) {
    return envelopeResponse(rpcFailure('internal', error?.message ?? String(error)));
  }
}

export function apply(ctx) {
  // 传输层随插件自带：注册成服务后，下面所有 ctx.get('dshImTransport') 才拿得到。
  const transport = new DshImTransport(ctx);
  ctx.provide('dshImTransport', transport);
  ctx.effect(() => () => transport.close(), 'dsh-yuxin: transport');

  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(() => connectionCtx.connection.fetch.register({
      path: ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleRequest(createHandler(ctx), request),
    }), 'dsh-yuxin: bot session route');
  });

  // 收帧器：传输层在 apply 里已注册，但 Cordis 服务可见性可能晚一步，
  // 所以仍重试到挂上为止（最多约 30 秒）。
  ctx.effect(() => {
    let tries = 0;
    let timer;
    const attempt = () => {
      if (attachReceiver(ctx)) return;
      if (++tries > 12) return;
      timer = setTimeout(attempt, 2500);
    };
    timer = setTimeout(attempt, 1500);
    return () => clearTimeout(timer);
  }, 'dsh-yuxin: transport receiver attach');
}
