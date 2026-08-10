# Security policy

## Supported versions

Security fixes are applied to the latest published version of docsdown. Upgrade to the newest release before reporting
an issue that may already have been corrected.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use
[GitHub private vulnerability reporting](https://github.com/sandrinodm/docsdown/security/advisories/new) to share the
details with the maintainer.

Include the affected version, operating system, reproduction steps, expected impact, and any proof-of-concept input.
Please avoid accessing data that does not belong to you and do not include secrets or personal data in the report.

## Security boundaries

Reports are especially useful for filesystem traversal, symlink handling, credential disclosure, unsafe cleanup,
untrusted Markdown or HTML processing, and requests that send GitHub credentials to non-GitHub origins.

docsdown treats the user-selected output path as its filesystem trust anchor. Remote documentation, repository paths,
links, and manifest content must remain within that canonical root.
