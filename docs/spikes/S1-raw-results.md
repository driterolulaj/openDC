# Spike S1: raw results

Captured 2026-10-24 in the Proxmox lab by `test/env/proxmox/spikes/s1-schema-matrix.sh` and `s1-live.sh`.
Summary and conclusions: [S1-app-configuration.md](S1-app-configuration.md).

## Live: Version 4.22.11-Debian-4.22.11+dfsg-0+deb13u1 on dc1, writes to dc2

| check | result |
|---|---|
| create container + msDS-App-Configuration over LDAP on dc2 | ok |
| replicated to dc1 (change notification, no forced replicate) | ok after 7 s |
| msDS-ObjectReferenceBL back-link on target (on dc1) | ok |
| CAS rev1->rev2 with current old value | ok |
| CAS with stale old value (must fail) | rejected: LDAP error 16 LDAP_NO_SUCH_ATTRIBUTE |
| msDS-Settings value count after CAS | 1 (expected 1) |
| msDS-Settings value size over LDAP | 64000 ok, 500000 ok, 1000000 ok, 1000001 rejected (LDAP error 21 LDAP_INVALID_ATTRIBUTE_SYNTAX), 4000000 rejected (LDAP error 21 LDAP_INVALID_ATTRIBUTE_SYNTAX) |
| 1000000-char value replicated intact | 1000000 chars on dc1 |
| write msDS-cloudExtensionAttribute1 and 20 on a user | ok |
| cloudExtensionAttribute values replicated to dc1 | 2/2 |
| cloudExtensionAttribute is single-valued (second add must fail) | rejected |
| base schema version (objectVersion) | 88 |
| domain / forest functional level | (Windows) 2008 R2; (Windows) 2008 R2;  |
| cleanup | ok |

## Live: Version 4.19.5-Ubuntu on dc2, writes to dc1

| check | result |
|---|---|
| create container + msDS-App-Configuration over LDAP on dc1 | ok |
| replicated to dc2 (change notification, no forced replicate) | ok after 2 s |
| msDS-ObjectReferenceBL back-link on target (on dc2) | ok |
| CAS rev1->rev2 with current old value | ok |
| CAS with stale old value (must fail) | rejected: LDAP error 16 LDAP_NO_SUCH_ATTRIBUTE |
| msDS-Settings value count after CAS | 1 (expected 1) |
| msDS-Settings value size over LDAP | 64000 ok, 500000 ok, 1000000 ok, 1000001 rejected (LDAP error 21 LDAP_INVALID_ATTRIBUTE_SYNTAX), 4000000 rejected (LDAP error 21 LDAP_INVALID_ATTRIBUTE_SYNTAX) |
| 1000000-char value replicated intact | 1000000 chars on dc2 |
| write msDS-cloudExtensionAttribute1 and 20 on a user | ok |
| cloudExtensionAttribute values replicated to dc2 | 2/2 |
| cloudExtensionAttribute is single-valued (second add must fail) | rejected |
| base schema version (objectVersion) | 88 |
| domain / forest functional level | (Windows) 2008 R2; (Windows) 2008 R2;  |
| cleanup | ok |

## Debian GNU/Linux 12 (bookworm), Samba 4.17.12-Debian

Base schemas offered: `2008_R2 2008_R2_old 2012 2012_R2` (default: 2012_R2)

| base schema | App-Configuration | carrier attrs (rangeUpper, single) | cloudExt 1..20 | create+read | msDS-Settings sizes accepted |
|---|---|---|---|---|---|
| 2008_R2 | yes | Settings (1000000, false); ObjectReference (none, false); Integer (none, false); DateTime (none, false); ByteArray (1000000, false) | 0/20 | ok | 1000 ok, 64000 ok, 500000 ok, 1000000 ok, 4000000 REJECTED |
| 2012 | provision failed:     raise Exception("File [%s] not found. Please install samba-ad-provision package" % path) | | | | |
| 2012_R2 | yes | Settings (1000000, false); ObjectReference (none, false); Integer (none, false); DateTime (none, false); ByteArray (1000000, false) | 20/20 | ok | 1000 ok, 64000 ok, 500000 ok, 1000000 ok, 4000000 REJECTED |

## Debian GNU/Linux 12 (bookworm), Samba 4.22.6-Debian-4.22.6+dfsg-0+deb13u1~bpo12+1

Base schemas offered: `2008_R2 2008_R2_old 2012 2012_R2 2016 2019` (default: 2019)

| base schema | App-Configuration | carrier attrs (rangeUpper, single) | cloudExt 1..20 | create+read | msDS-Settings sizes accepted |
|---|---|---|---|---|---|
| 2008_R2 | yes | Settings (1000000, false); ObjectReference (none, false); Integer (none, false); DateTime (none, false); ByteArray (1000000, false) | 0/20 | ok | 1000 ok, 64000 ok, 500000 ok, 1000000 ok, 4000000 REJECTED |
| 2012 | yes | Settings (1000000, false); ObjectReference (none, false); Integer (none, false); DateTime (none, false); ByteArray (1000000, false) | 20/20 | ok | 1000 ok, 64000 ok, 500000 ok, 1000000 ok, 4000000 REJECTED |
| 2012_R2 | yes | Settings (1000000, false); ObjectReference (none, false); Integer (none, false); DateTime (none, false); ByteArray (1000000, false) | 20/20 | ok | 1000 ok, 64000 ok, 500000 ok, 1000000 ok, 4000000 REJECTED |
| 2016 | yes | Settings (1000000, false); ObjectReference (none, false); Integer (none, false); DateTime (none, false); ByteArray (1000000, false) | 20/20 | ok | 1000 ok, 64000 ok, 500000 ok, 1000000 ok, 4000000 REJECTED |
| 2019 | yes | Settings (1000000, false); ObjectReference (none, false); Integer (none, false); DateTime (none, false); ByteArray (1000000, false) | 20/20 | ok | 1000 ok, 64000 ok, 500000 ok, 1000000 ok, 4000000 REJECTED |

## Debian GNU/Linux 13 (trixie), Samba 4.22.11-Debian-4.22.11+dfsg-0+deb13u1

Base schemas offered: `2008_R2 2008_R2_old 2012 2012_R2 2016 2019` (default: 2019)

| base schema | App-Configuration | carrier attrs (rangeUpper, single) | cloudExt 1..20 | create+read | msDS-Settings sizes accepted |
|---|---|---|---|---|---|
| 2008_R2 | yes | Settings (1000000, false); ObjectReference (none, false); Integer (none, false); DateTime (none, false); ByteArray (1000000, false) | 0/20 | ok | 1000 ok, 64000 ok, 500000 ok, 1000000 ok, 4000000 REJECTED |
| 2012 | yes | Settings (1000000, false); ObjectReference (none, false); Integer (none, false); DateTime (none, false); ByteArray (1000000, false) | 20/20 | ok | 1000 ok, 64000 ok, 500000 ok, 1000000 ok, 4000000 REJECTED |
| 2012_R2 | yes | Settings (1000000, false); ObjectReference (none, false); Integer (none, false); DateTime (none, false); ByteArray (1000000, false) | 20/20 | ok | 1000 ok, 64000 ok, 500000 ok, 1000000 ok, 4000000 REJECTED |
| 2016 | yes | Settings (1000000, false); ObjectReference (none, false); Integer (none, false); DateTime (none, false); ByteArray (1000000, false) | 20/20 | ok | 1000 ok, 64000 ok, 500000 ok, 1000000 ok, 4000000 REJECTED |
| 2019 | yes | Settings (1000000, false); ObjectReference (none, false); Integer (none, false); DateTime (none, false); ByteArray (1000000, false) | 20/20 | ok | 1000 ok, 64000 ok, 500000 ok, 1000000 ok, 4000000 REJECTED |

## Ubuntu 24.04.5 LTS, Samba 4.19.5-Ubuntu

Base schemas offered: `2008_R2 2008_R2_old 2012 2012_R2 2016 2019` (default: 2019)

| base schema | App-Configuration | carrier attrs (rangeUpper, single) | cloudExt 1..20 | create+read | msDS-Settings sizes accepted |
|---|---|---|---|---|---|
| 2008_R2 | yes | Settings (1000000, false); ObjectReference (none, false); Integer (none, false); DateTime (none, false); ByteArray (1000000, false) | 0/20 | ok | 1000 ok, 64000 ok, 500000 ok, 1000000 ok, 4000000 REJECTED |
| 2012 | yes | Settings (1000000, false); ObjectReference (none, false); Integer (none, false); DateTime (none, false); ByteArray (1000000, false) | 20/20 | ok | 1000 ok, 64000 ok, 500000 ok, 1000000 ok, 4000000 REJECTED |
| 2012_R2 | yes | Settings (1000000, false); ObjectReference (none, false); Integer (none, false); DateTime (none, false); ByteArray (1000000, false) | 20/20 | ok | 1000 ok, 64000 ok, 500000 ok, 1000000 ok, 4000000 REJECTED |
| 2016 | yes | Settings (1000000, false); ObjectReference (none, false); Integer (none, false); DateTime (none, false); ByteArray (1000000, false) | 20/20 | ok | 1000 ok, 64000 ok, 500000 ok, 1000000 ok, 4000000 REJECTED |
| 2019 | yes | Settings (1000000, false); ObjectReference (none, false); Integer (none, false); DateTime (none, false); ByteArray (1000000, false) | 20/20 | ok | 1000 ok, 64000 ok, 500000 ok, 1000000 ok, 4000000 REJECTED |

