# ADR-0017: Domain-wide singleton jobs run on the PDC emulator

Status: Proposed · Date: 2026-10-06

## Context
Some jobs must run exactly once per domain: scheduled backups, staged update rollouts, service-account password
rotation, CRL refresh for the root, audit retention, fleet heartbeats, Windows-DC retirement workflows. We
need a leader with no single point of failure, and we don't want to build or run a consensus system.

## Decision
- The platform leader is the DC that holds the **PDC emulator** FSMO role (`fSMORoleOwner` on the domain
  head). Each DC checks this every 60 s from its own replica. The scheduler is active only on the leader.
- Moving or seizing the PDC emulator moves leadership. The FSMO UI says so.
- To protect against split-brain during a partition (two DCs both believing they hold the role after a bad
  seize), jobs take an idempotency key (`jobType:period`) recorded in the directory before they run. A second
  claimant sees the existing claim after replication and backs off.
- SYSVOL replication (ADR-0019) uses the same role as its source of truth, which matches GPMC's default of
  editing GPOs on the PDC emulator.

## Consequences
- No new infrastructure, and admins already understand how to move the role.
- If the PDC emulator is down for a long time, singleton jobs stop. A diagnostic warns after 1 h, and the
  console offers "transfer/seize PDC emulator".
