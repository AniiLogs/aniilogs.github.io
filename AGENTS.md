# Notes for AI agents working on the AniiLogs site

- Layout, local development and deployment: see README.md.
- **`main` is protected: changes land by pull request** (merging deploys the public site). Claim a GitHub issue
  first, branch as `<github-name>/<topic>`, open the PR with `Closes #<issue>` and turn on auto-merge
  (`gh pr create --fill`, `gh pr merge --auto --squash`). It merges itself once the `site` check passes.
- Two developers share this repository. Follow the working agreement in the aLogs repository,
  https://github.com/AniiLogs/aLogs/blob/main/docs/working-together.md: claim an issue first, small short-lived
  branches, `git pull --rebase origin main` before pushing, never force-push.
- **First thing in every session:** `gh pr list --author @me`. Fix your own red or conflicted PRs first: rebase on
  `main`, fix, and push to the same branch. Auto-merge carries on; don't open a new PR.
- **Keep it cheap:**
  - Catch up with `git log --oneline -20` and `git diff --stat`. Open a full diff only for the files you will touch.
  - grep and read only the lines you need. `src/index.js` and the `public/` scripts are long.
  - Run the tests for what you changed (`node --test test/<file>.test.js`). The PR check runs everything.
  - Don't review the other developer's work unless asked.
  - Answer briefly.
- Never commit secrets, `.dev.vars`, game files or players' data. `npm run repo:validate` checks for some of these.
- Production D1 and R2 writes, and deploys outside a merged PR, need the maintainer's yes.
