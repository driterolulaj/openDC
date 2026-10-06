# ADR-0001: Record architecture decisions

Status: Proposed · Date: 2026-10-06

## Context
This is a multi-month, multi-contributor product that integrators will run for years. Choices such as schema,
replication model and privilege boundaries are expensive or impossible to reverse.

## Decision
Every significant decision gets an ADR in `docs/adr/NNNN-title.md` with these sections: Context, Decision,
Consequences, Alternatives. Accepted ADRs are immutable apart from their status line; a change means a new
ADR that supersedes the old one, and needs the project owner's approval.

## Consequences
- New sessions (human or AI) can recover the reasoning without re-deriving it.
- Writing a record adds a small cost to each decision.
