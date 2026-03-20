# Execution Plan: Cloud Auth Unification for Alpha

**Status:** Proposed  
**Created:** 2026-03-19  
**Goal:** Unify the cloud app and alpha-upload auth model so alpha users are first-class cloud users, browser and API routes share one identity boundary, and CLI uploads use cloud-issued credentials instead of a parallel local-only identity system.

## Why This Exists

Today the auth story is split:

- the Next.js cloud app uses Neon Auth wrappers
- the API package configures Better Auth directly
- local selftune stores a separate alpha identity block in `~/.selftune/config.json`
- alpha upload credentials are conceptually API keys, but that path is not yet the same clear product boundary as browser auth

That split creates unnecessary product and operational complexity:

- alpha users are not clearly the same thing as cloud users
- browser auth and upload auth are hard to reason about together
- operator support is harder because identity is duplicated across local and cloud layers
- rollout confidence is lower because the public authenticated upload path is not the same path we are exercising through the browser app

The desired model is simpler:

- **cloud account** is the source of truth for identity
- **org membership** is the source of truth for tenancy
- **alpha enrollment** is cloud-side state on that user or org membership
- **CLI upload credential** is minted from the signed-in cloud user and stored locally as a cache

Not every cloud user must be an alpha user.  
But every alpha user should be a cloud user.

## Architectural Recommendation

Use **Neon Auth as the canonical product auth boundary** for user and session identity.

That does not mean “keep two independent auth implementations because Neon Auth uses Better Auth internally.” It means:

- the product should treat Neon Auth as the user/session authority
- the API should trust the same identity model as the web app
- CLI upload credentials should be issued by the cloud app/API for authenticated cloud users
- local selftune should stop inventing its own long-lived alpha identity as the source of truth

### Docs Basis

Neon’s auth docs make the intended boundary explicit:

- Neon Auth is a **managed authentication service** for users, sessions, and auth configuration
- auth state lives in the **`neon_auth` schema**
- Neon positions it as the right choice for **production authentication**, preview environments, and branch-aware auth flows
- Neon also explicitly says **self-hosting Better Auth makes sense when you need custom plugins, hooks, and options not yet supported by Neon Auth**

That matters here because the current API package is trying to use a separate direct Better Auth setup plus the `apiKey()` plugin as if it were the same thing as Neon Auth. The docs do not support that assumption.

### What This Means for Upload Credentials

Neon Auth should remain the canonical **user/session** layer.

But alpha upload credentials should be treated as **product-owned credentials tied to Neon-authenticated users**, not as an implicit “Neon Auth supports the Better Auth API-key plugin” assumption.

Recommended long-term shape:

- browser sign-in and cloud identity: **Neon Auth**
- upload credential issuance and revocation: **product-owned tables and endpoints in the cloud app**
- upload credential verification: **API middleware that resolves the credential back to the same Neon-authenticated user/org graph**

### Auth Boundary After Unification

- **Browser app**
  - Neon Auth session/cookie
  - user signs in once
  - org membership resolved cloud-side

- **Cloud API**
  - browser requests authenticated via the same cloud user/session boundary
  - CLI upload requests authenticated via cloud-issued upload keys or tokens stored in product-owned tables
  - both paths resolve to the same `user_id` and `org_id`

- **Local selftune**
  - stores cached cloud identity references and upload credentials
  - does not treat local email/user_id as canonical enrollment truth

## Product Rules

1. Alpha enrollment is a cloud feature, not a local-only feature.
2. The source of truth for alpha status lives in the cloud backend.
3. The CLI may cache enrollment and credential state locally for convenience, but the cloud backend remains authoritative.
4. Upload credentials must be revocable and attributable to a real cloud user and org.
5. Auth for browser and auth for upload may use different credential forms, but they must resolve to the same user/org graph.

## Target State

- A user signs into the cloud app and belongs to an org.
- That user opts into alpha inside the product or through an authenticated CLI/browser handoff.
- The cloud app mints an upload credential scoped to that user/org.
- `selftune init --alpha` stores the credential locally and records the linked `cloud_user_id` and `org_id`.
- `selftune alpha upload` authenticates with that cloud-issued credential.
- Operator tools query by the same user/org identifiers the browser app uses.

## Scope

### In Scope

- choose one canonical auth boundary for app + API
- make alpha users first-class cloud users
- mint upload credentials from authenticated cloud users
- change local alpha identity semantics from source of truth to cache
- align CLI onboarding with cloud sign-in
- align docs and product language around one auth story

### Out of Scope

- enterprise SSO
- billing/plan enforcement beyond org membership hooks
- public self-serve signup polish
- non-alpha community contribution auth

## Repo Boundaries

### `/Users/danielpetro/conductor/workspaces/selftune-cloud-app/gwangju-v1`

Owns:

- canonical user/session/org auth model
- alpha enrollment state
- upload credential issuance and revocation
- protected operator surfaces
- upload auth verification

### `/Users/danielpetro/conductor/workspaces/selftune/miami`

Owns:

- local sign-in/enrollment handoff UX
- cached identity and credential storage
- upload client usage of issued credentials
- agent-facing workflow docs

## Execution Phases

### Phase 0: Decide the Canonical Auth Surface

**Priority:** Critical  
**Risk:** Low

Make an explicit architectural choice:

- treat Neon Auth as the product-level user/session authority
- stop treating the direct Better Auth setup in `packages/api` as an independent product auth stack
- stop assuming Neon Auth should also directly host the Better Auth `apiKey()` plugin path

Deliverables:

- short architecture note in the cloud repo
- one stated auth source of truth
- clear ownership of browser sessions vs CLI upload credentials

Completion criteria:

- the team can answer “how does a user authenticate?” in one sentence
- the team can answer “how does a CLI upload authenticate?” in one sentence

### Phase 1: Cloud Enrollment Model

**Priority:** Critical  
**Risk:** Medium

Add or normalize cloud-side enrollment state.

Recommended shape:

- `alpha_enrollments`
  - `user_id`
  - `org_id`
  - `status`
  - `consented_at`
  - `cohort`
  - `notes`
  - `created_at`
  - `updated_at`

Alternative:

- add alpha fields directly to a user/org membership table if that is materially simpler

Requirements:

- enrollment is queryable by user and org
- enrollment can be revoked without deleting the user
- operator tools can filter to alpha-enrolled users only

### Phase 2: Upload Credential Issuance

**Priority:** Critical  
**Risk:** Medium

Build the cloud-side flow that issues a CLI upload credential from an authenticated cloud user.

Recommended model:

- authenticated browser/session request
- server creates scoped upload credential
- credential tied to `user_id` + `org_id`
- credential revocable and auditable

The credential should be product-owned, not a side effect of a parallel Better Auth plugin stack.

Recommended model:

- `upload_credentials` or equivalent product-owned table
- credential issued only after a Neon-authenticated user session is resolved
- credential tied to `user_id` + `org_id`
- credential revocable without touching the underlying user account
- credential usage auditable (`created_by`, `last_used_at`, `revoked_at`)

The concrete credential can be either:

- a product-owned API key, or
- a signed upload token with rotation metadata

But it should not depend on a second hidden auth world, and it should not assume Neon Auth directly exposes the custom Better Auth plugin surface you would get from self-hosting.

Requirements:

- issue
- list
- revoke
- last used timestamp
- scope metadata (`push`, optional `read`)

### Phase 3: API Auth Unification

**Priority:** Critical  
**Risk:** High

Update the API so:

- browser-authenticated requests resolve user/org via the canonical cloud auth path
- upload-authenticated requests resolve to the same user/org model using the issued credential
- push/operator routes do not rely on a parallel auth implementation with drifting tables or models

This phase should remove the current conceptual split between:

- browser auth in the app
- direct Better Auth auth in `packages/api`
- product-owned upload credentials vs user/session identity

Completion criteria:

- the auth middleware resolves both browser and CLI callers into the same `user_id` / `org_id` context
- one integration test proves browser session auth
- one integration test proves upload credential auth

### Phase 4: Local CLI Onboarding Realignment

**Priority:** Critical  
**Risk:** Medium

Change `miami` so local alpha identity is no longer the primary source of truth.

New flow:

1. agent asks user whether they want to enroll in alpha
2. if yes, CLI opens or instructs a cloud login flow
3. cloud confirms identity and enrollment
4. cloud issues upload credential
5. local config stores:
   - `cloud_user_id`
   - `org_id`
   - cached email/display name if useful
   - upload credential metadata

Local config should stop behaving like the canonical alpha registry.

### Phase 5: Migration and Compatibility

**Priority:** High  
**Risk:** Medium

Provide a temporary migration path for existing local alpha users.

Recommended behavior:

- detect legacy local-only alpha blocks
- prompt to link or migrate to a cloud account
- do not silently discard local enrollment state
- support a transitional fallback period if needed

Completion criteria:

- existing testers can migrate without losing upload ability
- new testers only see the unified flow

## Testing Strategy

### Cloud Repo

- session-auth route tests
- upload-credential issuance tests
- upload-credential verification tests
- revoke/expired credential tests
- user/org resolution tests

### Local Repo

- init/enrollment tests
- migration from legacy local alpha block tests
- upload with cloud-issued credential tests
- opted-out user sends nothing tests

### End-to-End

1. sign in as a cloud user
2. enroll in alpha
3. mint upload credential
4. store locally
5. perform upload
6. verify rows land under the correct org/user
7. revoke credential
8. verify further uploads fail cleanly

## Rollout Order

1. Cloud enrollment model
2. Credential issuance + revocation
3. API auth unification
4. Local CLI onboarding realignment
5. Legacy migration
6. Remove obsolete local-only identity assumptions

## Acceptance Criteria

- Every alpha user is a cloud user.
- Browser auth and upload auth resolve into the same user/org graph.
- Local `~/.selftune/config.json` is a cache of cloud-linked identity state, not the source of truth.
- Upload credentials are cloud-issued, revocable, attributable, and stored in product-owned credential tables.
- One real end-to-end authenticated upload works without `DEV_AUTH=1`.
- The product can explain alpha enrollment in one consistent sentence across app, API, and CLI.

## Neon Docs Notes

Reviewed against Neon Auth overview, last updated **March 5, 2026**:

- Neon Auth overview: https://neon.com/docs/auth/overview

Key constraints taken from the docs:

- Neon Auth is managed and stores auth state in `neon_auth`
- Neon Auth is the recommended product auth layer for app users and sessions
- self-hosting Better Auth remains the path for unsupported custom plugins/hooks/options

That is why this plan converges on:

- **Neon Auth for user/session identity**
- **product-owned upload credentials for CLI ingestion**

## Related Plans

- [alpha-rollout-data-loop-plan.md](/Users/danielpetro/conductor/workspaces/selftune/miami/docs/exec-plans/active/alpha-rollout-data-loop-plan.md)
- [dashboard-data-integrity-recovery.md](/Users/danielpetro/conductor/workspaces/selftune/miami/docs/exec-plans/active/dashboard-data-integrity-recovery.md)
