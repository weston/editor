import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  shell as electronShell,
  type OpenDialogOptions,
} from "electron";
import {
  execFile,
  execFileSync,
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
import { homedir, tmpdir } from "node:os";
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
type TerminalInputState = {
  input: string;
  escape: "" | "start" | "csi" | "osc" | "ss3";
  sequence: string;
  pasting: boolean;
};

const terminalInputStates = new Map<string, TerminalInputState>();
let cachedShellPath: string | undefined;
let cachedLinearApiKey: string | undefined;

let mainWindow: BrowserWindow | null = null;

app.setName("Laser");
// Sessions, worktrees and terminal logs already live under the old name, and
// git records absolute worktree paths, so the data directory stays put.
app.setPath("userData", path.join(app.getPath("appData"), "Editor"));

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
    title: "Laser",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#111318",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
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

// The old name stays as an alias so agents already told about
// editor-terminal keep working.
function terminalHelperPaths() {
  return [
    path.join(editorBinDir(), "laser-terminal"),
    path.join(editorBinDir(), "editor-terminal"),
  ];
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
  ].slice(0, 20);

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
  const helper = `#!/bin/sh
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
    printf 'usage: laser-terminal lines [count] | commands [count] | paths\\n' >&2
    exit 2
    ;;
esac
`;

  for (const helperPath of terminalHelperPaths()) {
    await writeFile(helperPath, helper, "utf8");
    await chmod(helperPath, 0o755);
  }
}

function execGit(
  cwd: string,
  args: string[],
  maxBuffer = 1024 * 1024,
  timeout = 20_000,
): Promise<string> {
  return execFileText("git", args, cwd, maxBuffer, timeout);
}

// Checking out a large repo can take minutes, and git reports progress on
// stderr the whole time, so these need room to breathe.
function execGitCheckout(cwd: string, args: string[]): Promise<string> {
  return execGit(cwd, args, 32 * 1024 * 1024, 20 * 60_000);
}

function execEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: editorPath() };
}

function execFileText(
  command: string,
  args: string[],
  cwd: string,
  maxBuffer = 1024 * 1024,
  timeout = 20_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd, maxBuffer, timeout, env: execEnv() },
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

async function createSailbox(app: string, name: string, cwd: string) {
  const raw = await execFileText(
    "sail",
    ["--json", "box", "create", "--app", app, "--name", name],
    cwd,
    1024 * 1024,
    180_000,
  );
  const parsed = JSON.parse(raw) as { sailbox_id?: string };

  if (!parsed.sailbox_id) {
    throw new Error("sail box create did not return sailbox_id");
  }

  return parsed.sailbox_id;
}

async function updateSessionSailbox(
  sessionId: string,
  sailbox: NonNullable<SessionRecord["sailbox"]>,
): Promise<SessionRecord | undefined> {
  const state = await readState();
  let updated: SessionRecord | undefined;
  const sessions = state.sessions.map((session) => {
    if (session.id !== sessionId) {
      return session;
    }

    updated = { ...session, sailbox, updatedAt: Date.now() };
    return updated;
  });

  if (!updated) {
    return undefined;
  }

  await writeState({ ...state, sessions });
  sendRendererEvent("session:changed", updated);
  return updated;
}

async function provisionSailbox(sessionId: string) {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === sessionId);
  const sailbox = session?.sailbox;
  if (!session || session.target !== "sailbox" || !sailbox?.workdir) {
    return;
  }

  try {
    let sailboxId = sailbox.id;
    if (!sailboxId) {
      sailboxId = await createSailbox(
        sailbox.app || slugify(path.basename(session.repoPath)),
        sailbox.name || slugify(session.name),
        session.repoPath,
      );
      // Persist the id before the sync so a restart resumes instead of
      // creating a second box.
      await updateSessionSailbox(sessionId, { ...sailbox, id: sailboxId });
    }

    await syncWorktreeToSailbox(
      sailboxId,
      session.worktreePath,
      sailbox.workdir,
    );
    await updateSessionSailbox(sessionId, {
      ...sailbox,
      id: sailboxId,
      status: "ready",
      error: undefined,
    });
  } catch (error) {
    await updateSessionSailbox(sessionId, {
      ...sailbox,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function resumePendingSailboxes() {
  const state = await readState();
  for (const session of state.sessions) {
    if (
      session.target === "sailbox" &&
      session.sailbox?.status === "provisioning" &&
      !session.archived
    ) {
      void provisionSailbox(session.id);
    }
  }
}

async function syncWorktreeToSailbox(
  sailboxId: string,
  worktreePath: string,
  remoteWorkdir: string,
) {
  await new Promise<void>((resolve, reject) => {
    const tar = spawn("tar", ["--exclude", ".git", "-czf", "-", "."], {
      cwd: worktreePath,
      stdio: ["ignore", "pipe", "pipe"],
      env: execEnv(),
    });
    const sail = spawn(
      "sail",
      [
        "box",
        "exec",
        "--stdin",
        sailboxId,
        "/bin/sh",
        "-lc",
        `rm -rf ${shellQuote(remoteWorkdir)} && mkdir -p ${shellQuote(remoteWorkdir)} && tar -xzf - -C ${shellQuote(remoteWorkdir)}`,
      ],
      {
        cwd: worktreePath,
        stdio: ["pipe", "pipe", "pipe"],
        env: execEnv(),
      },
    );
    const stderr: Buffer[] = [];

    tar.stdout.pipe(sail.stdin);
    tar.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    sail.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    tar.on("error", reject);
    sail.on("error", reject);
    tar.on("exit", (code) => {
      if (code !== 0) {
        sail.kill();
        reject(
          new Error(Buffer.concat(stderr).toString() || `tar exited ${code}`),
        );
      }
    });
    sail.on("exit", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            Buffer.concat(stderr).toString() || `sail box exec exited ${code}`,
          ),
        );
        return;
      }
      resolve();
    });
  });
}

// Terminals cannot carry image bytes, so a pasted image is written to a file
// and the agent is handed the path instead.
async function saveClipboardImage(sessionId: string): Promise<string> {
  const image = clipboard.readImage();
  if (image.isEmpty()) {
    return "";
  }

  // tmpdir has no spaces, so the path can be typed unquoted.
  const directory = path.join(tmpdir(), "editor-pastes");
  await mkdir(directory, { recursive: true });
  const fileName = `paste-${Date.now()}.png`;
  const filePath = path.join(directory, fileName);
  await writeFile(filePath, image.toPNG());

  const state = await readState();
  const session = state.sessions.find((item) => item.id === sessionId);
  const sailboxId = session?.sailbox?.id;
  const workdir = session?.sailbox?.workdir;
  if (session?.target === "sailbox" && sailboxId && workdir) {
    const remotePath = `${workdir}/.editor-pastes/${fileName}`;
    await copyFileToSailbox(sailboxId, filePath, remotePath);
    return remotePath;
  }

  return filePath;
}

// A local path means nothing inside a sailbox, so dropped files are copied
// in and the agent is given the path they landed on.
async function resolveSessionFile(sessionId: string, filePath: string) {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === sessionId);
  const sailboxId = session?.sailbox?.id;
  const workdir = session?.sailbox?.workdir;
  if (session?.target !== "sailbox" || !sailboxId || !workdir) {
    return filePath;
  }

  const remotePath = `${workdir}/.editor-drops/${path.basename(filePath)}`;
  await copyFileToSailbox(sailboxId, filePath, remotePath);
  return remotePath;
}

async function copyFileToSailbox(
  sailboxId: string,
  localPath: string,
  remotePath: string,
) {
  const contents = await readFile(localPath);
  await new Promise<void>((resolve, reject) => {
    const sail = spawn(
      "sail",
      [
        "box",
        "exec",
        "--stdin",
        sailboxId,
        "/bin/sh",
        "-lc",
        `mkdir -p ${shellQuote(path.posix.dirname(remotePath))} && cat > ${shellQuote(remotePath)}`,
      ],
      { stdio: ["pipe", "ignore", "pipe"], env: execEnv() },
    );
    const stderr: Buffer[] = [];

    sail.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    sail.on("error", reject);
    sail.on("exit", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            Buffer.concat(stderr).toString() || `sail box exec exited ${code}`,
          ),
        );
        return;
      }
      resolve();
    });
    sail.stdin.end(contents);
  });
}

async function inspectRepo(repoPath: string): Promise<RepoSnapshot> {
  const rootPath = await execGit(repoPath, ["rev-parse", "--show-toplevel"]);
  const branch = await execGit(rootPath, ["branch", "--show-current"]).catch(
    () => "",
  );
  const status = await execGit(
    rootPath,
    ["status", "--short", "--branch"],
    32 * 1024 * 1024,
  ).catch(() => "");
  const diffStat = await execGit(
    rootPath,
    ["diff", "--stat"],
    8 * 1024 * 1024,
  ).catch(() => "");
  const diff = await execGit(
    rootPath,
    ["diff", "--", "."],
    32 * 1024 * 1024,
  ).catch(() => "");

  return {
    repoPath,
    rootPath,
    branch,
    status: status.slice(0, 20_000),
    diffStat: diffStat.slice(0, 20_000),
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
  const sailboxApp = input.sailbox?.app?.trim() || repoSlug;
  const sailboxName = input.sailbox?.name?.trim() || slug;
  const sailboxId = input.sailbox?.id?.trim() || undefined;
  const sailboxWorkdir =
    input.target === "sailbox" ? `/workspace/editor/${slug}` : undefined;

  await mkdir(path.dirname(worktreePath), { recursive: true });

  try {
    await execGitCheckout(snapshot.rootPath, [
      "worktree",
      "add",
      "--quiet",
      "-b",
      branch,
      worktreePath,
      baseRef,
    ]);
  } catch (error) {
    await execGitCheckout(snapshot.rootPath, [
      "worktree",
      "add",
      "--quiet",
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
    agentProfile: sourceSession?.agentProfile,
    agentSessions,
    sailbox:
      input.target === "sailbox"
        ? {
            app: sailboxApp,
            name: sailboxName,
            id: sailboxId,
            workdir: sailboxWorkdir,
            status: "provisioning",
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

  if (session.target === "sailbox") {
    void provisionSailbox(session.id);
  }

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
      agentProfile: input.agentProfile ?? session.agentProfile,
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

  await execGitCheckout(session.repoPath, [
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

  const archivedRef = await execGit(session.worktreePath, [
    "rev-parse",
    "HEAD",
  ]).catch(() => session.archivedRef);

  const now = Date.now();
  const sessions = state.sessions.map((item) =>
    item.id === session.id
      ? {
          ...item,
          archived: true,
          archivedAt: now,
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
  const worktreeExists = await stat(worktreePath)
    .then(() => true)
    .catch(() => false);

  if (!worktreeExists) {
    await mkdir(path.dirname(worktreePath), { recursive: true });
    await execGitCheckout(session.repoPath, [
      "worktree",
      "add",
      "--quiet",
      "-b",
      session.branch,
      worktreePath,
      ref,
    ]).catch(async () => {
      await execGitCheckout(session.repoPath, [
        "worktree",
        "add",
        "--quiet",
        worktreePath,
        ref,
      ]);
    });
  }

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

  const title = linearIssueTitle(session);
  const existing = await findLinearIssue(session, title);
  if (!existing && !title) {
    throw new Error(
      "Not enough context to create a Linear issue. Rename the session or add notes describing the work.",
    );
  }

  const issue = existing ?? (await createLinearIssue(session, title as string));
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
        .match(/https:\/\/(?:app\.)?graphite\.(?:com|dev)\/[^\s"'<>)]*/g)
        ?.map((url) => url.replace(/[.,;:]+$/, "")) ?? [],
    ),
  ];
}

// Launched from Finder the app inherits no shell environment, and keys are
// usually exported from .zshrc, which only an interactive shell reads.
function linearApiKey() {
  if (cachedLinearApiKey !== undefined) {
    return cachedLinearApiKey;
  }

  cachedLinearApiKey =
    process.env.LINEAR_API_KEY?.trim() || probeShellEnv("LINEAR_API_KEY");
  return cachedLinearApiKey;
}

// Reads a variable the way the user's shell would. A login shell covers
// .zprofile and .zshenv; sourcing the rc file covers keys exported from
// .zshrc, which a login shell never reads.
function probeShellEnv(name: string) {
  const shell = process.env.SHELL || "/bin/zsh";
  const print = `printf "<val>%s</val>" "$${name}"`;
  const rcFiles = path.basename(shell).includes("bash")
    ? ["$HOME/.bashrc", "$HOME/.bash_profile"]
    : ["$HOME/.zshrc"];
  const sourceRc = rcFiles
    .map((file) => `[ -f "${file}" ] && . "${file}"`)
    .join("; ");

  const attempts = [
    ["-lc", print],
    // An interactive rc can hijack the shell when there is no tty, so source
    // it non-interactively and let its interactive-only parts opt out.
    ["-c", `{ ${sourceRc}; } >/dev/null 2>&1; ${print}`],
  ];

  for (const args of attempts) {
    try {
      const output = execFileSync(shell, args, {
        timeout: 15_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).toString();
      const value = output.match(/<val>([\s\S]*?)<\/val>/)?.[1].trim();
      if (value) {
        return value;
      }
    } catch {
      continue;
    }
  }

  return "";
}

async function linearRequest<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const apiKey = linearApiKey();
  if (!apiKey) {
    throw new Error(
      "LINEAR_API_KEY is not set. Export it from your shell profile, then restart Laser.",
    );
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

// A session still called "Session 12" with no notes says nothing about the
// work, so there is nothing worth putting in an issue.
function linearIssueTitle(session: SessionRecord): string | null {
  const name = session.name.trim();
  if (name.length >= 3 && !/^session\s*\d*$/i.test(name)) {
    return name;
  }

  const noteLine = (session.notes ?? "")
    .split("\n")
    .map((line) => line.replace(/^[#\-*\s]+/, "").trim())
    .find((line) => line.length >= 3);

  return noteLine ? noteLine.slice(0, 120) : null;
}

async function findLinearIssue(
  session: SessionRecord,
  title: string | null,
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

  // Without a real title a search would match some unrelated issue.
  if (!title) {
    return null;
  }

  const query = title;
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

async function createLinearIssue(
  session: SessionRecord,
  title: string,
): Promise<LinearIssue> {
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
        title,
        description: [
          session.notes?.trim() ? `${session.notes.trim()}\n` : "",
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
  sendRendererEvent("agent:event", event);
}

function sendTerminalEvent(event: TerminalEvent) {
  sendRendererEvent("terminal:event", event);
}

function sendRendererEvent(channel: string, event: unknown) {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    mainWindow.webContents.isDestroyed()
  ) {
    return;
  }

  mainWindow.webContents.send(channel, event);
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

// Reconstructs the command line from raw pty input. Terminals interleave
// escape sequences with typing (focus changes, cursor keys, paste markers,
// replies to the shell), so those have to be consumed rather than recorded.
function recordTerminalInput(terminalId: string, data: string) {
  if (!terminalId.startsWith("shell:")) {
    return;
  }

  const state = terminalInputStates.get(terminalId) ?? newTerminalInputState();

  for (const char of data) {
    if (state.escape === "start") {
      state.sequence = "";
      state.escape =
        char === "[" ? "csi" : char === "]" ? "osc" : char === "O" ? "ss3" : "";
      continue;
    }

    if (state.escape === "ss3") {
      // ESC O <final> - cursor keys in application mode.
      state.escape = "";
      continue;
    }

    if (state.escape === "csi") {
      // Parameters run until a final byte in the @-~ range.
      if (char >= "@" && char <= "~") {
        if (state.sequence === "200") {
          state.pasting = true;
        } else if (state.sequence === "201") {
          state.pasting = false;
        }
        state.escape = "";
        state.sequence = "";
      } else {
        state.sequence += char;
      }
      continue;
    }

    if (state.escape === "osc") {
      // Ends at BEL, or at ESC which starts the ST pair.
      if (char === "\u0007") {
        state.escape = "";
      } else if (char === "\u001b") {
        state.escape = "start";
      }
      continue;
    }

    if (char === "\u001b") {
      state.escape = "start";
      continue;
    }

    if (state.pasting) {
      // Newlines inside a paste are content, not a submitted command.
      state.input += char === "\r" || char === "\n" ? " " : char;
      continue;
    }

    if (char === "\r") {
      const command = state.input.trim();
      state.input = "";
      if (command) {
        void appendTerminalCommand(terminalId, command.slice(0, 4000));
      }
    } else if (char === "\u007f" || char === "\b") {
      state.input = state.input.slice(0, -1);
    } else if (char === "\u0003" || char === "\u0015") {
      state.input = "";
    } else if (char === "\u0017") {
      state.input = state.input.replace(/\S+\s*$/, "");
    } else if (char === "\n") {
      continue;
    } else if (char >= " " || char === "\t") {
      state.input += char;
    }
  }

  terminalInputStates.set(terminalId, state);
}

function newTerminalInputState(): TerminalInputState {
  return { input: "", escape: "", sequence: "", pasting: false };
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function terminalEnv(
  terminalId?: string,
  size?: { cols: number; rows: number },
): NodeJS.ProcessEnv {
  const pairedTerminalId = terminalId
    ? pairedShellTerminalId(terminalId)
    : undefined;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: editorPath(),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    COLUMNS: size ? String(size.cols) : process.env.COLUMNS,
    LINES: size ? String(size.rows) : process.env.LINES,
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

function editorPath() {
  return [
    editorBinDir(),
    shellLoginPath(),
    process.env.PATH,
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    path.join(homedir(), ".local", "bin"),
    path.join(homedir(), ".sail", "bin"),
    path.join(homedir(), "go", "bin"),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]
    .filter(Boolean)
    .join(":");
}

function shellLoginPath() {
  if (cachedShellPath !== undefined) {
    return cachedShellPath;
  }

  try {
    cachedShellPath = execFileSync(process.env.SHELL || "/bin/zsh", [
      "-lc",
      'printf %s "$PATH"',
    ]).toString();
  } catch {
    cachedShellPath = "";
  }

  return cachedShellPath;
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

function startTerminal(
  terminalId: string,
  cwd: string,
  command?: string,
  cols = 100,
  rows = 30,
) {
  if (terminalProcesses.has(terminalId)) {
    return true;
  }

  const size = normalizedTerminalSize(cols, rows);
  const shell = process.env.SHELL || "/bin/zsh";
  const shellCommand = command
    ? `stty cols ${size.cols} rows ${size.rows} 2>/dev/null || true; ${command}`
    : undefined;
  const terminal = pty.spawn(
    shell,
    shellCommand ? ["-lc", shellCommand] : ["-l"],
    {
      name: "xterm-256color",
      cols: size.cols,
      rows: size.rows,
      cwd,
      env: terminalEnv(terminalId, size),
    },
  );

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

function normalizedTerminalSize(cols: number, rows: number) {
  return {
    cols: Math.max(20, Math.floor(Number.isFinite(cols) ? cols : 100)),
    rows: Math.max(5, Math.floor(Number.isFinite(rows) ? rows : 30)),
  };
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
  ipcMain.handle("repo:forget", async (_event, repoPath: string) => {
    const state = await readState();
    const recentRepoPaths = (state.recentRepoPaths ?? []).filter(
      (path) => path !== repoPath,
    );
    await writeState({
      ...state,
      recentRepoPaths,
      lastRepoPath:
        state.lastRepoPath === repoPath ? undefined : state.lastRepoPath,
    });
    return recentRepoPaths;
  });
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
  ipcMain.handle("session:retry-sailbox", async (_event, sessionId: string) => {
    const state = await readState();
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session?.sailbox) {
      throw new Error("session not found");
    }

    const updated = await updateSessionSailbox(sessionId, {
      ...session.sailbox,
      status: "provisioning",
      error: undefined,
    });
    void provisionSailbox(sessionId);
    return updated;
  });
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
    async (
      _event,
      terminalId: string,
      cwd: string,
      command?: string,
      cols?: number,
      rows?: number,
    ) => startTerminal(terminalId, cwd, command, cols, rows),
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
  ipcMain.handle("clipboard:save-image", async (_event, sessionId: string) =>
    saveClipboardImage(sessionId),
  );
  ipcMain.handle(
    "session:resolve-file",
    async (_event, sessionId: string, filePath: string) =>
      resolveSessionFile(sessionId, filePath),
  );
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
  void resumePendingSailboxes();

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
