---
name: changelog
description: Investigate npm dependency changelog entries between version ranges. Use when the user runs "bun update" and wants to understand what changed in specific packages, or when asked to "check changelog", "what changed in <pkg>", or review dependency updates for impact.
---

# Dependency Changelog Investigator

Analyze changelog entries for npm packages between two versions and assess impact on this project.

## Input

The user will provide either:
- Raw `bun update` output with `↑ package old → new` lines
- Explicit package names and version ranges

Parse all `↑ <package> <old_version> → <new_version>` lines from the input. The user may ask about all of them or only specific ones — respect their selection.

## Procedure

For each package, run these steps. Parallelize across packages where possible.

### Step 1: Resolve the GitHub repo

```bash
npm view <package> repository.url
```

This returns a URL like `git+https://github.com/org/repo.git`. Extract the `org/repo` portion.

If it returns nothing or a non-GitHub URL, fall back to `npm view <package> homepage` and try to derive the GitHub repo.

### Step 2: Identify the tag format

```bash
gh release list -R <org/repo> --limit 10 --json tagName --jq '.[].tagName'
```

Common tag formats (check which one the repo uses):
- `v1.2.3` (most common)
- `1.2.3`
- `<package-name>@1.2.3` (monorepos like `@modelcontextprotocol/*`)
- `<short-name>-v1.2.3`

Match the format against both the old and new versions. If neither version appears in releases, the repo may use CHANGELOG.md instead — skip to Step 3b.

### Step 3a: Fetch release notes (preferred)

For each release between `old_version` (exclusive) and `new_version` (inclusive):

```bash
gh release view <tag> -R <org/repo> --json body --jq '.body'
```

If the output is very long, summarize the key changes rather than dumping everything.

### Step 3b: Fetch CHANGELOG.md (fallback)

If no GitHub releases exist:

```bash
gh api repos/<org/repo>/contents/CHANGELOG.md --jq '.content' | base64 -d
```

Extract only the section(s) between the old and new versions. If the changelog is huge, use a targeted approach:

```bash
gh api repos/<org/repo>/contents/CHANGELOG.md --jq '.download_url'
```

Then fetch that URL and extract the relevant section.

### Step 3c: Compare commits (last resort)

If neither releases nor CHANGELOG.md exist:

```bash
gh api "repos/<org/repo>/compare/<old_tag>...<new_tag>" --jq '.commits[].commit.message' | head -30
```

### Step 4: Assess project impact

After gathering changelog data for all packages, analyze relevance to this project:

1. **Read the project's imports** — check which APIs/features from each package are actually used:
   ```bash
   grep -r "<package>" src/ --include="*.ts" -l
   ```
2. **Cross-reference** changelog entries against actual usage
3. **Flag** breaking changes, deprecations, new features we should adopt, and bug fixes that affect us
4. **Ignore** changes to APIs/features we don't use (but mention them briefly)

## Output Format

For each package, provide:

```
## <package> <old> → <new>

### What Changed
- Bullet summary of meaningful changes

### Impact on This Project
- **Breaking:** [any breaking changes affecting us]
- **Relevant:** [bug fixes or improvements to APIs we use]
- **New:** [new features worth considering]
- **None:** [changes to things we don't use — brief mention only]

### Action Items
- [ ] Concrete steps if any changes are needed (code changes, config updates, etc.)
```

If no action is needed for a package, say so clearly and move on. Don't pad the output.

## Tips

- Monorepo packages (scoped like `@org/pkg`) often share a single GitHub repo. Check once, extract relevant entries for each sub-package.
- Some repos tag releases per-package: `sdk@1.27.0`, `ext-apps@1.1.2`. Look for these patterns.
- If `gh` commands fail (rate limiting, private repo), fall back to `npm view <package> changelog` or check the package's npm page.
- For the MCP TypeScript SDK specifically: the repo is `modelcontextprotocol/typescript-sdk` and tags follow the pattern `<package-short-name>@<version>` (e.g., `sdk@1.27.0`).