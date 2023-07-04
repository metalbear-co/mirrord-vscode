<p align="center">
  <img src="images/icon.png" width="20%">
</p>
<h1 align="center">mirrord</h1>

[![Discord](https://img.shields.io/discord/933706914808889356?color=5865F2&label=Discord&logo=discord&logoColor=white)](https://discord.gg/metalbear)
![License](https://img.shields.io/badge/license-MIT-green)
![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/metalbear-co/mirrord-vscode)
[![Twitter Follow](https://img.shields.io/twitter/follow/metalbearco?style=social)](https://twitter.com/metalbearco)

mirrord lets developers run local processes in the context of their cloud environment. It’s meant to provide the benefits of running your service on a cloud environment (e.g. staging) without actually going through the hassle of deploying it there, and without disrupting the environment by deploying untested code. It comes as a Visual Studio Code extension, an IntelliJ plugin and a CLI tool. You can read more about it [here](https://mirrord.dev/docs/overview/introduction/).

This repository is for the VSCode extension.
mirrord main repository can be found [here](https://github.com/metalbear-co/mirrord).

## How to use

* Click mirrord status bar item to switch mirrord from `Disabled` to `Enabled`
* Start debugging your project
* Choose pod to impersonate
* The debugged process will start with mirrord, and receive the context of the impersonated pod. It will receive its environment variables and incoming traffic, will read and write files to it, and send outgoing traffic through it.

<p align="center">
  <img src="https://i.imgur.com/FFiir2G.gif" width="60%">
</p>

> mirrord uses your machine's default kubeconfig for access to the Kubernetes API.

> For incoming traffic, make sure your local process is listening on the same port as the remote pod.

## Settings

mirrord allows for rich configuration of the environment it provides. The schema for is documented [here](https://mirrord.dev/docs/overview/configuration/). You can also use `toml` or `yaml` format. However, the extension supports autocomplete only for `json` files.

mirrord reads its configuration from following locations:

1. Active config can be set for the whole workspace using the `selectActiveConfig` command or the link in the dropdown menu. If active config is set, mirrord always uses it.
2. If active config is not set, mirrord searches process environment (specified in launch configuration) for `MIRRORD_CONFIG_FILE` variable. This can be an absolute path or path relative to the project root.
3. If no config is specified, mirrord uses a default project config. This config is located in `.mirrord` directory and its name ends with `mirrord.{json,toml,yaml,yml}`. If there is no default config, mirrord creates a minimalistic one at `.mirrord/mirrord.json` when needed. If there are many candidates for default configs, mirrord sorts them alphabetically and uses the first one.

You can use the `changeSettings` command or the link in the dropdown menu to quickly edit detected configs.
