---
name: merge
description: Merge this worktree's branch into main and clean up. Use whenever the owner says "merge" or "merge and push" (push only when they say push).
---

Run these in order. Don't re-read CLAUDE.md to work them out; stop and tell the owner if a step fails.

1. **Commit** anything uncommitted on the branch (a clear message, ending with the attribution lines).
2. **README:** if the change added, renamed or removed a graph, or changed what one shows or lets you do, update its
   `###` section in `README.md` (plain, first-person, what it shows, not how it's built) and commit. Otherwise skip.
3. **Rebase:** `git rebase main`, fixing any conflicts.
4. **Check the rebase** (both must pass; fix on the branch and re-run if not):
   - `git grep -nE '^(<{7}|={7}|>{7})( |$)' -- index.html css js` prints nothing.
   - `python3 dev/harness.py && python3 dev/shot.py "http://localhost:<your port>/test.html?v=$RANDOM" /tmp/merge.png 1280 900`
     ends with the title `DONE` and prints no `EXC` lines. No need to look at the picture.
5. **Stop your server** (`pkill -f "http.server <your port>"`) and **leave the worktree** with `ExitWorktree`, `keep`.
   (A worktree session can't run git against the main checkout, so the merge happens from there.)
6. **Merge,** now in the main checkout: `git merge --ff-only <branch>`. If it refuses, tell the owner; never force it.
   **Push** only if the owner said push: `git push origin main` (this deploys the live site).
7. **Clean up:** `git worktree remove .claude/worktrees/<name>` and `git branch -d <branch>`. If the owner may be looking
   at `main` on 8765, re-run `python3 dev/harness.py` here.
8. **Reply** in one or two lines: merged (and pushed), and anything you kept under Visual tweaks.
