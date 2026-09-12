# Merge policy

Merge only the exact commit that passed required checks and review.

A candidate is eligible when:

- the quality gate passed on the candidate commit;
- required owner approvals are current;
- no active request for changes or blocking finding remains;
- the branch is current with the protected base under the repository's chosen policy;
- migrations and release notes are present when required.

Prefer a merge queue when several pull requests can interact. The queued candidate must run checks again against its actual base. If the candidate changes, its approval or check evidence must be recomputed.

Use squash merge by default for focused product changes and preserve a clear English commit message. Do not bypass protections for deadlines. Emergency paths require a named owner, reason, audit trail, validation, and follow-up review.

Remote rulesets, CODEOWNERS, status checks, and merge queues are operational only after they are configured and tested on the hosting platform.
