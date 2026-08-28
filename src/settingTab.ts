import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type DouyinSyncPlugin from "./main";
import { WHISPER_MODELS } from "./settings";

const STATUS_CLASSES = {
  ok: "douyin-sync-status--ok",
  error: "douyin-sync-status--error",
  checking: "douyin-sync-status--checking",
} as const;

export class DouyinSyncSettingTab extends PluginSettingTab {
  private statusEl!: HTMLDivElement;
  private statusDot!: HTMLSpanElement;
  private statusText!: HTMLSpanElement;
  private syncButton!: HTMLButtonElement;

  constructor(app: App, private plugin: DouyinSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("douyin-sync-settings");

    // ── Header ──
    this.renderHeader(containerEl);

    // ── Backend Status Card ──
    this.renderStatusCard(containerEl);

    // ── Connection Settings ──
    this.renderConnectionSection(containerEl);

    // ── Sync Settings ──
    this.renderSyncSection(containerEl);

    // ── Note Settings ──
    this.renderNoteSection(containerEl);

    // ── Actions ──
    this.renderActions(containerEl);

    // Initial status check
    void this.refreshStatus();
  }

  /* ──────────────── Header ──────────────── */

  private renderHeader(el: HTMLElement): void {
    const header = el.createDiv({ cls: "douyin-sync-header" });
    header.createEl("h2", { text: "抖音收藏同步 / Douyin Obsidian Sync" });
    header.createEl("p", {
      cls: "douyin-sync-header__desc",
      text: "将抖音收藏自动同步为 Obsidian 笔记，通过本地后端服务实现 / Sync Douyin favorites to Obsidian notes via local backend.",
    });
  }

  /* ──────────────── Status Card ──────────────── */

  private renderStatusCard(el: HTMLElement): void {
    const card = el.createDiv({ cls: "douyin-sync-card douyin-sync-card--status" });

    const titleRow = card.createDiv({ cls: "douyin-sync-card__title-row" });
    titleRow.createEl("span", { cls: "douyin-sync-card__icon", text: "🔗" });
    titleRow.createEl("span", { cls: "douyin-sync-card__title", text: "后端连接状态 / Backend Status" });

    this.statusEl = card.createDiv({ cls: "douyin-sync-status" });
    this.statusDot = this.statusEl.createSpan({ cls: "douyin-sync-status__dot" });
    this.statusText = this.statusEl.createSpan({ cls: "douyin-sync-status__text", text: "检查中…" });
    this.statusEl.addClass(STATUS_CLASSES.checking);
  }

  private async refreshStatus(): Promise<void> {
    this.statusEl.removeClass(STATUS_CLASSES.ok, STATUS_CLASSES.error);
    this.statusEl.addClass(STATUS_CLASSES.checking);
    this.statusText.setText("检查中…");

    const result = await this.plugin.checkBackendStatus();
    this.statusEl.removeClass(STATUS_CLASSES.checking);

    if (result.ok) {
      this.statusEl.addClass(STATUS_CLASSES.ok);
      this.statusText.setText(`已连接 · ${this.plugin.settings.backendUrl}`);
    } else if (result.status) {
      this.statusEl.addClass(STATUS_CLASSES.error);
      this.statusText.setText(`后端异常 · HTTP ${result.status}`);
    } else {
      this.statusEl.addClass(STATUS_CLASSES.error);
      this.statusText.setText(`未连接 · ${result.error ?? this.plugin.settings.backendUrl}`);
    }
  }

  /* ──────────────── Connection Settings ──────────────── */

  private renderConnectionSection(el: HTMLElement): void {
    const section = el.createDiv({ cls: "douyin-sync-section" });
    new Setting(section).setName("连接配置 / Connection").setHeading();

    new Setting(section)
      .setName("后端地址 / Backend URL")
      .setDesc("本地 Python 后端服务地址，默认 http://127.0.0.1:8765")
      .setClass("douyin-sync-setting")
      .addText((text) => {
        text
          .setPlaceholder("http://127.0.0.1:8765")
          .setValue(this.plugin.settings.backendUrl)
          .onChange((value) => {
            this.plugin.settings.backendUrl = value.trim() || "http://127.0.0.1:8765";
            void this.plugin.saveSettings();
          });
        text.inputEl.type = "url";
      });
  }

  /* ──────────────── Sync Settings ──────────────── */

  private renderSyncSection(el: HTMLElement): void {
    const section = el.createDiv({ cls: "douyin-sync-section" });
    new Setting(section).setName("同步配置 / Sync").setHeading();

    new Setting(section)
      .setName("自动同步 / Auto Sync")
      .setDesc("Obsidian 启动后和运行期间会检查是否到达每日同步时间")
      .setClass("douyin-sync-setting")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSyncEnabled).onChange((value) => {
          this.plugin.settings.autoSyncEnabled = value;
          void this.plugin.saveSettings();
        })
      );

    new Setting(section)
      .setName("每日同步时间 / Daily Sync Time")
      .setDesc("格式为 HH:MM；如果 Obsidian 在该时间后启动，会自动补跑一次")
      .setClass("douyin-sync-setting")
      .addText((text) => {
        text
          .setPlaceholder("09:00")
          .setValue(this.plugin.settings.syncTime)
          .onChange((value) => {
            this.plugin.settings.syncTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
              ? value
              : "09:00";
            void this.plugin.saveSettings();
          });
        text.inputEl.type = "time";
      });

    new Setting(section)
      .setName("上次运行时间 / Last Run")
      .setDesc(this.plugin.settings.lastRunDate || "尚未运行 / Never")
      .setClass("douyin-sync-setting");

    new Setting(section)
      .setName("同步模式 / Sync Mode")
      .setDesc("Light 模式仅同步链接和文案，速度快；Heavy 模式下载视频并转写，耗时较长")
      .setClass("douyin-sync-setting")
      .addDropdown((drop) => {
        drop.addOptions({
          light: "⚡ Light — 仅链接与文案",
          heavy: "🎬 Heavy — 下载视频 + 转写",
        });
        drop.setValue(this.plugin.settings.mode).onChange((value) => {
          this.plugin.settings.mode = value.startsWith("light") ? "light" : "heavy";
          void this.plugin.saveSettings();
        });
      });

    new Setting(section)
      .setName("Whisper 模型 / Whisper Model")
      .setDesc("仅 Heavy 模式视频转写使用；模型越大越精准但越慢，首次使用需下载模型文件")
      .setClass("douyin-sync-setting")
      .addDropdown((drop) => {
        const options: Record<string, string> = {};
        for (const m of WHISPER_MODELS) {
          options[m] = m === "small" ? `${m}（推荐）` : m;
        }
        drop.addOptions(options);
        drop.setValue(this.plugin.settings.whisperModel).onChange((value) => {
          this.plugin.settings.whisperModel = WHISPER_MODELS.find((m) => m === value) ?? "small";
          void this.plugin.saveSettings();
        });
      });

    new Setting(section)
      .setName("创建后打开最后一篇笔记 / Open Last Note")
      .setDesc("同步完成后自动打开最后导入的笔记")
      .setClass("douyin-sync-setting")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.openNoteAfterCreate).onChange((value) => {
          this.plugin.settings.openNoteAfterCreate = value;
          void this.plugin.saveSettings();
        })
      );

    new Setting(section)
      .setName("提取间隔 / Extract Delay")
      .setDesc("每条收藏提取之间的等待秒数，用于避免抖音限流（0 为不等待；heavy 模式含下载+转写，建议 ≥10s）")
      .setClass("douyin-sync-setting")
      .addSlider((slider) => {
        slider
          .setLimits(0, 60, 1)
          .setValue(this.plugin.settings.extractDelaySeconds)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.extractDelaySeconds = value;
            void this.plugin.saveSettings();
          });
      });
  }

  /* ──────────────── Note Settings ──────────────── */

  private renderNoteSection(el: HTMLElement): void {
    const section = el.createDiv({ cls: "douyin-sync-section" });
    new Setting(section).setName("笔记配置 / Notes").setHeading();

    new Setting(section)
      .setName("笔记文件夹 / Note Folder")
      .setDesc("存放抖音笔记的 Vault 文件夹路径")
      .setClass("douyin-sync-setting")
      .addText((text) => {
        text
          .setPlaceholder("Douyin")
          .setValue(this.plugin.settings.noteFolder)
          .onChange((value) => {
            this.plugin.settings.noteFolder = value.trim() || "Douyin";
            void this.plugin.saveSettings();
          });
      });

    new Setting(section)
      .setName("附件文件夹 / Attachment Folder")
      .setDesc("存放视频、图片等附件的路径（Heavy 模式使用）")
      .setClass("douyin-sync-setting")
      .addText((text) => {
        text
          .setPlaceholder("attachments/douyin")
          .setValue(this.plugin.settings.attachmentFolder)
          .onChange((value) => {
            this.plugin.settings.attachmentFolder = value.trim() || "attachments/douyin";
            void this.plugin.saveSettings();
          });
      });
  }

  /* ──────────────── Actions ──────────────── */

  private renderActions(el: HTMLElement): void {
    const section = el.createDiv({ cls: "douyin-sync-section douyin-sync-section--actions" });

    new Setting(section)
      .setName("手动同步 / Manual Sync")
      .setDesc("立即拉取新的抖音收藏并导入为笔记")
      .setClass("douyin-sync-setting")
      .addButton((button) => {
        button.setButtonText("立即同步").setClass("douyin-sync-btn--primary").onClick(() => {
          void this.handleSync(button.buttonEl);
        });
        this.syncButton = button.buttonEl;
      });

    new Setting(section)
      .setName("检查后端 / Check Backend")
      .setDesc("测试与本地后端服务的连接")
      .setClass("douyin-sync-setting")
      .addButton((button) =>
        button.setButtonText("重新检查").onClick(() => {
          button.setButtonText("检查中…");
          button.setDisabled(true);
          void this.refreshStatus().then(() => {
            const ok = this.statusEl.hasClass(STATUS_CLASSES.ok);
            new Notice(ok ? "✅ 后端已连接" : "❌ 后端未连接", 3000);
            button.setButtonText("重新检查");
            button.setDisabled(false);
          });
        })
      );
  }

  private async handleSync(button: HTMLButtonElement): Promise<void> {
    const original = button.textContent;
    button.textContent = "同步中…";
    button.disabled = true;
    button.addClass("douyin-sync-btn--loading");

    try {
      await this.plugin.syncFavoritesNow();
    } finally {
      button.textContent = original;
      button.disabled = false;
      button.removeClass("douyin-sync-btn--loading");
      void this.refreshStatus();
    }
  }
}
