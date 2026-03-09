/**
 * Episodic layer types — raw conversation exchanges.
 */

export interface Exchange {
  id: string;
  conversationId: string;
  project: string;
  timestamp: string;
  userMessage: string;
  assistantMessage: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  modelVersion?: string;
  exchangeIndex: number;
  tokenEstimate: number;
  createdAt: number;
  lastAccessed?: number;
}

export interface ToolCall {
  id: string;
  exchangeId: string;
  toolName: string;
  toolInput?: string;
  toolResultSummary?: string;
  isError: boolean;
  timestamp?: string;
}

export interface Conversation {
  id: string;
  project: string;
  startedAt?: string;
  endedAt?: string;
  exchangeCount: number;
  summary?: string;
  primaryTopics?: string[];
  archivePath?: string;
  lastIndexed?: number;
}
