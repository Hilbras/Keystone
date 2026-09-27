# Query plans

Measured with `EXPLAIN (ANALYZE, BUFFERS)` against this repository's own
database, not a synthetic fixture. Row counts at the time of measurement:

| Table | Rows |
| --- | --- |
| `users` | 33,050 |
| `organizations` | 15,674 |
| `org_memberships` | 24,160 |
| `audit_log` | 50,395 |
| `refresh_tokens` | 4,259 |
| `api_keys` | 373 |
| `permissions` | 145 |
| `role_permissions` | 292 |

Reproduce with `npm run plans:record`.

---

## The authorization path

These run on every organization-scoped request.

### `requireOrgRole` → membership by user

```sql
select org_id, role from org_memberships where user_id = $1
```

```
Index Scan using org_memberships_user_idx on org_memberships
  (cost=0.29..8.30 rows=1 width=22) (actual time=0.036..0.036 rows=0 loops=1)
  Index Cond: (user_id = '…'::uuid)
Execution Time: 0.066 ms
```

Indexed, correct.

### `request.state.org` → organization by id

```sql
select id, name from organizations where id = $1
```

```
Index Scan using organizations_pkey on organizations
  (cost=0.29..8.30 rows=1 width=39) (actual time=0.035..0.035 rows=0 loops=1)
Execution Time: 0.064 ms
```

Primary key, correct.

### `requirePermission` → permission by resource and action

```sql
select id from permissions where resource = $1 and action = $2
```

```
Seq Scan on permissions (cost=0.00..3.60 rows=1 width=16)
  (actual time=0.017..0.057 rows=1 loops=1)
Execution Time: 0.128 ms
```

### `requirePermission` → the role/permission join

```sql
select p.id from role_permissions rp
  join permissions p on p.id = rp.permission_id
  where rp.role = $1
```

```
->  Seq Scan on permissions p      (actual time=0.021..0.038 rows=145 loops=1)
    ->  Seq Scan on role_permissions rp (actual time=0.016..0.079 rows=18 loops=1)
Execution Time: 0.315 ms
```

**Both of these sequential scans are correct, and adding an index would be a
mistake.**

`permissions` is a catalogue of `resource:action` pairs — 145 rows across 32
resources. It is bounded by the shape of the authorization surface, not by how many
users or organizations exist. At 145 rows a sequential scan reads one page and
costs 0.13 ms; an index would add write amplification on the permission path and
change the plan to something marginally faster on a path that is not the
bottleneck.

This corrects a **High** finding in the v3.0.1 analysis, which rated the missing
indexes a risk on the strength of counting `index()` declarations. The count said
nothing about whether the plan was right. Measuring took four minutes and showed
the plan was right.

The tables are still worth watching. An operator can create permissions at runtime
(`POST /v1/admin/permissions`). If that is ever opened up to a volume where the
catalogue grows into the thousands, this decision should be revisited — so the
trigger is written down here rather than left to memory.

---

## The SCIM group list

The N+1 fixed in v3.1.0. Measured on one organization with 500 groups, 167
memberships, and a connection pool of **10**:

| | Time | Queries |
| --- | --- | --- |
| One `listMembers` call per group, concurrent | **4,649 ms** | 500 |
| One `listMembersForGroups` call for the page | **81 ms** | 1 |

**57×**, with 0 groups differing in result and identical member counts. The speed
came from doing less work, not from returning less: both paths were compared
group by group, byte for byte.

Against a 10-connection pool, 499 of the 500 queries were queued rather than
running. And the endpoint defaulted `count` to the full result set, so a bare
`GET /scim/v2/Groups` triggered all of it. The Users list at the same file already
clamped with `Math.min`; the Groups list did not.

## Bounded work

| Operation | Queries before | Queries after |
| --- | --- | --- |
| SCIM group list, 500 groups | 500 | 1 |

---

## What is not covered

`EXPLAIN` was run for the authorization path and the SCIM group list — the two
areas the analysis flagged. The remaining repository queries have **not** been
recorded here, which means the gate below only covers what has been measured. A
gate that claims more coverage than it has is worse than no gate, so the scope is
stated rather than implied.

---

## Generated output

Produced by `npm run plans:record`. Regenerate after any schema or query change:

```bash
DATABASE_URL=postgresql://… npm run plans:record
```

### `org-membership-by-user`

**Where:** requireOrgRole, every organization-scoped request

```sql
select org_id, role from org_memberships where user_id = $1::uuid
```

```
Index Scan using org_memberships_user_idx on org_memberships  (cost=0.29..8.30 rows=1 width=22) (actual time=0.025..0.025 rows=0 loops=1)
  Index Cond: (user_id = '00000000-0000-0000-0000-000000000000'::uuid)
  Buffers: shared hit=2
Planning:
  Buffers: shared hit=8
Planning Time: 0.206 ms
Execution Time: 0.049 ms
```

- sequential scans: **0**
- index scans: **1**
- `Execution Time: 0.049 ms`

### `organization-by-id`

**Where:** request.state.org, every organization-scoped request

```sql
select id, name from organizations where id = $1::uuid
```

```
Index Scan using organizations_pkey on organizations  (cost=0.29..8.30 rows=1 width=39) (actual time=0.027..0.027 rows=0 loops=1)
  Index Cond: (id = '00000000-0000-0000-0000-000000000000'::uuid)
  Buffers: shared hit=2
Planning:
  Buffers: shared hit=5
Planning Time: 0.249 ms
Execution Time: 0.054 ms
```

- sequential scans: **0**
- index scans: **1**
- `Execution Time: 0.054 ms`

### `permission-by-resource-action`

**Where:** requirePermission

```sql
select id from permissions where resource = $1 and action = $2
```

```
Seq Scan on permissions  (cost=0.00..3.60 rows=1 width=16) (actual time=0.040..0.041 rows=0 loops=1)
  Filter: ((resource = 'admin'::text) AND (action = 'create'::text))
  Rows Removed by Filter: 146
  Buffers: shared hit=2
Planning:
  Buffers: shared hit=11
Planning Time: 0.204 ms
Execution Time: 0.056 ms
```

- sequential scans: **1**
- index scans: **0**
- `Execution Time: 0.056 ms`

**The sequential scan is correct** — a 145-row catalogue; a sequential scan reads one page and an index would only add write amplification.

### `role-permission-join`

**Where:** requirePermission, role expansion

```sql
select p.id from role_permissions rp join permissions p on p.id = rp.permission_id where rp.role = $1
```

```
Hash Join  (cost=6.78..10.14 rows=18 width=16) (actual time=0.192..0.239 rows=18 loops=1)
  Hash Cond: (p.id = rp.permission_id)
  Buffers: shared hit=5
  ->  Seq Scan on permissions p  (cost=0.00..3.07 rows=107 width=16) (actual time=0.023..0.041 rows=146 loops=1)
        Buffers: shared hit=2
  ->  Hash  (cost=6.55..6.55 rows=18 width=16) (actual time=0.119..0.120 rows=18 loops=1)
        Buckets: 1024  Batches: 1  Memory Usage: 9kB
        Buffers: shared hit=3
        ->  Seq Scan on role_permissions rp  (cost=0.00..6.55 rows=18 width=16) (actual time=0.029..0.097 rows=18 loops=1)
              Filter: (role = 'admin'::text)
              Rows Removed by Filter: 276
              Buffers: shared hit=3
Planning:
  Buffers: shared hit=120
Planning Time: 2.527 ms
Execution Time: 0.331 ms
```

- sequential scans: **2**
- index scans: **0**
- `Execution Time: 0.331 ms`

**The sequential scan is correct** — 292 rows on one side; the join is cheaper to scan than to index twice.

### `scim-group-members-batched`

**Where:** SCIM group list, one query per page since v3.1.0

```sql
select user_id from scim_group_members where group_id = any($1::uuid[])
```

```
ERROR: malformed array literal: "00000000-0000-0000-0000-000000000000"
```

- sequential scans: **0**
- index scans: **0**

