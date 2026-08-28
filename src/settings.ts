export type WhisperModel = "tiny" | "base" | "small" | "medium" | "large-v2" | "large-v3";

export const WHISPER_MODELS: WhisperModel[] = ["tiny", "base", "small", "medium", "large-v2", "large-v3"];

export const VALID_WHISPER_MODELS = new Set<string>(WHISPER_MODELS);

export function sanitizeWhisperModel(value: unknown): WhisperModel {
  return VALID_WHISPER_MODELS.has(value as string) ? (value as WhisperModel) : "small";
}

export interface DouyinSyncSettings {
  backendUrl: string;
  noteFolder: string;
  attachmentFolder: string;
  mode: "light" | "heavy";
  whisperModel: WhisperModel;
  autoSyncEnabled: boolean;
  syncTime: string;
  lastRunDate: string;
  openNoteAfterCreate: boolean;
  extractDelaySeconds: number;
  /** 定时同步连续失败次数（仅统计定时触发，手动同步不计入） */
  scheduledFailCount: number;
  /** 定时同步下次允许尝试的时间戳（epoch ms），0 表示无退避 */
  scheduledNextAttemptAt: number;
  /** Dedup index: maps douyin_id → note_path. Persisted to avoid vault enumeration on every sync. */
  knownDouyinIndex: Record<string, string>;
}

export const DEFAULT_SETTINGS: DouyinSyncSettings = {
  backendUrl: "http://127.0.0.1:8765",
  noteFolder: "Douyin",
  attachmentFolder: "attachments/douyin",
  mode: "light",
  whisperModel: "small",
  autoSyncEnabled: true,
  syncTime: "09:00",
  lastRunDate: "",
  openNoteAfterCreate: false,
  extractDelaySeconds: 10,
  scheduledFailCount: 0,
  scheduledNextAttemptAt: 0,
  knownDouyinIndex: {},
};

export interface FavoriteItem {
  aweme_id: string;
  share_url: string;
  desc: string;
  cover?: string | null;
  create_time?: number | null;
  author?: string;
}

export interface SyncFavoritesResponse {
  items: FavoriteItem[];
}

export interface ExtractResult {
  douyin_id: string;
  video_url?: string | null;
  images: string[];
  desc: string;
  tags: string[];
  transcript?: string | null;
  author?: string;
  cover?: string | null;
  content_type?: "video" | "image";
  source?: string;
  out_dir?: string;
}
