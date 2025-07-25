import * as vscode from 'vscode';
import { ChildProcessWithoutNullStreams, spawn, exec } from 'child_process';
import { globalContext } from './extension';
import { tickMirrordForTeamsCounter } from './mirrordForTeams';
import { NotificationBuilder } from './notification';
import { MirrordStatus } from './status';
import { EnvVars, VerifiedConfig } from './config';
import { PathLike } from 'fs';
import { UserSelection } from './targetQuickPick';

/**
* Key to access the feedback counter (see `tickFeedbackCounter`) from the global user config.
*/
const FEEDBACK_COUNTER = 'mirrord-feedback-counter';

/**
* Amount of times we run mirrord before prompting for user feedback.
*/
const FEEDBACK_COUNTER_REVIEW_AFTER = 100;

/**
* Key to access the feedback counter (see `tickSlackCounter`) from the global user config.
*/
const SLACK_COUNTER = 'mirrord-slack-counter';

/**
* Amount of times we run mirrord before inviting the user to join the Slack server.
*/
const SLACK_COUNTER_PROMPT_AFTER = 10;

/**
* Key to access the feedback counter (see `tickNewsletterCounter`) from the global user config.
*/
export const NEWSLETTER_COUNTER = 'mirrord-newsletter-counter';

/**
* Amount of times we run mirrord before inviting the user to sign up to the newsletter.
*/
const NEWSLETTER_COUNTER_PROMPT_AFTER_FIRST = 5;
const NEWSLETTER_COUNTER_PROMPT_AFTER_SECOND = 20;
const NEWSLETTER_COUNTER_PROMPT_AFTER_THIRD = 100;

/**
* Environment variable name for listing targets with a specific type via the CLI 'ls' command.
*/
const MIRRORD_LS_TARGET_TYPES_ENV = "MIRRORD_LS_TARGET_TYPES";

/**
* Level of the notification, different levels map to different notification boxes.
*/
type NotificationLevel = "Info" | "Warning";

/**
* Represents an [`IdeAction`] that is a link button in the pop-up box.
*/
interface Link {
  kind: "Link";
  label: string;
  link: string;
}

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
 * Replaces the "plugin" platform query parameter in the given link with "vscode"
 */
function changeQueryParam(link: string): string {
  return link.replace("utm_medium=cli", "utm_medium=vscode").replace("utm_medium=plugin", "utm_medium=vscode");
}

/**
* Handles the mirrord -> IDE messages that come in json format.
*
* These messages contain more information than just text, see [`IdeMessage`].
*/
function handleIdeMessage(message: IdeMessage) {
  const notificationBuilder = new NotificationBuilder().withMessage(message.text);

  // Prepares each action.
  message.actions.forEach((action) => {
    switch (action.kind) {
      case "Link": {
        notificationBuilder.withGenericAction(action.label, async () => {
          vscode.env.openExternal(vscode.Uri.parse(changeQueryParam(action.link)));
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

/**
 * A mirrord target found in the cluster.
 */
export interface FoundTarget {
  /**
   * The path of this target, as in the mirrord config.
   */
  path: string;
  /**
   * Whether this target is available.
   */
  available: boolean;
};

/**
 * The new format of `mirrord ls`, including target availability and namespaces info.
 */
export interface MirrordLsOutput {
  /**
   * The targets found in the current namespace.
   */
  targets: FoundTarget[];
  /**
   * The namespace where the lookup was done.
   * 
   * If the CLI does not support listing namespaces, this is undefined.
   */
  current_namespace?: string;
  /**
   * All namespaces visible to the user.
   * 
   * If the CLI does not support listing namespaces, this is undefined.
   */
  namespaces?: string[];
};

/**
 * Checks whether the JSON value is in the @see MirrordLsOutput format.
 * 
 * @param output JSON parsed from `mirrord ls` stdout
 */
function isRichMirrordLsOutput(output: MirrordLsOutput | string[]): output is MirrordLsOutput {
  return "targets" in output && "current_namespace" in output && "namespaces" in output;
}

// Display error message with help
export function mirrordFailure(error: string) {
  new NotificationBuilder()
    .withMessage(`${error}. Please check the logs/errors.`)
    .withGenericAction("Get help on Slack", async () => {
      vscode.env.openExternal(vscode.Uri.parse('https://metalbear.co/slack'));
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
  usesOperator?: boolean;

  constructor(env: Map<string, string>, patchedPath: string | null, envToUnset: string[], usesOperator: boolean | undefined) {
    this.env = env;
    this.patchedPath = patchedPath;
    this.envToUnset = envToUnset;
    this.usesOperator = usesOperator;
  }

  static mirrordExecutionFromJson(data: string): MirrordExecution {
    const parsed = JSON.parse(data);
    return new MirrordExecution(
      new Map(Object.entries(parsed["environment"])),
      parsed["patched_path"],
      parsed["env_to_unset"],
      parsed["uses_operator"],
    );
  }

}

/**
* Sets up the args that are going to be passed to the mirrord cli.
*/
const makeMirrordArgs = (target: string | undefined, configFilePath: PathLike | null, userExecutable: PathLike | null): readonly string[] => {
  const args = ["ext"];

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
      "MIRRORD_PROGRESS_MODE": "json",
      // to have "advanced" progress in IDE
      "MIRRORD_PROGRESS_SUPPORT_IDE": "true",
      // to have namespaces in the `mirrord ls` output
      "MIRRORD_LS_RICH_OUTPUT": "true"
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
    return stdout.split(" ")[1]?.trim();
  }

  /**
   * Runs git -C @dir branch --show-current and returns a promise of the branch name.
   * @dir : the user's workplace folder
   */
  async getBranchName(dir: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      exec("git -C " + dir + " branch --show-current", (error, stdout, _stderr) => {
        if (error) {
          reject(error);
        } else {
          resolve(stdout);
        }
      });
    });
  }

  /**
  * Uses `mirrord ls` to get lists of targets and namespaces.
  * 
  * Note that old CLI versions return only targets.
  * 
  * @see MirrordLsOutput
  */
  async listTargets(configPath: string | null | undefined, configEnv: EnvVars, targetTypes: string[], namespace?: string,): Promise<MirrordLsOutput> {
    const args = ['ls'];
    if (configPath) {
      args.push('-f', configPath);
    }

    if (namespace !== undefined) {
      args.push('-n', namespace);
    }

    configEnv[MIRRORD_LS_TARGET_TYPES_ENV] = JSON.stringify(targetTypes);

    const stdout = await this.exec(args, configEnv);

    const targets = JSON.parse(stdout) as MirrordLsOutput | string[];
    let mirrordLsOutput: MirrordLsOutput;
    if (isRichMirrordLsOutput(targets)) {
      mirrordLsOutput = targets;
    } else {
      mirrordLsOutput = {
        targets: targets.map(path => {
          return { path, available: true };
        }),
      };
    }

    return mirrordLsOutput;
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
  * 
  * @param quickPickSelection target selected by the user from the quick pick widget.
  *                             `undefined` if we found the target in the config,
  *                             and the widget was not shown.
  */
  async binaryExecute(quickPickSelection: UserSelection | undefined, configFile: string | null, executable: string | null, configEnv: EnvVars, workspacePath: string | undefined): Promise<MirrordExecution> {
    tickMirrordForTeamsCounter();
    tickFeedbackCounter();
    tickSlackCounter();
    tickNewsletterCounter();

    let branchName = "";
    if (workspacePath !== undefined) {
      branchName = await this.getBranchName(workspacePath).catch(error => console.log("mirrord failed to retrieve git branch name", error)).then((res) => res ? res.trim() : "");
    }

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

        const args = makeMirrordArgs(quickPickSelection?.path, configFile, executable);
        let env: EnvVars;
        if (quickPickSelection?.namespace) {
          env = { MIRRORD_TARGET_NAMESPACE: quickPickSelection.namespace, ...configEnv };
        } else {
          env = configEnv;
        }
        if (branchName.length > 0) {
          env = { MIRRORD_BRANCH_NAME: branchName, ...env };
        }

        const child = this.spawnCliWithArgsAndEnv(args, env);

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
          const messages = buffer.split("\n");
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
              console.error("Failed to parse message from mirrord: " + data, e);
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
        vscode.commands.executeCommand(MirrordStatus.joinSlackCommandId);
      })
      .withDisableAction('promptReview')
      .info();
  }
}

/**
* Updates the global Slack counter.
* After `SLACK_COUNTER_PROMPT_AFTER` mirrord runs, displays a message asking the user to join the slack.
*/
function tickSlackCounter() {
  const previousRuns = parseInt(globalContext.globalState.get(SLACK_COUNTER) ?? '0');
  const currentRuns = previousRuns + 1;

  globalContext.globalState.update(SLACK_COUNTER, currentRuns);

  if ((currentRuns - SLACK_COUNTER_PROMPT_AFTER) === 0) {
    new NotificationBuilder()
      .withMessage(`Need any help with mirrord? Come chat with our team on Slack!`)
      .withGenericAction("Join Slack", async () => {
        vscode.commands.executeCommand(MirrordStatus.joinSlackCommandId);
      })
      .withDisableAction('promptSlack')
      .info();
  }
}

/**
* Updates the global newsletter counter.
* After `NEWSLETTER_COUNTER_PROMPT_AFTER_X` mirrord runs, displays a message asking the user to 
* sign up to the mirrord newsletter
*/
function tickNewsletterCounter() {
  const previousRuns = parseInt(globalContext.globalState.get(NEWSLETTER_COUNTER) ?? '0');
  const currentRuns = previousRuns + 1;

  globalContext.globalState.update(NEWSLETTER_COUNTER, currentRuns);

  let msg;
  switch (currentRuns) {
    case NEWSLETTER_COUNTER_PROMPT_AFTER_FIRST:
      msg = "Join thousands of devs using mirrord!\nGet the latest updates, tutorials, and insider info from our team.";
      break;
    case NEWSLETTER_COUNTER_PROMPT_AFTER_SECOND:
      msg = "Liking what mirrord can do?\nStay in the loop with updates, tips & tricks straight from the team.";
      break;
    case NEWSLETTER_COUNTER_PROMPT_AFTER_THIRD:
      msg = "Looks like you're doing some serious work with mirrord!\nWant to hear about advanced features, upcoming releases, and cool use cases?";
      break;
    default:
      break;
  }

  if (msg) {
    new NotificationBuilder()
    .withMessage(msg)
    .withGenericAction("Subscribe to the mirrord newsletter", async () => {
      vscode.commands.executeCommand(MirrordStatus.newsletterCommandId);
    })
    .withDisableAction('promptNewsletter')
    .info();
  }
}
