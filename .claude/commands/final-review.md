Review all changes in the current branch compared to main, check for public API impact, update the README if needed, and automatically bump the package version.

## Steps

1. **Diff analysis**: First run `git fetch origin main` to ensure the local main ref is up to date with the remote. Then run `git diff origin/main...HEAD` to see all changes in this branch and `git log --oneline origin/main..HEAD` to understand the commit history. Always compare against `origin/main`, not the local `main` branch.

2. **Determine version bump**:
   - **patch** (e.g. 0.1.0 → 0.1.1): Bug fixes, documentation changes, refactors, test additions, CI changes — anything that doesn't change the public API.
   - **minor** (e.g. 0.1.0 → 0.2.0): New features, new exports, new methods on public classes, new options added to existing methods — any additive change to the public API.
   - Never bump major unless explicitly told to.

3. **Review the changes**: Provide a concise summary of what changed, organized by category (features, fixes, docs, tests, CI, etc.). Flag any concerns.

4. **Public API review**: Check if any changes affect the public API or public usage:
   - Look at `src/index.ts` exports — any added, removed, renamed, or moved exports?
   - Check the `exports` field in `package.json` — any new or changed entry points?
   - Look at public class/type signatures — any changed method signatures, new required params, removed methods, or changed return types?
   - Check for breaking changes to the `durable-bash/object` sub-export.
   - If any public API changes are found, update `readme.md` to reflect them. Keep changes concise and developer-oriented — document what consumers need to know (imports, usage, API surface, entry points), not internal implementation details.

5. **Test coverage review**: For any new or changed functionality, review existing tests and add missing coverage:
   - Are the core behaviors tested (not just happy paths)? Check edge cases, error conditions, and boundary values that exercise the actual logic.
   - Do tests assert on the right things? Tests should verify correct outcomes and state, not just that "something was called" or "no error was thrown." A test that passes when the code is broken is worse than no test.
   - Are there integration-level tests that exercise the new code through `DurableFs`, not just `FsObject` in isolation?
   - Don't add tests for trivial wiring or scenarios already covered. Focus on cases where a bug would actually go undetected.
   - Run `bun test` after any test changes to confirm they pass.

6. **Bump the version**: Run `npm version <patch|minor> --no-git-tag-version` to update package.json. Do NOT create a git tag — the version in package.json is what npm publish uses.

7. **Verify**: Run `bun test && bun run check && bun run build` to make sure everything still passes.

8. **Commit**: Stage the package.json change and commit with message: `chore: bump version to <new-version>`.

9. **Update PR**: Check if there is an open pull request for the current branch (`gh pr view --json number,title,body`). If one exists, update its title and description to reflect the full scope of changes in the branch using `gh pr edit`. The PR may have been created early and its description may be outdated. Write a concise title (under 70 chars) and a body with a short summary of all changes, not just the latest commit.

10. **Report**: Show the old version, new version, bump type, and the reasoning for the bump decision.
