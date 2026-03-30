# PR Architecture Checklist

Use this checklist for any pull request that touches:

- hooks
- prompts
- runtime subagent APIs
- event logging
- trajectory writes
- state files
- cleanup flows
- routing
- promotion / reducer flows

## Required Questions

- [ ] What business concept is being written?
- [ ] Who is the single authoritative writer for that concept?
- [ ] Is this PR adding a second path for an existing concept?
- [ ] What is the authoritative truth source?
- [ ] Does this PR depend on a string protocol? If yes, is that protocol now explicit?
- [ ] What are the valid terminal states for the workflow being changed?
- [ ] What cleanup must happen?
- [ ] How is cleanup guaranteed?
- [ ] What old path is being retired, shadowed, or explicitly left active?
- [ ] Does this PR introduce any new direct state write that bypasses the intended owner?
- [ ] Is there a boundary test for the workflow owner?
- [ ] Is there an invariant test for the new forbidden condition?

## Red Flags

If any of the following is true, the PR needs deeper review:

- [ ] The same `source` or domain concept is now written from multiple files
- [ ] Session key parsing logic exists in more than one place
- [ ] Prompt text is being used as a hidden control protocol
- [ ] Cleanup is best-effort but not observable
- [ ] Runtime behavior changed but only unit tests were added
- [ ] New path added, old path not retired
- [ ] State is written to multiple stores without declared authority

## Outcome Labels

At review time, classify the PR as one of:

- `safe-local-change`
- `workflow-change`
- `ownership-change`
- `protocol-change`
- `truth-source-change`

Anything beyond `safe-local-change` should also update the documents in `docs/architecture-governance/`.
