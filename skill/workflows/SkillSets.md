# Skill Sets

Use Skill Sets when the user wants a reusable, reproducible selection of skills
for a project. A Skill Set imports immutable package revisions into SelfTune's
local Library, then materializes those revisions into Codex or Claude Code
project registries for Claude Code, Codex, OpenCode, OpenClaw, and Pi.

## Safety Model

- `create` copies and verifies each selected package in the local Library. It
  does not change a project.
- Library packages must be self-contained. Package-internal symbolic links are
  rejected because they would make an immutable revision depend on mutable
  external files.
- `plan` is read-only. Always show its create, unchanged, and conflict counts
  before applying, including how many pinned revisions must be downloaded.
- `apply` validates every destination before making any change. One conflict
  blocks the entire operation.
- When a pinned revision is missing locally, `apply` downloads that exact
  immutable package from the configured SelfTune Cloud or self-hosted
  destination, verifies both its remote object hash and package revision, then
  continues. A failed download or verification changes neither the project nor
  the local Library.
- A fully local apply does not contact the remote destination.
- Existing project registry links must resolve inside the selected project;
  SelfTune blocks links that redirect materialization elsewhere.
- Repeating `apply` against the same revisions is a no-op.
- `rollback` removes only paths owned by the selected receipt. It blocks if a
  linked or copied package changed after apply.
- `suggest` is read-only. It classifies package semantics locally and uses only
  trusted, deduplicated trigger observations for workflow and co-usage evidence.
  It does not call an LLM, upload transcript text, create a set, or install one.
- Candidate discovery uses older sessions. The newest eligible sessions are a
  chronological holdout and cannot contribute to discovering the candidate they
  validate. Once that holdout exists, a pattern with no later recurrence is not
  recommended.
- Source identity comes from the local skill lock. Two-skill candidates from the
  same source, including ordered workflows, are not presented as standalone
  suggestions. Larger communities may contain several independently useful
  skills from one source when their usage evidence supports the combination;
  each skill remains an independent package and can also participate in other
  sets.
- Unordered co-usage forms an overlapping graph. SelfTune merges mutually
  supported edges into dense sets of up to six skills without assigning a
  skill to only one set. A reusable skill can therefore appear in several
  project sets, with a separately scored role in each set.
- Candidate membership is frozen from the older discovery window. Validation
  then checks whether those pre-existing internal relationships recur in newer,
  unseen sessions and whether every member retains a recurring connection. It
  does not require every member to appear in the same later session. Exact
  whole-set co-usage remains descriptive evidence, not the validation gate.
- Suggested-set details include each member's source, contextual role, and
  membership strength. Source identity is metadata: independently useful skills
  from one repository remain separate graph nodes and can join a broader
  cross-source set.
- Protected SelfTune control packages and admin/system skills are classified but
  never included in a suggested project set.

## Review Suggested Sets

Classify the installed Library and find repeated ordered workflows, unordered
co-usage, and project-specific skill patterns:

```bash
selftune sets suggest --json
```

The default discovery floor is three trusted sessions and 0.35 pairwise Jaccard
affinity. Pair ranking also considers a one-sided 90% Wilson lower bound and lift
against independent usage. The newest 25% of eligible sessions form a holdout,
and validation requires two later relationship recurrences by default. A set of
three or more skills must retain enough of its discovery relationships in the
holdout, with at least one recurring connection for every member; a single
popular bridge skill cannot validate a sparse collection. Tune these only when
the user asks for a broader or narrower review:

```bash
selftune sets suggest \
  --min-occurrences 5 \
  --min-affinity 0.5 \
  --holdout-ratio 0.25 \
  --min-validation-occurrences 2 \
  --min-evidence-score 0.55 \
  --max 10 \
  --json
```

Treat suggestions as review candidates. A two-skill unordered result is an
**observed pairing**, not a finished Skill Set. Explain the pattern, evidence
state, discovery count, held-out relationship coverage, and each included
skill's contextual role, then use `sets create` only after the user accepts the
selection and target harnesses. `validated` means the discovery relationships
met their later-session recurrence and quality floors; `supported` has later
evidence below the validation floor; `exploratory` means there was not enough
history to reserve a holdout window. None of these labels establish causality.
Existing sets with the same skills are suppressed automatically.

In the desktop Library, the user can replace an inferred category or return a
skill to automatic classification. SelfTune retains both the inferred category
and the human correction as labeled local evidence. In Projects, creating a
suggested set records whether it was accepted as shown or edited first. A
dismissal records a structured reason against the immutable evidence snapshot.
"Not relevant right now" may resurface only after the evidence changes;
structural dismissals such as "these skills should stay separate" suppress the
same recommendation until the user changes it explicitly. These review records
contain aggregate evidence and identifiers, never transcript text.

SelfTune reports acceptance rate, edit rate and distance, dismissal reasons,
and category corrections by algorithm version. It calibrates the evidence floor
only after 20 usable labels with at least five positive and five structural
negative reviews. Before that gate, preserve the default floor and describe the
suggestions as uncalibrated. `--min-evidence-score` is an explicit one-command
override, not learned state.

## Create A Set

Use one `--skill-path` per package and one `--harness` per target registry:

```bash
selftune sets create \
  --name "Research project" \
  --description "Evidence-heavy research workflow" \
  --harness codex \
  --harness claude_code \
  --skill-path ~/.agents/skills/research \
  --skill-path ~/.agents/skills/citations \
  --json
```

The package directory name becomes the Skill Set entry name. Each package must
contain `SKILL.md`. Creating or updating a set records an immutable manifest
revision and keeps the current revision as an explicit pointer.

Update an existing set using the current revision hash shown by `list` or
`history`:

```bash
selftune sets update \
  --set research-project \
  --parent-revision <current-revision-hash> \
  --name "Research project" \
  --harness codex \
  --harness claude_code \
  --skill-path ~/.agents/skills/research \
  --skill-path ~/.agents/skills/citations \
  --json
```

The parent revision is an optimistic concurrency guard. A stale parent blocks
the update instead of replacing a change made by another desktop or device.

Capture the skills already active in the current project with one command:

```bash
selftune sets capture
```

SelfTune derives the set name from the project folder, detects every supported
non-empty project harness registry, deduplicates identical revisions, and pins
the packages in the local Library. Repeating the same capture returns the
existing set without creating another revision. A same-name set with different
contents is never overwritten; choose an explicit name instead:

```bash
selftune sets capture --name "Mobile Engineering" --json
```

Capture another folder or restrict capture to selected harnesses with
`--project` and repeated `--harness` flags. The older explicit command remains
available for compatibility:

```bash
selftune sets derive \
  --name "Existing project setup" \
  --project /path/to/project \
  --harness codex \
  --harness opencode \
  --json
```

The desktop Projects screen lists project-scoped skills already observed by
SelfTune. **Capture as Skill Set** runs the same operation directly for that
project; use **Capture Project** when the folder or inferred settings need to be
customized.

## Preview And Apply

### Configure an existing project with several Skill Sets

When the user asks to add a group of Skill Sets to a project already on disk,
use the project-level plan first. It validates every selected set together and
blocks if two selected sets pin different revisions to the same destination.

```bash
selftune project plan \
  --project /path/to/react-app \
  --set react \
  --set testing \
  --json
selftune project configure \
  --project /path/to/react-app \
  --set react \
  --set testing \
  --json
```

Always show the plan and ask for approval before `configure`. If the user asks
to create a new React app as well, use the explicit initializer after confirming
the target folder and selected sets. It uses the built-in React TypeScript starter
and requires `--yes` because it creates files and invokes the package manager:

```bash
selftune project init \
  --project /path/to/new-react-app \
  --set react \
  --set testing \
  --yes \
  --json
```

For a different framework or scaffold command, do not guess. Create the
project using the user-approved tool, then use `project plan` and `project
configure` against its folder.

```bash
selftune library sync
selftune sets plan --set research-project --project /path/to/project --json
selftune sets apply --set research-project --project /path/to/project --json
```

On a new device, `library sync` discovers hosted Skill Set manifests without
overwriting local sets. `sets apply` then downloads only the pinned revisions
that are missing from the local Library. If the destination is offline or a
revision is unavailable, preserve the project and report the returned
machine-readable remediation instead of falling back to another revision.

If the plan reports a conflict, preserve the destination package and ask the
user whether they want to archive it, choose another set, or keep the current
project setup. Never delete or overwrite it automatically.

## Inspect And Roll Back

```bash
selftune sets list --json
selftune sets history --set research-project --json
selftune sets receipts --json
selftune sets outcomes --json
selftune sets rollback --receipt <receipt-id> --json
```

Keep the immutable Library package after rollback. Rollback removes the
project materialization, not the backed-up revision or Skill Set definition.

`sets outcomes` measures accepted-and-applied sets against matched sessions in
the same project. It compares completion quality, errors, trusted trigger
coverage, total tokens, and grading pass rate before and after activation. Do
not describe the result as causal. At least five sessions are required on each
side, and `improved` or `regressed` requires two consistent metric movements and
no movement in the opposite direction. Treat every smaller or mixed result as
`inconclusive`. Attribute the measurement to the immutable set revision stored
on the apply receipt; a later set edit is a different revision and must not
rewrite the historical outcome.

## Share With A Repository

```bash
selftune sets export --set research-project --project /path/to/project --json
selftune sets import --manifest /path/to/project/.selftune/skill-set.json --json
```

The checked-in manifest contains pinned content hashes and harness intent, but
no device paths or credentials. Import verifies its revision and every cached
package. If a package is missing, run Sync & Backup first.

## Harness Targets

| Harness       | Project registry    |
| ------------- | ------------------- |
| `codex`       | `.agents/skills/`   |
| `claude_code` | `.claude/skills/`   |
| `opencode`    | `.opencode/skills/` |
| `openclaw`    | `.openclaw/skills/` |
| `pi`          | `.pi/agent/skills/` |
