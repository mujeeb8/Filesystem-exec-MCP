#!/usr/bin/env node
/**
 * Filesystem + Command Execution MCP Server
 * ------------------------------------------
 * Implements the Model Context Protocol (via the official TypeScript SDK)
 * and exposes:
 *   - A full set of filesystem tools (read/write/edit/search/move/tree/etc.)
 *   - Command execution tools (bash, POSIX shell, cmd.exe, PowerShell, and a
 *     generic "run_command" tool)
 *
 * SECURITY WARNING
 * ----------------
 * The command-execution tools let a connected MCP client run ARBITRARY
 * commands on this machine with the privileges of the user running this
 * process. There is no sandboxing. Only run this server with clients you
 * trust, and only point it at directories you're comfortable exposing.
 * Execution tools are gated behind ALLOW_EXEC (see below) and are disabled
 * by default.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Every positional CLI arg is treated as an allowed root directory that the
// filesystem tools (and, for cwd purposes, the exec tools) may operate in.
// Example: node dist/index.js /home/user/project /home/user/data
const rawArgs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const allowedDirectories = (rawArgs.length > 0 ? rawArgs : [process.cwd()]).map(
  (d) => path.resolve(expandHome(d))
);

// Command execution is opt-in. Enable with either:
//   --allow-exec on the command line, or
//   ALLOW_EXEC=true in the environment
const allowExec =
  process.argv.includes("--allow-exec") ||
  process.env.ALLOW_EXEC?.toLowerCase() === "true";

// Max buffer / default timeout for exec'd commands
const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB

function expandHome(p: string): string {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

// ---------------------------------------------------------------------------
// Path safety helpers (filesystem tools are jailed to allowedDirectories)
// ---------------------------------------------------------------------------

class PathAccessError extends Error {}

/** Resolve a user-supplied path and ensure it falls under an allowed root. */
async function resolveAllowedPath(userPath: string): Promise<string> {
  const expanded = expandHome(userPath);
  const absolute = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(allowedDirectories[0], expanded);

  const normalized = path.normalize(absolute);

  const isAllowed = allowedDirectories.some((dir) => {
    const rel = path.relative(dir, normalized);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });

  if (!isAllowed) {
    throw new PathAccessError(
      `Access denied: "${userPath}" resolves outside allowed directories: ${allowedDirectories.join(", ")}`
    );
  }

  // If the path exists, resolve symlinks and re-check (defends against
  // symlinks that point outside the allowed roots).
  try {
    const real = await fs.realpath(normalized);
    const realOk = allowedDirectories.some((dir) => {
      const rel = path.relative(dir, real);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    });
    if (!realOk) {
      throw new PathAccessError(
        `Access denied: "${userPath}" resolves (via symlink) outside allowed directories.`
      );
    }
    return real;
  } catch {
    // Path doesn't exist yet (e.g. a file about to be created) — that's fine,
    // the normalized/allowed check above already passed.
    return normalized;
  }
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "filesystem-exec-mcp-server",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Filesystem tools
// ---------------------------------------------------------------------------

server.registerTool(
  "read_text_file",
  {
    title: "Read text file",
    description:
      "Read the complete contents of a text file. Optionally read only the first N lines (head) or last N lines (tail).",
    inputSchema: {
      path: z.string().describe("Path to the file to read"),
      head: z.number().int().positive().optional().describe("Return only the first N lines"),
      tail: z.number().int().positive().optional().describe("Return only the last N lines"),
    },
  },
  async ({ path: p, head, tail }) => {
    const resolved = await resolveAllowedPath(p);
    const content = await fs.readFile(resolved, "utf-8");
    if (head) {
      const lines = content.split("\n").slice(0, head).join("\n");
      return { content: [{ type: "text", text: lines }] };
    }
    if (tail) {
      const allLines = content.split("\n");
      const lines = allLines.slice(Math.max(0, allLines.length - tail)).join("\n");
      return { content: [{ type: "text", text: lines }] };
    }
    return { content: [{ type: "text", text: content }] };
  }
);

server.registerTool(
  "read_media_file",
  {
    title: "Read media/binary file",
    description: "Read a file and return it as base64-encoded content with its detected MIME type.",
    inputSchema: {
      path: z.string().describe("Path to the media/binary file to read"),
    },
  },
  async ({ path: p }) => {
    const resolved = await resolveAllowedPath(p);
    const buf = await fs.readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    const mimeMap: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".pdf": "application/pdf",
      ".svg": "image/svg+xml",
    };
    const mimeType = mimeMap[ext] ?? "application/octet-stream";
    const isImage = mimeType.startsWith("image/");
    return {
      content: [
        isImage
          ? { type: "image", data: buf.toString("base64"), mimeType }
          : {
              type: "text",
              text: `[binary file, base64, mimeType=${mimeType}]\n${buf.toString("base64")}`,
            },
      ],
    };
  }
);

server.registerTool(
  "read_multiple_files",
  {
    title: "Read multiple files",
    description: "Read the contents of multiple text files in a single call.",
    inputSchema: {
      paths: z.array(z.string()).describe("Paths of files to read"),
    },
  },
  async ({ paths }) => {
    const results = await Promise.all(
      paths.map(async (p) => {
        try {
          const resolved = await resolveAllowedPath(p);
          const content = await fs.readFile(resolved, "utf-8");
          return `--- ${p} ---\n${content}`;
        } catch (err: any) {
          return `--- ${p} ---\nERROR: ${err.message}`;
        }
      })
    );
    return { content: [{ type: "text", text: results.join("\n\n") }] };
  }
);

server.registerTool(
  "write_file",
  {
    title: "Write file",
    description: "Create a new file or completely overwrite an existing file with new content.",
    inputSchema: {
      path: z.string().describe("Path to the file to write"),
      content: z.string().describe("Content to write to the file"),
    },
  },
  async ({ path: p, content }) => {
    const expanded = expandHome(p);
    const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(allowedDirectories[0], expanded);
    // Validate the parent directory is allowed (file itself may not exist yet).
    await resolveAllowedPath(path.dirname(absolute));
    await fs.writeFile(absolute, content, "utf-8");
    return { content: [{ type: "text", text: `Wrote ${Buffer.byteLength(content)} bytes to ${absolute}` }] };
  }
);

server.registerTool(
  "edit_file",
  {
    title: "Edit file",
    description:
      "Make line-based edits to a text file. Each edit replaces an exact block of oldText with newText. Set dryRun to preview a unified diff without writing.",
    inputSchema: {
      path: z.string().describe("Path to the file to edit"),
      edits: z
        .array(
          z.object({
            oldText: z.string().describe("Exact text to find and replace"),
            newText: z.string().describe("Text to replace it with"),
          })
        )
        .describe("List of edits to apply in order"),
      dryRun: z.boolean().optional().describe("Preview changes without writing to disk"),
    },
  },
  async ({ path: p, edits, dryRun }) => {
    const resolved = await resolveAllowedPath(p);
    let content = await fs.readFile(resolved, "utf-8");
    for (const edit of edits) {
      if (!content.includes(edit.oldText)) {
        throw new Error(`oldText not found in ${p}: ${edit.oldText.slice(0, 80)}...`);
      }
      content = content.replace(edit.oldText, edit.newText);
    }
    if (!dryRun) {
      await fs.writeFile(resolved, content, "utf-8");
    }
    return {
      content: [
        {
          type: "text",
          text: dryRun ? `Dry run OK. Preview:\n${content}` : `Applied ${edits.length} edit(s) to ${p}`,
        },
      ],
    };
  }
);

server.registerTool(
  "create_directory",
  {
    title: "Create directory",
    description: "Create a new directory (and parents as needed), or succeed silently if it already exists.",
    inputSchema: { path: z.string() },
  },
  async ({ path: p }) => {
    const expanded = expandHome(p);
    const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(allowedDirectories[0], expanded);
    await resolveAllowedPath(path.dirname(absolute)).catch(() => {
      throw new PathAccessError(`Access denied: "${p}" is outside allowed directories.`);
    });
    await fs.mkdir(absolute, { recursive: true });
    return { content: [{ type: "text", text: `Created directory ${absolute}` }] };
  }
);

server.registerTool(
  "list_directory",
  {
    title: "List directory",
    description: "List files and directories directly inside a given path.",
    inputSchema: { path: z.string() },
  },
  async ({ path: p }) => {
    const resolved = await resolveAllowedPath(p);
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const lines = entries.map((e) => `${e.isDirectory() ? "[DIR] " : "[FILE]"} ${e.name}`);
    return { content: [{ type: "text", text: lines.join("\n") || "(empty)" }] };
  }
);

server.registerTool(
  "list_directory_with_sizes",
  {
    title: "List directory with sizes",
    description: "List directory contents including file sizes, optionally sorted by name or size.",
    inputSchema: {
      path: z.string(),
      sortBy: z.enum(["name", "size"]).optional(),
    },
  },
  async ({ path: p, sortBy }) => {
    const resolved = await resolveAllowedPath(p);
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const rows = await Promise.all(
      entries.map(async (e) => {
        const full = path.join(resolved, e.name);
        const stat = await fs.stat(full).catch(() => null);
        return { name: e.name, isDir: e.isDirectory(), size: stat?.size ?? 0 };
      })
    );
    rows.sort((a, b) => (sortBy === "size" ? b.size - a.size : a.name.localeCompare(b.name)));
    const lines = rows.map(
      (r) => `${r.isDir ? "[DIR] " : "[FILE]"} ${r.name.padEnd(40)} ${r.isDir ? "" : r.size + " bytes"}`
    );
    return { content: [{ type: "text", text: lines.join("\n") || "(empty)" }] };
  }
);

server.registerTool(
  "directory_tree",
  {
    title: "Directory tree",
    description: "Get a recursive JSON tree view of files and directories under a path.",
    inputSchema: {
      path: z.string(),
      maxDepth: z.number().int().positive().max(20).optional(),
    },
  },
  async ({ path: p, maxDepth }) => {
    const resolved = await resolveAllowedPath(p);
    const depthLimit = maxDepth ?? 8;

    interface Node {
      name: string;
      type: "file" | "directory";
      children?: Node[];
    }

    async function walk(dir: string, depth: number): Promise<Node[]> {
      if (depth > depthLimit) return [];
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const nodes: Node[] = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          nodes.push({ name: entry.name, type: "directory", children: await walk(full, depth + 1) });
        } else {
          nodes.push({ name: entry.name, type: "file" });
        }
      }
      return nodes;
    }

    const tree = await walk(resolved, 0);
    return { content: [{ type: "text", text: JSON.stringify(tree, null, 2) }] };
  }
);

server.registerTool(
  "move_file",
  {
    title: "Move or rename file/directory",
    description: "Move or rename a file or directory.",
    inputSchema: { source: z.string(), destination: z.string() },
  },
  async ({ source, destination }) => {
    const src = await resolveAllowedPath(source);
    const expandedDest = expandHome(destination);
    const absDest = path.isAbsolute(expandedDest)
      ? expandedDest
      : path.resolve(allowedDirectories[0], expandedDest);
    await resolveAllowedPath(path.dirname(absDest));
    await fs.rename(src, absDest);
    return { content: [{ type: "text", text: `Moved ${source} -> ${destination}` }] };
  }
);

server.registerTool(
  "search_files",
  {
    title: "Search files",
    description: "Recursively search for files/directories whose name matches a pattern (case-insensitive substring).",
    inputSchema: {
      path: z.string(),
      pattern: z.string(),
      excludePatterns: z.array(z.string()).optional(),
    },
  },
  async ({ path: p, pattern, excludePatterns }) => {
    const resolved = await resolveAllowedPath(p);
    const excludes = excludePatterns ?? [];
    const matches: string[] = [];

    async function walk(dir: string) {
      let entries: fsSync.Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (excludes.some((ex) => entry.name.includes(ex))) continue;
        if (entry.name.toLowerCase().includes(pattern.toLowerCase())) {
          matches.push(full);
        }
        if (entry.isDirectory()) {
          await walk(full);
        }
      }
    }

    await walk(resolved);
    return { content: [{ type: "text", text: matches.join("\n") || "No matches found." }] };
  }
);

server.registerTool(
  "get_file_info",
  {
    title: "Get file info",
    description: "Get metadata (size, timestamps, type, permissions) about a file or directory.",
    inputSchema: { path: z.string() },
  },
  async ({ path: p }) => {
    const resolved = await resolveAllowedPath(p);
    const stat = await fs.stat(resolved);
    const info = {
      path: resolved,
      type: stat.isDirectory() ? "directory" : "file",
      size: stat.size,
      created: stat.birthtime,
      modified: stat.mtime,
      accessed: stat.atime,
      permissions: (stat.mode & 0o777).toString(8),
    };
    return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
  }
);

server.registerTool(
  "list_allowed_directories",
  {
    title: "List allowed directories",
    description: "Return the list of root directories this server is allowed to access for filesystem tools.",
    inputSchema: {},
  },
  async () => {
    return { content: [{ type: "text", text: allowedDirectories.join("\n") }] };
  }
);

// ---------------------------------------------------------------------------
// Command execution tools (opt-in via --allow-exec / ALLOW_EXEC=true)
// ---------------------------------------------------------------------------

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

async function runCommand(
  command: string,
  shellPath: string | true,
  cwd: string | undefined,
  timeoutMs: number
): Promise<ExecResult> {
  const workDir = cwd ? await resolveAllowedPath(cwd) : allowedDirectories[0];
  try {
    const { stdout, stderr } = await execAsync(command, {
      shell: shellPath as any,
      cwd: workDir,
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER_BYTES,
      windowsHide: true,
    });
    return { stdout, stderr, exitCode: 0, timedOut: false };
  } catch (err: any) {
    const timedOut = err.killed && err.signal === "SIGTERM";
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(err.message ?? err),
      exitCode: typeof err.code === "number" ? err.code : null,
      timedOut,
    };
  }
}

function formatExecResult(r: ExecResult): string {
  const parts = [
    `Exit code: ${r.exitCode ?? "unknown"}${r.timedOut ? " (TIMED OUT)" : ""}`,
    `--- stdout ---\n${r.stdout || "(empty)"}`,
    `--- stderr ---\n${r.stderr || "(empty)"}`,
  ];
  return parts.join("\n");
}

if (allowExec) {
  const timeoutSchema = z
    .number()
    .int()
    .positive()
    .max(600_000)
    .optional()
    .describe("Timeout in milliseconds (default 120000, max 600000)");
  const cwdSchema = z
    .string()
    .optional()
    .describe("Working directory (must be within an allowed directory). Defaults to the first allowed directory.");

  server.registerTool(
    "run_bash",
    {
      title: "Run bash command",
      description:
        "Execute a command using bash (/bin/bash -c). Full arbitrary command execution with the privileges of the server process. Use with caution.",
      inputSchema: { command: z.string(), cwd: cwdSchema, timeout: timeoutSchema },
    },
    async ({ command, cwd, timeout }) => {
      const result = await runCommand(command, "/bin/bash", cwd, timeout ?? DEFAULT_TIMEOUT_MS);
      return { content: [{ type: "text", text: formatExecResult(result) }] };
    }
  );

  server.registerTool(
    "run_shell",
    {
      title: "Run POSIX shell command",
      description:
        "Execute a command using the system default POSIX shell (/bin/sh -c). Full arbitrary command execution. Use with caution.",
      inputSchema: { command: z.string(), cwd: cwdSchema, timeout: timeoutSchema },
    },
    async ({ command, cwd, timeout }) => {
      const result = await runCommand(command, "/bin/sh", cwd, timeout ?? DEFAULT_TIMEOUT_MS);
      return { content: [{ type: "text", text: formatExecResult(result) }] };
    }
  );

  server.registerTool(
    "run_cmd",
    {
      title: "Run Windows cmd.exe command",
      description:
        "Execute a command using Windows cmd.exe (/c). Only works on Windows hosts. Full arbitrary command execution. Use with caution.",
      inputSchema: { command: z.string(), cwd: cwdSchema, timeout: timeoutSchema },
    },
    async ({ command, cwd, timeout }) => {
      if (process.platform !== "win32") {
        return {
          content: [{ type: "text", text: "ERROR: run_cmd is only available on Windows hosts." }],
          isError: true,
        };
      }
      const result = await runCommand(command, "cmd.exe", cwd, timeout ?? DEFAULT_TIMEOUT_MS);
      return { content: [{ type: "text", text: formatExecResult(result) }] };
    }
  );

  server.registerTool(
    "run_powershell",
    {
      title: "Run PowerShell command",
      description:
        "Execute a command using PowerShell (pwsh if available, else powershell.exe). Full arbitrary command execution. Use with caution.",
      inputSchema: { command: z.string(), cwd: cwdSchema, timeout: timeoutSchema },
    },
    async ({ command, cwd, timeout }) => {
      const psExecutable = process.platform === "win32" ? "powershell.exe" : "pwsh";
      const workDir = cwd ? await resolveAllowedPath(cwd) : allowedDirectories[0];
      try {
        const { stdout, stderr } = await execAsync(
          `${psExecutable} -NoProfile -NonInteractive -Command "${command.replace(/"/g, '\\"')}"`,
          {
            cwd: workDir,
            timeout: timeout ?? DEFAULT_TIMEOUT_MS,
            maxBuffer: MAX_BUFFER_BYTES,
            windowsHide: true,
          }
        );
        return { content: [{ type: "text", text: formatExecResult({ stdout, stderr, exitCode: 0, timedOut: false }) }] };
      } catch (err: any) {
        const result: ExecResult = {
          stdout: err.stdout ?? "",
          stderr: err.stderr ?? String(err.message ?? err),
          exitCode: typeof err.code === "number" ? err.code : null,
          timedOut: !!err.killed,
        };
        return { content: [{ type: "text", text: formatExecResult(result) }] };
      }
    }
  );

  server.registerTool(
    "run_command",
    {
      title: "Run command (generic)",
      description:
        "Execute a command using an explicitly chosen shell: 'bash', 'sh', 'cmd', or 'powershell'. Full arbitrary command execution. Use with caution.",
      inputSchema: {
        command: z.string(),
        shell: z.enum(["bash", "sh", "cmd", "powershell"]).default("bash"),
        cwd: cwdSchema,
        timeout: timeoutSchema,
      },
    },
    async ({ command, shell, cwd, timeout }) => {
      const shellMap: Record<string, string> = {
        bash: "/bin/bash",
        sh: "/bin/sh",
        cmd: "cmd.exe",
        powershell: process.platform === "win32" ? "powershell.exe" : "pwsh",
      };
      const result = await runCommand(command, shellMap[shell], cwd, timeout ?? DEFAULT_TIMEOUT_MS);
      return { content: [{ type: "text", text: formatExecResult(result) }] };
    }
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr only — stdout is reserved for the MCP protocol stream.
  console.error(`[filesystem-exec-mcp-server] started`);
  console.error(`[filesystem-exec-mcp-server] allowed directories:\n  ${allowedDirectories.join("\n  ")}`);
  console.error(`[filesystem-exec-mcp-server] command execution tools: ${allowExec ? "ENABLED" : "disabled"}`);
  if (!allowExec) {
    console.error(
      `[filesystem-exec-mcp-server] to enable run_bash/run_shell/run_cmd/run_powershell/run_command, start with --allow-exec or set ALLOW_EXEC=true`
    );
  }
}

main().catch((err) => {
  console.error("Fatal error starting server:", err);
  process.exit(1);
});
