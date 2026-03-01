Review all changes in the current branch compared to main and automatically bump the package version.

## Steps

1. **Diff analysis**: Run `git diff main...HEAD` to see all changes in this branch. Also run `git log --oneline main..HEAD` to understand the commit history.

2. **Determine version bump**:
   - **patch** (e.g. 0.1.0 → 0.1.1): Bug fixes, documentation changes, refactors, test additions, CI changes — anything that doesn't change the public API.
   - **minor** (e.g. 0.1.0 → 0.2.0): New features, new exports, new methods on public classes, new options added to existing methods — any additive change to the public API.
   - Never bump major unless explicitly told to.

3. **Review the changes**: Provide a concise summary of what changed, organized by category (features, fixes, docs, tests, CI, etc.). Flag any concerns.

4. **Bump the version**: Run `npm version <patch|minor> --no-git-tag-version` to update package.json. Do NOT create a git tag — the version in package.json is what npm publish uses.

5. **Verify**: Run `bun test && bun run check && bun run build` to make sure everything still passes.

6. **Commit**: Stage the package.json change and commit with message: `chore: bump version to <new-version>`.

7. **Report**: Show the old version, new version, bump type, and the reasoning for the bump decision.
