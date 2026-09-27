# Performance

Measured numbers about Keystone, and how to reproduce them.

| File | What it is |
|---|---|
| [`query-plans.md`](./query-plans.md) | `EXPLAIN` output for the queries that were suspected of being slow, recorded on a database with production-shaped data. |
| [`hot-paths.baseline.json`](./hot-paths.baseline.json) | The recorded baseline the benchmark compares against. |
| [`PERFORMANCE.md`](../PERFORMANCE.md) | Memory and deployment guidance, plus the hot-path baseline in prose. |

---

## Why the numbers are in a file and not in a comment

`docs/ANALYSIS-v3.0.1.md` rated two unindexed tables as High risk. Running
`EXPLAIN` on them showed sequential scans over 145 and 292 rows, which is the
correct plan at that size — the index would have been slower and would have cost
a write on every insert. The rating was wrong, and no amount of reading the
schema would have revealed it.

That is the reason for everything in this directory. A performance claim in
Keystone is a claim about a measurement, and a measurement that is not written
down is a measurement somebody will re-derive differently.

---

## The hot-path benchmark

Five paths, sized so a scaling problem is a slope rather than a suspicion:

| Scenario | Sizes | What it would show |
|---|---|---|
| `scim-group-list` | 50, 200, 1000 groups | N+1 on read. Statement count would climb with page size. |
| `scim-group-reconcile` | 10, 100, 1000 members | Quadratic on write. Statement count would climb faster than linearly. |
| `login` | — | The argon2id cost, plus the user lookup. |
| `refresh` | — | Token rotation, which is on every page load for a cookie session. |
| `authz-check` | — | `/v1/authz/check`, which an application calls per resource. |

Run it:

```bash
npm run bench:hot                    # compare against the recorded baseline
npm run bench:hot -- --record        # overwrite the baseline
npm run bench:hot -- --json          # numbers only, no comparison, no exit code
```

It needs a PostgreSQL and a Redis. It creates its own organisation, users and
groups, and removes them at the end, so it does not care what else is in the
database.

Nightly in CI: [`.github/workflows/benchmark.yml`](../../.github/workflows/benchmark.yml).

---

## Two numbers, and only one of them is trusted

**`queries`** — how many SQL statements the path sent. Exact, and identical on
every machine. This is the hard gate: a path that used to issue *N* statements and
issues *N+1* fails, with no tolerance to argue about. An N+1 query is not a slow
query, it is a different number of queries, and that is what this catches.

**`relative`** — wall-clock divided by a control measured immediately before that
scenario ran. An absolute millisecond baseline is not portable. A number recorded
on a development laptop means nothing on a hosted runner that is three times
slower, so a comparison against one produces a gate that is either permanently
red or permanently green, and a permanently red gate gets switched off. Dividing
both sides by the same control cancels the machine out and leaves the code.

The control is a fixed integer loop and twenty `SELECT 1`s, each the cheapest of
three runs, and it is measured **per scenario** rather than once for the run. A
full pass takes ten minutes — the 1,000-member reconcile alone takes about twenty
seconds — and the machine does not stay in one load regime for ten minutes. With
one control for the whole run, the login samples that followed the long
reconcile were divided by a number from a different minute than the one they ran
in.

Timings report the **median** of five samples, with one untimed warm-up pass per
scenario so JIT compilation and a cold connection pool do not land in the median.
The usual benchmarking advice is to take the minimum, on the reasoning that
contention only ever adds time. That is true, and it is why the minimum is
recorded as `fastest` — but it is not the whole picture, and §below is the case
that shows why the median is what the gate compares.

Timing tolerance is 40%. That is deliberately wide. A benchmark that fails on a
noisy machine trains people to ignore the benchmark, and the query-count gate
catches the regressions worth catching exactly.

---

## Four ways this benchmark was wrong before it was right

Kept here because each one produced a plausible-looking result rather than an
obvious failure, and because all four are the kind of mistake a future
maintainer will otherwise make again.

**It measured the rate limiter instead of the login.** `POST /auth/token-login`
allows five attempts per fifteen minutes, keyed on the client address together
with the submitted address. The benchmark did six logins from `127.0.0.1`, so the
sixth was refused — and a refusal is fast, because it never reaches the password
comparison. The scenario reported 528, 495, 504 and 504ms, then 20ms. The 20ms
was a 429. Four of the six numbers were entirely reasonable, which is what made
it survive. Each sample now uses a distinct source address.

**It measured a refusal instead of an authorization.** `/v1/authz/check` asks
"may this caller do this?" and answers `false` for anything the caller's role
does not grant. The scenario asked for `documents:read`, which is not in the
permission catalogue, so the endpoint correctly answered `false` — and the
benchmark recorded the cost of a refusal and called it the cost of an
authorization check. It now asks for `organization:read`, which an owner holds,
and asserts `allowed === true` rather than only a 200. The same trap applies to
every authorization benchmark: a denied answer is a valid answer, and it is a
different code path.

**It reported the fastest sample as the cost.** That 20ms outlier is exactly what
a minimum-of-N estimator latches onto. The rule "use the minimum" assumes the
spread is contention; a 25× spread is not contention, it is state, and a
state-dependent fast path is the one thing a minimum cannot distinguish from
genuine speed. The median is compared; the minimum is recorded beside it so the
spread stays visible — `spread 1.1x` in the output is a healthy run, and
`spread 12.0x` is a reason to look.

**The first version asserted nothing about the failure it had already detected.**
The login scenario asserted a 200 and the run *did* fail — the assertion worked.
The problem was upstream: `2>/dev/null` hid the stack trace, so a
completed-looking benchmark was actually a crashed one. Suppressing stderr in a
benchmark wrapper is a small thing that costs an afternoon.

There is a fifth, smaller one in the same family: the fixture's cleanup used
`ANY(${array}::uuid[])`, which Postgres reads as a record rather than an array.
It failed *after* the numbers were recorded, which is the worst possible moment
to discover that the thing which worked is not the thing you thought.

---

## Re-recording the baseline

Only when a change was **intended** to move a number, and only on a quiet
machine:

```bash
npm run bench:hot -- --record
git add docs/performance/hot-paths.baseline.json
```

Run it twice and check the numbers agree before committing. If they disagree by
more than a few percent, the machine was busy and the recording is not worth
having.

In CI:

```bash
gh workflow run benchmark --ref <branch> -f record=true
```

The recording is a normal pull request, so a baseline change is reviewed like any
other change. A baseline that can be changed silently is not a baseline.
