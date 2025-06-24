# mirrord for Visual Studio Code

[![Community Slack](https://img.shields.io/badge/Join-e5f7f7?logo=slack&label=Community%20Slack)](https://metalbear.co/slack)
![License](https://img.shields.io/badge/license-MIT-green)
![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/metalbear-co/mirrord-vscode)
[![Twitter Follow](https://img.shields.io/twitter/follow/metalbearco?style=social)](https://twitter.com/metalbearco)
[![VSCode Marketplace](https://img.shields.io/badge/VSCode%20Extension%20Page-756df3)](https://marketplace.visualstudio.com/items?itemName=MetalBear.mirrord)

mirrord lets developers [run local processes in the context of their cloud environment](https://mirrord.dev). It provides the benefits of running your service on a cloud environment (e.g. staging) without going through the hassle of deploying it there, and without disrupting the environment by deploying untested code. It comes as a Visual Studio Code extension, an IntelliJ plugin and a CLI tool. You can read more about what mirrord does [in our official docs](https://mirrord.dev/docs/overview/introduction/).

<p align="center">
  <img src="https://raw.githubusercontent.com/metalbear-co/mirrord-vscode/main/media/readme/demo_gif_cropped.gif" width="90%" alt="A gif showing mirrord being used to steal traffic from a kubernetes cluster in the VSCode UI">
</p>

This repository is for the VSCode extension.
mirrord's main repository can be found [here](https://github.com/metalbear-co/mirrord).

## How to use mirrord for VSCode

* Click the mirrord status bar item to switch mirrord from `Disabled` to `Enabled`

<p align="center">
  <img src="https://raw.githubusercontent.com/metalbear-co/mirrord-vscode/main/media/readme/mirrord_enable_demo.gif" width="60%" alt="A gif showing mirrord being enabled via a click in the VSCode UI">
</p>

* Start debugging your project **(shortcut: F5)**

* Choose a target to impersonate

<p align="center">
  <img src="https://raw.githubusercontent.com/metalbear-co/mirrord-vscode/main/media/readme/target_selection_popup.png" width="60%" alt="A screenshot of mirrord's target selection pop up in the VSCode UI">
</p>

* The debugged process will start with mirrord, and receive the context of the impersonated pod. It will receive its environment variables and incoming traffic, will read and write files to it, and send outgoing traffic through it.

> Unless explicitly set [in the config](https://mirrord.dev/docs/reference/configuration/#root-kubeconfig), mirrord uses your machine's default kubeconfig for access to the Kubernetes API. Alternatively, use the [port mapping configuration](https://mirrord.dev/docs/reference/configuration/#feature-network-incoming-port_mapping).

> For incoming traffic, make sure your local process is listening on the same port as the remote pod.

## Configuring mirrord for VSCode

mirrord allows for rich configuration of the environment it provides. The schema for it is documented [here](https://mirrord.dev/docs/reference/configuration/). The extension supports autocomplete for `json` files, but you can also use `toml` or `yaml` format.

_Quick start: the easiest way to start configuring mirrord is to choose_ "Settings" _from the status bar menu, which will open a new `mirrord.json`._

<p align="center">
  <img src="https://raw.githubusercontent.com/metalbear-co/mirrord-vscode/main/media/readme/settings_opt.png" width="20%" alt="A screenshot of mirrord's status bar menu in the VSCode UI, with 'Settings' highlighted">
</p>

## Helpful Links

* [Official documentation for this extension](https://mirrord.dev/docs/using-mirrord/vscode-extension/)
* [Official language-specific guides for debugging](https://metalbear.co/guides/)

## Contributions, feature requests, issues and support

* Feel free to join to our [Slack](https://metalbear.co/slack) if you need help using mirrord, or if you encounter an issue while using the extension.
* Check our open issues for [the VSCode extension](https://github.com/metalbear-co/mirrord-vscode/issues) and [mirrord's core code](https://github.com/metalbear-co/mirrord/issues), and 👍 react to any that you would like to see addressed.
* Before submitting a pull request for new features, please take a look at [mirrord's contributing guide](https://github.com/metalbear-co/mirrord/blob/main/CONTRIBUTING.md).