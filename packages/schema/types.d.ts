/**
 * unfirehose/1.0 — Schema types for machine learning agent session logging.
 *
 * Aligned with Vercel AI SDK part types where possible.
 * Provider-neutral naming: "reasoning" not "thinking", "tool-call" not "tool_use".
 */

export declare const SCHEMA_VERSION = "unfirehose/1.0";

// === Content Blocks ===

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ReasoningBlock {
  type: "reasoning";
  text: string;
}

export interface ToolCallBlock {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: unknown;
  isError?: boolean;
}

export interface ImageBlock {
  type: "image";
  mediaType: string;
  data: string;
}

export interface FileBlock {
  type: "file";
  mediaType: string;
  data: string;
}

export type ContentBlock =
  | TextBlock
  | ReasoningBlock
  | ToolCallBlock
  | ToolResultBlock
  | ImageBlock
  | FileBlock;

// === Token Usage ===

export interface InputTokenDetails {
  noCacheTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface OutputTokenDetails {
  textTokens?: number;
  reasoningTokens?: number;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputTokenDetails?: InputTokenDetails;
  outputTokenDetails?: OutputTokenDetails;
}

// === Message ===

export interface Message {
  $schema?: "unfirehose/1.0";
  type: "message";
  id?: string;
  sessionId?: string;
  parentId?: string | null;
  role: "user" | "assistant" | "system" | "tool";
  timestamp?: string;
  content: ContentBlock[];
  model?: string;
  stopReason?: "end_turn" | "tool_calls" | "length" | "content_filter" | "error";
  provider?: "anthropic" | "google" | "openai" | "local";
  usage?: Usage;
  subtype?: string;
  durationMs?: number;
  sidechain?: boolean;
  cwd?: string;
  gitBranch?: string;
  harness?: string;
  harnessVersion?: string;
}

// === Session ===

export interface Session {
  $schema?: "unfirehose/1.0";
  type: "session";
  id: string;
  projectId?: string;
  status?: "active" | "closed";
  createdAt?: string;
  updatedAt?: string;
  closedAt?: string | null;
  firstPrompt?: string;
  summary?: string;
  gitBranch?: string;
  cwd?: string;
  sidechain?: boolean;
  harness?: string;
  harnessVersion?: string;
  messageCount?: number;
  totalUsage?: Usage;
}

// === Todo ===

export interface Todo {
  $schema?: "unfirehose/1.0";
  type: "todo";
  uuid?: string;
  projectId?: string;
  sessionId?: string;
  status: "pending" | "in_progress" | "completed" | "obsolete";
  content: string;
  activeForm?: string | null;
  source?: "claude-code" | "gemini" | "uncloseai" | "hermes" | "fetch" | "manual";
  sourceSessionId?: string;
  blockedBy?: string[];
  estimatedMinutes?: number;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
}

// === Todo Event ===

export interface TodoEvent {
  $schema?: "unfirehose/1.0";
  type: "todo_event";
  todoUuid?: string;
  oldStatus?: string;
  newStatus: string;
  messageId?: string;
  eventAt?: string;
}

// === Metric ===

export interface Metric {
  $schema?: "unfirehose/1.0";
  type: "metric";
  window: string;
  projectId?: string;
  usage: Usage;
  messageCount?: number;
  costUsd?: number;
}

// === Project ===

export interface GitRemote {
  name: string;
  url: string;
  type?: "fetch" | "push";
}

export interface GitCommit {
  hash: string;
  subject: string;
  author?: string;
  date?: string;
}

export interface Project {
  $schema?: "unfirehose/1.0";
  type: "project";
  id: string;
  displayName?: string;
  path?: string;
  visibility?: "public" | "private";
  firstSeen?: string;
  git?: {
    branch?: string | null;
    remotes?: GitRemote[];
    recentCommits?: GitCommit[];
  };
}

// === Tool Definition ===

export interface ToolDefinition {
  $schema?: "unfirehose/1.0";
  type: "tool_definition";
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

// === Alert Threshold ===

export interface AlertThreshold {
  $schema?: "unfirehose/1.0";
  type: "alert_threshold";
  windowMinutes: number;
  metric: "output_tokens" | "input_tokens" | "total_tokens" | "cost_usd";
  thresholdValue: number;
  enabled: boolean;
}

// === Training Run Events ===

export interface TrainingRunStart {
  $schema?: "unfirehose/1.0";
  type: "run.start";
  run_id: string;
  model: string;
  config?: Record<string, unknown>;
  ts: string;
}

export interface TrainingRunLoss {
  $schema?: "unfirehose/1.0";
  type: "run.loss";
  run_id: string;
  step: number;
  loss: number;
  lr?: number;
  ts: string;
}

export interface TrainingRunSample {
  $schema?: "unfirehose/1.0";
  type: "run.sample";
  run_id: string;
  step: number;
  text: string;
  loss?: number;
  ts: string;
}

export interface TrainingRunCheckpoint {
  $schema?: "unfirehose/1.0";
  type: "run.checkpoint";
  run_id: string;
  step: number;
  path: string;
  size_bytes?: number;
  ts: string;
}

export interface TrainingRunEval {
  $schema?: "unfirehose/1.0";
  type: "run.eval";
  run_id: string;
  step: number;
  eval: string;
  score: number;
  ts: string;
}

export interface TrainingRunEnd {
  $schema?: "unfirehose/1.0";
  type: "run.end";
  run_id: string;
  final_loss?: number;
  wall_ms?: number;
  ts: string;
}

export type TrainingRunEvent =
  | TrainingRunStart
  | TrainingRunLoss
  | TrainingRunSample
  | TrainingRunCheckpoint
  | TrainingRunEval
  | TrainingRunEnd;

// === Union of all top-level objects ===

export type UnfirehoseObject =
  | Message
  | Session
  | Todo
  | TodoEvent
  | Metric
  | Project
  | ToolDefinition
  | AlertThreshold
  | TrainingRunEvent;

// === Standard Tool Registry ===

export type CanonicalToolName =
  | "Bash"
  | "Read"
  | "Write"
  | "Edit"
  | "Glob"
  | "Grep"
  | "WebFetch"
  | "WebSearch"
  | "Agent"
  | "AskUser";
