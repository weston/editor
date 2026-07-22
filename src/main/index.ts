import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell as electronShell,
  type OpenDialogOptions,
} from "electron";
import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import * as pty from "node-pty";
import type {
  AgentEvent,
  AgentProfileId,
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

const processes = new Map<string, ChildProcessWithoutNullStreams>();
const terminalProcesses = new Map<string, pty.IPty>();
const terminalInputStates = new Map<string, { input: string }>();

let mainWindow: BrowserWindow | null = null;

const agentCommands: Record<AgentProfileId, (prompt: string) => string> = {
  codex: (prompt) => `codex exec ${shellQuote(prompt)}`,
  claude: (prompt) => `claude -p ${shellQuote(prompt)}`,
  q: (prompt) => `q ${shellQuote(prompt)}`,
  shell: (prompt) => prompt,
};

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 700,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#111318",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

function statePath() {
  return path.join(app.getPath("userData"), "state.json");
}

function terminalLogPath(terminalId: string) {
  return path.join(
    app.getPath("userData"),
    "terminal-logs",
    `${terminalId.replace(/[^a-zA-Z0-9._-]/g, "_")}.log`,
  );
}

function terminalCommandsPath(terminalId: string) {
  return path.join(
    app.getPath("userData"),
    "terminal-commands",
    `${terminalId.replace(/[^a-zA-Z0-9._-]/g, "_")}.jsonl`,
  );
}

function editorBinDir() {
  return path.join(app.getPath("userData"), "bin");
}

function editorTerminalHelperPath() {
  return path.join(editorBinDir(), "editor-terminal");
}

async function readState(): Promise<StoredState> {
  try {
    const raw = await readFile(statePath(), "utf8");
    const parsed = JSON.parse(raw) as StoredState;
    return {
      sessions: parsed.sessions ?? [],
      lastRepoPath: parsed.lastRepoPath,
      recentRepoPaths: parsed.recentRepoPaths ?? [],
    };
  } catch {
    return { sessions: [] };
  }
}

function rememberRepo(state: StoredState, repoPath: string): StoredState {
  const recentRepoPaths = [
    repoPath,
    ...(state.recentRepoPaths ?? []).filter((path) => path !== repoPath),
  ].slice(0, 8);

  return {
    ...state,
    lastRepoPath: repoPath,
    recentRepoPaths,
  };
}

async function writeState(state: StoredState) {
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(statePath(), JSON.stringify(state, null, 2), "utf8");
}

async function ensureEditorTools() {
  await mkdir(editorBinDir(), { recursive: true });
  await writeFile(
    editorTerminalHelperPath(),
    `#!/bin/sh
set -eu
command_name="\${1:-lines}"
count="\${2:-80}"

case "$command_name" in
  lines)
    if [ -n "\${EDITOR_TERMINAL_LOG_PATH:-}" ] && [ -f "$EDITOR_TERMINAL_LOG_PATH" ]; then
      tail -n "$count" "$EDITOR_TERMINAL_LOG_PATH"
    fi
    ;;
  commands)
    if [ -n "\${EDITOR_TERMINAL_COMMANDS_PATH:-}" ] && [ -f "$EDITOR_TERMINAL_COMMANDS_PATH" ]; then
      tail -n "$count" "$EDITOR_TERMINAL_COMMANDS_PATH"
    fi
    ;;
  paths)
    printf 'EDITOR_SESSION_ID=%s\\n' "\${EDITOR_SESSION_ID:-}"
    printf 'EDITOR_TERMINAL_LOG_PATH=%s\\n' "\${EDITOR_TERMINAL_LOG_PATH:-}"
    printf 'EDITOR_TERMINAL_COMMANDS_PATH=%s\\n' "\${EDITOR_TERMINAL_COMMANDS_PATH:-}"
    ;;
  *)
    printf 'usage: editor-terminal lines [count] | commands [count] | paths\\n' >&2
    exit 2
    ;;
esac
`,
    "utf8",
  );
  await chmod(editorTerminalHelperPath(), 0o755);
}

function execGit(
  cwd: string,
  args: string[],
  maxBuffer = 1024 * 1024,
): Promise<string> {
  return execFileText("git", args, cwd, maxBuffer);
}

function execFileText(
  command: string,
  args: string[],
  cwd: string,
  maxBuffer = 1024 * 1024,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd, maxBuffer, timeout: 20_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout.trimEnd());
      },
    );
  });
}

async function createSailbox(
  input: NonNullable<CreateSessionInput["sailbox"]>,
  cwd: string,
) {
  if (input.id?.trim()) {
    return input.id.trim();
  }

  if (!input.app?.trim() || !input.name?.trim()) {
    throw new Error("missing Sailbox app or name");
  }

  const raw = await execFileText(
    "sail",
    [
      "--json",
      "box",
      "create",
      "--app",
      input.app.trim(),
      "--name",
      input.name.trim(),
    ],
    cwd,
  );
  const parsed = JSON.parse(raw) as { sailbox_id?: string };

  if (!parsed.sailbox_id) {
    throw new Error("sail box create did not return sailbox_id");
  }

  return parsed.sailbox_id;
}

async function inspectRepo(repoPath: string): Promise<RepoSnapshot> {
  const rootPath = await execGit(repoPath, ["rev-parse", "--show-toplevel"]);
  const branch = await execGit(rootPath, ["branch", "--show-current"]).catch(
    () => "",
  );
  const status = await execGit(rootPath, ["status", "--short", "--branch"]);
  const diffStat = await execGit(rootPath, ["diff", "--stat"]).catch(() => "");
  const diff = await execGit(
    rootPath,
    ["diff", "--", "."],
    4 * 1024 * 1024,
  ).catch(() => "");

  return {
    repoPath,
    rootPath,
    branch,
    status,
    diffStat,
    diff: diff.slice(0, 240_000),
  };
}

function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return slug || "session";
}

async function createSession(
  input: CreateSessionInput,
): Promise<SessionRecord> {
  return createSessionFrom(input);
}

async function createSessionFrom(
  input: CreateSessionInput,
  sourceSession?: SessionRecord,
): Promise<SessionRecord> {
  const snapshot = await inspectRepo(input.repoPath);
  const state = await readState();
  const now = Date.now();
  const slug = `${slugify(input.name)}-${now.toString(36)}`;
  const repoSlug = slugify(path.basename(snapshot.rootPath));
  const worktreePath = path.join(
    app.getPath("userData"),
    "worktrees",
    repoSlug,
    slug,
  );
  const branch = `agent/${slug}`;
  const baseRef = sourceSession
    ? await execGit(sourceSession.worktreePath, ["rev-parse", "HEAD"])
    : "HEAD";
  const agentSessions: SessionRecord["agentSessions"] = {
    claude: randomUUID(),
  };
  const sailboxId =
    input.target === "sailbox"
      ? await createSailbox(input.sailbox ?? {}, snapshot.rootPath)
      : undefined;

  await mkdir(path.dirname(worktreePath), { recursive: true });

  try {
    await execGit(snapshot.rootPath, [
      "worktree",
      "add",
      "-b",
      branch,
      worktreePath,
      baseRef,
    ]);
  } catch (error) {
    await execGit(snapshot.rootPath, [
      "worktree",
      "add",
      worktreePath,
      baseRef,
    ]).catch(() => {
      throw error;
    });
  }

  const session: SessionRecord = {
    id: randomUUID(),
    name: input.name,
    target: input.target,
    repoPath: snapshot.rootPath,
    worktreePath,
    branch,
    agentSessions,
    sailbox:
      input.target === "sailbox"
        ? {
            app: input.sailbox?.app?.trim() || undefined,
            name: input.sailbox?.name?.trim() || undefined,
            id: sailboxId,
          }
        : undefined,
    createdAt: now,
    updatedAt: now,
  };

  if (sourceSession) {
    await copyWorktreeChanges(sourceSession.worktreePath, worktreePath, slug);
    await forkClaudeSession(sourceSession, session);
  }

  if (sourceSession?.agentSessions?.claude) {
    session.forkedAgentSessions = {
      claude: sourceSession.agentSessions.claude,
    };
  }

  const existingSessions = sourceSession
    ? state.sessions.map((existingSession) =>
        existingSession.id === sourceSession.id
          ? {
              ...existingSession,
              agentSessions: {
                ...existingSession.agentSessions,
                ...sourceSession.agentSessions,
              },
            }
          : existingSession,
      )
    : state.sessions;

  await writeState({
    ...rememberRepo(state, snapshot.rootPath),
    sessions: [session, ...existingSessions],
  });

  return session;
}

async function copyWorktreeChanges(
  sourcePath: string,
  targetPath: string,
  slug: string,
) {
  const patchDir = path.join(app.getPath("userData"), "patches");
  await mkdir(patchDir, { recursive: true });

  const cachedPatchPath = path.join(patchDir, `${slug}-cached.patch`);
  const workingPatchPath = path.join(patchDir, `${slug}-working.patch`);
  const cachedPatch = await execGit(
    sourcePath,
    ["diff", "--binary", "--cached"],
    32 * 1024 * 1024,
  ).catch(() => "");
  const workingPatch = await execGit(
    sourcePath,
    ["diff", "--binary"],
    32 * 1024 * 1024,
  ).catch(() => "");

  try {
    if (cachedPatch.trim()) {
      await writeFile(cachedPatchPath, cachedPatch, "utf8");
      await execGit(targetPath, ["apply", "--index", cachedPatchPath]);
    }

    if (workingPatch.trim()) {
      await writeFile(workingPatchPath, workingPatch, "utf8");
      await execGit(targetPath, ["apply", workingPatchPath]);
    }
  } finally {
    await rm(cachedPatchPath, { force: true });
    await rm(workingPatchPath, { force: true });
  }

  const untracked = await execGit(
    sourcePath,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    32 * 1024 * 1024,
  ).catch(() => "");
  await Promise.all(
    untracked
      .split("\0")
      .filter(Boolean)
      .map(async (relativePath) => {
        const source = path.join(sourcePath, relativePath);
        const target = path.join(targetPath, relativePath);
        await mkdir(path.dirname(target), { recursive: true });
        await cp(source, target, { recursive: true, force: true });
      }),
  );
}

async function forkClaudeSession(
  sourceSession: SessionRecord,
  targetSession: SessionRecord,
) {
  const sourceClaudeId =
    sourceSession.agentSessions?.claude ??
    (await latestClaudeSessionId(sourceSession.worktreePath));
  const targetClaudeId = targetSession.agentSessions?.claude;

  if (!sourceClaudeId || !targetClaudeId) {
    return;
  }

  const sourcePath = path.join(
    claudeProjectPath(sourceSession.worktreePath),
    `${sourceClaudeId}.jsonl`,
  );
  const targetProjectPath = claudeProjectPath(targetSession.worktreePath);
  const targetPath = path.join(targetProjectPath, `${targetClaudeId}.jsonl`);
  const sourceRaw = await readFile(sourcePath, "utf8").catch(() => "");
  if (!sourceRaw) {
    return;
  }

  await mkdir(targetProjectPath, { recursive: true });
  await writeFile(
    targetPath,
    sourceRaw
      .replaceAll(sourceClaudeId, targetClaudeId)
      .replaceAll(sourceSession.worktreePath, targetSession.worktreePath)
      .replaceAll(sourceSession.branch, targetSession.branch),
    "utf8",
  );
  sourceSession.agentSessions = {
    ...sourceSession.agentSessions,
    claude: sourceClaudeId,
  };
}

async function latestClaudeSessionId(worktreePath: string) {
  const projectPath = claudeProjectPath(worktreePath);
  const entries = await readdir(projectPath).catch(() => []);
  const files = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".jsonl"))
      .map(async (entry) => {
        const filePath = path.join(projectPath, entry);
        const stats = await stat(filePath);
        return {
          id: path.basename(entry, ".jsonl"),
          mtimeMs: stats.mtimeMs,
        };
      }),
  );

  return files.sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.id;
}

function claudeProjectPath(worktreePath: string) {
  return path.join(
    homedir(),
    ".claude",
    "projects",
    claudeProjectSlug(worktreePath),
  );
}

function claudeProjectSlug(worktreePath: string) {
  return worktreePath.replace(/[^a-zA-Z0-9]/g, "-");
}

async function forkSession(input: ForkSessionInput): Promise<SessionRecord> {
  const state = await readState();
  const sourceSession = state.sessions.find(
    (session) => session.id === input.sourceSessionId,
  );

  if (!sourceSession) {
    throw new Error("session not found");
  }

  return createSessionFrom(
    {
      repoPath: sourceSession.repoPath,
      name: input.name,
      target: sourceSession.target,
      sailbox: sourceSession.sailbox,
    },
    sourceSession,
  );
}

async function updateSession(
  input: UpdateSessionInput,
): Promise<SessionRecord> {
  const state = await readState();
  const now = Date.now();
  let updatedSession: SessionRecord | undefined;
  const sessions = state.sessions.map((session) => {
    if (session.id !== input.id) {
      return session;
    }

    updatedSession = {
      ...session,
      name: input.name ?? session.name,
      pinned: input.pinned ?? session.pinned,
      graphitePrUrl:
        input.graphitePrUrl === undefined
          ? session.graphitePrUrl
          : (input.graphitePrUrl ?? undefined),
      graphitePrUrls:
        input.graphitePrUrls === undefined
          ? session.graphitePrUrls
          : (input.graphitePrUrls ?? undefined),
      linearIssue:
        input.linearIssue === undefined
          ? session.linearIssue
          : (input.linearIssue ?? undefined),
      notes: input.notes ?? session.notes,
      notesUndoStack: input.notesUndoStack ?? session.notesUndoStack,
      notesRedoStack: input.notesRedoStack ?? session.notesRedoStack,
      updatedAt: now,
    };
    return updatedSession;
  });

  if (!updatedSession) {
    throw new Error("session not found");
  }

  await writeState({ ...state, sessions });
  return updatedSession;
}

async function deleteSession(sessionId: string): Promise<SessionRecord[]> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) {
    return state.sessions;
  }

  stopAgent(sessionId);
  stopSessionTerminals(sessionId);

  await execGit(session.repoPath, [
    "worktree",
    "remove",
    "--force",
    session.worktreePath,
  ]).catch(() => undefined);

  const sessions = state.sessions.filter((item) => item.id !== sessionId);
  await writeState({ ...state, sessions });
  return sessions;
}

async function closeSession(
  input: CloseSessionInput,
): Promise<SessionRecord[]> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === input.id);
  if (!session) {
    return state.sessions;
  }

  stopAgent(session.id);
  stopSessionTerminals(session.id);

  if (input.completeLinear && session.linearIssue) {
    await completeLinearIssue(session.linearIssue.id);
  }

  const archivedRef = await execGit(session.worktreePath, [
    "rev-parse",
    "HEAD",
  ]).catch(() => session.archivedRef);

  if (input.cleanupGit) {
    await execGit(session.repoPath, [
      "worktree",
      "remove",
      "--force",
      session.worktreePath,
    ]).catch(() => undefined);
    await execGit(session.repoPath, ["branch", "-D", session.branch]).catch(
      () => undefined,
    );
  }

  const now = Date.now();
  const sessions = state.sessions.map((item) =>
    item.id === session.id
      ? {
          ...item,
          archived: input.archive,
          archivedAt: input.archive ? now : undefined,
          archivedRef,
          updatedAt: now,
        }
      : item,
  );
  await writeState({ ...state, sessions });
  return sessions;
}

async function reviveSession(sessionId: string): Promise<SessionRecord> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) {
    throw new Error("session not found");
  }

  const now = Date.now();
  const worktreePath = session.worktreePath;
  const ref = session.archivedRef || "HEAD";

  await mkdir(path.dirname(worktreePath), { recursive: true });
  await execGit(session.repoPath, [
    "worktree",
    "add",
    "-b",
    session.branch,
    worktreePath,
    ref,
  ]).catch(async () => {
    await execGit(session.repoPath, ["worktree", "add", worktreePath, ref]);
  });

  const updatedSession = {
    ...session,
    archived: false,
    archivedAt: undefined,
    updatedAt: now,
  };
  const sessions = state.sessions.map((item) =>
    item.id === session.id ? updatedSession : item,
  );
  await writeState({ ...state, sessions });
  return updatedSession;
}

async function syncLinear(sessionId: string): Promise<LinearIssue> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) {
    throw new Error("session not found");
  }

  const issue =
    (await findLinearIssue(session)) ?? (await createLinearIssue(session));
  const updatedSession = {
    ...session,
    linearIssue: issue,
    updatedAt: Date.now(),
  };
  const sessions = state.sessions.map((item) =>
    item.id === session.id ? updatedSession : item,
  );
  await writeState({ ...state, sessions });
  return issue;
}

async function refreshGraphitePrs(sessionId: string): Promise<string[]> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) {
    throw new Error("session not found");
  }

  const output = await execFileText(
    "gt",
    ["info"],
    session.worktreePath,
    4 * 1024 * 1024,
  ).catch(() => "");
  const urls = parseGraphiteUrls(output);
  const updatedSession = {
    ...session,
    graphitePrUrl: urls[0],
    graphitePrUrls: urls,
    updatedAt: Date.now(),
  };
  const sessions = state.sessions.map((item) =>
    item.id === session.id ? updatedSession : item,
  );
  await writeState({ ...state, sessions });
  return urls;
}

function parseGraphiteUrls(value: string) {
  return [
    ...new Set(
      value
        .match(/https:\/\/(?:app\.)?graphite\.dev\/[^\s"'<>)]*/g)
        ?.map((url) => url.replace(/[.,;:]+$/, "")) ?? [],
    ),
  ];
}

async function linearRequest<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error("LINEAR_API_KEY is not set");
  }

  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  const parsed = (await response.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };

  if (!response.ok || parsed.errors?.length) {
    throw new Error(
      parsed.errors?.map((error) => error.message).join(", ") ||
        `Linear request failed with ${response.status}`,
    );
  }

  if (!parsed.data) {
    throw new Error("Linear response did not include data");
  }

  return parsed.data;
}

async function findLinearIssue(
  session: SessionRecord,
): Promise<LinearIssue | null> {
  const identifier = [session.name, session.branch, session.graphitePrUrl]
    .join(" ")
    .match(/[A-Z][A-Z0-9]+-\d+/)?.[0];

  if (identifier) {
    const data = await linearRequest<{
      issue?: LinearIssueResponse | null;
    }>(
      `query Issue($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          url
          state { name }
        }
      }`,
      { id: identifier },
    ).catch(() => null);
    if (data?.issue) {
      return linearIssueFromResponse(data.issue);
    }
  }

  const query = session.name || path.basename(session.repoPath);
  const data = await linearRequest<{
    issueSearch?: { nodes: LinearIssueResponse[] };
  }>(
    `query IssueSearch($query: String!) {
      issueSearch(first: 10, query: $query) {
        nodes {
          id
          identifier
          title
          url
          state { name }
        }
      }
    }`,
    { query },
  ).catch(() => null);

  return data?.issueSearch?.nodes[0]
    ? linearIssueFromResponse(data.issueSearch.nodes[0])
    : null;
}

async function createLinearIssue(session: SessionRecord): Promise<LinearIssue> {
  const teamId = await linearTeamId();
  const data = await linearRequest<{
    issueCreate: { issue: LinearIssueResponse };
  }>(
    `mutation IssueCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        issue {
          id
          identifier
          title
          url
          state { name }
        }
      }
    }`,
    {
      input: {
        teamId,
        title: session.name,
        description: [
          `Session: ${session.id}`,
          `Repo: ${session.repoPath}`,
          `Branch: ${session.branch}`,
          session.graphitePrUrl ? `Graphite: ${session.graphitePrUrl}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    },
  );

  return linearIssueFromResponse(data.issueCreate.issue);
}

async function completeLinearIssue(issueId: string) {
  const data = await linearRequest<{
    issue?: {
      team?: {
        states?: {
          nodes: Array<{ id: string; name: string; type?: string }>;
        };
      };
    } | null;
  }>(
    `query IssueStates($id: String!) {
      issue(id: $id) {
        team {
          states {
            nodes { id name type }
          }
        }
      }
    }`,
    { id: issueId },
  );
  const state = data.issue?.team?.states?.nodes.find(
    (item) => item.type === "completed" || item.name.toLowerCase() === "done",
  );
  if (!state) {
    throw new Error("Linear completed state not found");
  }

  await linearRequest(
    `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`,
    { id: issueId, input: { stateId: state.id } },
  );
}

async function linearTeamId() {
  const configuredTeamKey = process.env.LINEAR_TEAM_KEY;
  const data = await linearRequest<{
    teams: { nodes: Array<{ id: string; key: string }> };
  }>(
    `query Teams {
      teams {
        nodes { id key }
      }
    }`,
    {},
  );
  const team = configuredTeamKey
    ? data.teams.nodes.find((item) => item.key === configuredTeamKey)
    : data.teams.nodes[0];

  if (!team) {
    throw new Error("Linear team not found");
  }

  return team.id;
}

type LinearIssueResponse = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state?: { name?: string } | null;
};

function linearIssueFromResponse(issue: LinearIssueResponse): LinearIssue {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    state: issue.state?.name,
  };
}

function sendAgentEvent(event: AgentEvent) {
  mainWindow?.webContents.send("agent:event", event);
}

function sendTerminalEvent(event: TerminalEvent) {
  mainWindow?.webContents.send("terminal:event", event);
}

async function appendTerminalOutput(terminalId: string, data: string) {
  const logPath = terminalLogPath(terminalId);
  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(logPath, data, "utf8");
}

async function appendTerminalCommand(terminalId: string, command: string) {
  const commandsPath = terminalCommandsPath(terminalId);
  await mkdir(path.dirname(commandsPath), { recursive: true });
  await appendFile(
    commandsPath,
    `${JSON.stringify({ command, at: Date.now() })}\n`,
    "utf8",
  );
}

function recordTerminalInput(terminalId: string, data: string) {
  if (!terminalId.startsWith("shell:")) {
    return;
  }

  const state = terminalInputStates.get(terminalId) ?? { input: "" };
  for (const char of data) {
    if (char === "\r") {
      const command = state.input.trimEnd();
      state.input = "";
      if (command.trim()) {
        void appendTerminalCommand(terminalId, command);
      }
    } else if (char === "\u007f") {
      state.input = state.input.slice(0, -1);
    } else if (char === "\u0003") {
      state.input = "";
    } else if (char === "\n" || char === "\u001b") {
      continue;
    } else if (char >= " " || char === "\t") {
      state.input += char;
    }
  }
  terminalInputStates.set(terminalId, state);
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function terminalEnv(terminalId?: string): NodeJS.ProcessEnv {
  const pairedTerminalId = terminalId
    ? pairedShellTerminalId(terminalId)
    : undefined;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${editorBinDir()}:${process.env.PATH ?? ""}`,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    CLICOLOR: "1",
    CLICOLOR_FORCE: "1",
    FORCE_COLOR: process.env.FORCE_COLOR ?? "3",
    EDITOR_SESSION_ID: terminalId ? sessionIdFromTerminalId(terminalId) : "",
    EDITOR_TERMINAL_LOG_PATH: pairedTerminalId
      ? terminalLogPath(pairedTerminalId)
      : "",
    EDITOR_TERMINAL_COMMANDS_PATH: pairedTerminalId
      ? terminalCommandsPath(pairedTerminalId)
      : "",
  };

  delete env.NO_COLOR;
  return env;
}

function pairedShellTerminalId(terminalId: string) {
  const sessionId = sessionIdFromTerminalId(terminalId);
  return sessionId ? `shell:${sessionId}` : "";
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

function startAgent(input: StartAgentInput) {
  stopAgent(input.sessionId);

  const agentCommand =
    input.commandOverride?.trim() || agentCommands[input.profile](input.prompt);
  const command =
    input.target === "sailbox"
      ? `sail box exec --stdin ${shellQuote(requiredSailboxId(input))} /bin/sh -lc ${shellQuote(agentCommand)}`
      : agentCommand;
  const shell = process.env.SHELL || "/bin/zsh";
  const child = spawn(shell, ["-lc", command], {
    cwd: input.cwd,
    env: terminalEnv(`agent:${input.sessionId}:${input.profile}`),
  });

  processes.set(input.sessionId, child);

  child.stdout.on("data", (chunk: Buffer) => {
    sendAgentEvent({
      sessionId: input.sessionId,
      type: "stdout",
      data: chunk.toString(),
      at: Date.now(),
    });
  });

  child.stderr.on("data", (chunk: Buffer) => {
    sendAgentEvent({
      sessionId: input.sessionId,
      type: "stderr",
      data: chunk.toString(),
      at: Date.now(),
    });
  });

  child.on("error", (error) => {
    processes.delete(input.sessionId);
    sendAgentEvent({
      sessionId: input.sessionId,
      type: "error",
      message: error.message,
      at: Date.now(),
    });
  });

  child.on("exit", (code, signal) => {
    processes.delete(input.sessionId);
    sendAgentEvent({
      sessionId: input.sessionId,
      type: "exit",
      code,
      signal,
      at: Date.now(),
    });
  });
}

function requiredSailboxId(input: StartAgentInput) {
  const sailboxId = input.sailboxId?.trim();
  if (!sailboxId) {
    throw new Error("missing sailbox id");
  }

  return sailboxId;
}

function stopAgent(sessionId: string) {
  const child = processes.get(sessionId);
  if (!child) {
    return false;
  }

  child.kill("SIGTERM");
  processes.delete(sessionId);
  return true;
}

function stopSessionTerminals(sessionId: string) {
  for (const [terminalId, terminal] of terminalProcesses.entries()) {
    if (
      terminalId === `shell:${sessionId}` ||
      terminalId.startsWith(`agent:${sessionId}:`)
    ) {
      terminal.kill();
      terminalProcesses.delete(terminalId);
    }
  }
}

function startTerminal(terminalId: string, cwd: string, command?: string) {
  if (terminalProcesses.has(terminalId)) {
    return true;
  }

  const shell = process.env.SHELL || "/bin/zsh";
  const terminal = pty.spawn(shell, command ? ["-lc", command] : ["-l"], {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
    cwd,
    env: terminalEnv(terminalId),
  });

  terminalProcesses.set(terminalId, terminal);
  sendTerminalEvent({
    terminalId,
    type: "stdout",
    data: "",
    at: Date.now(),
  });

  terminal.onData((data) => {
    void appendTerminalOutput(terminalId, data);
    sendTerminalEvent({
      terminalId,
      type: "stdout",
      data,
      at: Date.now(),
    });
  });

  terminal.onExit(({ exitCode, signal }) => {
    terminalProcesses.delete(terminalId);
    void appendTerminalOutput(
      terminalId,
      `\r\n[exited ${exitCode ?? signal ?? 0}]\r\n`,
    );
    sendTerminalEvent({
      terminalId,
      type: "exit",
      code: exitCode,
      signal: signal ? String(signal) : null,
      at: Date.now(),
    });
  });

  return true;
}

function registerIpc() {
  ipcMain.handle("state:load", async () => readState());

  ipcMain.handle("repo:choose", async () => {
    const options: OpenDialogOptions = {
      properties: ["openDirectory"],
      defaultPath: homedir(),
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const snapshot = await inspectRepo(result.filePaths[0]);
    const state = await readState();
    await writeState(rememberRepo(state, snapshot.rootPath));
    return snapshot;
  });

  ipcMain.handle("repo:inspect", async (_event, repoPath: string) =>
    inspectRepo(repoPath),
  );
  ipcMain.handle("session:create", async (_event, input: CreateSessionInput) =>
    createSession(input),
  );
  ipcMain.handle("session:fork", async (_event, input: ForkSessionInput) =>
    forkSession(input),
  );
  ipcMain.handle("session:close", async (_event, input: CloseSessionInput) =>
    closeSession(input),
  );
  ipcMain.handle("session:revive", async (_event, sessionId: string) =>
    reviveSession(sessionId),
  );
  ipcMain.handle("session:update", async (_event, input: UpdateSessionInput) =>
    updateSession(input),
  );
  ipcMain.handle("session:delete", async (_event, sessionId: string) =>
    deleteSession(sessionId),
  );
  ipcMain.handle("agent:start", async (_event, input: StartAgentInput) =>
    startAgent(input),
  );
  ipcMain.handle("agent:stop", async (_event, sessionId: string) =>
    stopAgent(sessionId),
  );
  ipcMain.handle(
    "agent:stdin",
    async (_event, sessionId: string, data: string) => {
      const child = processes.get(sessionId);
      if (!child) {
        return false;
      }

      child.stdin.write(data);
      return true;
    },
  );
  ipcMain.handle(
    "terminal:start",
    async (_event, terminalId: string, cwd: string, command?: string) =>
      startTerminal(terminalId, cwd, command),
  );
  ipcMain.handle(
    "terminal:stdin",
    async (_event, terminalId: string, data: string) => {
      const child = terminalProcesses.get(terminalId);
      if (!child) {
        return false;
      }

      recordTerminalInput(terminalId, data);
      child.write(data);
      return true;
    },
  );
  ipcMain.handle(
    "terminal:resize",
    async (_event, terminalId: string, cols: number, rows: number) => {
      const child = terminalProcesses.get(terminalId);
      if (!child) {
        return false;
      }

      child.resize(cols, rows);
      return true;
    },
  );
  ipcMain.handle("terminal:open-log", async (_event, terminalId: string) => {
    const logPath = terminalLogPath(terminalId);
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, "", { flag: "a" });
    return electronShell.openPath(logPath);
  });
  ipcMain.handle("external:open", async (_event, url: string) =>
    electronShell.openExternal(url),
  );
  ipcMain.handle("linear:sync", async (_event, sessionId: string) =>
    syncLinear(sessionId),
  );
  ipcMain.handle("graphite:refresh", async (_event, sessionId: string) =>
    refreshGraphitePrs(sessionId),
  );
}

app.whenReady().then(async () => {
  await ensureEditorTools();
  registerIpc();
  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on("before-quit", () => {
  for (const child of processes.values()) {
    child.kill("SIGTERM");
  }
  for (const child of terminalProcesses.values()) {
    child.kill();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
