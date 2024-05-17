import * as vscode from 'vscode';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { globalContext } from './extension';
import { tickMirrordForTeamsCounter } from './mirrordForTeams';
import { NotificationBuilder } from './notification';
import { MirrordStatus } from './status';
import { EnvVars, VerifiedConfig } from './config';
import { PathLike } from 'fs';

/**
* Key to access the feedback counter (see `tickFeedbackCounter`) from the global user config.
*/
const FEEDBACK_COUNTER = 'mirrord-feedback-counter';

/**
* Amount of times we run mirrord before prompting for user feedback.
*/
const FEEDBACK_COUNTER_REVIEW_AFTER = 100;

/**
* Key to access the feedback counter (see `tickDiscordCounter`) from the global user config.
*/
const DISCORD_COUNTER = 'mirrord-discord-counter';

/**
* Amount of times we run mirrord before inviting the user to join the Discord server.
*/
const DISCORD_COUNTER_PROMPT_AFTER = 10;

const TARGET_TYPE_DISPLAY: Record<string, string> = {
  pod: 'Pod',
  deployment: 'Deployment',
  rollout: 'Rollout',
};

// Option in the target selector that represents no target.
const TARGETLESS_TARGET: TargetQuickPick = {
  label: "No Target (\"targetless\")",
  type: 'targetless'
};

/**
* Level of the notification, different levels map to different notification boxes.
*/
type NotificationLevel = "Info" | "Warning";

/**
* Represents an [`IdeAction`] that is a link button in the pop-up box.
*/
type Link = { kind: "Link", label: string, link: string };

/**
* The actions of an [`IdeMessage`].
*
* TODO(alex): Add more possibilities as variants: `Link | Button | Close`.
*/
type IdeAction = Link;

/**
* Special mirrord -> IDE message, containing the message text, how to display it and more.
*/
interface IdeMessage {
  /**
  * Identifies this message, used to map a message with a `configEntry`.
  *
  * Not shown to the user.
  */
  id: string,

  /**
  * Level we should display this message as. 
  */
  level: NotificationLevel,

  /**
  * The main content of the message, that fills the pop-up box. 
  */
  text: string,

  /**
  * Buttons/actions that this message might contain. 
  */
  actions: Set<IdeAction>
}

/**
* Handles the mirrord -> IDE messages that come in json format.
*
* These messages contain more information than just text, see [`IdeMessage`].
*/
function handleIdeMessage(message: IdeMessage) {
  let notificationBuilder = new NotificationBuilder().withMessage(message.text);

  // Prepares each action.
  message.actions.forEach((action) => {
    switch (action.kind) {
      case "Link": {
        notificationBuilder.withGenericAction(action.label, async () => {
          vscode.env.openExternal(vscode.Uri.parse(action.link));
        });
        break;
      }
    }
  });

  switch (message.level) {
    case "Info": {
      notificationBuilder.info();
      break;
    }
    case "Warning": {
      notificationBuilder.warning();
      break;
    }
  }
}

type TargetQuickPick = vscode.QuickPickItem & (
  { type: 'targetless' } |
  { type: 'target' | 'page', value: string }
);

export class Targets {
  private activePage: string;

  private readonly inner: Record<string, TargetQuickPick[] | undefined>;
  readonly length: number;

  constructor(targets: string[], lastTarget?: string) {
    this.length = targets.length;

    this.inner = targets.reduce((acc, value) => {
      const targetType = value.split('/')[0];
      const target: TargetQuickPick = {
        label: value,
        type: 'target',
        value
      };

      if (Array.isArray(acc[targetType])) {
        acc[targetType]!.push(target);
      } else {
        acc[targetType] = [target];
      }

      return acc;
    }, {} as Targets['inner']);


    const types = Object.keys(this.inner);
    const lastPage = lastTarget?.split("/")?.[0] ?? '';

    if (types.includes(lastPage)) {
      this.activePage = lastPage;
    } else {
      this.activePage = types[0] ?? '';
    }
  }

  private quickPickSelects(): TargetQuickPick[] {
    return Object.keys(this.inner)
      .filter((value) => value !== this.activePage)
      .map((value) => ({
        label: `Show ${TARGET_TYPE_DISPLAY[value] ?? value}s`,
        type: 'page',
        value
      }));
  }


  quickPickItems(): TargetQuickPick[] {
    return [
      ...(this.inner[this.activePage] ?? []),
      TARGETLESS_TARGET,
      ...this.quickPickSelects()
    ];
  }

  switchPage(nextPage: TargetQuickPick) {
    if (nextPage.type === 'page') {
      this.activePage = nextPage.value;
    }
  }
}

/// Key used to store the last selected target in the persistent state.
export const LAST_TARGET_KEY = "mirrord-last-target";

// Display error message with help
export function mirrordFailure(error: string) {
  new NotificationBuilder()
    .withMessage(`${error}. Please check the logs/errors.`)
    .withGenericAction("Get help on Discord", async () => {
      vscode.env.openExternal(vscode.Uri.parse('https://discord.gg/metalbear'));
    })
    .withGenericAction("Open an issue on GitHub", async () => {
      vscode.env.openExternal(vscode.Uri.parse('https://github.com/metalbear-co/mirrord/issues/new/choose'));
    })
    .withGenericAction("Send us an email", async () => {
      vscode.env.openExternal(vscode.Uri.parse('mailto:hi@metalbear.co'));
    })
    .error();
}

// Like the Rust MirrordExecution struct.
export class MirrordExecution {

  env: Map<string, string>;
  patchedPath: string | null;
  envToUnset: undefined | string[];

  constructor(env: Map<string, string>, patchedPath: string | null, envToUnset: string[]) {
    this.env = env;
    this.patchedPath = patchedPath;
    this.envToUnset = envToUnset;
  }

  static mirrordExecutionFromJson(data: string): MirrordExecution {
    const parsed = JSON.parse(data);
    return new MirrordExecution(new Map(Object.entries(parsed["environment"])), parsed["patched_path"], parsed["env_to_unset"]);
  }

}

/**
* Sets up the args that are going to be passed to the mirrord cli.
*/
const makeMirrordArgs = (target: string | null, configFilePath: PathLike | null, userExecutable: PathLike | null): readonly string[] => {
  let args = ["ext"];

  if (target) {
    console.log(`target ${target}`);
    args.push("-t", target);
  }

  if (configFilePath) {
    console.log(`configFilePath ${configFilePath.toString()}`);
    args.push("-f", configFilePath.toString());
  }

  if (userExecutable) {
    console.log(`userExecutable ${userExecutable.toString()}`);
    args.push("-e", userExecutable.toString());
  }

  return args;
};

/**
* API to interact with the mirrord CLI, runs in the "ext" mode.
*/
export class MirrordAPI {
  cliPath: string;

  constructor(cliPath: string) {
    this.cliPath = cliPath;
  }

  // Return environment for the spawned mirrord cli processes.
  private static getEnv(configEnv: EnvVars): NodeJS.ProcessEnv {
    // clone env vars and add MIRRORD_PROGRESS_MODE
    return {
      ...process.env,
      ...configEnv,
      // eslint-disable-next-line @typescript-eslint/naming-convention
      "MIRRORD_PROGRESS_MODE": "json",
      // to have "advanced" progress in IDE
      // eslint-disable-next-line @typescript-eslint/naming-convention
      "MIRRORD_PROGRESS_SUPPORT_IDE": "true"
    };
  }

  // Execute the mirrord cli with the given arguments, return stdout.
  private async exec(args: string[], configEnv: EnvVars): Promise<string> {
    const child = this.spawnCliWithArgsAndEnv(args, configEnv);

    return await new Promise<string>((resolve, reject) => {
      let stdoutData = "";
      let stderrData = "";

      child.stdout.on("data", (data) => stdoutData += data.toString());
      child.stderr.on("data", (data) => stderrData += data.toString());

      child.stdout.on('end', () => console.log(`${stdoutData}`));
      child.stderr.on('end', () => console.log(`${stderrData}`));

      child.on("error", (err) => {
        console.error(err);
        reject(`process failed: ${err.message}`);
      });

      child.on("close", (code, signal) => {
        const match = stderrData.match(/Error: (.*)/)?.[1];
        if (match) {
          const error = JSON.parse(match);
          const notification = new NotificationBuilder()
            .withMessage(`mirrord error: ${error["message"]}`);
          if (error["help"]) {
            notification.withGenericAction("Help", async () => {
              vscode.window.showInformationMessage(error["help"]);
            });
          }
          notification.error();
          return reject(error["message"]);
        }

        if (code) {
          return reject(`process exited with error code: ${code}`);
        }

        if (signal !== null) {
          return reject(`process was killed by signal: ${signal}`);
        }

        resolve(stdoutData);
      });
    });
  }

  /**
  * Spawn the mirrord cli with the given arguments.
  * Used for reading/interacting while process still runs.
  */
  private spawnCliWithArgsAndEnv(args: readonly string[], configEnv: EnvVars): ChildProcessWithoutNullStreams {
    return spawn(this.cliPath, args, { env: MirrordAPI.getEnv(configEnv) });
  }

  /**
   * Runs mirrord --version and returns the version string.
   */
  async getBinaryVersion(): Promise<string | undefined> {
    const stdout = await this.exec(["--version"], {});
    // parse mirrord x.y.z
    return stdout.split(" ")[1].trim();
  }

  /**
  * Uses `mirrord ls` to get a list of all targets.
  * Targets are sorted, with an exception of the last used target being the first on the list.
  */
  async listTargets(configPath: string | null | undefined): Promise<Targets> {
    const args = ['ls'];
    if (configPath) {
      args.push('-f', configPath);
    }

    const stdout = await this.exec(args, {});

    const targets: string[] = JSON.parse(stdout);
    targets.sort();

    let lastTarget: string | undefined = globalContext.workspaceState.get(LAST_TARGET_KEY)
      || globalContext.globalState.get(LAST_TARGET_KEY);

    if (lastTarget !== undefined) {
      const idx = targets.indexOf(lastTarget);
      if (idx !== -1) {
        targets.splice(idx, 1);
        targets.unshift(lastTarget);
      }
    }

    return new Targets(targets, lastTarget);
  }

  /**
  * Executes the `mirrord verify-config {configPath}` command, parsing its output into a
  * `VerifiedConfig`.
  */
  async verifyConfig(configPath: vscode.Uri | null, configEnv: EnvVars): Promise<VerifiedConfig | undefined> {
    if (configPath) {
      const args = ['verify-config', '--ide', `${configPath.path}`];
      const stdout = await this.exec(args, configEnv);

      const verifiedConfig: VerifiedConfig = JSON.parse(stdout);
      return verifiedConfig;
    } else {
      return undefined;
    }
  }

  /**
  * Runs the extension execute sequence, creating agent and gathering execution runtime while also
  * setting env vars, both from system, and from `launch.json` (`configEnv`).
  *
  * Has 60 seconds timeout
  */
  async binaryExecute(target: string | null, configFile: string | null, executable: string | null, configEnv: EnvVars): Promise<MirrordExecution> {
    tickMirrordForTeamsCounter();
    tickFeedbackCounter();
    tickDiscordCounter();

    /// Create a promise that resolves when the mirrord process exits
    return await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "mirrord",
      cancellable: false
    }, (progress, _) => {
      return new Promise<MirrordExecution>((resolve, reject) => {
        setTimeout(() => {
          reject("timeout");
        }, 120 * 1000);

        const args = makeMirrordArgs(target, configFile, executable);

        const child = this.spawnCliWithArgsAndEnv(args, configEnv);

        let stderrData = "";
        child.stderr.on("data", (data) => stderrData += data.toString());

        child.on("error", (err) => {
          console.error(err);
          reject(`process failed: ${err.message}`);
        });

        child.on("close", (code, signal) => {
          const match = stderrData.match(/Error: (.*)/)?.[1];
          if (match) {
            const error = JSON.parse(match);
            const notification = new NotificationBuilder()
              .withMessage(`mirrord error: ${error["message"]}`);
            if (error["help"]) {
              notification.withGenericAction("Help", async () => {
                vscode.window.showInformationMessage(error["help"]);
              });
            }
            notification.error();
            return reject(error["message"]);
          }

          if (code) {
            return reject(`process exited with error code: ${code}`);
          }

          if (signal !== null) {
            return reject(`process was killed by signal: ${signal}`);
          }
        });

        const warningHandler = new MirrordWarningHandler();

        let buffer = "";
        child.stdout.on("data", (data) => {
          console.log(`mirrord: ${data}`);
          buffer += data;
          // fml - AH
          let messages = buffer.split("\n");
          for (const rawMessage of messages.slice(0, -1)) {
            if (!rawMessage) {
              break;
            }
            // remove from buffer + \n;
            buffer = buffer.slice(rawMessage.length + 1);

            let message;
            try {
              message = JSON.parse(rawMessage);
            } catch (e) {
              console.error("Failed to parse message from mirrord: " + data);
              return;
            }

            // First make sure it's not last message
            if ((message["name"] === "mirrord preparing to launch") && (message["type"]) === "FinishedTask") {
              if (message["success"]) {
                progress.report({ message: "mirrord started successfully, launching target." });
                return resolve(MirrordExecution.mirrordExecutionFromJson(message["message"]));
              }
            }

            // Be very careful here, when showing messages, the notification is happy to take a json
            // object, but it won't show anything! There is no json->string conversion, it just
            // silently does nothing (no compiler warnings either).
            switch (message["type"]) {
              case "Warning": {
                warningHandler.handle(message["message"]);
                break;
              }
              case "Info": {
                new NotificationBuilder()
                  .withMessage(message["message"])
                  .info();
                break;
              }
              case "IdeMessage": {
                // Internal messages sent by mirrord.
                handleIdeMessage(message["message"]);
                break;
              }
              default: {
                // If it is not last message, it is progress
                let formattedMessage = message["name"];
                if (message["message"]) {
                  formattedMessage += ": " + message["message"];
                }
                progress.report({ message: formattedMessage });
                break;
              }
            }
          }
        });
      });
    });
  }
}

class MirrordWarningHandler {
  private filters: [(message: string) => boolean, string][];

  constructor() {
    this.filters = [
      [
        (message: string) => message.includes("Agent version") && message.includes("does not match the local mirrord version"),
        "promptAgentVersionMismatch",
      ]
    ];
  }

  handle(warningMessage: string) {
    const builder = new NotificationBuilder()
      .withMessage(warningMessage);

    const filter = this.filters.find(filter => filter[0](warningMessage));
    if (filter !== undefined) {
      builder.withDisableAction(filter[1]);
    }

    builder.warning();
  }
}

/**
* Updates the global feedback counter.
* After each `FEEDBACK_COUNTER_REVIEW_AFTER` mirrord runs, displays a message asking the user to leave a review in the marketplace.
*/
function tickFeedbackCounter() {
  const previousRuns = parseInt(globalContext.globalState.get(FEEDBACK_COUNTER) ?? '0');
  const currentRuns = previousRuns + 1;

  globalContext.globalState.update(FEEDBACK_COUNTER, currentRuns);

  if ((currentRuns % FEEDBACK_COUNTER_REVIEW_AFTER) === 0) {
    new NotificationBuilder()
      .withMessage(`Enjoying mirrord? Don't forget to leave a review! Also consider giving us some feedback, we'd highly appreciate it!`)
      .withGenericAction("Review", async () => {
        vscode.env.openExternal(
          vscode.Uri.parse('https://marketplace.visualstudio.com/items?itemName=MetalBear.mirrord&ssr=false#review-details')
        );
      })
      .withGenericAction("Feedback", async () => {
        vscode.commands.executeCommand(MirrordStatus.joinDiscordCommandId);
      })
      .withDisableAction('promptReview')
      .info();
  }
}

/**
* Updates the global Discord counter.
* After each `DISCORD_COUNTER_PROMPT_AFTER` mirrord runs, displays a message asking the user to join the discord.
*/
function tickDiscordCounter() {
  const previousRuns = parseInt(globalContext.globalState.get(DISCORD_COUNTER) ?? '0');
  const currentRuns = previousRuns + 1;

  globalContext.globalState.update(DISCORD_COUNTER, currentRuns);

  if ((currentRuns % DISCORD_COUNTER_PROMPT_AFTER) === 0) {
    new NotificationBuilder()
      .withMessage(`Need any help with mirrord? Come chat with our team on Discord!`)
      .withGenericAction("Join us!", async () => {
        vscode.commands.executeCommand(MirrordStatus.joinDiscordCommandId);
      })
      .withDisableAction('promptDiscord')
      .info();
  }
}