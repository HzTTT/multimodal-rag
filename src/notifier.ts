/**
 * 索引通知器 - 批次聚合 + Agent 触发
 */

import type { PluginRuntime } from "openclaw/plugin-sdk";
import type { MediaType, NotificationConfig, IndexEventCallbacks } from "./types.js";

type BatchFileStatus = "queued" | "indexed" | "skipped" | "failed";
type BatchFile = { status: BatchFileStatus; fileType?: MediaType; error?: string };
type AgentConfigEntry = {
  id?: string;
  default?: boolean;
};
type MainSessionConfig = {
  agents?: {
    list?: AgentConfigEntry[];
  };
  session?: {
    store?: string;
  };
};
type RuntimeSystemCompat = {
  runCommandWithTimeout?: PluginRuntime["system"]["runCommandWithTimeout"];
};
type NotificationTargetResolved = {
  channel: string;
  to: string;
  accountId?: string;
};
type RootConfigCompat = MainSessionConfig;

/**
 * IndexNotifier 负责聚合索引事件并触发 agent 通知
 * 
 * 工作流程:
 * 1. 首个文件入队 -> 开始批次聚合（不立即通知）
 * 2. 持续聚合文件状态
 * 3. 当出现首个“有效结果”（indexed/failed）且批次仍有 queued 文件 -> 发送"开始索引"通知
 * 4. 当批次内最后一个 queued 文件完成（无 queued）-> 发送"索引完成总结"通知
 * 5. 若出现异常卡住，依赖 batchTimeout 兜底完成批次
 */
export class IndexNotifier implements IndexEventCallbacks {
  private state: "idle" | "batching" = "idle";
  private batch: Map<string, BatchFile> = new Map();
  private batchStartTime = 0;
  private startNotificationSent = false;
  private batchTimeoutTimer: NodeJS.Timeout | null = null;
  private deliveryChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: NotificationConfig,
    private readonly runtime: PluginRuntime,
    private readonly logger: { info?: (msg: string) => void; warn?: (msg: string) => void },
    private readonly mainSessionConfig?: MainSessionConfig,
  ) {}

  dispose(): void {
    this.clearTimers();
    this.batch.clear();
    this.batchStartTime = 0;
    this.startNotificationSent = false;
    this.state = "idle";
  }

  /**
   * 文件入队事件
   */
  onFileQueued(filePath: string): void {
    this.batch.set(filePath, { status: "queued" });

    if (this.state === "idle") {
      // 首个文件，开始批次
      this.state = "batching";
      this.batchStartTime = Date.now();
      this.startNotificationSent = false;

      // 设置批次最大超时
      this.batchTimeoutTimer = setTimeout(() => {
        this.finalizeBatch();
      }, this.config.batchTimeoutMs);
    }
  }

  /**
   * 文件索引成功事件
   */
  onFileIndexed(filePath: string, fileType: MediaType): void {
    if (this.state === "idle" && !this.batch.has(filePath)) {
      return;
    }
    this.batch.set(filePath, { status: "indexed", fileType });
    if (this.hasQueuedFiles()) {
      this.maybeSendStartNotification();
    }
    this.maybeFinalizeBatchIfSettled();
  }

  /**
   * 文件跳过事件（例如已存在的重复内容）
   */
  onFileSkipped(filePath: string, fileType: MediaType, _reason?: string): void {
    if (this.state === "idle" && !this.batch.has(filePath)) {
      return;
    }
    this.batch.set(filePath, { status: "skipped", fileType });
    this.maybeFinalizeBatchIfSettled();
  }

  /**
   * 文件索引失败事件
   */
  onFileFailed(filePath: string, error: string): void {
    if (this.state === "idle" && !this.batch.has(filePath)) {
      return;
    }
    this.batch.set(filePath, { status: "failed", error });
    if (this.hasQueuedFiles()) {
      this.maybeSendStartNotification();
    }
    this.maybeFinalizeBatchIfSettled();
  }

  /**
   * 批次完成，发送总结
   */
  private finalizeBatch(): void {
    if (this.state !== "batching") {
      return;
    }

    this.clearTimers();
    if (this.batch.size > 0 && (this.hasMeaningfulResults() || this.startNotificationSent)) {
      this.triggerAgent(this.buildSummaryMessage());
    } else {
      this.logger.info?.("Skip notification: empty batch");
    }

    // 重置状态
    this.batch.clear();
    this.batchStartTime = 0;
    this.startNotificationSent = false;
    this.state = "idle";
  }

  private maybeSendStartNotification(): void {
    if (this.startNotificationSent || this.state !== "batching") {
      return;
    }
    this.startNotificationSent = true;
    this.triggerAgent(this.buildStartMessage());
  }

  private maybeFinalizeBatchIfSettled(): void {
    if (this.state !== "batching") {
      return;
    }
    if (!this.hasQueuedFiles()) {
      this.finalizeBatch();
    }
  }

  private hasQueuedFiles(): boolean {
    return [...this.batch.values()].some((f) => f.status === "queued");
  }

  private hasMeaningfulResults(): boolean {
    for (const file of this.batch.values()) {
      if (file.status === "indexed" || file.status === "failed") {
        return true;
      }
    }
    return false;
  }

  /**
   * 清理所有计时器
   */
  private clearTimers(): void {
    if (this.batchTimeoutTimer) {
      clearTimeout(this.batchTimeoutTimer);
      this.batchTimeoutTimer = null;
    }
  }

  /**
   * 触发通知：仅保留 agent 主动回复链路。
   */
  private triggerAgent(text: string): void {
    // 保证通知顺序可预测，避免“开始/完成”乱序投递。
    this.deliveryChain = this.deliveryChain
      .then(() => this.triggerAgentInternal(text))
      .catch((err) => {
        this.logger.warn?.(`Failed to enqueue notification trigger: ${String(err)}`);
      });
  }

  private async triggerAgentInternal(text: string): Promise<void> {
    const system = this.runtime.system as unknown as RuntimeSystemCompat;

    try {
      if (await this.dispatchViaAgentTurn(text, system)) {
        return;
      }
      this.logger.warn?.(`Notification agent trigger failed for all targets: ${text.slice(0, 80)}...`);
    } catch (err) {
      this.logger.warn?.(`Failed to trigger notification: ${String(err)}`);
    }
  }

  /**
   * 通过 `openclaw agent --deliver` 触发 agent 主动回复用户。
   * 这条路径会让最终消息由 agent 生成并投递，而不是插件直接发送文本。
   */
  private async dispatchViaAgentTurn(
    text: string,
    system: RuntimeSystemCompat,
  ): Promise<boolean> {
    if (typeof system.runCommandWithTimeout !== "function") {
      return false;
    }

    const targets = await this.resolveNotificationTargets();
    const deliveryTargets: Array<NotificationTargetResolved | undefined> =
      targets.length > 0 ? targets : [undefined];

    let successCount = 0;
    for (const target of deliveryTargets) {
      const argv = this.buildAgentNotifyCommand(text, target);
      const targetLabel = this.formatTargetLabel(target);
      try {
        const result = await system.runCommandWithTimeout(argv, { timeoutMs: 180000 });
        if (result.code === 0) {
          successCount += 1;
          continue;
        }
        const detail = (result.stderr || result.stdout || "no output").trim();
        this.logger.warn?.(
          `Notification agent trigger failed (${targetLabel}, code=${String(result.code)}): ${detail}`,
        );
      } catch (err) {
        this.logger.warn?.(`Notification agent trigger error (${targetLabel}): ${String(err)}`);
      }
    }

    if (successCount > 0) {
      this.logger.info?.(
        `Notification delivered via agent turns (${successCount}/${deliveryTargets.length}): ${text.slice(0, 80)}...`,
      );
      return true;
    }

    return false;
  }


  private async resolveNotificationTargets(): Promise<NotificationTargetResolved[]> {
    const explicitTargets = Array.isArray(this.config.targets) ? this.config.targets : [];
    const normalizedTargets = explicitTargets
      .map((target) => ({
        channel: typeof target?.channel === "string" ? target.channel.trim() : "",
        to: typeof target?.to === "string" ? target.to.trim() : "",
        accountId:
          typeof target?.accountId === "string" && target.accountId.trim()
            ? target.accountId.trim()
            : undefined,
      }))
      .filter((target) => target.channel.length > 0 && target.to.length > 0);
    if (normalizedTargets.length > 0) {
      return normalizedTargets;
    }

    const channel =
      typeof this.config.channel === "string" && this.config.channel.trim()
        ? this.config.channel.trim()
        : "";
    const to = typeof this.config.to === "string" && this.config.to.trim() ? this.config.to.trim() : "";
    if (!channel || !to) {
      const latestActive = await this.resolveLatestActiveTarget();
      if (latestActive) {
        return [latestActive];
      }
      return [];
    }

    return [{ channel, to }];
  }

  /**
   * 自动回退：从 session store 里挑选最近活跃且可投递的目标。
   */
  private async resolveLatestActiveTarget(): Promise<NotificationTargetResolved | null> {
    try {
      const cfg = this.runtime.config.loadConfig() as RootConfigCompat;
      const storePath = this.runtime.channel.session.resolveStorePath(cfg.session?.store);
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(storePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      let winner: { updatedAt: number; target: NotificationTargetResolved } | null = null;

      for (const entry of Object.values(parsed)) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const record = entry as Record<string, unknown>;
        const rawChannel = typeof record.lastChannel === "string" ? record.lastChannel.trim() : "";
        const rawTo = typeof record.lastTo === "string" ? record.lastTo.trim() : "";
        if (!rawChannel || !rawTo || rawChannel === "webchat") {
          continue;
        }
        const updatedAt =
          typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
            ? record.updatedAt
            : 0;
        const accountId =
          typeof record.lastAccountId === "string" && record.lastAccountId.trim().length > 0
            ? record.lastAccountId.trim()
            : undefined;
        const target: NotificationTargetResolved = {
          channel: rawChannel,
          to: rawTo,
          accountId,
        };

        if (!winner || updatedAt > winner.updatedAt) {
          winner = { updatedAt, target };
        }
      }

      if (winner) {
        this.logger.info?.(
          `Notification auto target resolved from latest active session: ${winner.target.channel}:${winner.target.to}`,
        );
        return winner.target;
      }
    } catch (err) {
      this.logger.warn?.(`Notification auto-target discovery failed: ${String(err)}`);
    }
    return null;
  }

  private resolveNotificationAgentId(): string {
    const configuredAgentId =
      typeof this.config.agentId === "string" ? this.config.agentId.trim() : "";
    if (configuredAgentId) {
      return configuredAgentId;
    }

    const agents = this.mainSessionConfig?.agents?.list ?? [];
    return (
      agents.find((agent) => agent.default && typeof agent.id === "string" && agent.id.trim())
        ?.id?.trim() ??
      agents.find((agent) => typeof agent.id === "string" && agent.id.trim())?.id?.trim() ??
      "main"
    );
  }

  private buildAgentNotifyCommand(
    text: string,
    target: NotificationTargetResolved | undefined,
  ): string[] {
    const nodeExec = process.execPath;
    const cliEntry = process.argv[1];
    const agentId = this.resolveNotificationAgentId();
    const argvCore = [
      "agent",
      "--agent",
      agentId,
      "--message",
      this.buildAgentPrompt(text),
      "--thinking",
      "low",
      "--deliver",
      "--timeout",
      "120",
      "--reply-channel",
      target?.channel ?? "last",
    ];

    if (target?.to) {
      argvCore.push("--reply-to", target.to);
    }
    if (typeof target?.accountId === "string" && target.accountId.length > 0) {
      argvCore.push("--reply-account", target.accountId);
    }

    if (typeof cliEntry === "string" && cliEntry.trim().length > 0) {
      return [nodeExec, cliEntry, ...argvCore];
    }

    return ["openclaw", ...argvCore];
  }

  private buildAgentPrompt(text: string): string {
    return [
      "你收到一条来自 Multimodal RAG 的索引事件通知。",
      "请严格按你当前 agent 的人格设定回复，优先遵循已注入的 IDENTITY.md / SOUL.md。",
      "如果本轮上下文里看不到 IDENTITY.md 或 SOUL.md，请先读取工作区对应文件（存在就读），再回复。",
      "禁止调用 message、sessions_send、sessions_spawn 等消息投递工具；系统会用 --deliver 自动投递。",
      "除非为了读取 IDENTITY.md / SOUL.md，否则不要调用其他工具。",
      "只输出最终发给用户的通知正文，不要输出“已发送/已通知/处理中”等过程状态。",
      "避免模板化官腔，用该 agent 一贯口吻写一段自然中文通知。",
      `事件内容：${text}`,
    ].join("\n");
  }

  private formatTargetLabel(target?: NotificationTargetResolved): string {
    if (!target) {
      return "last";
    }
    return `${target.channel}:${target.to}`;
  }

  /**
   * 构建"开始索引"消息
   */
  private buildStartMessage(): string {
    return "[Multimodal RAG] 新文件索引通知: 已开始处理本轮新增媒体文件，请通知用户。";
  }

  /**
   * 构建"索引完成总结"消息
   */
  private buildSummaryMessage(): string {
    const files = [...this.batch.values()];
    const succeeded = files.filter((f) => f.status === "indexed");
    const skipped = files.filter((f) => f.status === "skipped");
    const failed = files.filter((f) => f.status === "failed");
    const total = succeeded.length + failed.length;

    // 统计成功文件的类型
    const images = succeeded.filter((f) => f.fileType === "image").length;
    const audios = succeeded.filter((f) => f.fileType === "audio").length;

    // 计算耗时
    const durationMs = Date.now() - this.batchStartTime;
    const durationSec = Math.floor(durationMs / 1000);
    const minutes = Math.floor(durationSec / 60);
    const seconds = durationSec % 60;
    const durationStr =
      minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;

    // 构建消息（仅统计本轮真正处理的文件：成功 + 失败，不把 skipped 算进处理总数）
    if (total === 0) {
      if (skipped.length > 0) {
        return `[Multimodal RAG] 索引完成通知: 本轮没有新增文件需要索引（跳过 ${skipped.length} 个已存在文件）。耗时 ${durationStr}。请通知用户。`;
      }
      return `[Multimodal RAG] 索引完成通知: 本轮没有可汇总的处理结果。耗时 ${durationStr}。请通知用户。`;
    }

    let message = `[Multimodal RAG] 索引完成通知: 本轮共处理 ${total} 个文件，`;
    message += `成功 ${succeeded.length} 个`;

    if (images > 0 || audios > 0) {
      const parts: string[] = [];
      if (images > 0) parts.push(`${images} 张图片`);
      if (audios > 0) parts.push(`${audios} 个音频`);
      message += ` (${parts.join(", ")})`;
    }

    if (failed.length > 0) {
      message += `，失败 ${failed.length} 个`;
    }

    if (skipped.length > 0) {
      message += `（另跳过 ${skipped.length} 个已存在文件）`;
    }

    message += `。耗时 ${durationStr}。请发送索引完成总结通知给用户。`;

    return message;
  }
}
