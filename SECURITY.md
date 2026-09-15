# Security policy

Report suspected vulnerabilities privately to the maintainer at
[aorfevre@gmail.com](mailto:aorfevre@gmail.com), with the subject
`cmux-companion security report`. Do not open a public issue or pull request
containing exploit details before coordinating disclosure. This email route also
works while the repository is private; it does not depend on GitHub private
vulnerability reporting being enabled.

Include the affected commit/version, macOS and relevant tool versions, the
security boundary involved, expected/actual behavior, and a minimal reproduction
using disposable data. Describe the impact and any workaround. Never attach
pairing tokens, session cookies, provider/GitHub credentials, private terminal
transcripts, or an entire application database. Start with a sanitized description;
coordinate privately if sensitive evidence is necessary.

The repository maintainer triages reports and coordinates fixes and disclosure.
There is no guaranteed response time. Security fixes target the current `main`
source and its supported installed release; older commits and unsupported native
CLI versions do not receive separate maintenance. Please report issues in older
versions too, identifying the exact affected commit.

Companion is designed for a single trusted Mac user over loopback and private
Tailscale Serve. A paired browser is privileged. The terminal input switch prevents
accidental typing; it is not an API permission tier. Do not expose Companion through
Tailscale Funnel or directly to the public internet. See the
[security model](README.md#security-model) and [data handling](README.md#data-handling).

Use your own disposable repositories and accounts for research. Do not test other
users' installations, alter unrelated sessions, or disclose third-party data.
