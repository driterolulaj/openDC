# ADR-0004: Change propagation with a per-node DirSync/USN watcher

Status: Proposed · Date: 2026-10-06

## Context
When directory objects change, local configuration has to follow. For example, a DHCP reservation changes, so
Kea on the nodes serving that subnet must re-render. UCS uses a notifier/listener pair on top of OpenLDAP's
transaction log. AD offers `uSNChanged`, the DirSync control (`1.2.840.113556.1.4.841`) and the change
notification control (`1.2.840.113556.1.4.528`).

## Decision
1. Every node runs `myucs-watcher` as the unprivileged `_myucs-watch` user.
   - **On a DC** it watches the local DC.
   - **On other nodes** it watches its home DC, chosen by AD site, and fails over to another DC in the site,
     then to any DC.
2. Change detection:
   - **Primary:** DirSync over the watched naming contexts. This returns changed attributes and deletions and
     needs the "Replicating Directory Changes" right, which is granted to the watcher's bind identity.
   - **Fallback:** polling `(uSNChanged>=N)` with paged results, and the Show Deleted control for tombstones.
   - **Wake-up:** a change notification search, where supported, to cut latency. Otherwise the poll interval
     applies (default 5 s; configurable).
3. **The checkpoint is bound to the DC.** Store `{dcDsaGuid, invocationId, dirsyncCookie | highestUsn}` in the
   platform DB. USNs are local to one DC and aren't replicated. If the DC or its `invocationId` differs from
   the checkpoint (failover, or a DC restored from backup), run a **full resync**: enumerate all watched
   objects and dispatch them as `sync` events.
4. Handlers are declared in module manifests: `{id, baseDn (relative), filter, attributes, roles}`.
   - They must be **idempotent**, because they can see the same change twice.
   - They run with a timeout and get bounded retries with backoff.
   - The checkpoint advances only after every matching handler succeeds, or after a handler has been
     **quarantined**: after N failures it's skipped, its own checkpoint is frozen, and a diagnostic is raised.
     A quarantined handler doesn't hold up the others.
5. Handlers are "what should be" reconcilers, not diff appliers: they recompute the desired output (such as a
   whole Kea config) from current directory state. That's what makes idempotency and full resyncs cheap.
6. Writes to the system go through the Config Registry and agent; handlers never touch the filesystem directly.
7. The watcher also feeds outbound webhooks (§6.15) and, later, ingestion of Samba's JSON DSDB audit log, so
   changes made outside MyUCS (for example with RSAT) still show up in history.

## Consequences
- No extra infrastructure (queue or broker), and it keeps working when the network is partitioned (the node
  just falls behind).
- Propagation is eventually consistent: replication delay plus poll interval. Writing a change and seeing its
  effect on another site can take minutes, depending on the replication schedule. The UI shows a "pending
  propagation" state for jobs that wait on it.
- Full resyncs cost O(watched objects). Load tests (50k users) must show that a resync is fast enough. Handlers
  watch narrow subtrees (mostly our own container), not every user.

## Alternatives
- **A message broker** (Redis/NATS): another stateful service to run, and it can disagree with the directory.
- **Polling `whenChanged`:** too coarse (one-second resolution, replicated timestamps).
- **Notification control alone:** no catch-up after downtime.
