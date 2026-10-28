/**
 * 鱼信 · 自研 P2P 传输层（方案一：协议自研 + iroh 引擎随包）
 *
 * 为什么存在
 * ------------------------------------------------------------------
 * 0.4.x 之前鱼信把 `dsh-weave` 当传输层直接吃（ctx.get('dshWeave')），
 * 于是装鱼信就得连带装一个第三方插件，且它的版本节奏、健康状态全在别人手里。
 * 本文件把鱼信用到的那部分能力（身份票据 / 信任名单 / 点对点收发 / 入站监听）
 * 直接实现在插件内部，对外零插件依赖。
 *
 * 兼容性契约（不能随便改，否则升级前后聊不通）
 * ------------------------------------------------------------------
 * 1. ALPN 仍是 `dsh-weave/1`：老版本对端（走 dsh-weave）按这个字符串开流。
 * 2. 帧格式仍是 `{kind:'dsh-weave/message', version:1, id, from, to, text}`，
 *    应答仍是 `{ok:true, id, result}` / `{ok:false, id, error}`。
 * 3. 单条消息一条双向流，写完整帧后 finish()，等对端回一帧应答。
 * 4. 去重键为 `${peerId}:${message.id}`，5 分钟或 1 万条后淘汰。
 *
 * 与 weave 的差异
 * ------------------------------------------------------------------
 * - 状态目录独立：DSH_HOME/dsh-im/transport/，首次启动从 dsh-weave 目录迁移。
 * - 默认端口 64606（避开 weave 的 64605），可用 DSH_IM_PORT 覆盖。
 * - 不注册任何 DSH 工具、不提供 /api 路由、不做 session 目录同步。
 * - 引擎（@number0/iroh）优先解析运行时依赖，失败则回落到随包 vendor 副本。
 *
 * @module dsh-im-ui/transport
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

/** 与 dsh-weave 对端保持一致的线协议标识。 */
export const DSH_IM_ALPN = 'dsh-weave/1';
export const DSH_IM_PROTOCOL_VERSION = 1;

const ALPN_BYTES = [...new TextEncoder().encode(DSH_IM_ALPN)];
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const DEFAULT_RECENT_MESSAGE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');

const encode = (value) => [...encoder.encode(JSON.stringify(value))];
const decode = (bytes) => JSON.parse(decoder.decode(Uint8Array.from(bytes)));

/**
 * 等一个 promise，但被 signal 中断时立刻拒绝；同时仍然观察上游的失败，
 * 避免中断后出现未处理的 rejection。
 * @param {Promise<unknown>} promise
 * @param {AbortSignal} [signal]
 */
function withSignal(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * 加载 iroh 引擎。
 *
 * 解析顺序：
 * 1. 随包 vendor 副本 `lib/vendor/node_modules/@number0/iroh`——分发给别人时
 *    对方 profile 里没有这个包，只有这份能用；用 createRequire 是为了让
 *    iroh 内部 `require('@number0/iroh-<平台>-<架构>')` 也能落到
 *    `lib/vendor/node_modules/` 里，而不是去爬外层的 node_modules。
 * 2. 运行时依赖 `@number0/iroh`——本机装了 iroh 的兜底。
 * @returns {Promise<typeof import('@number0/iroh')>}
 */
let engine;
async function loadIroh() {
  if (engine) return engine;
  const failures = [];
  try {
    engine = createRequire(new URL('./vendor/package.json', import.meta.url))('@number0/iroh');
    return engine;
  } catch (error) {
    failures.push(`vendor: ${error?.message ?? error}`);
  }
  try {
    engine = await import('@number0/iroh');
    return engine;
  } catch (error) {
    failures.push(`runtime: ${error?.message ?? error}`);
  }
  throw new Error(`鱼信 P2P 引擎不可用（${failures.join('；')}）。插件包可能不完整，请重新安装。`);
}

/**
 * 鱼信的点对点传输。
 *
 * 生命周期：构造 → （首次用时）start() 绑定端点 → 收发 → close()。
 * 暴露方法与 dsh-weave 的同名方法语义一致，所以界面层不用改。
 */
export class DshImTransport {
  /**
   * @param {object} ctx Cordis 上下文（只用于日志，不取任何服务）
   * @param {object} [config] 见下方默认值；不导 Schema，保持零额外依赖
   */
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.config = config;
    const base = config.stateDir ?? join(DEFAULT_HOME, 'dsh-im', 'transport');
    this.stateDir = base;
    this.identityPath = config.identityPath ?? join(base, 'identity.json');
    this.peersPath = config.peersPath ?? join(base, 'peers.json');
    /** 老版本留在 dsh-weave 目录里的身份与信任名单，只读迁移用。 */
    this.legacyDir = config.legacyDir ?? join(DEFAULT_HOME, 'dsh-weave');
    this.hostName = config.hostName ?? hostname();
    this.port = Number(config.port ?? process.env.DSH_IM_PORT ?? 64606);
    this.acknowledgementTimeoutMs = Number(config.acknowledgementTimeoutMs ?? 10_000);
    this.shutdownTimeoutMs = Number(config.shutdownTimeoutMs ?? 1_000);
    this.maxConcurrentInbound = Number(config.maxConcurrentInbound ?? 64);
    this.recentMessageLimit = Number(config.recentMessageLimit ?? 10_000);
    this.recentMessageTtlMs = Number(config.recentMessageTtlMs ?? DEFAULT_RECENT_MESSAGE_TTL_MS);

    this.endpoint = undefined;
    this.starting = undefined;
    this.trustedPeers = new Set();
    this.peerTickets = new Map();
    this.hostStates = new Map();
    this.listeners = new Set();
    this.recentMessages = new Map();
    /** 在跑的入站任务 → 中断器，close() 时统一中止并等待。 */
    this.inbound = new Map();
    this.saveTail = Promise.resolve();
    this.closed = false;
    this.lifetime = new AbortController();
    this.ready = this.#loadPeers();
  }

  /** 幂等：无论几个调用方同时进来，只绑定一个端点。 */
  start() {
    if (this.closed) return Promise.reject(new Error('鱼信传输层已关闭'));
    if (this.endpoint) return Promise.resolve(this.endpoint);
    if (!this.starting) {
      this.starting = this.#start().catch((error) => {
        this.starting = undefined;
        throw error;
      });
    }
    return this.starting;
  }

  async #start() {
    const { Endpoint, RelayMode } = await loadIroh();
    await this.ready;
    if (this.closed) throw new Error('鱼信传输层已关闭');
    const builder = Endpoint.builder();
    builder.applyN0();
    builder.alpns([ALPN_BYTES]);
    if (this.config.relayMode === 'disabled') builder.relayMode(RelayMode.disabled());
    builder.secretKey(await this.#secretKey());
    if (Number.isInteger(this.port) && this.port > 0 && this.port < 65536) builder.bindAddr(`0.0.0.0:${this.port}`);
    const endpoint = await builder.bind();
    if (this.closed) {
      await endpoint.close();
      throw new Error('鱼信传输层在启动过程中被关闭');
    }
    this.endpoint = endpoint;
    void this.#acceptLoop();
    return endpoint;
  }

  /**
   * 读身份私钥；没有就生成。
   * 顺序：本插件目录 → 老 weave 目录（迁移）→ 新建。
   * @returns {Promise<number[]>} 32 字节私钥
   */
  async #secretKey() {
    const { SecretKey } = await loadIroh();
    const candidates = [this.identityPath, join(this.legacyDir, 'identity.json')];
    let migrated;
    for (const path of candidates) {
      let raw;
      try {
        raw = JSON.parse(await readFile(path, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      if (!Array.isArray(raw?.secretKey) || raw.secretKey.length !== 32 || !raw.secretKey.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
        throw new Error(`鱼信身份文件 ${path} 无效：需要 32 字节私钥；只有确认要换一个新身份时才删它`);
      }
      if (path !== this.identityPath) {
        // 老 weave 身份复用过来，这样老好友不用重新加；源文件保留不动。
        migrated = raw.secretKey;
        await this.#writeIdentity(migrated);
        this.ctx?.logger?.info?.(`鱼信：已从 ${path} 迁移身份，好友关系无需重建`);
      }
      try {
        await chmod(this.stateDir, 0o700);
        await chmod(this.identityPath, 0o600);
      } catch {}
      return raw.secretKey;
    }
    const secretKey = SecretKey.generate().toBytes();
    await this.#writeIdentity(secretKey);
    return secretKey;
  }

  async #writeIdentity(secretKey) {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await chmod(this.stateDir, 0o700);
    const temporary = `${this.identityPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, secretKey })}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.identityPath);
    await chmod(this.identityPath, 0o600);
  }

  /** 读信任名单；新旧目录都读，两边取并集（老文件只读）。 */
  async #loadPeers() {
    const { EndpointTicket } = await loadIroh();
    const sources = [join(this.legacyDir, 'peers.json'), this.peersPath];
    for (const path of sources) {
      let saved;
      try {
        saved = JSON.parse(await readFile(path, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        if (path === this.peersPath) throw error;
        continue;
      }
      if (Array.isArray(saved?.peerIds)) {
        for (const peerId of saved.peerIds) if (typeof peerId === 'string' && peerId) this.trustedPeers.add(peerId);
      }
      if (Array.isArray(saved?.tickets)) {
        for (const entry of saved.tickets) {
          if (!entry || typeof entry.peerId !== 'string' || typeof entry.ticket !== 'string') continue;
          try {
            const ticketPeer = EndpointTicket.fromString(entry.ticket).endpointAddr().id().toString();
            if (ticketPeer !== entry.peerId) continue;
            this.trustedPeers.add(entry.peerId);
            this.peerTickets.set(entry.peerId, entry.ticket);
          } catch {
            // 票据坏掉只丢地址，peer 仍然可信；重新配对会写一份新票据。
          }
        }
      }
    }
    try {
      await chmod(this.stateDir, 0o700);
      await chmod(this.peersPath, 0o600);
    } catch {}
  }

  /** 串行化写盘，避免并发写同一文件。 */
  async #savePeers() {
    const save = this.saveTail.then(async () => {
      await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
      await chmod(this.stateDir, 0o700);
      const temporary = `${this.peersPath}.${randomUUID()}.tmp`;
      const body = { version: 2, peerIds: this.peers(), tickets: this.endpoints() };
      await writeFile(temporary, `${JSON.stringify(body)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.peersPath);
      await chmod(this.peersPath, 0o600);
    });
    this.saveTail = save.catch(() => {});
    return save;
  }

  async close() {
    this.closed = true;
    this.lifetime.abort();
    this.starting = undefined;
    const endpoint = this.endpoint;
    this.endpoint = undefined;
    for (const controller of this.inbound.values()) controller.abort();
    if (endpoint && !endpoint.isClosed()) await endpoint.close();
    if (this.inbound.size) {
      let timer;
      await Promise.race([
        Promise.allSettled([...this.inbound.keys()]),
        new Promise((resolve) => {
          timer = setTimeout(resolve, this.shutdownTimeoutMs);
          timer.unref?.();
        }),
      ]).finally(() => clearTimeout(timer));
    }
    this.inbound.clear();
    this.recentMessages.clear();
    this.hostStates.clear();
    this.listeners.clear();
  }

  /* ---------------------------------------------------------------- 对外 API */

  /** 本机票据：对方用它加你为好友。 */
  async ticket() {
    const { EndpointTicket } = await loadIroh();
    return EndpointTicket.fromAddr((await this.start()).addr()).toString();
  }

  /** 用对方票据建立信任关系，返回 peerId。 */
  async trust(ticket) {
    const { EndpointTicket } = await loadIroh();
    await this.ready;
    const id = EndpointTicket.fromString(ticket).endpointAddr().id().toString();
    this.trustedPeers.add(id);
    this.peerTickets.set(id, ticket);
    await this.#savePeers();
    return id;
  }

  async untrust(peerId) {
    await this.ready;
    if (typeof peerId !== 'string' || !peerId) throw new Error('需要 peerId');
    const removed = this.trustedPeers.delete(peerId) || this.peerTickets.delete(peerId);
    this.peerTickets.delete(peerId);
    this.hostStates.delete(peerId);
    await this.#savePeers();
    return removed;
  }

  /**
   * 只解析票据里的 peerId，不改信任关系。
   * 同步接口（界面层按同步用），因此要求引擎已加载——实际调用点都是先
   * `await ticket()` / `await trust()` 再调它，那时引擎必然就绪。
   */
  identify(ticket) {
    const { EndpointTicket } = engine ?? {};
    if (!EndpointTicket) throw new Error('鱼信 P2P 引擎尚未加载，先取一次本机票据再解析');
    return EndpointTicket.fromString(ticket).endpointAddr().id().toString();
  }

  peers() {
    return [...this.trustedPeers].sort();
  }

  endpoints() {
    return [...this.peerTickets]
      .map(([peerId, ticket]) => ({ peerId, ticket }))
      .sort((a, b) => a.peerId.localeCompare(b.peerId));
  }

  hosts() {
    return this.peers().map((hostId) => ({
      hostId,
      addressKnown: this.peerTickets.has(hostId),
      state: this.peerTickets.has(hostId) ? (this.hostStates.get(hostId) ?? 'unknown') : 'unpaired',
    }));
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 按 hostId 发一条；会顺带维护在线状态。 */
  async sendTo({ hostId, from, to, text, id, timeoutMs, signal }) {
    signal = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    await withSignal(this.ready, signal);
    signal.throwIfAborted();
    const ticket = this.peerTickets.get(hostId);
    if (!ticket) throw new Error(`好友 ${hostId} 没有可用的地址票据，请在鱼信里重新加一次`);
    const previousState = this.hostStates.get(hostId);
    this.hostStates.set(hostId, 'connecting');
    try {
      const result = await this.send({ ticket, from, to, text, id, timeoutMs, signal });
      this.hostStates.set(hostId, 'online');
      return result;
    } catch (error) {
      if (!this.closed) this.hostStates.set(hostId, signal.aborted ? (previousState ?? 'unknown') : 'offline');
      throw error;
    }
  }

  /** 按票据直接发一条，等对端应答。 */
  async send({ ticket, from, to, text, id = randomUUID(), timeoutMs = this.acknowledgementTimeoutMs, signal }) {
    if (typeof text !== 'string' || text.trim() === '') throw new Error('鱼信消息内容不能为空');
    const deadline = new AbortController();
    signal = AbortSignal.any([this.lifetime.signal, deadline.signal, ...(signal ? [signal] : [])]);
    signal.throwIfAborted();
    const timer = setTimeout(() => deadline.abort(new Error(`等对端应答超时（${timeoutMs}ms）`)), timeoutMs);
    timer.unref?.();
    let connection;
    const close = () => connection?.close(0n, []);
    signal.addEventListener('abort', close, { once: true });
    try {
      const { EndpointTicket } = await loadIroh();
      const endpoint = await withSignal(this.start(), signal);
      signal.throwIfAborted();
      const address = EndpointTicket.fromString(ticket).endpointAddr();
      const peerId = address.id().toString();
      if (!this.trustedPeers.has(peerId)) throw new Error(`对方 ${peerId} 不在信任名单里，先加好友`);
      await withSignal(
        endpoint.connect(address, ALPN_BYTES).then((connected) => {
          connection = connected;
          if (signal.aborted) close();
        }),
        signal,
      );
      signal.throwIfAborted();
      const stream = await withSignal(connection.openBi(), signal);
      signal.throwIfAborted();
      const frame = { kind: 'dsh-weave/message', version: DSH_IM_PROTOCOL_VERSION, id, from, to, text };
      await withSignal(stream.send.writeAll(encode(frame)), signal);
      await withSignal(stream.send.finish(), signal);
      const acknowledgement = decode(await withSignal(stream.recv.readToEnd(4096), signal));
      signal.throwIfAborted();
      if (acknowledgement?.ok !== true || acknowledgement.id !== id) {
        throw new Error(acknowledgement?.error ?? '对方拒绝了这条消息');
      }
      return { id, peerId, delivered: true, result: acknowledgement.result };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', close);
      close();
    }
  }

  /* ------------------------------------------------------------ 入站处理 */

  async #acceptLoop() {
    const endpoint = this.endpoint;
    if (!endpoint) return;
    try {
      while (!endpoint.isClosed()) {
        if (this.inbound.size >= this.maxConcurrentInbound) await Promise.race(this.inbound.keys());
        const incoming = await endpoint.acceptNext();
        if (!incoming) return;
        const controller = new AbortController();
        const task = this.#accept(incoming, controller.signal).finally(() => this.inbound.delete(task));
        this.inbound.set(task, controller);
      }
    } catch (error) {
      if (!endpoint.isClosed()) console.warn('鱼信入站循环停止', error);
    }
  }

  async #accept(incoming, signal) {
    let connection;
    let stream;
    let messageId;
    try {
      connection = await (await incoming.accept()).connect();
      const disconnected = new AbortController();
      connection.closed().then(
        () => disconnected.abort(),
        () => disconnected.abort(),
      );
      signal = AbortSignal.any([signal, disconnected.signal]);
      const peerId = connection.remoteId().toString();
      stream = await connection.acceptBi();
      if (signal.aborted) return;
      if (!this.trustedPeers.has(peerId)) throw new Error(`对方 ${peerId} 不在信任名单里`);
      this.hostStates.set(peerId, 'online');
      const message = decode(await stream.recv.readToEnd(MAX_FRAME_BYTES));
      messageId = message?.id;
      const fields = [message?.id, message?.from, message?.to, message?.text];
      if (message?.kind !== 'dsh-weave/message' || message.version !== DSH_IM_PROTOCOL_VERSION) {
        throw new Error('不是鱼信消息帧');
      }
      if (!fields.every((value) => typeof value === 'string' && value)) throw new Error('消息帧字段不完整');
      if (signal.aborted) return;
      const received = Object.freeze({ ...message, peerId, receivedAt: Date.now() });

      // 同一个 id 重复到达时直接回放上次结果，不重复投递。
      const dedupeKey = `${peerId}:${message.id}`;
      const cached = this.recentMessages.get(dedupeKey);
      if (cached !== undefined) {
        const duplicateResult = typeof cached.then === 'function' ? await cached : cached.result;
        if (signal.aborted) return;
        await stream.send.writeAll(encode({ ok: true, id: message.id, result: duplicateResult }));
        await stream.send.finish();
        return;
      }

      const processing = this.#dispatch(received, signal).then(
        (result) => {
          if (!this.closed) this.recentMessages.set(dedupeKey, { result, settledAt: Date.now() });
          return result;
        },
        (error) => {
          this.recentMessages.delete(dedupeKey);
          throw error;
        },
      );
      this.recentMessages.set(dedupeKey, processing);
      this.#evictRecentMessages();
      const result = await processing;
      if (signal.aborted) return;
      await stream.send.writeAll(encode({ ok: true, id: message.id, result }));
      await stream.send.finish();
    } catch (error) {
      if (signal.aborted) return;
      this.ctx?.logger?.warn?.('鱼信拒收了入站帧', error);
      if (stream && typeof messageId === 'string') {
        try {
          await stream.send.writeAll(encode({ ok: false, id: messageId, error: String(error?.message ?? error) }));
          await stream.send.finish();
        } catch {
          // 应答尽力而为：这条流已经断了就没有第二条通道能通知对端。
        }
      }
    } finally {
      if (connection) {
        // QUIC 关闭连接会丢弃未读数据，所以先等对端读完应答再关；有上限，
        // 免得一个永不关闭的对端长期占住入站槽位。
        if (!signal.aborted) {
          const peerClosed = connection.closed().catch(() => undefined);
          let closeTimer;
          await withSignal(
            Promise.race([
              peerClosed,
              new Promise((resolve) => {
                closeTimer = setTimeout(resolve, this.acknowledgementTimeoutMs);
                closeTimer.unref?.();
              }),
            ]),
            signal,
          )
            .catch(() => {})
            .finally(() => clearTimeout(closeTimer));
        }
        connection.close(0n, []);
      }
    }
  }

  #evictRecentMessages() {
    const now = Date.now();
    for (const [key, entry] of this.recentMessages) {
      if (typeof entry.then === 'function') continue;
      if (now - entry.settledAt >= this.recentMessageTtlMs) this.recentMessages.delete(key);
    }
    while (this.recentMessages.size > this.recentMessageLimit) {
      const next = this.recentMessages.entries().next().value;
      if (!next || typeof next[1].then === 'function') return;
      this.recentMessages.delete(next[0]);
    }
  }

  /**
   * 把帧交给订阅者。没人认领时返回 undefined——这不算错误，
   * 对端可能是别的协议的发送方，静默丢弃比报错更好排查。
   */
  async #dispatch(received, signal) {
    signal?.throwIfAborted();
    for (const listener of this.listeners) {
      signal?.throwIfAborted();
      const outcome = await withSignal(listener(received, { signal }), signal);
      if (outcome === true) return undefined
      if (outcome && typeof outcome === 'object' && outcome.claimed === true) return outcome.result;
    }
    return undefined;
  }
}
