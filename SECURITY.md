# Security policy

Report a vulnerability privately through a GitHub security advisory. Open the repository's **Security** tab and click **Report a vulnerability**. Do not open a public issue.

Include the version or commit, the steps to reproduce, and what an attacker gains.

Gary holds API keys for your media services and acts on them for other people. These areas are the most important to report:

- Any way to reach the agent or `/api/*` without an enrolled identity or `GARY_ADMIN_TOKEN`.
- Any way for one person to read or change another person's data.
- Any request, message, or change that Gary makes while `GARY_READ_ONLY=true`.
- Any secret that appears in a reply, a log line, or the doctor output.

Only the latest release gets security fixes.
