# filesystem-exec-mcp-server

A Model Context Protocol (MCP) server, written in TypeScript with the official
`@modelcontextprotocol/sdk`, that exposes:

- A full set of **filesystem tools** (read, write, edit, search, move, tree, etc.),
  jailed to one or more directories you specify.
- **Command execution tools** — `run_bash`, `run_shell`, `run_cmd`,
  `run_powershell`, and a generic `run_command` — that run arbitrary commands
  on the host machine.

## Install

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

## Configure in an MCP client (e.g. Claude Desktop / Claude Code)

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

Remove `--allow-exec` if you only want the filesystem tools.

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