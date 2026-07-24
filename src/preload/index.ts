import { contextBridge, ipcRenderer } from "electron";
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
} from "../shared.js";

type StoredState = {
  sessions: SessionRecord[];
  lastRepoPath?: string;
  recentRepoPaths?: string[];
};

const api = {
  loadState: () => ipcRenderer.invoke("state:load") as Promise<StoredState>,
  chooseRepo: () =>
    ipcRenderer.invoke("repo:choose") as Promise<RepoSnapshot | null>,
  inspectRepo: (repoPath: string) =>
    ipcRenderer.invoke("repo:inspect", repoPath) as Promise<RepoSnapshot>,
  forgetRepo: (repoPath: string) =>
    ipcRenderer.invoke("repo:forget", repoPath) as Promise<string[]>,
  createSession: (input: CreateSessionInput) =>
    ipcRenderer.invoke("session:create", input) as Promise<SessionRecord>,
  forkSession: (input: ForkSessionInput) =>
    ipcRenderer.invoke("session:fork", input) as Promise<SessionRecord>,
  closeSession: (input: CloseSessionInput) =>
    ipcRenderer.invoke("session:close", input) as Promise<SessionRecord[]>,
  reviveSession: (sessionId: string) =>
    ipcRenderer.invoke("session:revive", sessionId) as Promise<SessionRecord>,
  updateSession: (input: UpdateSessionInput) =>
    ipcRenderer.invoke("session:update", input) as Promise<SessionRecord>,
  deleteSession: (sessionId: string) =>
    ipcRenderer.invoke("session:delete", sessionId) as Promise<SessionRecord[]>,
  retrySailbox: (sessionId: string) =>
    ipcRenderer.invoke(
      "session:retry-sailbox",
      sessionId,
    ) as Promise<SessionRecord>,
  startAgent: (input: StartAgentInput) =>
    ipcRenderer.invoke("agent:start", input) as Promise<void>,
  stopAgent: (sessionId: string) =>
    ipcRenderer.invoke("agent:stop", sessionId) as Promise<boolean>,
  sendAgentInput: (sessionId: string, data: string) =>
    ipcRenderer.invoke("agent:stdin", sessionId, data) as Promise<boolean>,
  startTerminal: (
    terminalId: string,
    cwd: string,
    command?: string,
    cols?: number,
    rows?: number,
  ) =>
    ipcRenderer.invoke(
      "terminal:start",
      terminalId,
      cwd,
      command,
      cols,
      rows,
    ) as Promise<boolean>,
  sendTerminalInput: (terminalId: string, data: string) =>
    ipcRenderer.invoke("terminal:stdin", terminalId, data) as Promise<boolean>,
  resizeTerminal: (terminalId: string, cols: number, rows: number) =>
    ipcRenderer.invoke(
      "terminal:resize",
      terminalId,
      cols,
      rows,
    ) as Promise<boolean>,
  openTerminalLog: (terminalId: string) =>
    ipcRenderer.invoke("terminal:open-log", terminalId) as Promise<string>,
  openExternal: (url: string) =>
    ipcRenderer.invoke("external:open", url) as Promise<void>,
  syncLinear: (sessionId: string) =>
    ipcRenderer.invoke("linear:sync", sessionId) as Promise<LinearIssue>,
  refreshGraphitePrs: (sessionId: string) =>
    ipcRenderer.invoke("graphite:refresh", sessionId) as Promise<string[]>,
  onAgentEvent: (handler: (event: AgentEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AgentEvent) =>
      handler(payload);
    ipcRenderer.on("agent:event", listener);
    return () => ipcRenderer.removeListener("agent:event", listener);
  },
  onTerminalEvent: (handler: (event: TerminalEvent) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: TerminalEvent,
    ) => handler(payload);
    ipcRenderer.on("terminal:event", listener);
    return () => ipcRenderer.removeListener("terminal:event", listener);
  },
  onSessionChanged: (handler: (session: SessionRecord) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: SessionRecord,
    ) => handler(payload);
    ipcRenderer.on("session:changed", listener);
    return () => ipcRenderer.removeListener("session:changed", listener);
  },
};

contextBridge.exposeInMainWorld("agentEditor", api);
