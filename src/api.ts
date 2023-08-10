import * as vscode from 'vscode';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { globalContext } from './extension';
import { tickWaitlistCounter } from './waitlist';
import { NotificationBuilder } from './notification';

/**
* Key to access the feedback counter (see `tickFeedbackCounter`) from the global user config.
*/
const FEEDBACK_COUNTER = 'mirrord-feedback-counter';

/**
* Amount of times we run mirrord before prompting for user feedback.
*/
const FEEDBACK_COUNTER_REVIEW_AFTER = 100;

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

  constructor(env: Map<string, string>, patchedPath: string | null) {
    this.env = env;
    this.patchedPath = patchedPath;
  }

  static mirrordExecutionFromJson(data: string): MirrordExecution {
    const parsed = JSON.parse(data);
    return new MirrordExecution(new Map(Object.entries(parsed["environment"])), parsed["patched_path"]);
  }

}

// API to interact with the mirrord CLI, runs in the "ext" mode
export class MirrordAPI {
  cliPath: string;

  constructor(cliPath: string) {
    this.cliPath = cliPath;
  }

  // Return environment for the spawned mirrord cli processes.
  private static getEnv(): NodeJS.ProcessEnv {
    // clone env vars and add MIRRORD_PROGRESS_MODE
    return {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      "MIRRORD_PROGRESS_MODE": "json",
      ...process.env,
    };
  }

  // Execute the mirrord cli with the given arguments, return stdout.
  private async exec(args: string[]): Promise<string> {
    const child = this.spawn(args);

    return await new Promise<string>((resolve, reject) => {
      let stdoutData = "";
      let stderrData = "";

      child.stdout.on("data", (data) => stdoutData += data.toString());
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

        resolve(stdoutData);
      });
    });
  }

  // Spawn the mirrord cli with the given arguments
  // used for reading/interacting while process still runs.
  private spawn(args: string[]): ChildProcessWithoutNullStreams {
    return spawn(this.cliPath, args, { env: MirrordAPI.getEnv() });
  }

  /**
   * Runs mirrord --version and returns the version string.
   */
  async getBinaryVersion(): Promise<string | undefined> {
    const stdout = await this.exec(["--version"]);
    // parse mirrord x.y.z
    return stdout.split(" ")[1].trim();
  }

  /// Uses `mirrord ls` to get a list of all targets.
  /// Targets are sorted, with an exception of the last used target being the first on the list.
  async listTargets(configPath: string | null | undefined): Promise<Targets> {
    const args = ['ls'];
    if (configPath) {
      args.push('-f', configPath);
    }

    const stdout = await this.exec(args);

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

  // Run the extension execute sequence
  // Creating agent and gathering execution runtime (env vars to set)
  // Has 60 seconds timeout
  async binaryExecute(target: string | null, configFile: string | null, executable: string | null): Promise<MirrordExecution> {
    tickWaitlistCounter(!!target?.startsWith('deployment/'));
    tickFeedbackCounter();

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

        const args = ["ext"];
        if (target) {
          args.push("-t", target);
        }
        if (configFile) {
          args.push("-f", configFile);
        }
        if (executable) {
          args.push("-e", executable);
        }

        const child = this.spawn(args);

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

            if (message["type"] === "Warning") {
              warningHandler.handle(message["message"]);
            } else {
              // If it is not last message, it is progress
              let formattedMessage = message["name"];
              if (message["message"]) {
                formattedMessage += ": " + message["message"];
              }
              progress.report({ message: formattedMessage });
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
* Updates the global feedback counter. When it hits `FEEDBACK_COUNTER_REVIEW_AFTER` mirrord runs, 
* displays a message asking the user to like mirrord.
*/
function tickFeedbackCounter() {
  const counter = parseInt(globalContext.globalState.get(FEEDBACK_COUNTER) ?? '0');
  globalContext.globalState.update(FEEDBACK_COUNTER, counter + 1);

  if (counter >= FEEDBACK_COUNTER_REVIEW_AFTER) {
    new NotificationBuilder()
      .withMessage(`Enjoying mirrord? Don't forget to leave a review! Also consider giving us some feedback, we'd highly appreciate it!`)
      .withGenericAction("Review", async () => {
        vscode.env.openExternal(vscode.Uri.parse('https://marketplace.visualstudio.com/items?itemName=MetalBear.mirrord&ssr=false#review-details'));
      })
      .withGenericAction("Feedback", async () => {
        vscode.env.openExternal(vscode.Uri.parse('https://mirrord.dev/feedback'));
      })
      .info();
  }
}

