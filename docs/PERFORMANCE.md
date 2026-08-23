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
