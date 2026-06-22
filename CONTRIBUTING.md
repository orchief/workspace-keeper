# Contributing

Thanks for contributing to Workspace Keeper.

## Development

```bash
npm install
npm test
node ./bin/workspace-keeper.js tui --root ~/workspaces
```

## Pull Requests

- Keep changes focused and explain the user-visible behavior.
- Add or update tests for ranking, command parsing, safety gates, or TUI input behavior.
- Run `npm test` before opening a pull request.
- Do not commit generated scan data, shell history dumps, SSH configs, credentials, or local machine paths.

## Safety

Workspace Keeper can launch local and remote commands. Changes that affect execution, SSH parsing, confirmation gates, or risk classification should be reviewed carefully and tested with harmless commands first.
