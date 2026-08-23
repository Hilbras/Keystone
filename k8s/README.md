# Hilbras Keystone Kubernetes Deployment

This directory contains Kustomize manifests for deploying Keystone on Kubernetes.

## Structure

- `base/` — Common resources (namespace, deployment, service, ingress, HPA, PDB).
- `overlays/dev/` — Development overlay with single replica and in-process queue.
- `overlays/production/` — Production overlay with HA settings and BullMQ.

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

## Notes

- Replace placeholder hostnames in `ingress.yaml` and overlay patches.
- Use cert-manager or provide your own TLS secret.
- PostgreSQL and Redis should be running in the cluster or as managed services.
