# Overstory

[![CI](https://img.shields.io/github/actions/workflow/status/jayminwest/overstory/ci.yml?branch=main)](https://github.com/jayminwest/overstory/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/Bun-%E2%89%A51.0-orange)](https://bun.sh)
[![GitHub release](https://img.shields.io/github/v/release/jayminwest/overstory)](https://github.com/jayminwest/overstory/releases)

Project-agnostic swarm system for Claude Code agent orchestration. Overstory turns a single Claude Code session into a multi-agent team by spawning worker agents in git worktrees via tmux, coordinating them through a custom SQLite mail system, and merging their work back with tiered conflict resolution.

> **⚠️ Warning: Agent swarms are not a universal solution.** Do not deploy Overstory without understanding the risks of multi-agent orchestration — compounding error rates, cost amplification, debugging complexity, and merge conflicts are the normal case, not edge cases. Read [STEELMAN.md](STEELMAN.md) for a full risk analysis and the [Agentic Engineering Book](https://github.com/jayminwest/agentic-engineering-book) ([web version](https://jayminwest.com/agentic-engineering-book)) before using this tool in production.

## How It Works

CLAUDE.md + hooks + the `ov` CLI turn your Claude Code session into a multi-agent orchestrator. A persistent coordinator agent manages task decomposition and dispatch, while a mechanical watchdog daemon monitors agent health in the background.

```
Coordinator (persistent orchestrator at project root)
  --> Supervisor (per-project team lead, depth 1)
        --> Workers: Scout, Builder, Reviewer, Merger (depth 2)
```

### Agent Types

| Agent | Role | Access |
|-------|------|--------|
| **Coordinator** | Persistent orchestrator — decomposes objectives, dispatches agents, tracks task groups | Read-only |
| **Supervisor** | Per-project team lead — manages worker lifecycle, handles nudge/escalation | Read-only |
| **Scout** | Read-only exploration and research | Read-only |
| **Builder** | Implementation and code changes | Read-write |
| **Reviewer** | Validation and code review | Read-only |
| **Lead** | Team coordination, can spawn sub-workers | Read-write |
| **Merger** | Branch merge specialist | Read-write |
| **Monitor** | Tier 2 continuous fleet patrol — ongoing health monitoring | Read-only |

### Key Architecture

- **Agent Definitions**: Two-layer system — base `.md` files define the HOW (workflow), per-task overlays define the WHAT (task scope). Base definition content is injected into spawned agent overlays automatically.
- **Messaging**: Custom SQLite mail system with typed protocol — 8 message types (`worker_done`, `merge_ready`, `dispatch`, `escalation`, etc.) for structured agent coordination, plus broadcast messaging with group addresses (`@all`, `@builders`, etc.)
- **Worktrees**: Each agent gets an isolated git worktree — no file conflicts between agents
- **Merge**: FIFO merge queue (SQLite-backed) with 4-tier conflict resolution
- **Watchdog**: Tiered health monitoring — Tier 0 mechanical daemon (tmux/pid liveness), Tier 1 AI-assisted failure triage, Tier 2 monitor agent for continuous fleet patrol
- **Tool Enforcement**: PreToolUse hooks mechanically block file modifications for non-implementation agents and dangerous git operations for all agents
- **Task Groups**: Batch coordination with auto-close when all member issues complete
- **Session Lifecycle**: Checkpoint save/restore for compaction survivability, handoff orchestration for crash recovery
- **Token Instrumentation**: Session metrics extracted from Claude Code transcript JSONL files

## Requirements

- [Bun](https://bun.sh) (v1.0+)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- git
- tmux

## Installation

```bash
# Clone the repository
git clone https://github.com/jayminwest/overstory.git
cd overstory

# Install dev dependencies
bun install

# Link the CLI globally
bun link
```

## Quick Start

```bash
# Initialize overstory in your project
cd your-project
ov init

# Install hooks into .claude/settings.local.json
ov hooks install

# Start a coordinator (persistent orchestrator)
ov coordinator start

# Or spawn individual worker agents
ov sling <task-id> --capability builder --name my-builder

# Check agent status
ov status

# Live dashboard for monitoring the fleet
ov dashboard

# Nudge a stalled agent
ov nudge <agent-name>

# Check mail from agents
ov mail check --inject
```

## CLI Reference

```
ov agents discover               Discover agents by capability/state/parent
  --capability <type>                    Filter by capability type
  --state <state>                        Filter by agent state
  --parent <name>                        Filter by parent agent
  --json                                 JSON output

ov init                          Initialize .overstory/ in current project
                                        (deploys agent definitions automatically)

ov coordinator start             Start persistent coordinator agent
  --attach / --no-attach                 TTY-aware tmux attach (default: auto)
  --watchdog                             Auto-start watchdog daemon with coordinator
  --monitor                              Auto-start Tier 2 monitor agent
ov coordinator stop              Stop coordinator
ov coordinator status            Show coordinator state

ov supervisor start              Start per-project supervisor agent
  --attach / --no-attach                 TTY-aware tmux attach (default: auto)
ov supervisor stop               Stop supervisor
ov supervisor status             Show supervisor state

ov sling <task-id>              Spawn a worker agent
  --capability <type>                    builder | scout | reviewer | lead | merger
                                         | coordinator | supervisor | monitor
  --name <name>                          Unique agent name
  --spec <path>                          Path to task spec file
  --files <f1,f2,...>                    Exclusive file scope
  --parent <agent-name>                  Parent (for hierarchy tracking)
  --depth <n>                            Current hierarchy depth
  --skip-scout                           Skip scout phase (passed to lead overlay)
  --skip-task-check                      Skip task existence validation
  --json                                 JSON output

ov stop <agent-name>            Terminate a running agent
  --clean-worktree                       Remove the agent's worktree (best-effort)
  --json                                 JSON output

ov prime                         Load context for orchestrator/agent
  --agent <name>                         Per-agent priming
  --compact                              Restore from checkpoint (compaction)

ov status                        Show all active agents, worktrees, tracker state
  --json                                 JSON output
  --verbose                              Show detailed agent info
  --all                                  Show all runs (default: current run only)

ov dashboard                     Live TUI dashboard for agent monitoring
  --interval <ms>                        Refresh interval (default: 2000)
  --all                                  Show all runs (default: current run only)

ov hooks install                 Install orchestrator hooks to .claude/settings.local.json
  --force                                Overwrite existing hooks
ov hooks uninstall               Remove orchestrator hooks
ov hooks status                  Check if hooks are installed

ov mail send                     Send a message
  --to <agent>  --subject <text>  --body <text>
  --to @all | @builders | @scouts ...    Broadcast to group addresses
  --type <status|question|result|error>
  --priority <low|normal|high|urgent>    (urgent/high auto-nudges recipient)

ov mail check                    Check inbox (unread messages)
  --agent <name>  --inject  --json
  --debounce <ms>                        Skip if checked within window

ov mail list                     List messages with filters
  --from <name>  --to <name>  --unread

ov mail read <id>                Mark message as read
ov mail reply <id> --body <text> Reply in same thread

ov nudge <agent> [message]       Send a text nudge to an agent
  --from <name>                          Sender name (default: orchestrator)
  --force                                Skip debounce check
  --json                                 JSON output

ov group create <name>           Create a task group for batch tracking
ov group status <name>           Show group progress
ov group add <name> <issue-id>   Add issue to group
ov group list                    List all groups

ov merge                         Merge agent branches into canonical
  --branch <name>                        Specific branch
  --all                                  All completed branches
  --into <branch>                        Target branch (default: session-branch.txt > canonicalBranch)
  --dry-run                              Check for conflicts only

ov worktree list                 List worktrees with status
ov worktree clean                Remove completed worktrees
  --completed                            Only finished agents
  --all                                  Force remove all
  --force                                Delete even if branches are unmerged

ov monitor start                 Start Tier 2 monitor agent
ov monitor stop                  Stop monitor agent
ov monitor status                Show monitor state

ov log <event>                   Log a hook event
ov watch                         Start watchdog daemon (Tier 0)
  --interval <ms>                        Health check interval
  --background                           Run as background process
ov run list                      List orchestration runs
ov run show <id>                 Show run details
ov run complete <id>             Mark a run complete

ov trace                         View agent/bead timeline
  --agent <name>                         Filter by agent
  --run <id>                             Filter by run

ov clean                         Clean up worktrees, sessions, artifacts
  --completed                            Only finished agents
  --all                                  Force remove all
  --run <id>                             Clean a specific run

ov doctor                        Run health checks on overstory setup
  --json                                 JSON output
  --category <name>                      Run a specific check category only

ov inspect <agent>               Deep per-agent inspection
  --json                                 JSON output
  --follow                               Polling mode (refreshes periodically)
  --interval <ms>                        Refresh interval for --follow
  --no-tmux                              Skip tmux capture
  --limit <n>                            Limit events shown

ov spec write <task-id>          Write a task specification
  --body <content>                       Spec content (or pipe via stdin)

ov errors                        Aggregated error view across agents
  --agent <name>                         Filter by agent
  --run <id>                             Filter by run
  --since <ts>  --until <ts>             Time range filter
  --limit <n>  --json

ov replay                        Interleaved chronological replay
  --run <id>                             Filter by run
  --agent <name>                         Filter by agent(s)
  --since <ts>  --until <ts>             Time range filter
  --limit <n>  --json

ov feed [options]                Unified real-time event stream across agents
  --follow, -f                           Continuously poll for new events
  --interval <ms>                        Polling interval (default: 2000)
  --agent <name>  --run <id>             Filter by agent or run
  --json                                 JSON output

ov logs [options]                Query NDJSON logs across agents
  --agent <name>                         Filter by agent
  --level <level>                        Filter by log level (debug|info|warn|error)
  --since <ts>  --until <ts>             Time range filter
  --follow                               Tail logs in real time
  --json                                 JSON output

ov costs                         Token/cost analysis and breakdown
  --live                                 Show real-time token usage for active agents
  --self                                 Show cost for current orchestrator session
  --agent <name>                         Filter by agent
  --run <id>                             Filter by run
  --by-capability                        Group by capability type
  --last <n>  --json

ov metrics                       Show session metrics
  --last <n>                             Last N sessions
  --json                                 JSON output

Global Flags:
  --quiet, -q                            Suppress non-error output
  --completions <shell>                  Generate shell completions (bash, zsh, fish)
```

## Tech Stack

- **Runtime**: Bun (TypeScript directly, no build step)
- **Dependencies**: Minimal runtime — `chalk` (color output), `commander` (CLI framework), core I/O via Bun built-in APIs
- **Database**: SQLite via `bun:sqlite` (WAL mode for concurrent access)
- **Linting**: Biome (formatter + linter)
- **Testing**: `bun test` (2145 tests across 76 files, colocated with source)
- **External CLIs**: `bd` (beads) or `sd` (seeds), `mulch`, `git`, `tmux` — invoked as subprocesses

## Development

```bash
# Run tests (2145 tests across 76 files)
bun test

# Run a single test
bun test src/config.test.ts

# Lint + format check
biome check .

# Type check
tsc --noEmit

# All quality gates
bun test && biome check . && tsc --noEmit
```

### Versioning

Version is maintained in two places that must stay in sync:

1. `package.json` — `"version"` field
2. `src/index.ts` — `VERSION` constant

Use the bump script to update both:

```bash
bun run version:bump <major|minor|patch>
```

Git tags, npm publishing, and GitHub releases are handled automatically by the `publish.yml` workflow when a version bump is pushed to `main`.

## Project Structure

```
overstory/
  src/
    index.ts                      CLI entry point (Commander.js program)
    types.ts                      Shared types and interfaces
    config.ts                     Config loader + validation
    errors.ts                     Custom error types
    commands/                     One file per CLI subcommand (30 commands)
      agents.ts                   Agent discovery and querying
      coordinator.ts              Persistent orchestrator lifecycle
      supervisor.ts               Team lead management
      dashboard.ts                Live TUI dashboard (ANSI via Chalk)
      hooks.ts                    Orchestrator hooks management
      sling.ts                    Agent spawning
      group.ts                    Task group batch tracking
      nudge.ts                    Agent nudging
      mail.ts                     Inter-agent messaging
      monitor.ts                  Tier 2 monitor management
      merge.ts                    Branch merging
      status.ts                   Fleet status overview
      prime.ts                    Context priming
      init.ts                     Project initialization
      worktree.ts                 Worktree management
      watch.ts                    Watchdog daemon
      log.ts                      Hook event logging
      logs.ts                     NDJSON log query
      feed.ts                     Unified real-time event stream
      run.ts                      Orchestration run lifecycle
      trace.ts                    Agent/bead timeline viewing
      clean.ts                    Worktree/session cleanup
      doctor.ts                   Health check runner (9 check modules)
      inspect.ts                  Deep per-agent inspection
      spec.ts                     Task spec management
      errors.ts                   Aggregated error view
      replay.ts                   Interleaved event replay
      stop.ts                     Agent termination
      costs.ts                    Token/cost analysis
      metrics.ts                  Session metrics
      completions.ts              Shell completion generation (bash/zsh/fish)
    agents/                       Agent lifecycle management
      manifest.ts                 Agent registry (load + query)
      overlay.ts                  Dynamic CLAUDE.md overlay generator
      identity.ts                 Persistent agent identity (CVs)
      checkpoint.ts               Session checkpoint save/restore
      lifecycle.ts                Handoff orchestration
      hooks-deployer.ts           Deploy hooks + tool enforcement
    worktree/                     Git worktree + tmux management
    mail/                         SQLite mail system (typed protocol, broadcast)
    merge/                        FIFO queue + conflict resolution
    watchdog/                     Tiered health monitoring (daemon, triage, health)
    logging/                      Multi-format logger + sanitizer + reporter + color control
    metrics/                      SQLite metrics + transcript parsing
    doctor/                       Health check modules (9 checks)
    insights/                     Session insight analyzer for auto-expertise
    tracker/                      Pluggable task tracker (beads + seeds backends)
    mulch/                        mulch CLI wrapper
    e2e/                          End-to-end lifecycle tests
  agents/                         Base agent definitions (.md, 8 roles)
  templates/                      Templates for overlays and hooks
```

## License

MIT

---

Inspired by: https://github.com/steveyegge/gastown/
