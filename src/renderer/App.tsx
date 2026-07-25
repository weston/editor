import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
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
  Link2,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Redo2,
  Search,
  Settings as SettingsIcon,
  SquareTerminal,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  {
    id: "claude",
    name: "Claude",
    command: "claude --dangerously-skip-permissions",
  },
  {
    id: "codex",
    name: "Codex",
    command: "codex --dangerously-bypass-approvals-and-sandbox",
  },
];

const emptySnapshot: RepoSnapshot = {
  repoPath: "",
  rootPath: "",
  branch: "",
  status: "",
  diffStat: "",
  diff: "",
};

const shortcutTargets = [
  "cycleSessions",
  "agent",
  "terminal",
  "notes",
  "newSession",
  "search",
] as const;

const defaultShortcuts: Shortcuts = {
  cycleSessions: "Control+Tab",
  agent: "Control+2",
  terminal: "Control+3",
  notes: "Control+4",
  newSession: "Control+N",
  search: "Control+F",
};

// Bumped when the defaults change so stored Cmd bindings do not shadow them.
const shortcutStorageKey = "agent-editor:shortcuts:v2";
const splitStorageKey = "agent-editor:panel-split";
const notesDraftStorageKey = "agent-editor:note-drafts";
const graphiteUrlPattern =
  /https:\/\/(?:app\.)?graphite\.(?:com|dev)\/[^\s"'<>)]*/g;
const agentIdleAfterMs = 4000;
const typingEchoMs = 1500;
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

type ShortcutTarget = (typeof shortcutTargets)[number];
type Shortcuts = Record<ShortcutTarget, string>;
type PanelFocus = "sidebar" | "agent" | "terminal";
type RightPaneMode = "terminal" | "notes";
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
  const [editingSessionId, setEditingSessionId] = useState("");
  const [editingSessionName, setEditingSessionName] = useState("");
  const [forkingSessionId, setForkingSessionId] = useState("");
  const [forkSessionName, setForkSessionName] = useState("");
  const [confirmingDeleteId, setConfirmingDeleteId] = useState("");
  const [closingSessionId, setClosingSessionId] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [sessionSearch, setSessionSearch] = useState("");
  const [rightPaneMode, setRightPaneMode] = useState<RightPaneMode>("terminal");
  const [showSettings, setShowSettings] = useState(false);
  const [showPrMenu, setShowPrMenu] = useState(false);
  const [focusedPanel, setFocusedPanel] = useState<PanelFocus>("agent");
  const [exitedTerminalIds, setExitedTerminalIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [finishedAgentIds, setFinishedAgentIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [workingAgentIds, setWorkingAgentIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [capturingShortcut, setCapturingShortcut] =
    useState<ShortcutTarget | null>(null);
  const [shortcuts, setShortcuts] = useState<Shortcuts>(loadShortcuts);
  const [splitPercent, setSplitPercent] = useState(loadSplitPercent);
  const [error, setError] = useState("");
  const sidebarRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sessionListRef = useRef<HTMLElement>(null);
  const sessionTopsRef = useRef(new Map<string, number>());
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
  const focusedPanelRef = useRef<PanelFocus>("agent");
  const visibleSessionsRef = useRef<SessionRecord[]>([]);
  const activeSessionIdRef = useRef("");
  const activeAgentTerminalIdRef = useRef("");
  const notesSaveTimersRef = useRef(new Map<string, number>());
  const agentOutputAtRef = useRef(new Map<string, number>());
  const agentInputAtRef = useRef(new Map<string, number>());
  const agentInteractedRef = useRef(new Set<string>());
  const workingAgentIdsRef = useRef<Set<string>>(new Set());

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
  const normalizedSearch = sessionSearch.trim().toLowerCase();
  const visibleSessions = useMemo(() => {
    const inView = orderedSessions.filter((session) =>
      showArchived ? session.archived : !session.archived,
    );
    if (!normalizedSearch) {
      return inView;
    }

    const tokens = normalizedSearch.split(/\s+/);
    return inView.filter((session) => sessionMatchesSearch(session, tokens));
  }, [orderedSessions, showArchived, normalizedSearch]);
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
  const workingSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const terminalId of workingAgentIds) {
      const sessionId = sessionIdFromTerminalId(terminalId);
      if (sessionId) {
        ids.add(sessionId);
      }
    }
    return ids;
  }, [workingAgentIds]);
  const activeSailboxState = sailboxState(activeSession);
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
    const tick = () => {
      const now = Date.now();
      const next = new Set<string>();
      for (const [terminalId, at] of agentOutputAtRef.current) {
        if (now - at < agentIdleAfterMs) {
          next.add(terminalId);
        }
      }

      const previous = workingAgentIdsRef.current;
      let changed = next.size !== previous.size;
      for (const terminalId of previous) {
        if (!next.has(terminalId)) {
          changed = true;
          markAgentReady(terminalId);
        }
      }
      if (!changed) {
        for (const terminalId of next) {
          if (!previous.has(terminalId)) {
            changed = true;
          }
        }
      }

      if (changed) {
        workingAgentIdsRef.current = next;
        setWorkingAgentIds(next);
      }
    };

    const timer = window.setInterval(tick, 400);
    return () => window.clearInterval(timer);
  }, []);

  // FLIP: whenever the sidebar order changes between renders, animate each
  // row from its previous position to its new one.
  useLayoutEffect(() => {
    const list = sessionListRef.current;
    if (!list) {
      return;
    }

    const listTop = list.getBoundingClientRect().top;
    const tops = new Map<string, number>();
    for (const child of Array.from(list.children)) {
      if (!(child instanceof HTMLElement) || !child.dataset.sessionId) {
        continue;
      }

      tops.set(
        child.dataset.sessionId,
        child.getBoundingClientRect().top - listTop + list.scrollTop,
      );
    }

    const previousTops = sessionTopsRef.current;
    for (const child of Array.from(list.children)) {
      if (!(child instanceof HTMLElement) || !child.dataset.sessionId) {
        continue;
      }

      const previousTop = previousTops.get(child.dataset.sessionId);
      const nextTop = tops.get(child.dataset.sessionId);
      if (previousTop === undefined || nextTop === undefined) {
        continue;
      }

      const delta = previousTop - nextTop;
      if (Math.abs(delta) < 2) {
        continue;
      }

      child.animate(
        [
          { transform: `translateY(${delta}px)` },
          { transform: "translateY(0)" },
        ],
        { duration: 240, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
      );
    }

    sessionTopsRef.current = tops;
  });

  useEffect(() => {
    focusedPanelRef.current = focusedPanel;
  }, [focusedPanel]);

  useEffect(() => {
    visibleSessionsRef.current = visibleSessions;
  }, [visibleSessions]);

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

  // Periodically re-run gt info for the active session so the Graphite
  // button lights up on its own once a PR exists.
  useEffect(() => {
    if (!activeSession || activeSession.archived) {
      return;
    }

    const timer = window.setInterval(() => {
      refreshGraphitePrs();
    }, 180_000);
    return () => window.clearInterval(timer);
  }, [activeSession?.id, activeSession?.archived]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (!topbarActionsRef.current?.contains(target)) {
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
    return window.agentEditor.onSessionChanged((updated) => {
      setSessions((current) =>
        current.map((session) =>
          session.id === updated.id
            ? { ...session, sailbox: updated.sailbox }
            : session,
        ),
      );
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (capturingShortcut) {
        event.preventDefault();
        event.stopPropagation();

        if (event.key === "Escape") {
          setCapturingShortcut(null);
          return;
        }

        const shortcut = shortcutFromEvent(event);
        if (shortcut) {
          setShortcuts((current) => ({
            ...current,
            [capturingShortcut]: shortcut,
          }));
          setCapturingShortcut(null);
        }
        return;
      }

      if (showSettings && event.key === "Escape") {
        event.preventDefault();
        setShowSettings(false);
        return;
      }

      const target = shortcutTargetForEvent(event, shortcutsRef.current);
      if (!target) {
        return;
      }

      // Shortcuts with a modifier still work while typing, so you can leave
      // the notes editor or the search box the same way you entered it.
      if (isEditableTarget(event.target) && !hasModifier(event)) {
        return;
      }

      event.preventDefault();
      runShortcut(target);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [capturingShortcut, showSettings]);

  useEffect(() => {
    if (
      !activeSession?.worktreePath ||
      !activeAgentTerminalId ||
      activeSailboxState !== "ready" ||
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
  }, [
    activeAgentTerminalId,
    activeSession?.worktreePath,
    agentCommand,
    activeSailboxState,
  ]);

  useEffect(() => {
    if (
      rightPaneMode !== "terminal" ||
      !activeSession?.repoPath ||
      !activeShellTerminalId ||
      activeSailboxState !== "ready" ||
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
    activeSailboxState,
  ]);

  function handleTerminalEvent(event: TerminalEvent) {
    const terminal = terminalsRef.current.get(event.terminalId);
    if (!terminal) {
      return;
    }

    if (event.type === "exit") {
      terminal.write(`\r\n[exited ${event.code ?? event.signal ?? 0}]\r\n`);
      startedTerminalIdsRef.current.delete(event.terminalId);
      agentOutputAtRef.current.delete(event.terminalId);
      agentInputAtRef.current.delete(event.terminalId);
      agentInteractedRef.current.delete(event.terminalId);
      setExitedTerminalIds((current) => new Set(current).add(event.terminalId));
      return;
    }

    if (event.type === "error") {
      terminal.write(`\r\n${event.message ?? "Terminal error"}\r\n`);
      return;
    }

    const data = event.data ?? "";
    terminal.write(data);
    if (data && event.terminalId.startsWith("agent:")) {
      const inputAt = agentInputAtRef.current.get(event.terminalId) ?? 0;
      if (Date.now() - inputAt > typingEchoMs) {
        agentOutputAtRef.current.set(event.terminalId, Date.now());
      }
    }
    captureGraphiteUrl(event.terminalId, data);
  }

  function recordAgentInput(terminalId: string, data: string) {
    if (!terminalId.startsWith("agent:")) {
      return;
    }

    if (data.startsWith("\u001b")) {
      agentInputAtRef.current.set(terminalId, Date.now());
      return;
    }

    agentInputAtRef.current.set(terminalId, Date.now());
    agentInteractedRef.current.add(terminalId);
  }

  function markAgentReady(terminalId: string) {
    if (!agentInteractedRef.current.delete(terminalId)) {
      return;
    }

    const sessionId = sessionIdFromTerminalId(terminalId);
    if (sessionId) {
      bumpSessionActivity(sessionId);
    }

    if (sessionId === activeSessionIdRef.current) {
      return;
    }

    setFinishedAgentIds((current) => new Set(current).add(terminalId));
  }

  function bumpSessionActivity(sessionId: string) {
    const now = Date.now();
    setSessions((current) =>
      current.map((session) =>
        session.id === sessionId ? { ...session, updatedAt: now } : session,
      ),
    );
    window.agentEditor.updateSession({ id: sessionId }).catch(() => undefined);
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
    terminal.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (event.metaKey) {
          window.agentEditor.openExternal(uri).catch(() => undefined);
        }
      }),
    );
    terminal.attachCustomKeyEventHandler((event) =>
      handleTerminalKeyEvent(event, terminalId, terminal),
    );
    terminal.onData((data) => {
      recordAgentInput(terminalId, data);
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
    if (
      event.key === "Enter" &&
      event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      // Swallow keypress/keyup too: xterm resends a bare CR on the Enter
      // keypress, which would submit right after the inserted newline.
      if (event.type === "keydown") {
        recordAgentInput(terminalId, "\r");
        window.agentEditor
          .sendTerminalInput(terminalId, "\u001b\r")
          .catch(() => undefined);
      }
      return false;
    }

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
      runShortcut(target);
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
      });
      setSessions((current) => [session, ...current]);
      setActiveSessionId(session.id);
      setRepo(await window.agentEditor.inspectRepo(session.worktreePath));
      rememberRecentRepo(session.repoPath);
      setSessionName("");
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

  async function retrySailbox(session: SessionRecord) {
    setError("");

    try {
      const updatedSession = await window.agentEditor.retrySailbox(session.id);
      setSessions((current) =>
        current.map((item) =>
          item.id === session.id
            ? { ...item, sailbox: updatedSession.sailbox }
            : item,
        ),
      );
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

  function forgetRecentRepo(repoPath: string) {
    setRecentRepoPaths((current) =>
      current.filter((path) => path !== repoPath),
    );
    window.agentEditor.forgetRepo(repoPath).catch(() => undefined);
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

    recordAgentInput(activeAgentTerminalId, text);
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
              }
            : session,
        ),
      );
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

  function runShortcut(target: ShortcutTarget) {
    if (target === "cycleSessions") {
      cycleSessions();
      return;
    }

    if (target === "newSession") {
      setShowNewSession(true);
      return;
    }

    if (target === "search") {
      setFocusedPanel("sidebar");
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
      return;
    }

    if (target === "notes") {
      setRightPaneMode("notes");
      setFocusedPanel("terminal");
      requestAnimationFrame(() => notesEditorRef.current?.focus());
      return;
    }

    focusPanel(target);
  }

  function cycleSessions() {
    const sessionList = visibleSessionsRef.current;
    if (sessionList.length === 0) {
      return;
    }

    const index = sessionList.findIndex(
      (session) => session.id === activeSessionIdRef.current,
    );
    const next = sessionList[(index + 1) % sessionList.length];
    if (next) {
      selectSession(next);
    }
  }

  function focusPanel(target: PanelFocus) {
    setFocusedPanel(target);
    if (target === "sidebar") {
      const element = sidebarRef.current?.querySelector<
        HTMLButtonElement | HTMLInputElement
      >("button, input");
      element?.focus();
      return;
    }

    if (target === "terminal") {
      setRightPaneMode("terminal");
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

  function resetShortcuts() {
    setShortcuts(defaultShortcuts);
    setCapturingShortcut(null);
  }

  function closeSettings() {
    setShowSettings(false);
    setCapturingShortcut(null);
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
          <div className="session-search">
            <Search size={13} className="search-icon" />
            <input
              ref={searchInputRef}
              value={sessionSearch}
              onChange={(event) => setSessionSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && visibleSessions[0]) {
                  selectSession(visibleSessions[0]);
                }
                if (event.key === "Escape") {
                  if (sessionSearch) {
                    setSessionSearch("");
                  } else {
                    event.currentTarget.blur();
                  }
                }
              }}
              placeholder="Search sessions"
            />
            {sessionSearch ? (
              <button
                className="search-clear"
                onClick={() => {
                  setSessionSearch("");
                  searchInputRef.current?.focus();
                }}
                aria-label="Clear search"
              >
                <X size={12} />
              </button>
            ) : null}
          </div>
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
            {creatingSession ? (
              <div className="creating-session">
                <span className="pane-spinner" aria-hidden="true" />
                <span>Creating session… (large repos can take a minute)</span>
              </div>
            ) : null}
            <div className="repo-list">
              <div className="repo-scroll">
                {recentRepoPaths.map((repoPath) => (
                  <div className="repo-row" key={repoPath}>
                    <button
                      onClick={() => createSessionForRepo(repoPath)}
                      disabled={creatingSession}
                    >
                      <span>{basename(repoPath)}</span>
                      <small>{repoPath}</small>
                    </button>
                    <button
                      className="repo-remove"
                      onClick={() => forgetRecentRepo(repoPath)}
                      disabled={creatingSession}
                      data-tooltip="Remove from list"
                      aria-label="Remove from list"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
              <button
                onClick={chooseRepoForNewSession}
                disabled={creatingSession}
              >
                <span>Choose repo</span>
              </button>
            </div>
          </section>
        ) : null}

        <nav className="session-list" ref={sessionListRef}>
          {normalizedSearch && visibleSessions.length === 0 ? (
            <p className="session-search-empty">No matching sessions</p>
          ) : null}
          {visibleSessions.map((session) => (
            <div
              className={sessionItemClassName(
                session,
                activeSessionId,
                finishedAgentIds,
                workingSessionIds,
              )}
              key={session.id}
              data-session-id={session.id}
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
              ) : (
                <>
                  <button
                    className="session-main"
                    onClick={() => selectSession(session)}
                  >
                    <span className="session-title">
                      <span className="session-name">{session.name}</span>
                      {workingSessionIds.has(session.id) ||
                      sailboxState(session) === "provisioning" ? (
                        <span className="status-dots" aria-hidden="true">
                          <i />
                          <i />
                          <i />
                        </span>
                      ) : sessionHasFinishedAgent(session, finishedAgentIds) ? (
                        <span className="status-done" aria-hidden="true" />
                      ) : null}
                    </span>
                    <small>{session.branch}</small>
                  </button>
                  <div className="session-actions">
                    {session.archived ? (
                      <button
                        onClick={() => reviveSession(session)}
                        data-tooltip="Unarchive"
                        aria-label="Unarchive"
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
                        {closingSessionId === session.id ? (
                          <>
                            <button
                              onClick={() => closeSession(session)}
                              data-tooltip="Confirm archive"
                              aria-label="Confirm archive"
                            >
                              <Check size={13} />
                            </button>
                            <button
                              onClick={() => setClosingSessionId("")}
                              data-tooltip="Cancel"
                              aria-label="Cancel"
                            >
                              <X size={13} />
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => {
                              setClosingSessionId(session.id);
                              setEditingSessionId("");
                              setForkingSessionId("");
                              setConfirmingDeleteId("");
                            }}
                            data-tooltip="Archive"
                            aria-label="Archive"
                          >
                            <Archive size={13} />
                          </button>
                        )}
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
              <button
                className="pr-link lit linear"
                onClick={openLinearUrl}
                data-tooltip="Open in Linear"
              >
                {activeSession.linearIssue.identifier}
                <ExternalLink size={13} />
              </button>
            ) : null}
            {activeSession && !activeSession.archived ? (
              <button
                className="pr-link"
                onClick={() => syncLinear(activeSession)}
                data-tooltip={
                  activeSession.linearIssue
                    ? "Re-sync Linear issue"
                    : "Link a Linear issue"
                }
              >
                <Link2 size={13} />
                Linear
              </button>
            ) : null}
            {activeSession && !activeSession.archived ? (
              <button
                className={
                  activeGraphitePrUrls.length
                    ? "pr-link lit graphite"
                    : "pr-link"
                }
                onClick={openOrRefreshGraphite}
                data-tooltip={
                  activeGraphitePrUrls.length === 1
                    ? "Open PR in Graphite"
                    : activeGraphitePrUrls.length > 1
                      ? `${activeGraphitePrUrls.length} PRs — choose one`
                      : "Detect PRs"
                }
              >
                <GitPullRequest size={13} />
                Graphite
                {activeGraphitePrUrls.length > 1 ? (
                  <span className="pr-count">
                    {activeGraphitePrUrls.length}
                  </span>
                ) : null}
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
              onClick={() => setShowSettings(true)}
              data-tooltip="Settings"
              aria-label="Settings"
            >
              <SettingsIcon size={16} />
            </button>
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
                <span>{currentProfile.command}</span>
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
            {activeSailboxState === "ready" ? (
              <div className="xterm-host" ref={agentContainerRef} />
            ) : (
              <div className="pane-status">
                {activeSailboxState === "error" ? (
                  <>
                    <p>Sailbox failed to start</p>
                    <small>{activeSession?.sailbox?.error}</small>
                    <button
                      onClick={() => {
                        if (activeSession) {
                          retrySailbox(activeSession);
                        }
                      }}
                    >
                      Retry
                    </button>
                  </>
                ) : (
                  <>
                    <span className="pane-spinner" aria-hidden="true" />
                    <p>Starting sailbox…</p>
                    <small>
                      The agent will start automatically once the box is up.
                    </small>
                  </>
                )}
              </div>
            )}
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
              activeSailboxState === "ready" ? (
                <div className="xterm-host" ref={shellContainerRef} />
              ) : (
                <div className="pane-status">
                  {activeSailboxState === "error" ? (
                    <p>Sailbox failed to start</p>
                  ) : (
                    <>
                      <span className="pane-spinner" aria-hidden="true" />
                      <p>Starting sailbox…</p>
                    </>
                  )}
                </div>
              )
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

      {showSettings ? (
        <div
          className="settings-overlay"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) {
              closeSettings();
            }
          }}
        >
          <section className="settings-panel">
            <div className="settings-head">
              <h2>Settings</h2>
              <button onClick={closeSettings} aria-label="Close settings">
                <X size={14} />
              </button>
            </div>

            <div className="settings-section">
              <div className="settings-section-head">
                <h3>Shortcuts</h3>
                <button className="settings-reset" onClick={resetShortcuts}>
                  Reset to defaults
                </button>
              </div>
              <p className="settings-hint">
                Click a shortcut, then press the keys you want.
              </p>
              {shortcutTargets.map((target) => (
                <button
                  className={
                    capturingShortcut === target
                      ? "settings-row capturing"
                      : "settings-row"
                  }
                  key={target}
                  onClick={() => updateShortcut(target)}
                >
                  <span>{shortcutLabel(target)}</span>
                  <kbd>
                    {capturingShortcut === target
                      ? "Press keys…"
                      : displayShortcut(shortcuts[target])}
                  </kbd>
                </button>
              ))}
            </div>
          </section>
        </div>
      ) : null}
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
      const base = `claude --dangerously-skip-permissions --append-system-prompt ${shellQuote(terminalAccessPrompt(session.target))}`;
      const quotedId = shellQuote(claudeSessionId);
      const transcriptName = shellQuote(`${claudeSessionId}.jsonl`);
      command = `if find "$HOME/.claude/projects" -name ${transcriptName} 2>/dev/null | grep -q .; then ${base} --resume ${quotedId}; else ${base} --session-id ${quotedId}; fi`;
    }
  }

  if (profile.id === "codex") {
    command = `codex --dangerously-bypass-approvals-and-sandbox ${shellQuote(terminalAccessPrompt(session.target))}`;
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
      Record<string, NotesState> | Record<string, never>;
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
  workingSessionIds: Set<string>,
) {
  const classNames = ["session-item"];
  if (session.id === activeSessionId) {
    classNames.push("active");
  }
  if (workingSessionIds.has(session.id)) {
    classNames.push("agent-working");
  } else if (sessionHasFinishedAgent(session, finishedAgentIds)) {
    classNames.push("agent-finished");
  }

  return classNames.join(" ");
}

function sailboxState(
  session: SessionRecord | undefined,
): "ready" | "provisioning" | "error" {
  if (!session || session.target !== "sailbox") {
    return "ready";
  }

  const sailbox = session.sailbox;
  if (sailbox?.status === "error") {
    return "error";
  }

  // Sessions from before provisioning states existed have no status; treat
  // them as ready when the box details are present.
  if (sailbox?.id && sailbox.workdir && sailbox.status !== "provisioning") {
    return "ready";
  }

  return "provisioning";
}

function sessionMatchesSearch(session: SessionRecord, tokens: string[]) {
  const haystack = [
    session.name,
    session.branch,
    session.repoPath,
    session.notes ?? "",
    session.linearIssue?.identifier ?? "",
    session.linearIssue?.title ?? "",
    session.sailbox?.name ?? "",
    session.sailbox?.app ?? "",
  ]
    .join("\n")
    .toLowerCase();

  return tokens.every((token) => haystack.includes(token));
}

function sessionHasFinishedAgent(
  session: SessionRecord,
  finishedAgentIds: Set<string>,
) {
  return [...finishedAgentIds].some((terminalId) =>
    terminalId.startsWith(`agent:${session.id}:`),
  );
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
    const stored = JSON.parse(
      localStorage.getItem(shortcutStorageKey) ?? "{}",
    ) as Partial<Record<string, string>>;
    const shortcuts = { ...defaultShortcuts };
    // Only adopt bindings we still have an action for; older versions stored
    // targets that no longer exist.
    for (const target of shortcutTargets) {
      const value = stored[target];
      if (typeof value === "string" && value) {
        shortcuts[target] = value;
      }
    }
    return shortcuts;
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

const shortcutLabels: Record<ShortcutTarget, string> = {
  cycleSessions: "Cycle through sessions",
  agent: "Focus agent",
  terminal: "Focus terminal",
  notes: "Focus notes",
  newSession: "New session",
  search: "Search sessions",
};

function shortcutLabel(target: ShortcutTarget) {
  return shortcutLabels[target];
}

function hasModifier(event: KeyboardEvent) {
  return event.metaKey || event.ctrlKey || event.altKey;
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
