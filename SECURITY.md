# Security reporting and publication checks

Treat pairing tokens, cmux socket passwords, provider credentials, push keys,
terminal transcripts and local SQLite data as private. Never attach them to a
public issue, pull request, screenshot or diagnostic log.

Use GitHub's **Report a vulnerability** option when it is available. Otherwise,
open an issue requesting a private contact channel without including vulnerability
details or sensitive data. Include a minimal reproduction using disposable state,
the affected commit and platform once a private channel is established.

## Before making a repository or release public

1. Review tracked files and every branch/tag intended for publication. A fresh
   checkout should contain no private runtime data; retain the `.env*`, output and
   credential exclusions in `.gitignore`.
2. Scan both the current tracked snapshot and complete reachable Git history with
   a current secret scanner. A clean current tree does not erase historical data.
3. Review findings locally with redaction enabled. If a credential is confirmed,
   revoke/rotate it at its issuer before planning any history rewrite. Do not test
   suspected credentials against external services.
4. Review commit author identities, historical paths/project names, images and
   release assets separately; a secret scanner is not a privacy audit.
5. Check `npm audit`, root and imported copyright notices, and
   [third-party license obligations](THIRD_PARTY.md).

The [2026-09-13 audit](docs/open-source-readiness.md) records its exact scope,
findings and limits. It is evidence for that tree, not a guarantee for later
commits, external PR attachments, releases or unreachable Git objects.
