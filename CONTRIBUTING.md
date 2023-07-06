# Contributing

Before submitting pull request features, please discuss them with us first by opening an issue or a discussion.
We welcome new/junior/starting developers. Feel free to join to our [Discord channel](https://discord.gg/metalbear) for help and guidance.

If you would like to start working on an issue, please comment on the issue on GitHub, so that we can assign you to that
issue.

## Building the VS Code extension

To build the VS Code extension, follow these steps:

Run:
```bash
cd mirrord-vscode
npm install
npm run compile
```

If you want to package the extension into a .vsix file (which can then be installed in VS Code), run
```bash
npm run package
```

You should see something like
```text
DONE  Packaged: /Users/you/Documents/projects/mirrord/vscode-ext/mirrord-<version>.vsix (11 files, 92.14MB)
```

Note that packaging isn't necessary for debugging the extension.

## Debugging the VS Code extension
To debug the VS Code extension, first [build the extension](#building-the-vs-code-extension).

Now you can just open the extension's code in VS Code and run or debug it, using the "Launch Extension" run configuration. Another VS Code window will start. You can set breakpoints
in the extension's code in the first window, and use the extension in the second window to reach the breakpoints.
When in debug mode, the extension will automatically use the debug mirrord binary.

If you want to see the layer's logs, [use the console](#mirrord-console) by setting
```json
            "env": {
                "RUST_LOG": "warn,mirrord=trace",
                "MIRRORD_CONSOLE_ADDR": "127.0.0.1:11233"
            }

```
in the launch configuration of the second window.