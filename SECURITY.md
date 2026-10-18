# Security policy

## Reporting a vulnerability

Please report privately via GitHub's "Report a vulnerability" (Security tab) rather than a public issue.
Expect an acknowledgement within a few days.

## Scope notes

This project lets an LLM edit files and run allowlisted commands. Known, accepted risks: the `run_command`
allowlist includes interpreters (`python`, `node`, `npx`), and file contents the agent reads can contain
prompt injection. Run it on disposable workspaces, ideally in a container. See the README's Security section.

## Secrets

Never commit API keys. If one leaks, revoke it at the provider first, then remove it from history.
