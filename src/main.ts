import { Notice, Plugin, TFile } from "obsidian";
import { checkHealth, extractFavorite, registerVaultConfig, syncFavorites } from "./backend";
import {
  DEFAULT_SETTINGS,
  type DouyinSyncSettings,
  type FavoriteItem,
  sanitizeWhisperModel,
} from "./settings";
import { DouyinSyncSettingTab } from "./settingTab";
import {
  buildDouyinIdIndexFromStored,
  collectKnownDouyinIdsFromIndex,
  collectKnownDouyinNotesFromIndex,
  findExistingDouyinNote,
  rebuildIndexFromVault,
  writeFavoriteNote,
} from "./vaultWriter";

export default class DouyinSyncPlugin extends Plugin {
  settings: DouyinSyncSettings = { ...DEFAULT_SETTINGS };
  private statusBarItem!: HTMLElement;
  private syncInProgress = false;
  private backendConnected = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new DouyinSyncSettingTab(this.app, this));

    // Ribbon icon
    this.addRibbonIcon("sync", "同步抖音收藏", () => void this.syncFavoritesNow());

    // Status bar
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass("douyin-sync-statusbar");
    this.statusBarItem.setText("抖音同步就绪");

    // Commands
    this.addCommand({
      id: "sync-favorites-now",
      name: "立即同步抖音收藏",
      callback: () => void this.syncFavoritesNow(),
    });

    this.addCommand({
      id: "check-backend",
      name: "检查后端连接状态",
      callback: () => void this.showBackendNotice(),
    });

    // Startup health check
    if (this.app.workspace.layoutReady) {
      void this.onWorkspaceReady();
    } else {
      this.app.workspace.onLayoutReady(() => void this.onWorkspaceReady());
    }

    this.registerInterval(
      window.setInterval(() => void this.checkScheduledSync(), 60 * 1000)
    );

    // Auto-reconnect: when disconnected, check every 30s
    this.registerInterval(
      window.setInterval(() => void this.autoReconnect(), 30 * 1000)
    );
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<DouyinSyncSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved ?? {});
    this.settings.whisperModel = sanitizeWhisperModel(this.settings.whisperModel);
    if (/^\d{4}-\d{2}-\d{2}$/.test(this.settings.lastRunDate)) {
      this.settings.lastRunDate = `${this.settings.lastRunDate} ${this.settings.syncTime}:00`;
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    void this.registerVaultWithBackend();
  }

  private async onWorkspaceReady(): Promise<void> {
    await this.updateStatusBar();
    await this.registerVaultWithBackend();
    await this.checkScheduledSync();
  }

  private getVaultBasePath(): string | null {
    const adapter = this.app.vault.adapter as unknown as {
      getBasePath?: () => string;
      basePath?: string;
    };
    return adapter.getBasePath?.() ?? adapter.basePath ?? null;
  }

  private async registerVaultWithBackend(): Promise<void> {
    const vaultPath = this.getVaultBasePath();
    if (!vaultPath) return;
    const health = await checkHealth(this.settings.backendUrl);
    if (!health.ok) return;
    try {
      const knownNotes = collectKnownDouyinNotesFromIndex(this.settings.knownDouyinIndex);
      await registerVaultConfig(this.settings.backendUrl, this.settings, vaultPath, knownNotes);
    } catch (e) {
      console.warn("Failed to register Douyin vault config", e);
    }
  }

  async checkBackendStatus(): Promise<{ ok: boolean; status?: number; error?: string }> {
    return checkHealth(this.settings.backendUrl);
  }

  /** Rebuild the persisted dedup index by scanning existing vault notes. */
  async rebuildDedupIndex(): Promise<number> {
    const index = await rebuildIndexFromVault(this.app, this.settings.noteFolder);
    this.settings.knownDouyinIndex = index;
    await this.saveData(this.settings);
    return Object.keys(index).length;
  }

  private async updateStatusBar(): Promise<void> {
    const result = await this.checkBackendStatus();
    this.backendConnected = result.ok;
    if (result.ok) {
      this.statusBarItem.setText("● 抖音同步已连接");
      this.statusBarItem.addClass("douyin-sync-statusbar--ok");
      this.statusBarItem.removeClass("douyin-sync-statusbar--error");
    } else {
      this.statusBarItem.setText("○ 抖音同步未连接");
      this.statusBarItem.removeClass("douyin-sync-statusbar--ok");
      this.statusBarItem.addClass("douyin-sync-statusbar--error");
    }
  }

  private async autoReconnect(): Promise<void> {
    // 始终做真实健康检查：后端随时可能重启/宕机，
    // 不能因为本地缓存的连接状态就跳过探测
    const result = await this.checkBackendStatus();
    const wasConnected = this.backendConnected;
    this.backendConnected = result.ok;
    if (result.ok) {
      // 粘性状态：同步结果（● 已同步 · N 条）不被 30s 健康检查覆盖，
      // 仅在连接状态实际变化（断连恢复）时才刷新文案
      if (!wasConnected) {
        this.statusBarItem.setText("● 抖音同步已连接");
      }
      this.statusBarItem.addClass("douyin-sync-statusbar--ok");
      this.statusBarItem.removeClass("douyin-sync-statusbar--error");
    } else {
      this.statusBarItem.setText("○ 抖音同步未连接");
      this.statusBarItem.removeClass("douyin-sync-statusbar--ok");
      this.statusBarItem.addClass("douyin-sync-statusbar--error");
    }
    if (result.ok && !wasConnected) {
      new Notice("✅ 抖音同步后端已连接", 3000);
      // Backend just came back — try registering vault and checking scheduled sync
      void this.registerVaultWithBackend();
      void this.checkScheduledSync();
    }
  }

  private async showBackendNotice(): Promise<void> {
    const result = await this.checkBackendStatus();
    if (result.ok) {
      new Notice("✅ 后端已连接：" + this.settings.backendUrl, 4000);
    } else if (result.status) {
      new Notice("⚠️ 后端异常：HTTP " + result.status, 5000);
    } else {
      new Notice("❌ 后端未连接：" + (result.error ?? this.settings.backendUrl), 5000);
    }
    void this.updateStatusBar();
  }

  async syncFavoritesNow(): Promise<void> {
    await this.runSync({ scheduled: false });
  }

  private pad2(n: number): string {
    return n < 10 ? `0${n}` : String(n);
  }

  private todayKey(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = this.pad2(now.getMonth() + 1);
    const day = this.pad2(now.getDate());
    return `${year}-${month}-${day}`;
  }

  private localDateTimeKey(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = this.pad2(now.getMonth() + 1);
    const day = this.pad2(now.getDate());
    const hour = this.pad2(now.getHours());
    const minute = this.pad2(now.getMinutes());
    const second = this.pad2(now.getSeconds());
    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
  }

  private isAtOrAfterSyncTime(): boolean {
    const match = this.settings.syncTime.match(/^(\d{2}):(\d{2})$/);
    if (!match) return false;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return false;
    const now = new Date();
    return now.getHours() > hour || (now.getHours() === hour && now.getMinutes() >= minute);
  }

  private async checkScheduledSync(): Promise<void> {
    if (!this.settings.autoSyncEnabled) return;
    if (this.syncInProgress) return;
    if (this.settings.lastRunDate.startsWith(this.todayKey())) return;
    if (!this.isAtOrAfterSyncTime()) return;
    // 失败退避：未到下次允许尝试时间则跳过，避免频繁重试
    if (Date.now() < this.settings.scheduledNextAttemptAt) return;
    await this.runSync({ scheduled: true });
  }

  /**
   * 记录一次定时同步失败并计算退避：5/10/20/40 分钟，封顶 60 分钟。
   * 连续 8 次失败后当天放弃（次日自动恢复）；手动同步成功会重置计数。
   */
  private async noteScheduledFailure(): Promise<string> {
    const n = this.settings.scheduledFailCount + 1;
    this.settings.scheduledFailCount = n;
    let nextAt: number;
    let hint: string;
    if (n >= 8) {
      const endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 999);
      nextAt = endOfDay.getTime();
      hint = "（连续失败已达上限，今天不再自动重试，明天自动恢复）";
      console.warn("[DouyinSync] Scheduled sync gave up for today after", n, "failures");
    } else {
      const minutes = Math.min(5 * 2 ** (n - 1), 60);
      nextAt = Date.now() + minutes * 60 * 1000;
      hint = `（将在 ${minutes} 分钟后自动重试）`;
    }
    this.settings.scheduledNextAttemptAt = nextAt;
    // 仅落盘退避状态，不触发 saveSettings 的后端注册探测
    await this.saveData(this.settings);
    return hint;
  }

  private async markRunComplete(): Promise<void> {
    this.settings.lastRunDate = this.localDateTimeKey();
    this.settings.scheduledFailCount = 0;
    this.settings.scheduledNextAttemptAt = 0;
    await this.saveSettings();
  }

  private async runSync(options: { scheduled: boolean }): Promise<boolean> {
    if (this.syncInProgress) {
      if (!options.scheduled) new Notice("抖音同步正在运行中。", 4000);
      return false;
    }
    this.syncInProgress = true;
    this.statusBarItem.setText("⏳ 同步中…");
    this.statusBarItem.removeClass("douyin-sync-statusbar--ok", "douyin-sync-statusbar--error");

    try {
      const health = await checkHealth(this.settings.backendUrl);
      if (!health.ok) {
        const msg = "后端未连接：" + this.settings.backendUrl;
        if (!options.scheduled) {
          new Notice("❌ " + msg, 7000);
        } else {
          const retryInfo = await this.noteScheduledFailure();
          console.warn("[DouyinSync] Scheduled sync skipped — backend unavailable:", msg);
          new Notice(`⏰ 定时同步失败：后端未连接${retryInfo}`, 5000);
        }
        void this.updateStatusBar();
        return false;
      }

      // Migrate: if the persisted index is empty, do a one-time vault scan to rebuild it
      if (Object.keys(this.settings.knownDouyinIndex).length === 0) {
        this.settings.knownDouyinIndex = await rebuildIndexFromVault(this.app, this.settings.noteFolder);
        await this.saveSettings();
      }

      let favorites: FavoriteItem[] = [];
      try {
        const knownIds = collectKnownDouyinIdsFromIndex(this.settings.knownDouyinIndex);
        favorites = await syncFavorites(this.settings.backendUrl, knownIds, 30);
      } catch (e) {
        const msg = String(e);
        if (msg.includes("AUTH_EXPIRED")) {
          const retryInfo = options.scheduled ? await this.noteScheduledFailure() : "";
          new Notice(`🔐 Cookie 过期或缺失，请先更新后端 cookie.json。${retryInfo}`, 8000);
        } else {
          if (!options.scheduled) {
            new Notice("❌ 拉取收藏失败：" + msg, 8000);
          } else {
            const retryInfo = await this.noteScheduledFailure();
            console.warn("[DouyinSync] Scheduled sync failed:", msg);
            new Notice(`⏰ 定时同步失败：${msg}${retryInfo}`, 8000);
          }
        }
        void this.updateStatusBar();
        return false;
      }

      if (favorites.length === 0) {
        if (!options.scheduled) new Notice("✨ 没有新的抖音收藏。", 4000);
        this.statusBarItem.setText("● 已同步 · 无新内容");
        this.statusBarItem.addClass("douyin-sync-statusbar--ok");
        await this.markRunComplete();
        return true;
      }

      if (!options.scheduled) {
        new Notice(`📥 开始导入 ${favorites.length} 条收藏…`, 4000);
      }

      // Build dedup lookup Map from the persisted index (no vault scan)
      const douyinIndex = buildDouyinIdIndexFromStored(this.app, this.settings.knownDouyinIndex);

      let imported = 0;
      let failed = 0;
      let skipped = 0;
      let lastFile: TFile | null = null;

      for (let i = 0; i < favorites.length; i++) {
        const favorite = favorites[i];
        this.statusBarItem.setText(`⏳ 同步中 ${i + 1}/${favorites.length}`);
        try {
          const extract = await extractFavorite(
            this.settings.backendUrl,
            favorite.share_url,
            this.settings.mode,
            this.settings.whisperModel
          );
          const existing = findExistingDouyinNote(
            douyinIndex,
            extract.douyin_id || favorite.aweme_id
          );
          if (existing) {
            skipped++;
            continue;
          }
          const result = await writeFavoriteNote(this.app, this.settings, favorite, extract);
          lastFile = result.file;
          // Update persisted dedup index with the new note
          this.settings.knownDouyinIndex[result.douyinId] = result.notePath;
          await this.saveData(this.settings);
          imported++;
        } catch (e) {
          console.error("Douyin favorite import failed", favorite.aweme_id, e);
          failed++;
        }
        // Delay between extracts to avoid Douyin rate limiting
        if (i < favorites.length - 1 && this.settings.extractDelaySeconds > 0) {
          this.statusBarItem.setText(`⏳ 等待 ${this.settings.extractDelaySeconds}s…`);
          await sleep(this.settings.extractDelaySeconds * 1000);
        }
      }

      const icon = failed === 0 ? "✅" : "⚠️";
      new Notice(`${icon} 导入完成：${imported} 条成功，${skipped} 条重复跳过，${failed} 条失败。`, 6000);
      this.statusBarItem.setText(`● 已同步 · ${imported} 条`);
      this.statusBarItem.addClass("douyin-sync-statusbar--ok");
      await this.markRunComplete();

      if (lastFile && this.settings.openNoteAfterCreate && !options.scheduled) {
        await this.app.workspace.getLeaf().openFile(lastFile);
      }
      return failed === 0;
    } finally {
      this.syncInProgress = false;
    }
  }
}
