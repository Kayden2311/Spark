# Automation pipeline

The pipeline protects a small production-ready MVP without turning the repository into an operations platform.

## Local and CI gate

From `Spark_Core`, the required quality gate installs from the frozen lockfile and runs the real package scripts for linting, type checks, focused tests, production builds, and dependency auditing. Add specialized gates only when the related behavior exists.

A missing command, unavailable dependency, zero-test suite where tests are required, cancellation, or timeout is a failure. Checks attach to the exact commit under review. Documentation-only changes may use focused documentation checks after a trustworthy classifier exists; until then, the full workflow is acceptable.

## Workflow stages

1. **Test:** deterministic checks in an isolated environment with no production secrets.
2. **Review:** owner review plus independent security/correctness review for risky changes.
3. **Merge:** merge only the tested commit after all blocking findings and required checks are resolved.
4. **Release:** build once from trusted main, promote the same artifact, run migrations separately, and smoke-test.

The current `.github/workflows/ci.yml` implements the repository quality gate. Remote CODEOWNERS, rulesets, review gates, release workflows, environments, and scheduled maintenance are proposals until configured and verified on GitHub.

## Security

Pull-request code is untrusted. Use read-only tokens, isolated runners, commit-SHA-pinned actions, digest-pinned service images, structured inputs, and no production credentials. Never execute pull-request code in a privileged `pull_request_target` job. Store the tested SHA, tool versions, results, and sanitized failure artifacts.

See [testing](testing.md), [code review](code-review.md), [independent review](independent-review.md), and [merging](merging.md).
