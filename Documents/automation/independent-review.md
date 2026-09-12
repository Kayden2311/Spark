# Independent review

Use independent review for authentication, authorization, RLS, migrations, CI policy, and complex transactional changes. Small, low-risk changes need one reviewer; high-risk areas use separate correctness and security reviewers.

## Independence

- A reviewer must not have authored the implementation.
- First-pass reviewers receive the same immutable snapshot, a neutral brief, and fresh context.
- Do not share author conclusions or another reviewer's findings before both first passes finish.
- Reviewers are read-only and disclose prior involvement.
- Reports include evidence, severity, confidence, scope, and limitations. There is no finding quota.

The author fixes confirmed findings and records the new snapshot. A fresh reviewer verifies the fix. Use an adjudicator only for a material disagreement after first-pass reports are sealed. Adjudication follows source evidence or a reproducible test, never majority vote.

An unresolved P0/P1 blocks merge. A real unresolved P2 also blocks unless the responsible owner records an evidence-backed disposition. Agent review is supporting evidence; it is not human approval or proof that remote protections are enabled.
