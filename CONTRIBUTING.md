# Contributing to OpenDC

OpenDC is licensed under AGPL-3.0-only ([ADR-0023](docs/adr/0023-license-agpl.md)). Contributions are
accepted under the same license.

## Developer Certificate of Origin

Every commit in a pull request must carry a `Signed-off-by:` line (`git commit -s`). The line certifies the
[Developer Certificate of Origin 1.1](https://developercertificate.org/): you wrote the change, or have the
right to submit it under the project's license. Use your real name and an email address you can be reached at.
CI rejects pull requests with unsigned commits.

## Before you open a pull request

- Read [CLAUDE.md](CLAUDE.md). Its hard rules and code conventions apply to everyone, not only AI sessions.
- `npm ci --ignore-scripts && npm run build && npm test` passes.
- New dependencies are listed in [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md) and approved first.
- Every source file starts with `// SPDX-License-Identifier: AGPL-3.0-only`.
- User-facing strings are in the en and de locale files.
