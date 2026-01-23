import * as vscode from 'vscode';
import { globalContext } from './extension';
import { isTargetSet, MirrordConfigManager } from './config';
import { MirrordAPI, mirrordFailure, MirrordExecution } from './api';
import { updateTelemetries } from './versionCheck';
import { getMirrordBinary } from './binaryManager';
import { platform } from 'node:os';
import { NotificationBuilder } from './notification';
import { setOperatorUsed } from './mirrordForTeams';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { TargetQuickPick, UserSelection } from './targetQuickPick';
import Logger from './logger';

const DYLD_ENV_VAR_NAME = "DYLD_INSERT_LIBRARIES";

/// Get the name of the field that holds the exectuable in a debug configuration of the given type,
/// and the executable. Returning the field name for replacing the value with the patched path later.
/// Also returning the executable because in some configuration types there is some extra logic to
/// be done for retrieving the executable out of its field (see the `node-terminal` case).
function getFieldAndExecutable(config: vscode.DebugConfiguration): [keyof vscode.DebugConfiguration, string | null] {
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
function changeConfigForSip(config: vscode.DebugConfiguration, executableFieldName: string, executionInfo: MirrordExecution) {
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
    config[executableFieldName] = `echo '${escapedCommand}' | ${DYLD_ENV_VAR_NAME}=${libraryPath} ${sh} -is`;
  } else if (executionInfo.patchedPath !== null) {
    config[executableFieldName] = executionInfo.patchedPath!;
  }
}

// We need to patch the debug configuration to run the user's program in a mirrord-created
// environment.
// We do this by creating a batch script that calls `mirrord.exe exec` and then pointing the
// debug configuration to this script.
//
// The patched field is going to be:
// - `program` for compiled languages (Go, C#)
// - `runtimeExecutable` for Node
// - `python` for Python
//
// The script will then execute the original program with the original arguments.
async function patchConfigForWindows(config: vscode.DebugConfiguration, configPath: string | undefined): Promise<[patchField: string, scriptPath: string] | null> {
  // Helper to find the field and executable to patch.
  function getPatchInfo(config: vscode.DebugConfiguration): [string, string] | null {
    switch (config.type) {
      case "pwa-node":
      case "node": {
        const executable = config.runtimeExecutable || "node";
        return ["runtimeExecutable", executable];
      }
      case "debugpy":
      case "python": {
        if (config.python) {
          return ["python", config.python];
        }
        if (config.pythonPath) { // For legacy python extension support
          return ["pythonPath", config.pythonPath];
        }
        // If no python is specified, the extension finds it.
        // We can add it to the config and have our wrapper call `python`.
        return ["python", "python"];
      }
      case "coreclr": {
        if (config.program) {
          return ["program", config.program];
        }
        return null;
      }
      case "go": {
        if (config.program) {
          return ["program", config.program];
        }
        return null;
      }
      default: {
        if (config.program) {
          return ["program", config.program];
        }
        return null;
      }
    }
  }

  const patchInfo = getPatchInfo(config);
  if (!patchInfo) {
    console.log("Not patching debug configuration for Windows: could not determine executable.");
    return null;
  }

  const [patchField, executableToWrapOriginal] = patchInfo;

  // The executable path might have spaces. It needs to be quoted.
  const executableToWrap = `"${executableToWrapOriginal}"`;

  const fileName = `mirrord_exec_${crypto.randomBytes(16).toString('hex')}.bat`;
  const tmpDir = os.tmpdir();
  const scriptPath = path.join(tmpDir, fileName);

  const configFlag = configPath ? `-f "${configPath}"` : '';
  // The `%*` is important to pass all arguments to the original executable.
  // In this case, it will function exactly as in the original case.
  const content = `mirrord.exe exec --ide-orchestrated ${configFlag} -- ${executableToWrap} %*`;

  await fs.promises.writeFile(scriptPath, content);

  return [patchField, scriptPath];
}

/**
* Entrypoint for the vscode extension, called from `resolveDebugConfigurationWithSubstitutedVariables`.
*/
async function main(
  folder: vscode.WorkspaceFolder | undefined,
  config: vscode.DebugConfiguration,
  _token: vscode.CancellationToken): Promise<vscode.DebugConfiguration | null | undefined> {
  if ((!globalContext.workspaceState.get('enabled') && !(config.env?.["MIRRORD_ACTIVE"] === "1")) || config.env?.["MIRRORD_ACTIVE"] === "0") {
    return config;
  }

  // Sometimes VSCode launches then attaches, so having a warning/error here is confusing
  // We used to return null in that case but that failed the attach.
  if (config.request === "attach") {
    return config;
  }

  // For some reason resolveDebugConfiguration runs twice for Node projects. __parentId is populated.
  if (config.__parentId || config.env?.["__MIRRORD_EXT_INJECTED"] === 'true') {
    return config;
  }

  updateTelemetries();

  //TODO: add progress bar maybe ?
  const cliPath = await getMirrordBinary(false);

  if (!cliPath) {
    mirrordFailure(`Couldn't download mirrord binaries or find local one in path`);
    return null;
  }

  const mirrordApi = new MirrordAPI(cliPath);

  config.env ||= {};
  let quickPickSelection: UserSelection | undefined = undefined;

  const configPath = await MirrordConfigManager.getInstance().resolveMirrordConfig(folder, config);
  const verifiedConfig = await mirrordApi.verifyConfig(configPath, config.env);

  // If target wasn't specified in the config file (or there's no config file), let user choose pod from dropdown
  if (!configPath || (verifiedConfig && !isTargetSet(verifiedConfig))) {
    const supportedTypes = TargetQuickPick.getSupportedTargetTypes();
    const getTargets = async (namespace?: string) => {
      return mirrordApi.listTargets(configPath?.path, config.env, supportedTypes, namespace);
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
    config.env["MIRRORD_SKIP_PROCESSES"] = "dlv;debugserver;compile;go;asm;cgo;link;git;gcc;as;ld;collect2;cc1";
  } else if (config.type === "python" || config.type === "debugpy") {
    config.env["MIRRORD_DETECT_DEBUGGER_PORT"] = "debugpy";
  } else if (config.type === "java") {
    config.env["MIRRORD_DETECT_DEBUGGER_PORT"] = "javaagent";
  } else if (config.type === "pwa-node") {
    // if any of the --inspect flags are used with node, the port for inspection should be ignored
    // see: https://nodejs.org/en/learn/getting-started/debugging#enable-inspector
    config.env["MIRRORD_DETECT_DEBUGGER_PORT"] = "nodeinspector";
  }

  // Add a fixed range of ports that VS Code uses for debugging.
  // TODO: find a way to use MIRRORD_DETECT_DEBUGGER_PORT for other debuggers.
  config.env["MIRRORD_IGNORE_DEBUGGER_PORTS"] = "45000-65535";

  const isMac = platform() === "darwin";
  const isWindows = platform() === "win32";

  if (isWindows) {
    const patch = await patchConfigForWindows(config, configPath?.path);
    if (patch) {
      const [patchField, scriptPath] = patch;
      config[patchField] = scriptPath;
    }
  }

  const [executableFieldName, executable] = isMac ? getFieldAndExecutable(config) : [null, null];

  let executionInfo;
  try {
    executionInfo = await mirrordApi.binaryExecute(quickPickSelection, configPath?.path || null, executable, config.env, folder?.uri.path);
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

  config.env["__MIRRORD_EXT_INJECTED"] = 'true';
  return config;
}

/**
* We implement the `resolveDebugConfiguration` that comes with vscode variables resolved already.
*/
export class ConfigurationProvider implements vscode.DebugConfigurationProvider {
  async resolveDebugConfigurationWithSubstitutedVariables(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
    _token: vscode.CancellationToken): Promise<vscode.DebugConfiguration | null | undefined> {
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
