<div align="center">
  <img src="icon.png" alt="Filesystem + Exec icon" width="120" height="120" />

  <h1>Filesystem + Exec</h1>

  <p>
    A Model Context Protocol (MCP) server that gives an AI agent a full set of
    <strong>filesystem tools</strong> and optional <strong>command execution</strong>,
    packaged as a one-click <code>.mcpb</code> extension for Claude Desktop.
  </p>

  <p>
    <img alt="version" src="https://img.shields.io/badge/version-1.0.0-blue" />
    <img alt="license" src="https://img.shields.io/badge/license-MIT-green" />
    <img alt="platforms" src="https://img.shields.io/badge/platforms-darwin%20%7C%20win32%20%7C%20linux-lightgrey" />
    <img alt="node" src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen" />
  </p>
</div>

---

`filesystem-exec-mcp` server is written in TypeScript with the official
`@modelcontextprotocol/sdk` and exposes:

- A full set of **filesystem tools** (read, write, edit, search, move, tree, etc.),
  jailed to one or more directories you specify.
- **Command execution tools** — `run_bash`, `run_shell`, `run_cmd`,
  `run_powershell`, and a generic `run_command` — that run any commands
  on the host machine but you can switch it on and off by setting up `ALLOW-EXEC` env to `true` or `false` or if you are using `.mcpb` file than directly in Claude Desktop by switching a button in settings --> Extensions --> Filesystem + Exec's config.

## The `.mcpb` file

This repo builds and ships **`filesystem-mcpb.mcpb`**, a single-file
[MCP Bundle](https://github.com/modelcontextprotocol/mcpb) that packages the
compiled server, its dependencies, `manifest.json`, and `icon.png` into one
installable archive. It lets Claude Desktop install this whole server with a
double-click — no `npm install`, no manual config file editing.

### How to use it

1. **Get the file** — download `filesystem-mcpb.mcpb` from the or [Releases](https://github.com/mujeeb8/Filesystem-exec-MCP/releases)
   or build it by yourself, see [Building the `.mcpb`](#-building-the-mcpb).
2. **Install it**:
   - In Claude Desktop: **Settings → Extensions → Advanced settings → Install
     Extension…**, then select the `filesystem-mcpb.mcpb` file
3. **Configure it** — Claude Desktop shows a setup screen for the two options:
   - **Allowed Directories** — the only folder(s) the server can touch (defaults
     to `~/Desktop`)
   - **Enable command execution** — off by default; only turn this on if you
     want the agent to be able to run shell commands
4. **Use it** — once installed, the tools listed below become available to
   Claude in any conversation, scoped to whatever directories you approved.
5. **Done**

### Building the `.mcpb`

```bash
npm install -g @anthropic-ai/mcpb   # once, if you don't have the CLI
npm install
npm run build                       # compiles src/index.ts -> dist/index.js
mcpb pack                           # bundles dist/, manifest.json, icon.png -> .mcpb
```

## Install (from source)

```bash
npm install
npm run build
```

This compiles `src/index.ts` to `dist/index.js`.

## Environment Variables

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `ALLOW_EXEC` | Boolean (`true` / `false`) | `false` | Opt-in flag to enable the command execution tools (`run_bash`, `run_shell`, `run_cmd`, `run_powershell`, and `run_command`). By default, these tools are completely disabled. Set `ALLOW_EXEC=true` in your environment to make these tools available to connected clients. |

## Run standalone (for testing)

```bash
node dist/index.js /path/to/allowed/dir1 /path/to/allowed/dir2 --allow-exec
```

- Any number of positional args = allowed root directories for the filesystem
  tools (defaults to the current working directory if none given).
- `--allow-exec` (or `ALLOW_EXEC=true` in the env) turns on the command
  execution tools. Omit it to run in filesystem-only mode.

The server speaks MCP over stdio, so it's meant to be launched by an MCP
client, not used interactively.

## Configure in an MCP client (e.g. Claude Desktop) Manually

Add to your client's MCP server config (e.g.
`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "filesystem-exec": {
      "command": "node",
      "args": [
        "/absolute/path/to/claude-project/dist/index.js",
        "/absolute/path/to/allowed/dir",
        "--allow-exec"
      ]
    }
  }
}
```

Remove `--allow-exec` if you don't want to use command execution tools.

## Tools

### Filesystem

| Tool | Description |
|---|---|
| `read_text_file` | Read a text file, optionally just head/tail N lines |
| `read_media_file` | Read an image/binary file as base64 |
| `read_multiple_files` | Read several files in one call |
| `write_file` | Create or overwrite a file |
| `edit_file` | Apply find/replace edits, with optional dry run |
| `create_directory` | mkdir -p |
| `list_directory` | List entries in a directory |
| `list_directory_with_sizes` | List entries with sizes, sortable |
| `directory_tree` | Recursive JSON tree of a directory |
| `move_file` | Move/rename a file or directory |
| `search_files` | Recursive filename search |
| `get_file_info` | Stat a file/directory |
| `list_allowed_directories` | Show the configured allowed roots |

### Command execution (opt-in)

| Tool | Description |
|---|---|
| `run_bash` | Run a command via `/bin/bash -c` |
| `run_shell` | Run a command via `/bin/sh -c` |
| `run_cmd` | Run a command via Windows `cmd.exe` (Windows hosts only) |
| `run_powershell` | Run a command via PowerShell (`pwsh` or `powershell.exe`) |
| `run_command` | Generic — pick `shell: bash \| sh \| cmd \| powershell` |

All exec tools accept optional `cwd` (must resolve inside an allowed
directory) and `timeout` (ms, default `120000`, max `600000`) parameters, and
return stdout, stderr, and the exit code.

## Development

```bash
npm run dev     # tsc --watch
npm run start   # run the compiled server
```

## Documentation

Full setup instructions and a tool reference are available in
[`docs/documentation.html`](https://mujeeb8.github.io/Filesystem-exec-MCP/documentation.html).

## Privacy Policy

This extension runs entirely on your local machine. It makes no network
requests, collects no telemetry or analytics, and has no server or account of
any kind — there is nothing transmitted anywhere. It only accesses the files
in directories you explicitly approve during setup, and only runs shell
commands if you separately enable that option (off by default).

The full privacy policy is available in
[`docs/privacy-policy.html`](https://mujeeb8.github.io/Filesystem-exec-MCP/privacy-policy.html).
