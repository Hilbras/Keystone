# Phase 1 v1.7.0 Task List

- [x] Task 1: Add failing authorization regression tests
- [x] Task 2: Quarantine organization-scoped global user mutations
- [x] Task 3: Add explicit platform-role use case and endpoint
- [x] Task 4: Remove role from generic identity/profile contracts
- [x] Task 5: Enforce organization membership role invariants
- [x] Task 6: Close unsafe workflow authorization paths
- [x] Task 7: Centralize authorization context and guards
- [x] Task 8: Enforce organization-scoped resource ownership
- [x] Task 9: Add authorization and role-transition audit contracts
- [x] Task 10: Update API/UI contracts and documentation
- [x] Task 11: Synchronize release metadata and run quality gates
- [ ] Task 12: External release checkpoint (approval required)
- [x] Task 13: Enforce a closed workflow step contract
- [x] Task 14: Remove actorless global mutation APIs
- [x] Task 15: Enforce application-layer permissions and scoped SDK authorization
- [x] Task 6A: Make owner invariants atomic
- [x] Task 16: Enforce runtime role vocabularies and namespace boundaries
- [x] Task 17: Close secret and configuration response leaks
- [x] Task 18: Repair audit contracts and transition writers
- [x] Task 19: Complete frontend and release contract follow-up

## Checkpoints

- [x] After Tasks 1–4: platform-role escalation blocked at every boundary
- [x] After Tasks 5–8: membership, workflow, and resource-scope invariants enforced
- [x] After Tasks 9–11: audit, docs, versions, and local release gates synchronized (dependency/lint/npm-secret blockers remain explicit)

## Release blockers to resolve before tagging

- [ ] Existing High `npm audit` findings are fixed or covered by an approved, documented exception
- [ ] A real lint gate exists or its absence is explicitly accepted
- [x] CI runs the security regression suite through the dedicated `npm run test:security` step
- [x] npm publication procedure is configured and verified in the release workflow (secret still required)
- [x] `package-lock.json` version is synchronized with `1.7.0`
