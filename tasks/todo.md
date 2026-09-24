# Phase 1 v1.7.0 Task List

- [ ] Task 1: Add failing authorization regression tests
- [ ] Task 2: Quarantine organization-scoped global user mutations
- [ ] Task 3: Add explicit platform-role use case and endpoint
- [ ] Task 4: Remove role from generic identity/profile contracts
- [ ] Task 5: Enforce organization membership role invariants
- [ ] Task 6: Close unsafe workflow authorization paths
- [ ] Task 7: Centralize authorization context and guards
- [ ] Task 8: Enforce organization-scoped resource ownership
- [ ] Task 9: Add authorization and role-transition audit contracts
- [ ] Task 10: Update API/UI contracts and documentation
- [ ] Task 11: Synchronize release metadata and run quality gates
- [ ] Task 12: External release checkpoint (approval required)

## Checkpoints

- [ ] After Tasks 1–4: platform-role escalation blocked at every boundary
- [ ] After Tasks 5–8: membership, workflow, and resource-scope invariants enforced
- [ ] After Tasks 9–11: audit, docs, versions, and local release gates synchronized

## Release blockers to resolve before tagging

- [ ] Existing High `npm audit` findings are fixed or covered by an approved, documented exception
- [ ] A real lint gate exists or its absence is explicitly accepted
- [ ] CI runs the security regression suite
- [ ] npm publication procedure is configured and verified
- [ ] `package-lock.json` version is synchronized with `1.7.0`
