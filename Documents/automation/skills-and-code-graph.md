# Skills and code graphs

Installed project skills are recorded in `installed-skills.json`. Use only the skill relevant to the current task:

- PostgreSQL guidance for schemas, migrations, RLS, queries, and database performance.
- Node.js patterns for Fastify backend work.
- API design guidance for REST contracts.
- Systematic debugging for failures and unexpected behavior.
- GitHub Actions templates for CI work.
- Trailmark and diagramming tools for source-derived impact or dependency questions.

Skills are development aids, not runtime dependencies. Third-party examples must not replace the selected Spark architecture.

Dependency Cruiser is the normal lightweight import and cycle gate. Use Trailmark only when a concrete call-flow, data-flow, or blast-radius question justifies it. Record the tool version, source snapshot, command, scope, parse failures, and unresolved dynamic edges. A graph cannot prove authorization, exploitability, ACID behavior, or test success.

Do not add another graph database, indexer, or MCP service without a measured need.
