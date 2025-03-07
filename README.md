# mirrord for VSCode

[![Discord](https://img.shields.io/discord/933706914808889356?color=5865F2&label=Discord&logo=discord&logoColor=white)](https://discord.gg/metalbear)
![License](https://img.shields.io/badge/license-MIT-green)
![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/metalbear-co/mirrord-vscode)
[![Twitter Follow](https://img.shields.io/twitter/follow/metalbearco?style=social)](https://twitter.com/metalbearco)

mirrord lets developers [run local processes in the context of their cloud environment](https://mirrord.dev). It’s meant to provide the benefits of running your service on a cloud environment (e.g. staging) without actually going through the hassle of deploying it there, and without disrupting the environment by deploying untested code. It comes as a Visual Studio Code extension, an IntelliJ plugin and a CLI tool. You can read more about it [here](https://mirrord.dev/docs/overview/introduction/).

This repository is for the VSCode extension.
mirrord's main repository can be found [here](https://github.com/metalbear-co/mirrord).

<!-- TODO: change GIF to wide -->
<!-- <p align="center">
  <img src="https://i.imgur.com/FFiir2G.gif" width="60%">
</p> -->

## How to use

* Click the mirrord status bar item to switch mirrord from `Disabled` to `Enabled`

<p align="center">
<!-- TODO: use absolute link when merging: https://raw.githubusercontent.com/metalbear-co/mirrord-vscode/images/mirrord_enable_demo.gif -->
  <img src="/images/mirrord_enable_demo.gif" width="60%" alt="A gif showing mirrord being enabled via a click in the VSCode UI">
</p>

* Start debugging your project **(shortcut: F5)**

* Choose a target to impersonate

<p align="center">
  <img src="/images/target_selection_popup.png" width="60%" alt="A screenshot of mirrord's target selection pop up in the VSCode UI">
</p>

* The debugged process will start with mirrord, and receive the context of the impersonated pod. It will receive its environment variables and incoming traffic, will read and write files to it, and send outgoing traffic through it.

> mirrord uses your machine's default kubeconfig for access to the Kubernetes API.

> For incoming traffic, make sure your local process is listening on the same port as the remote pod.

> By default, mirrord is disabled when you open a VSCode window. To change this behaviour, set the `enabledByDefault` setting to `true`.

## Settings

mirrord allows for rich configuration of the environment it provides. The schema for it is documented [here](https://mirrord.dev/docs/reference/configuration/). The extension supports autocomplete for `json` files, but you can also use `toml` or `yaml` format.

mirrord reads its configuration from the following locations:

1. An active config can be set for the whole workspace using the `selectActiveConfig` command or the link in the status bar menu. If an active config is set, mirrord always uses it.
2. If an active config is not set, mirrord searches the process environment (specified in the launch configuration) for the `MIRRORD_CONFIG_FILE` variable. This path can use the `${workspaceFolder}` variable.
3. If no config is specified, mirrord looks for a default project config file in the `.mirrord` directory with a name ending with `mirrord.{json,toml,yaml,yml}`. If there is no default config file, mirrord uses default configuration values for everything. If there are multiple candidates for the default config file, mirrord sorts them alphabetically and uses the first one.

You can use the `changeSettings` command or the link in the dropdown menu to quickly edit detected configs.

## Helpful Links
* [Official documentation for this extension](https://mirrord.dev/docs/using-mirrord/vscode-extension/)
* [Official language-specific guides for debugging](https://metalbear.co/guides/)