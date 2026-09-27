# Security gate exceptions

The release gate fails on any critical or high advisory without an exception
recorded here. An undocumented exception is not an exception: the gate still
fails, which is intentional, because the alternative is a gate that gets
quietly disabled.

## Currently accepted

None. `npm audit` reports 0 vulnerabilities across production and development
dependencies, and no critical or high advisory is outstanding.

## Adding an exception

An entry is only acceptable if it is time-bounded and someone is accountable.
Record:

| Field | Meaning |
| --- | --- |
| Advisory | Identifier, e.g. `GHSA-xxxx-xxxx-xxxx` |
| Dependency | Package and the version range affected |
| Severity | As reported by the scanner |
| Reason | Why the risk is accepted rather than fixed |
| Mitigation | What reduces the exposure in the meantime |
| Expires | Date after which the gate fails again |
| Owner | Who agreed to it |

An exception without an expiry is treated as no exception. A dependency with no
fix available is a legitimate reason; "we are shipping this week" is not.

## Advisory history

Superseded entries are kept with a resolution, so the record of what was accepted
and why remains readable.
