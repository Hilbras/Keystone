# Performance and Memory Optimization

This guide explains why Keystone may feel heavy during local development and how to run it efficiently in production.

---

## Why it feels heavy during development

### 1. Development tools use more memory

When you run `./start.sh`, the backend starts with:

```bash
npx tsx watch src/index.ts
```

`tsx watch` keeps a TypeScript compiler in memory and recompiles files on every change. This is convenient but uses more RAM than a compiled build.

The frontend runs:

```bash
npm run dev   # Vite dev server
```

Vite also keeps modules in memory for fast hot reload.

**Typical dev memory usage:**

| Process | Memory |
|---------|--------|
| Backend (`tsx watch`) | ~200–400 MB |
| Frontend (`vite dev`) | ~150–300 MB |
| PostgreSQL container | ~100–200 MB |
| Redis container | ~10–50 MB |
| Browsers | 500 MB–2 GB |

### 2. Stale processes accumulate

If `./start.sh` is run multiple times or crashes, old `tsx watch` and `vite` processes may stay alive and continue using memory and ports.

### 3. `node_modules` is large

Node projects naturally have large dependency trees:

```
413 MB   total node_modules across backend + frontend + SDK
```

This is disk space, not RAM, but it makes the project feel heavy.

---

## Quick fixes

### Kill stale processes

The latest `start.sh` does this automatically. If you still see old processes:

```bash
./scripts/kill-keystone.sh
```

Or manually:

```bash
pkill -f "tsx watch src/index.ts"
pkill -f "tsx watch src/setup-server.ts"
pkill -f "frontend/node_modules/.bin/vite"
```

### Run in production mode

After building:

```bash
npm run build:all
./start.sh --production
```

This uses `node dist/index.js` instead of `tsx watch`, which uses significantly less memory.

### Stop the frontend if you only need the API

If you are integrating an external app and do not need the admin UI:

```bash
npm start   # backend only
```

---

## Production deployment optimizations

1. **Use `npm start` or `node dist/index.js`** — never `tsx watch` in production.
2. **Run with `NODE_ENV=production`** — this disables development logging and tracing overhead.
3. **Disable OpenTelemetry if not needed** — remove `OTEL_EXPORTER_OTLP_ENDPOINT` from `.env`.
4. **Use managed PostgreSQL and Redis** — reduces local container overhead.
5. **Use a process manager** like systemd, PM2, or Docker Compose with restart policies.
6. **Build the frontend once** and serve the `dist/` folder with Nginx/Caddy instead of `vite dev`.

### Example systemd service

```ini
[Unit]
Description=Hilbras Keystone
After=network.target

[Service]
Type=simple
User=keystone
WorkingDirectory=/opt/keystone
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=/opt/keystone/.env

[Install]
WantedBy=multi-user.target
```

---

## Reducing bundle size

The admin frontend bundle is currently:

```
252 KB   index.js (gzipped)
24 KB    index.css (gzipped)
```

If you need to reduce it further:

- Use route-based code splitting.
- Lazy-load heavy panels (organizations, audit logs, billing).
- Remove unused Lucide icons by importing only the ones used.

---

## Monitoring memory

Check Keystone memory usage:

```bash
ps -eo pid,ppid,%mem,rss,args | grep "node dist/index.js" | grep -v grep
```

Check Docker container resources:

```bash
docker stats --no-stream
```

If memory keeps growing after running for hours, it may be a leak. Enable heap snapshots or contact the maintainers.

---

## Hot-path benchmark

Everything above is about memory on a developer laptop. This section is about
whether the request paths that matter are actually fast, measured rather than
argued about.

```bash
npm run bench:hot                    # compare against the recorded baseline
npm run bench:hot -- --record        # overwrite the baseline
npm run bench:hot -- --json          # numbers only, no comparison, no exit code
npm run bench:hot -- --only=reconcile   # one group of scenarios
```

It needs a PostgreSQL and a Redis, creates its own organization, users and groups,
and removes them at the end. The recorded baseline is
[`docs/performance/hot-paths.baseline.json`](./performance/hot-paths.baseline.json);
the reasoning behind it is in
[`docs/performance/README.md`](./performance/README.md). A nightly CI job compares
against it: [`.github/workflows/benchmark.yml`](../.github/workflows/benchmark.yml).

### What it measures

| Scenario | Sizes | The question it answers |
|---|---|---|
| `scim-group-list` | 50, 200, 1000 groups | Is group listing N+1, or constant per page? |
| `scim-group-reconcile` | 10, 100, 1000 members | Is member reconciliation quadratic, or linear? And what is the constant? |
| `login` | — | The argon2id cost, which is a deliberate choice and not a regression. |
| `refresh` | — | Token rotation, on every page load for a cookie session. |
| `authz-check` | — | `/v1/authz/check`, which an application calls per resource. |

### Two numbers, and only one of them is trusted

**`queries` — how many SQL statements the path sent.** Exact, and identical on
every machine. This is the hard gate: a path that used to issue *N* statements and
issues *N+1* fails with no tolerance to argue about. An N+1 query is not a slow
query, it is a different number of queries.

**`relative` — wall-clock divided by a control measured immediately before the
scenario ran.** An absolute millisecond baseline is not portable: a number
recorded on a laptop means nothing on a runner three times slower, and comparing
against one produces a gate that is either permanently red or permanently green.
A permanently red gate gets switched off.

The control is a fixed integer loop and twenty `SELECT 1`s, each the cheapest of
three runs, measured per scenario rather than once per benchmark — a full pass
takes ten minutes and the machine does not stay in one load regime for ten
minutes. Scenario timings report the **minimum** of five samples for the same
reason: contention can only add time, so the fastest run is closest to what the
code costs. A regression that affects every sample still moves the floor.

Timing tolerance is 40%. That is deliberately wide. A benchmark that fails on a
noisy machine trains people to ignore the benchmark, and the query-count gate
catches the regressions worth catching exactly.

### The recorded baseline

Statement counts, from `docs/performance/hot-paths.baseline.json`. These do not
vary by machine, which is the point of recording them:

| Scenario | Statements | Note |
|---|---|---|
| `scim-group-list-50` | 5 | |
| `scim-group-list-200` | 5 | **Same as 50.** Constant per page. |
| `scim-group-list-1000` | 10 | Two pages, because the page cap is 500. |
| `scim-group-reconcile-10` | 70 | 6 per member, plus a fixed 10 |
| `scim-group-reconcile-100` | 610 | 6 per member, plus a fixed 10 |
| `scim-group-reconcile-1000` | 6,010 | 6 per member, plus a fixed 10 |
| `login` | 9 | Argon2id, and see below. |
| `refresh` | 9 | |
| `authz-check` | 7 | |

Three things fall out of that table, and each one corrects a claim that had been
made by reading the code rather than by running it.

**The group list is already constant.** 5 statements at 50 groups, 5 at 200, 10
for 1,000 across two pages. The plan had set a target of "2 queries"; that was a
guess written before anything was measured, and the extra statements are SCIM
credential resolution rather than the member fetch.

**The reconcile is not quadratic — it is linear with a 6× constant, which is
worse than it sounds.** `addMember` opens a transaction per member: `BEGIN`, a
group lookup, a membership lookup, an insert, `COMMIT`. Six statements and a
commit, per member. A 1,000-member group push is 6,010 statements and takes about
20–50 seconds. No individual query is slow; there are six thousand of them. The
`keystone.scim.group.reconcile` span carries `members_submitted`, `members_added`
and `members_removed` so a slow reconcile in production can be attributed to
group size rather than guessed at.

**Login is nine statements and roughly two seconds, and all of the time is
argon2id.** The parameters are `memoryCost: 65536, timeCost: 3, parallelism: 4`
— above the OWASP minimum, deliberately, and it costs about 2.2 seconds on the
machine that recorded the baseline. Nothing about that is a query problem, and the
`keystone.token.issue` span separates the two: the span's duration is the whole
issuance, and a `cpu` reading of 2.2s against 9 statements says the time is in
the hash. Whether that trade is right is a security decision rather than a
performance one, but it should be a decision made knowing the number.

### Re-recording

Only when a change was intended to move a number, and only on a quiet machine.
Run it twice and check the numbers agree before committing — if they disagree by
more than a few percent, the machine was busy and the recording is not worth
having. In CI:

```bash
gh workflow run benchmark --ref <branch> -f record=true
```

The recording is a normal pull request. A baseline that can be changed silently is
not a baseline.
