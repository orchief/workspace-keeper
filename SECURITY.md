# Security Policy

## Supported Versions

Security fixes are handled on the default branch until the project starts publishing versioned releases.

## Reporting A Vulnerability

Please do not open a public issue for a vulnerability that could expose secrets or enable unintended command execution.

Report privately through GitHub Security Advisories for this repository when available, or contact the maintainers through the GitHub profile associated with the repository.

## Sensitive Data

Workspace Keeper reads local shell history, project metadata, and SSH configuration to rank commands. Generated files under `data/` may contain local paths, project names, command history, SSH aliases, and remote hostnames. These files are intentionally ignored by Git and must not be published.
