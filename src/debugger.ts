import * as vscode from "vscode";
import { globalContext } from "./extension";
import { isTargetSet, MirrordConfigManager } from "./config";
import { MirrordAPI, mirrordFailure, MirrordExecution } from "./api";
import { updateTelemetries } from "./versionCheck";
import { getMirrordBinary } from "./binaryManager";
import { platform } from "node:os";
import { NotificationBuilder } from "./notification";
import { setOperatorUsed } from "./mirrordForTeams";
import fs from "fs";
import { TargetQuickPick, UserSelection } from "./targetQuickPick";
import Logger from "./logger";

const DYLD_ENV_VAR_NAME = "DYLD_INSERT_LIBRARIES";

/**
 * Info needed by the DAP tracker to perform attach after the process starts.
 */
export interface PendingAttach {
  cliPath: string;
  configEnv: Record<string, string>;
  stopOnEntryProperty: string;
  userHadStopOnEntry: boolean;
}

/**
 * Queue of pending attaches. `main()` pushes here on Windows after setting up
 * stopOnEntry. The tracker factory in `extension.ts` shifts from it when
 * creating a tracker for a mirrord-injected session. Config resolution and
 * tracker creation happen sequentially per session, so ordering is preserved.
 */
export const pendingAttaches: PendingAttach[] = [];

/**
 * Returns the name of the "stop on entry" config property for the given debug type.
 *
 * Most debuggers use `stopOnEntry`, but C# (coreclr/clr) uses `stopAtEntry`.
 */
function getStopOnEntryProperty(debugType: string): string {
  switch (debugType) {
    case "coreclr":
    case "clr":
      return "stopAtEntry";
    default:
      return "stopOnEntry";
  }
}

/// Get the name of the field that holds the exectuable in a debug configuration of the given type,
/// and the executable. Returning the field name for replacing the value with the patched path later.
/// Also returning the executable because in some configuration types there is some extra logic to
/// be done for retrieving the executable out of its field (see the `node-terminal` case).
function getFieldAndExecutable(
  config: vscode.DebugConfiguration,
): [keyof vscode.DebugConfiguration, string | null] {
  switch (config.type) {
    case "pwa-node":
    case "node": {
      // https://code.visualstudio.com/docs/nodejs/nodejs-debugging#_launch-configuration-attributes
      return ["runtimeExecutable", config["runtimeExecutable"]];
    }
    case "node-terminal": {
      // Command could contain multiple commands like "command1 arg1; command2 arg2", so we execute that command
      // in a shell, to which we inject the layer. In order to inject the layer to the shell, we have to patch it
      // for SIP, so we pass the shell to the mirrod CLI.
      return ["command", vscode.env.shell];
    }
    case "debugpy":
    case "python": {
      if ("python" in config) {
        return ["python", config["python"]];
      }
      // Official documentation states the relevant field name is "python" (https://code.visualstudio.com/docs/python/debugging#_python),
      // but when debugging we see the field is called "pythonPath".
      return ["pythonPath", config["pythonPath"]];
    }
    default: {
      if ("python" in config && fs.existsSync(config["python"])) {
        // We don't know that config type yet, but the config has the field "python" that contains a path that exists,
        // so we assume that's the path of the python binary and we patch that.
        return ["python", config["python"]];
      }
      return ["program", config["program"]];
    }
  }
}

/// Edit the launch configuration in order to sidestep SIP on macOS, and allow the layer to be
/// loaded into the process. This includes replacing the executable with the path to a patched
/// executable if the original executable is SIP protected, and some other special workarounds.
function changeConfigForSip(
  config: vscode.DebugConfiguration,
  executableFieldName: string,
  executionInfo: MirrordExecution,
) {
  if (config.type === "node-terminal") {
    const command = config[executableFieldName];
    if (command === null) {
      return;
    }

    // The command could have single quotes, and we are putting the whole command in single quotes in the changed command.
    // So we replace each `'` with `'\''` (closes the string, concats an escaped single quote, opens the string)
    const escapedCommand = command.replaceAll("'", "'\\''");
    const sh = executionInfo.patchedPath ?? vscode.env.shell;

    const libraryPath = executionInfo.env.get(DYLD_ENV_VAR_NAME);

    // Run the command in a SIP-patched shell, that way everything that runs in the original command will be SIP-patched
    // on runtime.
    config[executableFieldName] =
      `echo '${escapedCommand}' | ${DYLD_ENV_VAR_NAME}=${libraryPath} ${sh} -is`;
  } else if (executionInfo.patchedPath !== null) {
    config[executableFieldName] = executionInfo.patchedPath!;
  }
}

/**
 * Entrypoint for the vscode extension, called from `resolveDebugConfigurationWithSubstitutedVariables`.
 */
async function main(
  folder: vscode.WorkspaceFolder | undefined,
  config: vscode.DebugConfiguration,
  _token: vscode.CancellationToken,
): Promise<vscode.DebugConfiguration | null | undefined> {
  if (
    (!globalContext.workspaceState.get("enabled") &&
      !(config.env?.["MIRRORD_ACTIVE"] === "1")) ||
    config.env?.["MIRRORD_ACTIVE"] === "0"
  ) {
    return config;
  }

  // Sometimes VSCode launches then attaches, so having a warning/error here is confusing
  // We used to return null in that case but that failed the attach.
  if (config.request === "attach") {
    return config;
  }

  // For some reason resolveDebugConfiguration runs twice for Node projects. __parentId is populated.
  if (config.__parentId || config.env?.["__MIRRORD_EXT_INJECTED"] === "true") {
    return config;
  }

  updateTelemetries();

  //TODO: add progress bar maybe ?
  const cliPath = await getMirrordBinary(false);

  if (!cliPath) {
    mirrordFailure(
      `Couldn't download mirrord binaries or find local one in path`,
    );
    return null;
  }

  const mirrordApi = new MirrordAPI(cliPath);

  config.env ||= {};
  let quickPickSelection: UserSelection | undefined = undefined;

  const configPath =
    await MirrordConfigManager.getInstance().resolveMirrordConfig(
      folder,
      config,
    );
  const verifiedConfig = await mirrordApi.verifyConfig(configPath, config.env);

  // If target wasn't specified in the config file (or there's no config file), let user choose pod from dropdown
  if (!configPath || (verifiedConfig && !isTargetSet(verifiedConfig))) {
    const supportedTypes = TargetQuickPick.getSupportedTargetTypes();
    const getTargets = async (namespace?: string) => {
      return mirrordApi.listTargets(
        configPath?.path,
        config.env,
        supportedTypes,
        namespace,
      );
    };

    try {
      const quickPick = await TargetQuickPick.new(getTargets);
      quickPickSelection = await quickPick.showAndGet();
    } catch (err) {
      mirrordFailure(`mirrord failed to list targets: ${err}`);
      return null;
    }
  }

  if (config.type === "go") {
    config.env["MIRRORD_SKIP_PROCESSES"] =
      "dlv;debugserver;compile;go;asm;cgo;link;git;gcc;as;ld;collect2;cc1";
  } else if (config.type === "python" || config.type === "debugpy") {
    config.env["MIRRORD_DETECT_DEBUGGER_PORT"] = "debugpy";
  } else if (config.type === "java") {
    config.env["MIRRORD_DETECT_DEBUGGER_PORT"] = "javaagent";
  } else if (config.type in ["pwa-node", "node", "node-terminal"]) {
    // if any of the --inspect flags are used with node, the port for inspection should be ignored
    // see: https://nodejs.org/en/learn/getting-started/debugging#enable-inspector
    config.env["MIRRORD_DETECT_DEBUGGER_PORT"] = "nodeinspector";
    config.env["MIRRORD_ENV_LOAD_FROM_PROCESS"] = "true";
  }

  // Add a fixed range of ports that VS Code uses for debugging.
  // TODO: find a way to use MIRRORD_DETECT_DEBUGGER_PORT for other debuggers.
  config.env["MIRRORD_IGNORE_DEBUGGER_PORTS"] = "45000-65535";

  const isMac = platform() === "darwin";
  const isWindows = platform() === "win32";

  const [executableFieldName, executable] = isMac
    ? getFieldAndExecutable(config)
    : [null, null];

  let executionInfo;
  try {
    executionInfo = await mirrordApi.binaryExecute(
      quickPickSelection,
      configPath?.path || null,
      executable,
      config.env,
      folder?.uri.path,
    );
  } catch (err) {
    mirrordFailure(`mirrord preparation failed: ${err}`);
    return null;
  }

  if (executionInfo.usesOperator === true) {
    setOperatorUsed();
  }

  if (isMac) {
    changeConfigForSip(config, executableFieldName as string, executionInfo);
  }

  const env = executionInfo?.env;

  config.env = Object.assign({}, config.env, Object.fromEntries(env));

  if (executionInfo.envToUnset) {
    for (const key of executionInfo.envToUnset) {
      delete config.env[key];
    }
  }

  config.env["__MIRRORD_EXT_INJECTED"] = "true";

  // On Windows, set up the attach flow: force stop-on-entry so we can inject
  // the layer DLL before any user code runs.
  if (isWindows) {
    const stopProp = getStopOnEntryProperty(config.type);
    const userHadStopOnEntry = !!config[stopProp];

    config[stopProp] = true;

    pendingAttaches.push({
      cliPath,
      configEnv: { ...config.env },
      stopOnEntryProperty: stopProp,
      userHadStopOnEntry,
    });
  }

  return config;
}

/**
 * We implement the `resolveDebugConfiguration` that comes with vscode variables resolved already.
 */
export class ConfigurationProvider
  implements vscode.DebugConfigurationProvider
{
  async resolveDebugConfigurationWithSubstitutedVariables(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
    _token: vscode.CancellationToken,
  ): Promise<vscode.DebugConfiguration | null | undefined> {
    try {
      return await main(folder, config, _token);
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      Logger.error(`debug config provider error: ${errorMsg}`);
      new NotificationBuilder()
        .withMessage(`mirrord extension error: ${e}`)
        .error();
    }
  }
}
