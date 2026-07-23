import type {
  AgentEvent,
  CloseSessionInput,
  CreateSessionInput,
  ForkSessionInput,
  LinearIssue,
  RepoSnapshot,
  SessionRecord,
  StartAgentInput,
  TerminalEvent,
  UpdateSessionInput,
} from "../shared";

type StoredState = {
  sessions: SessionRecord[];
  lastRepoPath?: string;
  recentRepoPaths?: string[];
};

declare global {
  interface Window {
    agentEditor: {
      loadState: () => Promise<StoredState>;
      chooseRepo: () => Promise<RepoSnapshot | null>;
      inspectRepo: (repoPath: string) => Promise<RepoSnapshot>;
      createSession: (input: CreateSessionInput) => Promise<SessionRecord>;
      forkSession: (input: ForkSessionInput) => Promise<SessionRecord>;
      closeSession: (input: CloseSessionInput) => Promise<SessionRecord[]>;
      reviveSession: (sessionId: string) => Promise<SessionRecord>;
      updateSession: (input: UpdateSessionInput) => Promise<SessionRecord>;
      deleteSession: (sessionId: string) => Promise<SessionRecord[]>;
      retrySailbox: (sessionId: string) => Promise<SessionRecord>;
      startAgent: (input: StartAgentInput) => Promise<void>;
      stopAgent: (sessionId: string) => Promise<boolean>;
      sendAgentInput: (sessionId: string, data: string) => Promise<boolean>;
      startTerminal: (
        terminalId: string,
        cwd: string,
        command?: string,
        cols?: number,
        rows?: number,
      ) => Promise<boolean>;
      sendTerminalInput: (terminalId: string, data: string) => Promise<boolean>;
      resizeTerminal: (
        terminalId: string,
        cols: number,
        rows: number,
      ) => Promise<boolean>;
      openTerminalLog: (terminalId: string) => Promise<string>;
      openExternal: (url: string) => Promise<void>;
      syncLinear: (sessionId: string) => Promise<LinearIssue>;
      refreshGraphitePrs: (sessionId: string) => Promise<string[]>;
      onAgentEvent: (handler: (event: AgentEvent) => void) => () => void;
      onTerminalEvent: (handler: (event: TerminalEvent) => void) => () => void;
      onSessionChanged: (
        handler: (session: SessionRecord) => void,
      ) => () => void;
    };
  }
}

export {};
