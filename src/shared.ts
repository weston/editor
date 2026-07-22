export type AgentProfileId = "codex" | "claude" | "q" | "shell";
export type RuntimeTarget = "local" | "sailbox";

export type AgentProfile = {
  id: AgentProfileId;
  name: string;
  command: string;
};

export type RepoSnapshot = {
  repoPath: string;
  rootPath: string;
  branch: string;
  status: string;
  diffStat: string;
  diff: string;
};

export type SessionRecord = {
  id: string;
  name: string;
  target: RuntimeTarget;
  repoPath: string;
  worktreePath: string;
  branch: string;
  sailbox?: {
    app?: string;
    name?: string;
    id?: string;
  };
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  agentSessions?: Partial<Record<AgentProfileId, string>>;
  forkedAgentSessions?: Partial<Record<AgentProfileId, string>>;
  graphitePrUrl?: string;
  graphitePrUrls?: string[];
  linearIssue?: LinearIssue;
  notes?: string;
  notesUndoStack?: string[];
  notesRedoStack?: string[];
  archived?: boolean;
  archivedAt?: number;
  archivedRef?: string;
};

export type AgentEvent =
  | {
      sessionId: string;
      type: "stdout" | "stderr";
      data: string;
      at: number;
    }
  | {
      sessionId: string;
      type: "exit";
      code: number | null;
      signal: string | null;
      at: number;
    }
  | {
      sessionId: string;
      type: "error";
      message: string;
      at: number;
    };

export type CreateSessionInput = {
  repoPath: string;
  name: string;
  target: RuntimeTarget;
  sailbox?: {
    app?: string;
    name?: string;
    id?: string;
  };
};

export type ForkSessionInput = {
  sourceSessionId: string;
  name: string;
};

export type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state?: string;
};

export type CloseSessionInput = {
  id: string;
  completeLinear: boolean;
  cleanupGit: boolean;
  archive: boolean;
};

export type StartAgentInput = {
  sessionId: string;
  cwd: string;
  target: RuntimeTarget;
  sailboxId?: string;
  profile: AgentProfileId;
  prompt: string;
  commandOverride?: string;
};

export type TerminalEvent = {
  terminalId: string;
  type: "stdout" | "stderr" | "exit" | "error";
  data?: string;
  message?: string;
  code?: number | null;
  signal?: string | null;
  at: number;
};

export type UpdateSessionInput = {
  id: string;
  name?: string;
  pinned?: boolean;
  graphitePrUrl?: string | null;
  graphitePrUrls?: string[] | null;
  linearIssue?: LinearIssue | null;
  notes?: string;
  notesUndoStack?: string[];
  notesRedoStack?: string[];
};
