# Hilbras Keystone Kubernetes Deployment

This directory contains Kustomize manifests for deploying Keystone on Kubernetes.

## Structure

- `base/` — Common resources (namespace, deployment, service, HPA, PDB).
- `overlays/dev/` — Development overlay with single replica and in-process queue.
- `overlays/production/` — Production overlay with HA settings and BullMQ.
- `overlays/ingress/` — Opt-in. Adds an Ingress to the production overlay.

## Quick start

1. Copy and edit the example secret:

   ```bash
   cp base/secret.example.yaml base/secret.yaml
   # edit base/secret.yaml with real credentials
   ```

2. Apply the production overlay:

   ```bash
   kubectl apply -k overlays/production
   ```

3. Verify rollout:

   ```bash
   kubectl -n keystone-prod rollout status deployment/prod-keystone
   ```

## There is no Ingress in the base, and that is deliberate

`GET /metrics` is unauthenticated **by decision** — see
[docs/security/monitoring.md](../docs/security/monitoring.md) for the reasoning.
The base Service is a `ClusterIP`, so `/metrics` is reachable only from inside the
cluster, which is the right default for a scrape endpoint: Prometheus usually runs
in the cluster, and nothing should have to authenticate to read a counter.

An Ingress at `path: /` with `pathType: Prefix` matches `/metrics` like any other
path. So an Ingress in the base would publish the whole route table and the
traffic shape to whatever host it names — and until 3.5.12 that is exactly what
this repository shipped, while a document said the opposite.

`scripts/verify-k8s-manifests.mjs` fails if an Ingress is added to the base
without an exclusion for `/metrics`, so this cannot regress quietly.

## If you want a public hostname

```bash
kubectl apply -k overlays/ingress     # instead of overlays/production
```

`overlays/ingress` includes `overlays/production` and adds an Ingress carrying the
host, the TLS secret and the `/metrics` exclusion. Read the comment at the top of
`overlays/ingress/ingress.yaml` before applying it: the exclusion uses an
annotation that **ingress-nginx ignores unless the cluster sets
`allow-snippet-annotations: "true"`**, and that flag is off by default because
turning it on re-opens CVE-2021-25742. If your cluster has snippets disabled,
exclude the path at the controller or network level instead, and verify the result:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://your-host/metrics   # want 404
```

## Notes

- Replace placeholder hostnames in `overlays/ingress/ingress.yaml` and its
  kustomization's namespace/prefix.
- Use cert-manager or provide your own TLS secret.
- PostgreSQL and Redis should be running in the cluster or as managed services.
