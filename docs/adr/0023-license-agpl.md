# ADR-0023: License: AGPL-3.0

Status: Accepted 2026-10-24 · Date: 2026-10-24 · Decided by the project owner (OPEN-QUESTIONS Q12)

## Context
OpenDC is installed by integrators at many client sites, and most of its value reaches users over the
network (console, portal, self-service). It ships with a GPLv3 component (the Samba AD DC container image,
Phase 6). The project owner chose the AGPL, the license UCS also uses.

## Decision
1. All OpenDC code in this repository is licensed **AGPL-3.0-only**. The full text is in `LICENSE`.
   - "-only" rather than "-or-later" keeps the choice of any future license version with the copyright holder.
     Switching to "-or-later" is possible until the first outside contribution is merged, and needs a
     contributor-wide agreement after that.
2. Every source file starts with `// SPDX-License-Identifier: AGPL-3.0-only` (or the comment syntax of the
   file type). Every `package.json` has `"license": "AGPL-3.0-only"`.
3. **Network use (AGPL §13).** The console, the portal and the self-service pages show a "Source code" link to
   the corresponding source of the exact running version: the release tag plus any local patches the platform
   update channel applied. White-labeling (Phase 7) can restyle this link but can't remove it.
4. **Dependency compatibility.**
   - Allowed: MIT, BSD-2/3-Clause, ISC, Apache-2.0, MPL-2.0, LGPL-2.1+/3, GPL-3.0(-or-later), AGPL-3.0, 0BSD,
     CC0, Unlicense.
   - Not allowed: GPL-2.0-only, SSPL, BUSL, Commons Clause, and any proprietary or "non-commercial" license.
   - CI checks the license fields in the SBOM that `@cyclonedx/cyclonedx-npm` already produces (no extra tool),
     and fails on anything outside the allowed list.
5. **Orchestrated components keep their own licenses.** Distro packages (Samba, Kea, CUPS, nginx) are separate
   programs that we install and configure, and their licenses are unaffected. For the Samba container image
   we build and distribute, we publish the GPLv3 corresponding source with each image digest (Phase 6).

## Consequences
- Integrators who modify OpenDC and let users reach the modified version over the network have to offer
  those users the modified source. The integrator documentation (Phase 8) says so plainly.
- A closed-source fleet console (Q15) is only possible as a separate program that talks to OpenDC over its
  public API, or under a different license from the copyright holder. The project owner chose a **DCO** over a CLA (Q17, 2026-10-24). Contributions stay under AGPL-3.0-only with
  no relicensing grant, so dual-licensing later covers only code the copyright holder owns. `CONTRIBUTING.md`
  describes the sign-off, and CI checks it on pull requests.

## Alternatives
- **Apache-2.0/MIT:** maximises adoption, but lets competitors ship closed forks of the console.
- **Proprietary with an open core:** conflicts with publishing the platform as the basis for integrators, and
  needs a license server or audit story.
