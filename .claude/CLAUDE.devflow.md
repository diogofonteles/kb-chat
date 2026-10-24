# devflow — fixed goal rules

Single source of these rules (the why: the plugin's `references/rule-origins.md`, not loaded). Project conventions (commits, branches, package manager) stay in the repository's rules; project commands in `harness.json` → `commands` (shown at `SessionStart`).

## Invariants

- Never assume: re-query the state on the spot (git, PR, CI, cloud provider) and separate proven, inferred and unverified. Challenged? Verify before restating.
- Evidence or it did not happen. "Green" requires command output with exit 0, a SHA, a run/PR URL or a screenshot. Zero checks is not green. A missing variable is a block, not a caveat. A result for code changed afterwards does not count.
- Commits, branches, tags, PRs, issues and comments with no mention of AI at all (no `Co-Authored-By`, no footer). The `no-ai` guard refuses.
- Secrets never in an argument, versioned file, evidence or output. The git credential comes from `gh` (`gh auth setup-git`); secret-setting commands (`gh secret set`, the provider's CLI) without a literal value.
- Never a direct or forced push to an environment branch (e.g. `develop`, `main`, plus `protectedBranches`). Always `feature/*` (or `fix/`, `chore/`, `hotfix/`) from the **updated** base (`repos[].base.branch`) + PR.
- Promotion only by PR, only in the order of `repos[].promotion` (e.g. develop → qa → staging → main). Production is a human decision: the `production` guard refuses merges, workflows and deploy commands above `goal.finalEnvironment`.
- Languages come from `devflow-config`: replies in the conversation language, work artifacts in the artifacts language, code, docs and commits in the code language.
- Use the project's package manager (repository rules), never another. One heavy command at a time; never wait in the foreground for a background job.

## Work-item state

The machine state lives in `work/<ID>/state.json`, in the folder that has `.claude/harness.json` (`work/` is in `.gitignore`). It is written only through the `devflow-state` CLI (on the PATH):

| When | Command |
|---|---|
| Start or resume | `devflow-state start <ID> --title "..."` |
| Change stage | `devflow-state stage <stage>` |
| Gate by command (preferred) | `devflow-state run <gate> -- <command>` (records log and exit code) |
| Gate by other evidence | `devflow-state gate <gate> --status ok --sha <sha> \| --url <url> \| --file <path> \| --screenshot <png>` |
| Gate that does not apply | `devflow-state gate <gate> --status not-applicable --reason "..."` |
| Decision taken by the recommended option | `devflow-state decision "<what>" --reason "<why>"` |
| Next step | `devflow-state next "<step>"` |
| Review round | `devflow-state review` |
| Real block | `devflow-state block --type <TYPE> --reason "..." --request "..." --where chat\|<url>` |
| End | `devflow-state complete` (refuses if a required gate is missing) |

Helpers on the PATH: `devflow-pr-checks <pr>` (checks verdict) and `devflow-deploy-run <branch>` (deploy run matched by SHA).

The `Stop` hook reads that file: the turn only ends with the work item **done with all required gates proven** or with **an open block and the request made**. After a few turns with no state change it records `NO-PROGRESS` and stops. On `SessionStart` (start, resume, compaction) the state summary is reinjected; the state on disk prevails over memory.

## Goal mode: does not ask

Under `/goal <ID>` (or "following the recommended path"):

1. Decide by the recommended option and record the decision (`devflow-state decision`). Non-blocking ambiguity becomes a recorded premise, not a question.
2. No skill has a "stop and confirm": plan, task list, PR title, merge into the base branch and promotion up to the final environment are authorized by `/goal` itself.
3. Stop **only** for a catalog block, with the request ready:
   - `PO-DECISION`: product decision with no reasonable default (cite the open question);
   - `DEPENDENCY`: an external API or service down or its contract changed;
   - `INFRA`: cloud provider, CI or database down (with the failed command);
   - `CREDENTIAL`: token, environment secret or test account missing;
   - `ACCESS`: permission on the SCM or the cloud provider;
   - `HUMAN-ACTION`: only a person can do it (new secret in the environment, MFA login);
   - `IRREVERSIBLE`: production, production data, truncating a table in a shared environment;
   - `COST`: action that spends quota or money (paid API calls, bigger machines);
   - `SCOPE`: contradictory request or larger than authorized;
   - `ATTEMPT-LIMIT`: 3 review rounds or 2 fix attempts without converging.
   A missing local artifact (PRD, techspec) is never a block.
4. When blocking: ask right away, with the command or options ready, and carry on with what does not depend on the block. Repeat the request once; if the goal is then reopened with no change, answer only `Waiting for you: <request>`.
5. Never slice the delivery or declare a partial "done" without written approval. "Validate later and complete it" is not an accepted state.

## Goal routine

A stage advances only with its done criterion met and evidence in the state. The required gates are `goal.requiredGates` in `harness.json`, plus `qa` while `qa.enabled` (default on); `<base>` is `repos[].base.branch`.

1. **Preflight**: the preflight commands (`commands.preflight`; at least `gh auth status` and `git fetch origin`). Failed → `ACCESS`/`INFRA` block with the command.
2. **Intake** (`intake`): if `<backlog.dir>/<ID>-*.md` exists (default `docs/backlog/`, skill `backlog-planner`), it is the request; else record the literal request (text, date, source) in `work/<ID>/request.md`. Criterion × code matrix (OK / TO BUILD / UNREACHABLE / CONFLICT) from its BR/FR/AC; UNREACHABLE or CONFLICT with no default = `PO-DECISION`. Skills: `product-manager`, `web-research`, `ux-researcher` (plan the human runs).
3. **Spec** (`spec`): 1 page in `work/<ID>/spec.md`: outcome with a metric, out of scope, real files, input → output, contracts/migration/rollout per `commands`, each AC mapped to a test, the exact verification command. UI: screen spec (`product-designer`). Boundary, data store, integration or public contract: `software-architect`; hard to reverse = ADR.
4. **Execution**: `git checkout <base> && git pull --ff-only` and `git checkout -b feature/<slug>`. A test that fails before the fix. Before coding, load the `coding-standards` skill and read the stack references; the project's standard prevails. Conventional commits, in the code language.
5. **Tests and gates** (`gates`): `devflow-state run gates -- '<commands.gates>'` (runs the unit and integration tests); a UI change adds the E2E of the touched flow (`commands.e2e`). No `--no-verify`, loosened assertion, disabled test or lowered coverage.
6. **Local validation** (`local-validation`): start the dev servers (`commands.devServers`, in order); the spec's scenarios in the browser at two widths, screenshots actually looked at against the screen spec and the `product-designer` rules.
7. **QA** (`qa`, when `qa.enabled`): `qa-engineer` skill in a subagent with no context of the implementation: AC traceability (each AC → test → result/evidence), E2E of touched flows and regression, an exploratory session (negative, edge, permission), accessibility and NFR checks; report in `work/<ID>/qa.md` with an explicit verdict; failures go back to execution (same cap as review).
8. **Review** (`review`): `code-reviewer` skill in a subagent with no context of the implementation; findings cite the rule ID, explicit verdict; with UI, include the `product-designer` review. Cap of 3 rounds, decreasing scope; count each with `devflow-state review`.
9. **PR** (`pr`): check `git log origin/<base>..HEAD --oneline` (empty = nothing to deliver) and `gh pr list --head <branch> --state all`; then `gh pr create --base <base> --title "<conventional>" --body-file work/<ID>/pr.md`. **CI** (`ci`): `devflow-state run ci -- devflow-pr-checks <n> --wait 20` (reads `bucket`; zero checks is not green). Failed: read `gh run view <run> --log-failed` before any rerun.
10. **Merge** (`merge`): `gh pr merge <n> --merge` into `<base>`; record the merge SHA.
11. **Promotion** (`promotion`): one PR per step of `repos[].promotion` up to `goal.finalEnvironment`, each with green CI (plus the `commands.rollout` checks). Merge each one.
12. **Deploy** (`deploy-<env>`, e.g. `deploy-staging`): `devflow-state run deploy-<env> -- devflow-deploy-run <branch> --workflow <environments.<env>.deployWorkflow> --wait 20`: the run for the merge's `headSha`, not the latest success, ends in success with every `apps[].smoke`.
13. **Final environment validation** (e.g. `staging-validation`): the spec's scenarios on the final environment's screen with `environments.<env>.testAccount` (QA on: run with `qa-engineer`, smoke E2E + the AC scenarios); the smokes and something only this version has. Negative control: a new protected route without a session refuses.
14. **Closing**: reread the whole request, check it item by item, a factual summary (what changed, PRs, deploy run, how to test) and `devflow-state complete`. Record the next human step: the promotion PR above `goal.finalEnvironment`.

## When a guard refuses

The message carries the rule and the fix: fix and carry on; never work around it (another command, MCP, script). If the guard refused something legitimate, record the decision and ask for the guard to be adjusted: a guard that blocks what is authorized is a guard defect.
