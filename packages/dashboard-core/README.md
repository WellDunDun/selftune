# @selftune/dashboard-core

Shared dashboard application layer for SelfTune cloud and local hosts.

This package owns:

- capability and entitlement contracts
- host adapter interfaces
- normalized dashboard view models
- shared route definition helpers
- shared dashboard chrome primitives used by cloud and local hosts
- shared feature gates and locked-route upgrade surfaces
- shared screen implementations, including analytics, the overview autonomy/comparison/support surfaces, skills library, Projects and Skill Sets, and the shared skill report scaffold/trust chrome

## Usage

```ts
import {
  DashboardChrome,
  DashboardHostProvider,
  canUseFeature,
  type Capabilities,
  type DashboardHostAdapter,
} from "@selftune/dashboard-core";
```

## Host adapter pattern

The shared application supports three server hosts: Local, SelfTune Cloud, and
Self-host. Desktop embeds Local and adds native shell behavior; it is not a
fourth dashboard host.

Each composition root supplies one `DashboardHostAdapter`. Authentication,
queries, mutations, navigation, permissions, and live updates live behind that
adapter. Feature contributions are either available, upgrade-required, or
absent. `capabilitiesFromAdapter` derives the legacy route-gating projection,
so applications must not maintain a second host-by-feature matrix.

Shared screens consume adapter operations and feature access only. They must
not branch on `adapter.host`. When a capability is absent, use
`featureAccessFromAdapter` to render an intentional unavailable state; when it
is upgrade-only, render the contribution's upgrade destination.

The Skills Library follows the same rule at feature depth. Hosts supply normalized inventory and
optional actions through `DashboardHostAdapter.library`; search, filters, details, diffs, and
availability states remain inside the shared screen.

## OSS Mirror

This package is canonical in the root `packages/` directory and mirrored into
`oss/selftune/packages/dashboard-core` via `scripts/sync-embedded-shared.sh`.
