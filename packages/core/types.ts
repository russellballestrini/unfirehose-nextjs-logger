// === Content Block Types ===

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

// === Usage ===

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  service_tier?: string;
}

// === JSONL Line Types ===

interface BaseEntry {
  parentUuid?: string;
  isSidechain?: boolean;
  userType?: string;
  cwd?: string;
  sessionId: string;
  version?: string;
  gitBranch?: string;
  uuid?: string;
  timestamp?: string;
}

export interface UserEntry extends BaseEntry {
  type: 'user';
  message: {
    role: 'user';
    content: ContentBlock[] | string;
  };
  thinkingMetadata?: { maxThinkingTokens: number };
  todos?: unknown[];
  permissionMode?: string;
}

export interface AssistantEntry extends BaseEntry {
  type: 'assistant';
  message: {
    role: 'assistant';
    content: ContentBlock[];
    model?: string;
    usage?: TokenUsage;
    id?: string;
  };
  requestId?: string;
}

export interface SystemEntry extends BaseEntry {
  type: 'system';
  subtype?: string;
  durationMs?: number;
  slug?: string;
}

export interface ProgressEntry extends BaseEntry {
  type: 'progress';
  data?: string;
  toolUseID?: string;
  parentToolUseID?: string;
}

export interface FileHistorySnapshot {
  type: 'file-history-snapshot';
  messageId?: string;
  snapshot?: {
    messageId: string;
    trackedFileBackups: Record<string, string>;
    timestamp: string;
  };
  isSnapshotUpdate?: boolean;
}

export type SessionEntry =
  | UserEntry
  | AssistantEntry
  | SystemEntry
  | ProgressEntry
  | FileHistorySnapshot;

// === Index Types ===

export interface SessionIndexEntry {
  sessionId: string;
  fullPath?: string;
  fileMtime?: number;
  firstPrompt?: string;
  displayName?: string;
  summary?: string;
  messageCount?: number;
  created?: string;
  modified?: string;
  gitBranch?: string;
  projectPath?: string;
  isSidechain?: boolean;
}

export interface SessionsIndex {
  version?: number;
  entries: SessionIndexEntry[];
  originalPath?: string;
}

// === Stats Types ===

export interface DailyActivity {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

export interface ModelUsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests?: number;
  costUSD?: number;
}

export interface StatsCache {
  version?: number;
  lastComputedDate?: string;
  dailyActivity: DailyActivity[];
  dailyModelTokens: Array<{
    date: string;
    tokensByModel: Record<string, number>;
  }>;
  modelUsage: Record<string, ModelUsageStats>;
  totalSessions: number;
  totalMessages: number;
  longestSession?: {
    sessionId: string;
    duration: number;
    messageCount: number;
    timestamp: string;
  };
  firstSessionDate?: string;
  hourCounts: Record<string, number>;
}

// === History ===

export interface HistoryEntry {
  display?: string;
  pastedContents?: Record<string, unknown>;
  timestamp: number;
  project?: string;
  sessionId?: string;
}

// === Project ===

export interface ProjectInfo {
  name: string;
  displayName: string;
  path: string;
  sessionCount: number;
  totalMessages: number;
  latestActivity: string;
  hasMemory: boolean;
}

// === Project Metadata (git) ===

export interface GitRemote {
  name: string;
  url: string;
  type: 'fetch' | 'push';
}

export interface GitCommit {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

export interface ProjectMetadata {
  repoPath: string;
  branch: string | null;
  remotes: GitRemote[];
  recentCommits: GitCommit[];
  claudeMd: string | null;
  claudeMdExists: boolean;
}

// === Thinking Excerpt ===

export interface ThinkingExcerpt {
  sessionId: string;
  project: string;
  timestamp: string;
  thinking: string;
  precedingPrompt: string;
  model?: string;
}
