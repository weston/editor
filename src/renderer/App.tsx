import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  Archive,
  Check,
  Bot,
  ExternalLink,
  FileText,
  GitFork,
  GitPullRequest,
  Keyboard,
  Link2,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Redo2,
  SquareTerminal,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type {
  AgentProfile,
  AgentProfileId,
  RepoSnapshot,
  RuntimeTarget,
  SessionRecord,
  TerminalEvent,
} from "../shared";

const profiles: AgentProfile[] = [
  { id: "claude", name: "Claude", command: "claude" },
  { id: "codex", name: "Codex", command: "codex" },
];

const emptySnapshot: RepoSnapshot = {
  repoPath: "",
  rootPath: "",
  branch: "",
  status: "",
  diffStat: "",
  diff: "",
};

const defaultShortcuts: Shortcuts = {
  sidebar: "Meta+1",
  agent: "Meta+2",
  terminal: "Meta+3",
};

const shortcutStorageKey = "agent-editor:shortcuts";
const splitStorageKey = "agent-editor:panel-split";
const notesDraftStorageKey = "agent-editor:note-drafts";
const graphiteUrlPattern = /https:\/\/(?:app\.)?graphite\.dev\/[^\s"'<>)]*/g;
let measuredCellWidthCache = 0;

type MountedTerminal = {
  id: string;
  container: HTMLDivElement;
  resizeObserver: ResizeObserver;
  animationFrames: number[];
};

type CachedTerminal = {
  terminal: Terminal;
  fit: FitAddon;
};

type ShortcutTarget = "sidebar" | "agent" | "terminal";
type Shortcuts = Record<ShortcutTarget, string>;
type RightPaneMode = "terminal" | "notes";
type CloseOptions = {
  linear: boolean;
  git: boolean;
  archive: boolean;
};
type NotesState = {
  notes: string;
  notesUndoStack: string[];
  notesRedoStack: string[];
};

export default function App() {
  const [repo, setRepo] = useState<RepoSnapshot>(emptySnapshot);
  const [recentRepoPaths, setRecentRepoPaths] = useState<string[]>([]);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [profile, setProfile] = useState<AgentProfileId>("claude");
  const [showNewSession, setShowNewSession] = useState(false);
  const [sessionName, setSessionName] = useState("");
  const [creatingSession, setCreatingSession] = useState(false);
  const [newSessionTarget, setNewSessionTarget] =
    useState<RuntimeTarget>("local");
  const [newSailboxId, setNewSailboxId] = useState("");
  const [newSailboxApp, setNewSailboxApp] = useState("");
  const [newSailboxName, setNewSailboxName] = useState("");
  const [editingSessionId, setEditingSessionId] = useState("");
  const [editingSessionName, setEditingSessionName] = useState("");
  const [forkingSessionId, setForkingSessionId] = useState("");
  const [forkSessionName, setForkSessionName] = useState("");
  const [confirmingDeleteId, setConfirmingDeleteId] = useState("");
  const [closingSessionId, setClosingSessionId] = useState("");
  const [closeOptions, setCloseOptions] = useState<CloseOptions>({
    linear: true,
    git: true,
    archive: true,
  });
  const [showArchived, setShowArchived] = useState(false);
  const [rightPaneMode, setRightPaneMode] = useState<RightPaneMode>("terminal");
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showPrMenu, setShowPrMenu] = useState(false);
  const [focusedPanel, setFocusedPanel] = useState<ShortcutTarget>("agent");
  const [exitedTerminalIds, setExitedTerminalIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [finishedAgentIds, setFinishedAgentIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [capturingShortcut, setCapturingShortcut] =
    useState<ShortcutTarget | null>(null);
  const [shortcuts, setShortcuts] = useState<Shortcuts>(loadShortcuts);
  const [splitPercent, setSplitPercent] = useState(loadSplitPercent);
  const [error, setError] = useState("");
  const sidebarRef = useRef<HTMLElement>(null);
  const topbarActionsRef = useRef<HTMLDivElement>(null);
  const workspaceGridRef = useRef<HTMLDivElement>(null);
  const terminalPanelRef = useRef<HTMLElement>(null);
  const agentContainerRef = useRef<HTMLDivElement>(null);
  const shellContainerRef = useRef<HTMLDivElement>(null);
  const notesEditorRef = useRef<HTMLTextAreaElement>(null);
  const mountedAgentRef = useRef<MountedTerminal | null>(null);
  const mountedShellRef = useRef<MountedTerminal | null>(null);
  const terminalsRef = useRef(new Map<string, Terminal>());
  const terminalCacheRef = useRef(new Map<string, CachedTerminal>());
  const startedTerminalIdsRef = useRef(new Set<string>());
  const graphiteUrlsRef = useRef(new Map<string, string[]>());
  const graphiteDetectionRef = useRef(new Set<string>());
  const shortcutsRef = useRef(shortcuts);
  const focusedPanelRef = useRef<ShortcutTarget>("agent");
  const activeSessionIdRef = useRef("");
  const activeAgentTerminalIdRef = useRef("");
  const notesSaveTimersRef = useRef(new Map<string, number>());

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId),
    [activeSessionId, sessions],
  );
  const orderedSessions = useMemo(
    () =>
      [...sessions].sort((left, right) => {
        if (Boolean(left.pinned) !== Boolean(right.pinned)) {
          return left.pinned ? -1 : 1;
        }

        return right.updatedAt - left.updatedAt;
      }),
    [sessions],
  );
  const visibleSessions = useMemo(
    () =>
      orderedSessions.filter((session) =>
        showArchived ? session.archived : !session.archived,
      ),
    [orderedSessions, showArchived],
  );
  const currentProfile =
    profiles.find((item) => item.id === profile) ?? profiles[0];
  const agentCommand = activeSession
    ? commandForAgent(activeSession, currentProfile)
    : currentProfile.command;
  const shellCommand = activeSession
    ? commandForShell(activeSession)
    : undefined;
  const activeContext = activeSession?.id || repo.rootPath || "";
  const activeRepoName = activeSession
    ? basename(activeSession.repoPath)
    : repo.rootPath
      ? basename(repo.rootPath)
      : "";
  const activeGraphitePrUrls = activeSession
    ? [
        ...new Set([
          ...(activeSession.graphitePrUrls ?? []),
          ...(activeSession.graphitePrUrl ? [activeSession.graphitePrUrl] : []),
        ]),
      ]
    : [];
  const activeAgentTerminalId = activeSession
    ? agentTerminalId(activeSession.id, profile)
    : "";
  const activeShellTerminalId = activeSession
    ? shellTerminalId(activeSession.id)
    : "";
  const workspaceGridStyle: CSSProperties = {
    gridTemplateColumns: `minmax(320px, ${splitPercent}%) 8px minmax(280px, 1fr)`,
  };

  useEffect(() => {
    shortcutsRef.current = shortcuts;
    localStorage.setItem(shortcutStorageKey, JSON.stringify(shortcuts));
  }, [shortcuts]);

  useEffect(() => {
    localStorage.setItem(splitStorageKey, String(splitPercent));
  }, [splitPercent]);

  useEffect(() => {
    refitMountedTerminal(mountedAgentRef.current);
    refitMountedTerminal(mountedShellRef.current);
  }, [
    splitPercent,
    activeAgentTerminalId,
    activeShellTerminalId,
    rightPaneMode,
  ]);

  useEffect(() => {
    const refit = () => {
      refitMountedTerminal(mountedAgentRef.current);
      refitMountedTerminal(mountedShellRef.current);
    };

    window.addEventListener("resize", refit);
    return () => window.removeEventListener("resize", refit);
  }, []);

  useEffect(() => {
    focusedPanelRef.current = focusedPanel;
  }, [focusedPanel]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    activeAgentTerminalIdRef.current = activeAgentTerminalId;
  }, [activeAgentTerminalId]);

  useEffect(() => {
    if (
      !activeSession ||
      activeSession.archived ||
      graphiteDetectionRef.current.has(activeSession.id)
    ) {
      return;
    }

    graphiteDetectionRef.current.add(activeSession.id);
    refreshGraphitePrs();
  }, [activeSession?.id, activeSession?.archived]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (!topbarActionsRef.current?.contains(target)) {
        setShowShortcuts(false);
        setCapturingShortcut(null);
        setShowPrMenu(false);
      }
    };

    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, []);

  useEffect(() => {
    window.agentEditor.loadState().then(async (state) => {
      const sessionsWithDrafts = state.sessions.map(applyStoredNotesDraft);
      setSessions(sessionsWithDrafts);
      setRecentRepoPaths(state.recentRepoPaths ?? []);
      setActiveSessionId(sessionsWithDrafts[0]?.id ?? "");
      graphiteUrlsRef.current = new Map(
        sessionsWithDrafts
          .filter(
            (session) =>
              session.graphitePrUrl || session.graphitePrUrls?.length,
          )
          .map((session) => [
            session.id,
            [
              ...(session.graphitePrUrls ?? []),
              ...(session.graphitePrUrl ? [session.graphitePrUrl] : []),
            ],
          ]),
      );

      if (state.lastRepoPath) {
        try {
          setRepo(await window.agentEditor.inspectRepo(state.lastRepoPath));
        } catch {
          setRepo({ ...emptySnapshot, repoPath: state.lastRepoPath });
        }
      }
    });

    return window.agentEditor.onTerminalEvent(handleTerminalEvent);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (capturingShortcut) {
        const shortcut = shortcutFromEvent(event);
        event.preventDefault();
        event.stopPropagation();

        if (shortcut) {
          setShortcuts((current) => ({
            ...current,
            [capturingShortcut]: shortcut,
          }));
          setCapturingShortcut(null);
        }
        return;
      }

      if (isEditableTarget(event.target)) {
        return;
      }

      const target = shortcutTargetForEvent(event, shortcutsRef.current);
      if (!target) {
        return;
      }

      event.preventDefault();
      focusPanel(target);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [capturingShortcut]);

  useEffect(() => {
    if (
      !activeSession?.worktreePath ||
      !activeAgentTerminalId ||
      !agentContainerRef.current
    ) {
      detachMounted(mountedAgentRef.current);
      mountedAgentRef.current = null;
      return;
    }

    mountedAgentRef.current = mountTerminal({
      container: agentContainerRef.current,
      current: mountedAgentRef.current,
      terminalId: activeAgentTerminalId,
      cwd: activeSession.worktreePath,
      command: agentCommand,
    });

    return () => {
      detachMounted(mountedAgentRef.current);
      mountedAgentRef.current = null;
    };
  }, [activeAgentTerminalId, activeSession?.worktreePath, agentCommand]);

  useEffect(() => {
    if (
      rightPaneMode !== "terminal" ||
      !activeSession?.repoPath ||
      !activeShellTerminalId ||
      !shellContainerRef.current
    ) {
      detachMounted(mountedShellRef.current);
      mountedShellRef.current = null;
      return;
    }

    mountedShellRef.current = mountTerminal({
      container: shellContainerRef.current,
      current: mountedShellRef.current,
      terminalId: activeShellTerminalId,
      cwd: activeSession.repoPath,
      command: shellCommand,
    });

    return () => {
      detachMounted(mountedShellRef.current);
      mountedShellRef.current = null;
    };
  }, [
    activeShellTerminalId,
    activeSession?.repoPath,
    rightPaneMode,
    shellCommand,
  ]);

  function handleTerminalEvent(event: TerminalEvent) {
    const terminal = terminalsRef.current.get(event.terminalId);
    if (!terminal) {
      return;
    }

    if (event.type === "exit") {
      terminal.write(`\r\n[exited ${event.code ?? event.signal ?? 0}]\r\n`);
      startedTerminalIdsRef.current.delete(event.terminalId);
      setExitedTerminalIds((current) => new Set(current).add(event.terminalId));
      markAgentFinished(event.terminalId);
      return;
    }

    if (event.type === "error") {
      terminal.write(`\r\n${event.message ?? "Terminal error"}\r\n`);
      return;
    }

    const data = event.data ?? "";
    terminal.write(data);
    captureGraphiteUrl(event.terminalId, data);
  }

  function markAgentFinished(terminalId: string) {
    if (!terminalId.startsWith("agent:")) {
      return;
    }

    const isVisibleAgent =
      terminalId === activeAgentTerminalIdRef.current &&
      focusedPanelRef.current === "agent";
    if (isVisibleAgent) {
      return;
    }

    setFinishedAgentIds((current) => new Set(current).add(terminalId));
  }

  function mountTerminal({
    container,
    current,
    terminalId,
    cwd,
    command,
  }: {
    container: HTMLDivElement;
    current: MountedTerminal | null;
    terminalId: string;
    cwd: string;
    command?: string;
  }) {
    if (current?.id === terminalId) {
      refitMountedTerminal(current);
      ensureTerminalStarted(
        terminalId,
        cwd,
        command,
        terminalCacheRef.current.get(terminalId),
      );
      return current;
    }

    detachMounted(current);
    container.replaceChildren();

    const cached = getOrCreateTerminal(terminalId, cwd, command);
    if (cached.terminal.element) {
      container.appendChild(cached.terminal.element);
    } else {
      cached.terminal.open(container);
    }
    fitAndResizeTerminal(terminalId, cached, container);
    cached.terminal.focus();

    const resizeObserver = new ResizeObserver(() => {
      fitAndResizeTerminal(terminalId, cached, container);
    });
    resizeObserver.observe(container);

    const animationFrames = [
      requestAnimationFrame(() =>
        fitAndResizeTerminal(terminalId, cached, container),
      ),
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          fitAndResizeTerminal(terminalId, cached, container);
          ensureTerminalStarted(terminalId, cwd, command, cached);
        });
      }),
    ];

    return {
      id: terminalId,
      container,
      resizeObserver,
      animationFrames,
    };
  }

  function fitAndResizeTerminal(
    terminalId: string,
    cached: CachedTerminal,
    container?: HTMLDivElement,
  ) {
    cached.fit.fit();
    clampTerminalColumns(cached, container);
    window.agentEditor
      .resizeTerminal(terminalId, cached.terminal.cols, cached.terminal.rows)
      .catch(() => undefined);
  }

  function ensureTerminalStarted(
    terminalId: string,
    cwd: string,
    command: string | undefined,
    cached: CachedTerminal | undefined,
  ) {
    if (!cached) {
      return;
    }

    if (startedTerminalIdsRef.current.has(terminalId)) {
      return;
    }

    startedTerminalIdsRef.current.add(terminalId);
    window.agentEditor
      .startTerminal(
        terminalId,
        cwd,
        command,
        cached.terminal.cols,
        cached.terminal.rows,
      )
      .then(() => {
        forceTerminalResize(terminalId, cached);
        requestAnimationFrame(() => forceTerminalResize(terminalId, cached));
      })
      .catch((nextError) => {
        startedTerminalIdsRef.current.delete(terminalId);
        cached.terminal.write(
          `\r\n${nextError instanceof Error ? nextError.message : String(nextError)}\r\n`,
        );
      });
  }

  function forceTerminalResize(terminalId: string, cached: CachedTerminal) {
    cached.terminal.resize(cached.terminal.cols, cached.terminal.rows);
    window.agentEditor
      .resizeTerminal(terminalId, cached.terminal.cols, cached.terminal.rows)
      .catch(() => undefined);
  }

  function clampTerminalColumns(
    cached: CachedTerminal,
    container?: HTMLDivElement,
  ) {
    if (!container) {
      return;
    }

    const maxCols = measuredTerminalColumns(container);
    if (cached.terminal.cols > maxCols) {
      cached.terminal.resize(maxCols, cached.terminal.rows);
    }
  }

  function measuredTerminalColumns(container: HTMLDivElement) {
    return Math.max(
      20,
      Math.floor(terminalContentWidth(container) / measuredCellWidth()) - 2,
    );
  }

  function terminalContentWidth(container: HTMLDivElement) {
    const style = window.getComputedStyle(container);
    const padding =
      Number.parseFloat(style.paddingLeft) +
      Number.parseFloat(style.paddingRight);
    return Math.max(20, container.clientWidth - padding);
  }

  function measuredCellWidth() {
    if (measuredCellWidthCache) {
      return measuredCellWidthCache;
    }

    const probe = document.createElement("span");
    probe.textContent = "00000000000000000000";
    probe.style.position = "fixed";
    probe.style.left = "-9999px";
    probe.style.top = "-9999px";
    probe.style.fontFamily = '"SF Mono", Menlo, ui-monospace, monospace';
    probe.style.fontSize = "12px";
    probe.style.letterSpacing = "0";
    probe.style.whiteSpace = "pre";
    document.body.appendChild(probe);
    measuredCellWidthCache = probe.getBoundingClientRect().width / 20;
    probe.remove();
    return measuredCellWidthCache || 7.5;
  }

  function refitMountedTerminal(mounted: MountedTerminal | null) {
    if (!mounted) {
      return;
    }

    const cached = terminalCacheRef.current.get(mounted.id);
    if (!cached) {
      return;
    }

    requestAnimationFrame(() => {
      fitAndResizeTerminal(mounted.id, cached, mounted.container);
    });
  }

  function getOrCreateTerminal(
    terminalId: string,
    cwd: string,
    command?: string,
  ) {
    const cached = terminalCacheRef.current.get(terminalId);
    if (cached) {
      return cached;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: '"SF Mono", Menlo, ui-monospace, monospace',
      fontSize: 12,
      scrollback: 100_000,
      theme: {
        background: "#171717",
        foreground: "#e7e7e7",
        cursor: "#ffffff",
        selectionBackground: "#404040",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.attachCustomKeyEventHandler((event) =>
      handleTerminalKeyEvent(event, terminalId, terminal),
    );
    terminal.onData((data) => {
      window.agentEditor
        .sendTerminalInput(terminalId, data)
        .catch(() => undefined);
    });
    terminalsRef.current.set(terminalId, terminal);

    const nextCached = { terminal, fit };
    terminalCacheRef.current.set(terminalId, nextCached);
    return nextCached;
  }

  function handleTerminalKeyEvent(
    event: KeyboardEvent,
    terminalId: string,
    terminal: Terminal,
  ) {
    if (event.type !== "keydown") {
      return true;
    }

    if (event.metaKey && normalizeKey(event.key) === "C") {
      const selection = terminal.getSelection();
      if (selection) {
        navigator.clipboard
          .writeText(normalizeTerminalText(selection))
          .catch(() => undefined);
        return false;
      }
    }

    const target = shortcutTargetForEvent(event, shortcutsRef.current);
    if (target) {
      focusPanel(target);
      return false;
    }

    return true;
  }

  function detachMounted(mounted: MountedTerminal | null) {
    if (!mounted) {
      return;
    }

    mounted.resizeObserver.disconnect();
    mounted.animationFrames.forEach((frame) => cancelAnimationFrame(frame));
  }

  async function createSessionForRepo(repoPath: string) {
    if (creatingSession) {
      return;
    }

    const name = sessionName.trim() || `Session ${sessions.length + 1}`;
    setError("");
    setCreatingSession(true);

    try {
      const session = await window.agentEditor.createSession({
        repoPath,
        name,
        target: newSessionTarget,
        sailbox:
          newSessionTarget === "sailbox"
            ? {
                id: newSailboxId,
                app: newSailboxApp,
                name: newSailboxName || name,
              }
            : undefined,
      });
      setSessions((current) => [session, ...current]);
      setActiveSessionId(session.id);
      setRepo(await window.agentEditor.inspectRepo(session.worktreePath));
      rememberRecentRepo(session.repoPath);
      setSessionName("");
      setNewSailboxId("");
      setNewSailboxName("");
      setShowNewSession(false);
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
    } finally {
      setCreatingSession(false);
    }
  }

  async function chooseRepoForNewSession() {
    if (creatingSession) {
      return;
    }

    setError("");

    try {
      const nextRepo = await window.agentEditor.chooseRepo();
      if (!nextRepo) {
        return;
      }

      setRepo(nextRepo);
      rememberRecentRepo(nextRepo.rootPath);
      await createSessionForRepo(nextRepo.rootPath);
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
    }
  }

  async function selectSession(session: SessionRecord) {
    setActiveSessionId(session.id);
    clearFinishedAgents(session.id);
    window.agentEditor
      .inspectRepo(session.worktreePath)
      .then(setRepo)
      .catch(() => undefined);
  }

  async function renameSession(sessionId: string) {
    const name = editingSessionName.trim();
    if (!name) {
      return;
    }

    try {
      const updatedSession = await window.agentEditor.updateSession({
        id: sessionId,
        name,
      });
      setSessions((current) =>
        current.map((session) =>
          session.id === sessionId ? updatedSession : session,
        ),
      );
      setEditingSessionId("");
      setEditingSessionName("");
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
    }
  }

  async function forkSession(session: SessionRecord) {
    const name = forkSessionName.trim() || `${session.name} fork`;
    setError("");

    try {
      const forkedSession = await window.agentEditor.forkSession({
        sourceSessionId: session.id,
        name,
      });
      setSessions((current) => [forkedSession, ...current]);
      setActiveSessionId(forkedSession.id);
      setRepo(await window.agentEditor.inspectRepo(forkedSession.worktreePath));
      setForkingSessionId("");
      setForkSessionName("");
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
    }
  }

  async function togglePinned(session: SessionRecord) {
    try {
      const updatedSession = await window.agentEditor.updateSession({
        id: session.id,
        pinned: !session.pinned,
      });
      setSessions((current) =>
        current.map((item) => (item.id === session.id ? updatedSession : item)),
      );
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
    }
  }

  async function deleteSession(sessionId: string) {
    try {
      const nextSessions = await window.agentEditor.deleteSession(sessionId);
      setSessions(nextSessions);
      setConfirmingDeleteId("");
      setEditingSessionId("");
      setForkingSessionId("");
      if (activeSessionId === sessionId) {
        setActiveSessionId(nextSessions[0]?.id ?? "");
      }
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
    }
  }

  async function syncLinear(session: SessionRecord) {
    setError("");

    try {
      const issue = await window.agentEditor.syncLinear(session.id);
      setSessions((current) =>
        current.map((item) =>
          item.id === session.id ? { ...item, linearIssue: issue } : item,
        ),
      );
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
    }
  }

  async function closeSession(session: SessionRecord) {
    setError("");

    try {
      const nextSessions = await window.agentEditor.closeSession({
        id: session.id,
        completeLinear: closeOptions.linear,
        cleanupGit: closeOptions.git,
        archive: closeOptions.archive,
      });
      setSessions(nextSessions);
      setClosingSessionId("");
      const nextActive = nextSessions.find((item) => !item.archived);
      if (activeSessionId === session.id) {
        setActiveSessionId(nextActive?.id ?? "");
      }
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
    }
  }

  async function reviveSession(session: SessionRecord) {
    setError("");

    try {
      const revivedSession = await window.agentEditor.reviveSession(session.id);
      setSessions((current) =>
        current.map((item) => (item.id === session.id ? revivedSession : item)),
      );
      setActiveSessionId(revivedSession.id);
      setRepo(
        await window.agentEditor.inspectRepo(revivedSession.worktreePath),
      );
      setShowArchived(false);
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
    }
  }

  function updateSessionNotes(session: SessionRecord, notes: string) {
    const previousNotes = session.notes ?? "";
    if (notes === previousNotes) {
      return;
    }

    const undoStack = [...(session.notesUndoStack ?? []), previousNotes];
    const redoStack: string[] = [];
    updateNotesState(session.id, notes, undoStack, redoStack);
  }

  function undoNotes(session: SessionRecord) {
    const undoStack = session.notesUndoStack ?? [];
    const previousNotes = undoStack.at(-1);
    if (previousNotes === undefined) {
      return;
    }

    updateNotesState(session.id, previousNotes, undoStack.slice(0, -1), [
      ...(session.notesRedoStack ?? []),
      session.notes ?? "",
    ]);
  }

  function redoNotes(session: SessionRecord) {
    const redoStack = session.notesRedoStack ?? [];
    const nextNotes = redoStack.at(-1);
    if (nextNotes === undefined) {
      return;
    }

    updateNotesState(
      session.id,
      nextNotes,
      [...(session.notesUndoStack ?? []), session.notes ?? ""],
      redoStack.slice(0, -1),
    );
  }

  function updateNotesState(
    sessionId: string,
    notes: string,
    notesUndoStack: string[],
    notesRedoStack: string[],
  ) {
    const updated = { notes, notesUndoStack, notesRedoStack };
    writeNotesDraft(sessionId, updated);
    setSessions((current) =>
      current.map((session) =>
        session.id === sessionId ? { ...session, ...updated } : session,
      ),
    );

    const existingTimer = notesSaveTimersRef.current.get(sessionId);
    if (existingTimer) {
      window.clearTimeout(existingTimer);
    }

    const timer = window.setTimeout(() => {
      notesSaveTimersRef.current.delete(sessionId);
      window.agentEditor
        .updateSession({ id: sessionId, ...updated })
        .catch((nextError) => {
          setError(
            nextError instanceof Error ? nextError.message : String(nextError),
          );
        });
    }, 350);
    notesSaveTimersRef.current.set(sessionId, timer);
  }

  function rememberRecentRepo(repoPath: string) {
    setRecentRepoPaths((current) => [
      repoPath,
      ...current.filter((path) => path !== repoPath),
    ]);
  }

  function captureGraphiteUrl(terminalId: string, data: string) {
    const sessionId = sessionIdFromTerminalId(terminalId);
    if (!sessionId || !data.includes("graphite.dev")) {
      return;
    }

    const match = data.match(graphiteUrlPattern)?.at(-1);
    if (!match) {
      return;
    }

    const url = match.replace(/[.,;:]+$/, "");
    const urls = graphiteUrlsRef.current.get(sessionId) ?? [];
    if (urls.includes(url)) {
      return;
    }

    const nextUrls = [url, ...urls];
    graphiteUrlsRef.current.set(sessionId, nextUrls);
    setSessions((current) =>
      current.map((session) =>
        session.id === sessionId
          ? { ...session, graphitePrUrl: nextUrls[0], graphitePrUrls: nextUrls }
          : session,
      ),
    );
    window.agentEditor
      .updateSession({
        id: sessionId,
        graphitePrUrl: nextUrls[0],
        graphitePrUrls: nextUrls,
      })
      .catch(() => undefined);
  }

  function copySelectionToAgent() {
    const text = selectedTextFromFocusedPane();
    if (!text || !activeAgentTerminalId) {
      return;
    }

    window.agentEditor
      .sendTerminalInput(activeAgentTerminalId, text)
      .then(() => focusPanel("agent"))
      .catch(() => undefined);
  }

  function copySelectionToTerminal() {
    const text = selectedTextFromFocusedPane();
    if (!text || !activeShellTerminalId) {
      return;
    }

    window.agentEditor
      .sendTerminalInput(activeShellTerminalId, text)
      .then(() => {
        setRightPaneMode("terminal");
        focusPanel("terminal");
      })
      .catch(() => undefined);
  }

  function copySelectionToNotes() {
    const text = selectedTextFromFocusedPane();
    if (!text || !activeSession) {
      return;
    }

    const currentNotes = activeSession.notes ?? "";
    updateSessionNotes(
      activeSession,
      currentNotes ? `${currentNotes}\n${text}` : text,
    );
    setRightPaneMode("notes");
  }

  function selectedTextFromFocusedPane() {
    if (document.activeElement === notesEditorRef.current) {
      return selectedNotesText(notesEditorRef.current);
    }

    if (focusedPanel === "agent") {
      return selectedTerminalText(
        terminalsRef.current.get(activeAgentTerminalId),
      );
    }

    if (rightPaneMode === "notes") {
      return selectedNotesText(notesEditorRef.current);
    }

    return selectedTerminalText(
      terminalsRef.current.get(activeShellTerminalId),
    );
  }

  function restartAgentTerminal() {
    if (!activeSession || !activeAgentTerminalId) {
      return;
    }

    const cached = terminalCacheRef.current.get(activeAgentTerminalId);
    cached?.terminal.write("\r\n[restarting]\r\n");
    window.agentEditor
      .startTerminal(
        activeAgentTerminalId,
        activeSession.worktreePath,
        agentCommand,
        cached?.terminal.cols,
        cached?.terminal.rows,
      )
      .then(() => {
        startedTerminalIdsRef.current.add(activeAgentTerminalId);
        setExitedTerminalIds((current) => {
          const next = new Set(current);
          next.delete(activeAgentTerminalId);
          return next;
        });
        if (cached) {
          window.agentEditor
            .resizeTerminal(
              activeAgentTerminalId,
              cached.terminal.cols,
              cached.terminal.rows,
            )
            .catch(() => undefined);
        }
      })
      .catch(() => undefined);
  }

  async function openTerminalLog() {
    if (!activeShellTerminalId) {
      return;
    }

    const result = await window.agentEditor.openTerminalLog(
      activeShellTerminalId,
    );
    if (result) {
      setError(result);
    }
  }

  async function refreshGraphitePrs() {
    if (!activeSession) {
      return [];
    }

    setError("");
    try {
      const urls = await window.agentEditor.refreshGraphitePrs(
        activeSession.id,
      );
      graphiteUrlsRef.current.set(activeSession.id, urls);
      setSessions((current) =>
        current.map((session) =>
          session.id === activeSession.id
            ? {
                ...session,
                graphitePrUrl: urls[0],
                graphitePrUrls: urls,
                updatedAt: Date.now(),
              }
            : session,
        ),
      );
      setShowPrMenu(urls.length > 1);
      return urls;
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
      return [];
    }
  }

  async function openOrRefreshGraphite() {
    const refreshedUrls = await refreshGraphitePrs();
    const urls = refreshedUrls.length ? refreshedUrls : activeGraphitePrUrls;

    if (urls.length === 1) {
      window.agentEditor.openExternal(urls[0]).catch(() => undefined);
    } else if (urls.length > 1) {
      setShowPrMenu(true);
      setShowShortcuts(false);
    }
  }

  function openLinearUrl() {
    if (!activeSession?.linearIssue?.url) {
      return;
    }

    window.agentEditor
      .openExternal(activeSession.linearIssue.url)
      .catch(() => undefined);
  }

  function clearFinishedAgents(sessionId: string) {
    setFinishedAgentIds((current) => {
      const next = new Set(current);
      for (const terminalId of next) {
        if (terminalId.startsWith(`agent:${sessionId}:`)) {
          next.delete(terminalId);
        }
      }
      return next;
    });
  }

  function beginPanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    const grid = workspaceGridRef.current;
    if (!grid) {
      return;
    }

    event.preventDefault();
    const rect = grid.getBoundingClientRect();

    const onPointerMove = (moveEvent: PointerEvent) => {
      const nextPercent =
        ((moveEvent.clientX - rect.left) / Math.max(rect.width, 1)) * 100;
      setSplitPercent(Math.min(78, Math.max(42, nextPercent)));
    };
    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  function focusPanel(target: ShortcutTarget) {
    setFocusedPanel(target);
    if (target === "sidebar") {
      const element = sidebarRef.current?.querySelector<
        HTMLButtonElement | HTMLInputElement
      >("button, input");
      element?.focus();
      return;
    }

    const mounted =
      target === "agent" ? mountedAgentRef.current : mountedShellRef.current;
    if (!mounted) {
      return;
    }

    terminalsRef.current.get(mounted.id)?.focus();
    if (target === "agent" && activeSessionIdRef.current) {
      clearFinishedAgents(activeSessionIdRef.current);
    }
  }

  function updateShortcut(target: ShortcutTarget) {
    setCapturingShortcut(target);
  }

  return (
    <main className="app-shell">
      <aside
        className="sidebar"
        ref={sidebarRef}
        onPointerDown={() => setFocusedPanel("sidebar")}
      >
        <div className="drag-zone" />

        <div className="sidebar-top">
          <h1>Editor</h1>
        </div>

        <div className="sidebar-actions">
          <button
            className="new-button"
            onClick={() => setShowNewSession(true)}
          >
            <Plus size={15} />
            New
          </button>
          <button
            className={
              showArchived ? "archive-toggle active" : "archive-toggle"
            }
            onClick={() => setShowArchived((current) => !current)}
          >
            <Archive size={14} />
            Archived
          </button>
        </div>

        {showNewSession ? (
          <section className="new-session-sheet">
            <div className="sheet-head">
              <h2>New Session</h2>
              <button
                onClick={() => setShowNewSession(false)}
                disabled={creatingSession}
              >
                <X size={14} />
              </button>
            </div>
            <input
              value={sessionName}
              onChange={(event) => setSessionName(event.target.value)}
              placeholder="Name"
              disabled={creatingSession}
            />
            <div className="segmented new-session-target">
              <button
                className={newSessionTarget === "local" ? "selected" : ""}
                onClick={() => setNewSessionTarget("local")}
                disabled={creatingSession}
              >
                Local
              </button>
              <button
                className={newSessionTarget === "sailbox" ? "selected" : ""}
                onClick={() => setNewSessionTarget("sailbox")}
                disabled={creatingSession}
              >
                Sailbox
              </button>
            </div>
            {newSessionTarget === "sailbox" ? (
              <div className="sailbox-fields">
                <input
                  value={newSailboxId}
                  onChange={(event) => setNewSailboxId(event.target.value)}
                  placeholder="Sailbox ID"
                  disabled={creatingSession}
                />
                <div className="sailbox-create-fields">
                  <input
                    value={newSailboxApp}
                    onChange={(event) => setNewSailboxApp(event.target.value)}
                    placeholder="App"
                    disabled={creatingSession}
                  />
                  <input
                    value={newSailboxName}
                    onChange={(event) => setNewSailboxName(event.target.value)}
                    placeholder="Sailbox name"
                    disabled={creatingSession}
                  />
                </div>
              </div>
            ) : null}
            <div className="repo-list">
              {recentRepoPaths.map((repoPath) => (
                <button
                  key={repoPath}
                  onClick={() => createSessionForRepo(repoPath)}
                  disabled={creatingSession}
                >
                  <span>{basename(repoPath)}</span>
                  <small>{repoPath}</small>
                </button>
              ))}
              <button
                onClick={chooseRepoForNewSession}
                disabled={creatingSession}
              >
                <span>Choose repo</span>
              </button>
            </div>
          </section>
        ) : null}

        <nav className="session-list">
          {visibleSessions.map((session) => (
            <div
              className={sessionItemClassName(
                session,
                activeSessionId,
                finishedAgentIds,
              )}
              key={session.id}
            >
              {editingSessionId === session.id ? (
                <div className="session-edit">
                  <input
                    value={editingSessionName}
                    onChange={(event) =>
                      setEditingSessionName(event.target.value)
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        renameSession(session.id);
                      }
                      if (event.key === "Escape") {
                        setEditingSessionId("");
                        setEditingSessionName("");
                      }
                    }}
                  />
                  <button
                    onClick={() => renameSession(session.id)}
                    data-tooltip="Save"
                    aria-label="Save"
                  >
                    <Check size={14} />
                  </button>
                  <button
                    onClick={() => {
                      setEditingSessionId("");
                      setEditingSessionName("");
                    }}
                    data-tooltip="Cancel"
                    aria-label="Cancel"
                  >
                    <X size={14} />
                  </button>
                </div>
              ) : forkingSessionId === session.id ? (
                <div className="session-edit">
                  <input
                    value={forkSessionName}
                    onChange={(event) => setForkSessionName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        forkSession(session);
                      }
                      if (event.key === "Escape") {
                        setForkingSessionId("");
                        setForkSessionName("");
                      }
                    }}
                  />
                  <button
                    onClick={() => forkSession(session)}
                    data-tooltip="Create fork"
                    aria-label="Create fork"
                  >
                    <Check size={14} />
                  </button>
                  <button
                    onClick={() => {
                      setForkingSessionId("");
                      setForkSessionName("");
                    }}
                    data-tooltip="Cancel"
                    aria-label="Cancel"
                  >
                    <X size={14} />
                  </button>
                </div>
              ) : closingSessionId === session.id ? (
                <div className="close-confirm">
                  <label>
                    <input
                      type="checkbox"
                      checked={closeOptions.linear}
                      onChange={(event) =>
                        setCloseOptions((current) => ({
                          ...current,
                          linear: event.target.checked,
                        }))
                      }
                      disabled={!session.linearIssue}
                    />
                    Linear
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={closeOptions.git}
                      onChange={(event) =>
                        setCloseOptions((current) => ({
                          ...current,
                          git: event.target.checked,
                        }))
                      }
                    />
                    Git
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={closeOptions.archive}
                      onChange={(event) =>
                        setCloseOptions((current) => ({
                          ...current,
                          archive: event.target.checked,
                        }))
                      }
                    />
                    Archive
                  </label>
                  <button
                    onClick={() => closeSession(session)}
                    data-tooltip="Confirm close"
                    aria-label="Confirm close"
                  >
                    <Check size={14} />
                  </button>
                  <button
                    onClick={() => {
                      setClosingSessionId("");
                    }}
                    data-tooltip="Cancel"
                    aria-label="Cancel"
                  >
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <>
                  <button
                    className="session-main"
                    onClick={() => selectSession(session)}
                  >
                    <span>{session.name}</span>
                    <small>{session.branch}</small>
                  </button>
                  <div className="session-actions">
                    {session.archived ? (
                      <button
                        onClick={() => reviveSession(session)}
                        data-tooltip="Revive"
                        aria-label="Revive"
                      >
                        <RotateCcw size={13} />
                      </button>
                    ) : (
                      <>
                        <button
                          onClick={() => togglePinned(session)}
                          data-tooltip={session.pinned ? "Unpin" : "Pin"}
                          aria-label={session.pinned ? "Unpin" : "Pin"}
                        >
                          {session.pinned ? (
                            <PinOff size={13} />
                          ) : (
                            <Pin size={13} />
                          )}
                        </button>
                        <button
                          onClick={() => {
                            setForkingSessionId(session.id);
                            setForkSessionName(`${session.name} fork`);
                            setEditingSessionId("");
                            setConfirmingDeleteId("");
                            setClosingSessionId("");
                          }}
                          data-tooltip="Fork"
                          aria-label="Fork"
                        >
                          <GitFork size={13} />
                        </button>
                        <button
                          onClick={() => {
                            setEditingSessionId(session.id);
                            setEditingSessionName(session.name);
                            setForkingSessionId("");
                            setConfirmingDeleteId("");
                            setClosingSessionId("");
                          }}
                          data-tooltip="Rename"
                          aria-label="Rename"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          onClick={() => {
                            setClosingSessionId(session.id);
                            setCloseOptions({
                              linear: Boolean(session.linearIssue),
                              git: true,
                              archive: true,
                            });
                            setEditingSessionId("");
                            setForkingSessionId("");
                            setConfirmingDeleteId("");
                          }}
                          data-tooltip="Close"
                          aria-label="Close"
                        >
                          <Archive size={13} />
                        </button>
                        {confirmingDeleteId === session.id ? (
                          <>
                            <button
                              onClick={() => deleteSession(session.id)}
                              data-tooltip="Confirm delete"
                              aria-label="Confirm delete"
                            >
                              <Check size={13} />
                            </button>
                            <button
                              onClick={() => setConfirmingDeleteId("")}
                              data-tooltip="Cancel"
                              aria-label="Cancel"
                            >
                              <X size={13} />
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => {
                              setConfirmingDeleteId(session.id);
                              setEditingSessionId("");
                              setForkingSessionId("");
                              setClosingSessionId("");
                            }}
                            data-tooltip="Delete"
                            aria-label="Delete"
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          ))}
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="workspace-title">
            <strong>{activeSession?.name || "New session"}</strong>
            <span>
              {[activeRepoName, activeContext].filter(Boolean).join(" · ") ||
                "No session"}
            </span>
          </div>
          <div className="topbar-actions" ref={topbarActionsRef}>
            {activeSession?.linearIssue ? (
              <button className="pr-link" onClick={openLinearUrl}>
                {activeSession.linearIssue.identifier}
                <ExternalLink size={13} />
              </button>
            ) : null}
            {activeSession && !activeSession.archived ? (
              <button
                className="pr-link"
                onClick={() => syncLinear(activeSession)}
              >
                <Link2 size={13} />
                Linear
              </button>
            ) : null}
            {activeSession && !activeSession.archived ? (
              <button className="pr-link" onClick={openOrRefreshGraphite}>
                <GitPullRequest size={13} />
                Graphite
              </button>
            ) : null}
            <div className="transfer-actions">
              <button
                onClick={copySelectionToAgent}
                disabled={!activeSession}
                data-tooltip="Copy selection to Agent"
                aria-label="Copy selection to Agent"
              >
                <Bot size={14} />
              </button>
              <button
                onClick={copySelectionToTerminal}
                disabled={!activeSession}
                data-tooltip="Copy selection to Terminal"
                aria-label="Copy selection to Terminal"
              >
                <SquareTerminal size={14} />
              </button>
              <button
                onClick={copySelectionToNotes}
                disabled={!activeSession}
                data-tooltip="Copy selection to Notes"
                aria-label="Copy selection to Notes"
              >
                <FileText size={14} />
              </button>
            </div>
            {showPrMenu ? (
              <div className="pr-menu">
                {activeGraphitePrUrls.map((url, index) => (
                  <button
                    className="pr-row"
                    key={url}
                    onClick={() => {
                      window.agentEditor
                        .openExternal(url)
                        .catch(() => undefined);
                      setShowPrMenu(false);
                    }}
                  >
                    <span>{`PR ${index + 1}`}</span>
                    <small>{url}</small>
                  </button>
                ))}
              </div>
            ) : null}
            <button
              className="icon-button"
              onClick={() => setShowShortcuts((current) => !current)}
            >
              <Keyboard size={16} />
            </button>
            {showShortcuts ? (
              <div className="shortcut-menu">
                {(["sidebar", "agent", "terminal"] as const).map((target) => (
                  <button
                    className="shortcut-row"
                    key={target}
                    onClick={() => updateShortcut(target)}
                  >
                    <span>{shortcutLabel(target)}</span>
                    <strong>
                      {capturingShortcut === target
                        ? "Press keys"
                        : displayShortcut(shortcuts[target])}
                    </strong>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </header>

        {error ? <div className="error-line">{error}</div> : null}

        <div
          className="workspace-grid"
          ref={workspaceGridRef}
          style={workspaceGridStyle}
        >
          <section
            className="agent-panel"
            onPointerDown={() => {
              setFocusedPanel("agent");
              if (activeSession) {
                clearFinishedAgents(activeSession.id);
              }
            }}
          >
            <div className="agent-head">
              <div className="segmented">
                {profiles.map((item) => (
                  <button
                    className={item.id === profile ? "selected" : ""}
                    key={item.id}
                    onClick={() => {
                      setProfile(item.id);
                      if (activeSession) {
                        clearFinishedAgents(activeSession.id);
                      }
                    }}
                  >
                    {item.name}
                  </button>
                ))}
              </div>
              <div className="agent-tools">
                <span>{agentCommand}</span>
                {exitedTerminalIds.has(activeAgentTerminalId) ? (
                  <button
                    onClick={restartAgentTerminal}
                    disabled={!activeSession}
                    data-tooltip="Restart agent"
                    aria-label="Restart agent"
                  >
                    <RotateCcw size={13} />
                  </button>
                ) : null}
              </div>
            </div>
            <div className="xterm-host" ref={agentContainerRef} />
          </section>

          <div className="panel-divider" onPointerDown={beginPanelResize} />

          <aside
            className="terminal-panel"
            ref={terminalPanelRef}
            onPointerDown={() => setFocusedPanel("terminal")}
          >
            <div className="terminal-head">
              <div className="right-pane-tabs">
                <button
                  className={rightPaneMode === "terminal" ? "selected" : ""}
                  onClick={() => setRightPaneMode("terminal")}
                >
                  Terminal
                </button>
                <button
                  className={rightPaneMode === "notes" ? "selected" : ""}
                  onClick={() => {
                    setRightPaneMode("notes");
                  }}
                >
                  Notes
                </button>
              </div>
              <div className="terminal-tools">
                {rightPaneMode === "notes" ? (
                  <>
                    <button
                      onClick={() => {
                        if (activeSession) {
                          undoNotes(activeSession);
                        }
                      }}
                      disabled={
                        !activeSession ||
                        (activeSession.notesUndoStack ?? []).length === 0
                      }
                      title="Undo"
                    >
                      <Undo2 size={13} />
                    </button>
                    <button
                      onClick={() => {
                        if (activeSession) {
                          redoNotes(activeSession);
                        }
                      }}
                      disabled={
                        !activeSession ||
                        (activeSession.notesRedoStack ?? []).length === 0
                      }
                      title="Redo"
                    >
                      <Redo2 size={13} />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={openTerminalLog}
                      disabled={!activeSession}
                      title="Open terminal log"
                    >
                      <FileText size={13} />
                    </button>
                  </>
                )}
              </div>
            </div>
            {rightPaneMode === "terminal" ? (
              <div className="xterm-host" ref={shellContainerRef} />
            ) : (
              <textarea
                className="notes-editor"
                ref={notesEditorRef}
                value={activeSession?.notes ?? ""}
                onChange={(event) => {
                  if (activeSession) {
                    updateSessionNotes(activeSession, event.target.value);
                  }
                }}
                onKeyDown={(event) => {
                  if (!activeSession || !event.metaKey) {
                    return;
                  }

                  if (normalizeKey(event.key) !== "Z") {
                    return;
                  }

                  event.preventDefault();
                  if (event.shiftKey) {
                    redoNotes(activeSession);
                  } else {
                    undoNotes(activeSession);
                  }
                }}
                disabled={!activeSession}
              />
            )}
          </aside>
        </div>
      </section>
    </main>
  );
}

function agentTerminalId(sessionId: string, profile: AgentProfileId) {
  return `agent:${sessionId}:${profile}`;
}

function shellTerminalId(sessionId: string) {
  return `shell:${sessionId}`;
}

function sessionIdFromTerminalId(terminalId: string) {
  if (terminalId.startsWith("shell:")) {
    return terminalId.slice("shell:".length);
  }

  if (terminalId.startsWith("agent:")) {
    return terminalId.split(":")[1] ?? "";
  }

  return "";
}

function basename(repoPath: string) {
  return repoPath.split(/[\\/]/).filter(Boolean).at(-1) ?? repoPath;
}

function commandForAgent(session: SessionRecord, profile: AgentProfile) {
  let command = profile.command;

  if (profile.id === "claude") {
    const claudeSessionId = session.agentSessions?.claude;
    if (claudeSessionId) {
      const promptFlag = ` --append-system-prompt ${shellQuote(terminalAccessPrompt(session.target))}`;
      command = session.forkedAgentSessions?.claude
        ? `claude --resume ${shellQuote(claudeSessionId)}${promptFlag}`
        : `claude --session-id ${shellQuote(claudeSessionId)}${promptFlag}`;
    }
  }

  if (profile.id === "codex") {
    command = `codex ${shellQuote(terminalAccessPrompt(session.target))}`;
  }

  return wrapSailboxCommand(session, command, true);
}

function commandForShell(session: SessionRecord) {
  if (session.target !== "sailbox") {
    return undefined;
  }

  return wrapSailboxCommand(session, "/bin/bash -l", true);
}

function wrapSailboxCommand(
  session: SessionRecord,
  command: string,
  interactive = false,
) {
  if (session.target !== "sailbox") {
    return command;
  }

  const sailboxId = session.sailbox?.id;
  const workdir = session.sailbox?.workdir;
  if (!sailboxId || !workdir) {
    return command;
  }

  return [
    "sail box exec",
    "--stdin",
    interactive ? "--tty" : "",
    "--cwd",
    shellQuote(workdir),
    shellQuote(sailboxId),
    "/bin/sh",
    "-lc",
    shellQuote(command),
  ]
    .filter(Boolean)
    .join(" ");
}

function terminalAccessPrompt(target: RuntimeTarget) {
  if (target === "sailbox") {
    return "You are running inside Editor in a Sailbox workspace. The paired terminal is attached to the same Sailbox and working directory.";
  }

  return "You are running inside Editor. You can inspect the paired terminal for this session by running `editor-terminal lines 200` for recent terminal output, `editor-terminal commands 20` for recent commands, or `editor-terminal paths` for the backing files.";
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function applyStoredNotesDraft(session: SessionRecord): SessionRecord {
  const draft = readNotesDrafts()[session.id];
  return draft ? { ...session, ...draft } : session;
}

function readNotesDrafts() {
  try {
    return JSON.parse(localStorage.getItem(notesDraftStorageKey) ?? "{}") as
      | Record<string, NotesState>
      | Record<string, never>;
  } catch {
    return {};
  }
}

function writeNotesDraft(sessionId: string, notesState: NotesState) {
  const drafts = readNotesDrafts();
  localStorage.setItem(
    notesDraftStorageKey,
    JSON.stringify({ ...drafts, [sessionId]: notesState }),
  );
}

function selectedTerminalText(terminal: Terminal | undefined) {
  const selection = terminal?.getSelection();
  return selection ? normalizeTerminalText(selection) : "";
}

function selectedNotesText(element: HTMLTextAreaElement | null) {
  if (!element) {
    return "";
  }

  return element.value.slice(element.selectionStart, element.selectionEnd);
}

function sessionItemClassName(
  session: SessionRecord,
  activeSessionId: string,
  finishedAgentIds: Set<string>,
) {
  const classNames = ["session-item"];
  if (session.id === activeSessionId) {
    classNames.push("active");
  }
  if (
    [...finishedAgentIds].some((terminalId) =>
      terminalId.startsWith(`agent:${session.id}:`),
    )
  ) {
    classNames.push("agent-finished");
  }

  return classNames.join(" ");
}

function normalizeTerminalText(value: string) {
  return stripTerminalControl(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function stripTerminalControl(value: string) {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function loadShortcuts(): Shortcuts {
  try {
    return {
      ...defaultShortcuts,
      ...JSON.parse(localStorage.getItem(shortcutStorageKey) ?? "{}"),
    };
  } catch {
    return defaultShortcuts;
  }
}

function loadSplitPercent() {
  const stored = Number(localStorage.getItem(splitStorageKey));
  return Number.isFinite(stored) ? Math.min(78, Math.max(42, stored)) : 62;
}

function shortcutFromEvent(event: KeyboardEvent) {
  const key = normalizeKey(event.key);
  if (!key || ["META", "CONTROL", "ALT", "SHIFT"].includes(key)) {
    return "";
  }

  const parts = [];
  if (event.metaKey) {
    parts.push("Meta");
  }
  if (event.ctrlKey) {
    parts.push("Control");
  }
  if (event.altKey) {
    parts.push("Alt");
  }
  if (event.shiftKey) {
    parts.push("Shift");
  }
  parts.push(key);
  return parts.join("+");
}

function shortcutTargetForEvent(event: KeyboardEvent, shortcuts: Shortcuts) {
  const shortcut = shortcutFromEvent(event);
  return (Object.keys(shortcuts) as ShortcutTarget[]).find(
    (target) => shortcuts[target] === shortcut,
  );
}

function normalizeKey(key: string) {
  if (key.length === 1) {
    return key.toUpperCase();
  }

  return key;
}

function displayShortcut(shortcut: string) {
  return shortcut
    .replace("Meta", "Cmd")
    .replace("Control", "Ctrl")
    .replace("Alt", "Opt");
}

function shortcutLabel(target: ShortcutTarget) {
  if (target === "sidebar") {
    return "Sessions";
  }
  if (target === "agent") {
    return "Agent";
  }
  return "Terminal";
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  );
}
