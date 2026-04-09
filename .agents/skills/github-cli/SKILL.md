---
name: github-cli
description: GitHub CLI (gh) workflows and best practices. Use when working with PRs, issues, workflows, releases, or GitHub API. Triggers on "gh", "github cli", "create pr", "check ci", "merge pr", "copilot coding agent", etc.
---

# GitHub CLI

## When to Use

- Creating, reviewing, or merging PRs
- Working with issues, releases, or workflows
- Querying GitHub API (prefer `gh api` over raw curl)
- CI/CD debugging and monitoring
- Managing Copilot coding agent tasks

## What's New (2026)

### Native `gh copilot` Bridge (v2.86.0)

```bash
# Launches Copilot CLI (prompts to install if missing)
gh copilot

# Forward args directly to Copilot CLI
gh copilot <args>
```

Replaces the old `gh-copilot` extension. Now built into `gh` as a native command.

### Copilot Coding Agent Integration (v2.80.0+)

```bash
# Create a coding agent task
gh agent-task create "refactor authentication module"

# Use a custom agent
gh agent-task create --custom-agent my-agent "refactor auth"

# List active agent tasks
gh agent-task list

# View task details and follow logs
gh agent-task view <task-id> --follow
```

### PR Revert Command (v2.83.0)

```bash
# Revert a merged PR
gh pr revert <number>
```

### Release Attestation Verification (v2.81.0)

```bash
# Verify release attestation
gh release verify v1.2.3

# Verify specific asset
gh release verify-asset v1.2.3 binary.tar.gz
```

### Advanced Search Syntax (v2.79.0)

```bash
# Use GitHub's full search syntax with --search
gh pr list --search 'review:required draft:false'
gh issue list --search 'no:assignee label:"help wanted",bug sort:created-asc'

# Logical operators
gh pr list --search 'label:"bug" label:"urgent"'  # AND
gh pr list --search 'label:"bug","wip"'           # OR
```

### Auth Improvements

```bash
# Auto-copy OAuth code to clipboard
gh auth login --clipboard
gh auth refresh --clipboard

# JSON output for scripting
gh auth status --json
```

### Accessibility Preview (v2.72.0+)

```bash
# Enable accessibility features (screen reader support, color customization)
gh a11y
```

## Copilot CLI (Standalone)

**The old `gh-copilot` extension was deprecated Oct 25, 2025.** Replaced by standalone Copilot CLI + native `gh copilot` bridge (v2.86.0).

```bash
# Install (pick one)
npm install -g @github/copilot-cli    # Requires Node.js 22+
brew install copilot-cli               # macOS/Linux

# Launch interactive session
copilot

# Or via gh bridge
gh copilot

# Key slash commands
/model          # Switch models (Codex Sonnet 4.5 default, also GPT-5, Codex Sonnet 4)
/delegate       # Hand off to coding agent (commits unstaged changes to new branch)
/login          # Authenticate (first time only)
```

The new Copilot CLI supports custom MCP servers, custom agents (`copilot --agent=my-agent`), and is a full agentic assistant.

## Modern Patterns

### JSON Output + jq

Always use `--json` for scripting. Never parse human-readable output.

```bash
# Get specific fields
gh pr list --json number,title,author --jq '.[] | "\(.number): \(.title)"'

# Filter in the query
gh pr list --json number,title,state --jq '.[] | select(.state == "OPEN")'
```

### Browse Shortcuts

```bash
# Open repo in browser
gh browse

# Specific pages
gh browse -p     # Projects
gh browse -r     # Releases
gh browse -s     # Settings
gh browse -A     # Actions (v2.85.0)

# Open file at line
gh browse path/to/file.py:59

# Open issue/PR by number
gh browse 123
```

### The `-w` Flag (Open in Web)

Works across many commands:

```bash
gh issue list -w
gh pr view -w
gh release view -w
gh workflow view -w
gh run view -w
```

### Issue-Linked Branches

```bash
# Create branch linked to issue (auto-links PRs from this branch)
gh issue develop -c 123
```

### PR Creation Modes

```bash
# Interactive (prompts for everything)
gh pr create

# Fill from commits
gh pr create --fill                 # Title + body from commits
gh pr create --fill-first           # Just first commit
gh pr create --fill-verbose         # Detailed commit list

# Direct
gh pr create -t "feat: thing" -b "Description here"
gh pr create -t "feat: thing" -F body.md

# Open editor
gh pr create -e --fill-first

# Open in browser (prefills form)
gh pr create -w

# With metadata
gh pr create --fill -d -r @team/reviewers -l "needs-review"
```

### PR Checkout

```bash
# By number or URL
gh pr checkout 719
gh pr checkout https://github.com/user/repo/pull/719

# Alias
gh co 719

# Works even for closed PRs with deleted branches
```

### Auto-Merge Workflows

```bash
# Enable auto-merge (requires branch protection)
gh pr merge --auto --squash

# Merge methods
gh pr merge -m    # Merge commit
gh pr merge -r    # Rebase
gh pr merge -s    # Squash

# Delete branch after merge
gh pr merge -d --squash

# Cancel auto-merge
gh pr merge --disable-auto
```

### Workflow Watching

```bash
# Watch current commit's run (live updates every 3s)
gh run watch

# Watch specific run
gh run watch <run-id>

# Compact output for large workflows
gh run watch --compact

# Exit with failure code if run fails (useful in scripts)
gh run watch --exit-status

# Trigger and watch
gh workflow run deploy.yml && sleep 2 && gh run watch
```

### CI Debugging

```bash
# View failed job logs only
gh run view <run-id> --log-failed

# Re-run only failed jobs
gh run rerun <run-id> --failed

# Force cancel
gh run cancel <run-id> --force

# Download artifacts
gh run download <run-id>
```

### Cache Management

```bash
# List caches
gh cache list

# Delete by key
gh cache delete <key>

# Delete by ref
gh cache delete <key> --ref refs/heads/feature-x

# Delete all (with safety flag)
gh cache delete --all --succeed-on-no-caches
```

### GraphQL API

Use for complex/nested queries where REST would require multiple calls.

```bash
gh api graphql -f query='
  query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      pullRequests(first: 10, states: OPEN) {
        nodes {
          number
          title
          reviews(first: 5) { nodes { state } }
        }
      }
    }
  }
' -F owner='{owner}' -F repo='{repo}'
```

### Attestation Verification

```bash
# Verify artifact attestation
gh attestation verify <artifact> --owner <org>

# Verify with specific bundle
gh attestation verify <artifact> --bundle attestation.json
```

## Extensions

```bash
# Install
gh extension install <owner/repo>

# Notable extensions (2025)
gh extension install dlvhdr/gh-dash       # TUI dashboard
gh extension install github/gh-models     # Model evals (gh models eval)
```

### gh-models (Model Evaluation)

```bash
# Run prompt evaluations defined in .prompt.yml
gh models eval

# Auto-generate test cases
gh models generate
```

## Useful Aliases

```bash
gh alias set pv 'pr view --web'
gh alias set co 'pr checkout'
gh alias set ms 'pr merge --squash --auto'
gh alias set ww 'run watch --exit-status'
```

## Anti-Patterns

| Avoid                               | Instead                                                  |
| ----------------------------------- | -------------------------------------------------------- |
| Parsing text output                 | `--json` + `--jq`                                        |
| `curl` to GitHub API                | `gh api` (handles auth, pagination)                      |
| Manual polling for CI               | `gh run watch`                                           |
| Multiple REST calls for nested data | GraphQL                                                  |
| `gh copilot` extension (old)        | `copilot` CLI or `gh copilot` bridge (v2.86.0+)          |
| gh < v2.86                          | Upgrade — native Copilot bridge, agent-task improvements |

## Authentication Contexts

| Context             | Method                                    |
| ------------------- | ----------------------------------------- |
| Local dev           | `gh auth login` (browser OAuth)           |
| CI/Actions          | `GITHUB_TOKEN` auto-injected              |
| CI (elevated perms) | `GH_TOKEN` env var with PAT               |
| Codespaces          | Auto-authenticated                        |
| SSH preference      | `gh auth login --git-protocol ssh`        |
| Scope refresh       | `gh auth refresh --scopes write:packages` |

## Sources

- [GitHub CLI Releases](https://github.com/cli/cli/releases)
- [CLI Manual](https://cli.github.com/manual/)
- [Copilot CLI Repo](https://github.com/github/copilot-cli)
- [Copilot CLI Docs](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started)
- [gh-copilot Deprecation Notice](https://github.blog/changelog/2025-09-25-upcoming-deprecation-of-gh-copilot-cli-extension/)
- [Adam Johnson: Top gh Commands (Nov 2025)](https://adamj.eu/tech/2025/11/24/github-top-gh-cli-commands/)
