# ADR-0020: Console login via LDAPS bind against a verified DC

Status: Proposed · Date: 2026-10-06 · **Deviates from the spec, needs the project owner's decision (OPEN-QUESTIONS Q5)**

## Context
The spec says "LDAP bind with Kerberos-verified credentials". Kerberos verification usually means an AS-REQ for
the user, followed by obtaining and checking a service ticket against a local keytab, to defeat KDC spoofing.
From Node that needs either a native GSSAPI/krb5 addon or wrapping `kinit`/`kvno` with root-only keytab
access, and it adds complexity.

## Decision
1. Before SSO exists, login is a **simple bind over LDAPS** with the user's credentials to a DC whose
   certificate is verified against the domain CA. Normally that's the local DC on a DC, or the home DC.
   - The verified TLS channel already defeats DC/KDC spoofing, which is the reason Kerberos verification is
     done in the first place.
   - Failed binds increment `badPwdCount` on the DC, so the domain lockout policy applies natively.
   - The credential is discarded right after the bind. The session stores the user's SID, GUID and the time
     their `tokenGroups` were evaluated, never the password.
2. Admins can enable an optional TOTP second factor (SECURITY.md §4). It's mandatory for the Domain Admin role
   once SSO is off. That default is configurable.
3. Once the Keycloak app is installed (Phase 5), the console accepts OIDC, and Keycloak handles Kerberos/SPNEGO.

## Consequences
- No native addon and no keytab access for the API.
- If you insist on Kerberos verification, it can be added later as an agent operation (`krb5.verifyPassword`),
  using the host keytab and the MIT/Heimdal CLI. That costs a root round trip per login.
