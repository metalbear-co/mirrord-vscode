import * as vscode from 'vscode';
import { globalContext } from './extension';
import { MirrordConfigManager } from './config';
import { LAST_TARGET_KEY, MirrordAPI, mirrordFailure, MirrordExecution } from './api';
import { updateTelemetries } from './versionCheck';
import { getLocalMirrordBinary, getMirrordBinary } from './binaryManager';
import { platform } from 'node:os';
import { NotificationBuilder } from './notification';

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
			return ["command", config["command"]?.split(' ')[0]];
		}
		case "python": {
			if ("python" in config) {
				return ["python", config["python"]];
			}
			// Official documentation states the relevant field name is "python" (https://code.visualstudio.com/docs/python/debugging#_python), 
			// but when debugging we see the field is called "pythonPath".
			return ["pythonPath", config["pythonPath"]];
		}
		default: {
			return ["program", config["program"]];
		}
	}
}

/// Edit the launch configuration in order to sidestep SIP on macOS, and allow the layer to be
/// loaded into the process. This includes replacing the executable with the path to a patched
/// executable if the original executable is SIP protected, and some other special workarounds.
function changeConfigForSip(config: vscode.DebugConfiguration, executableFieldName: string, executionInfo: MirrordExecution) {
	if (config.type === "node-terminal") {
		let command = config[executableFieldName];
		if (command === null) {
			return;
		}
		if (executionInfo.patchedPath !== null) {
			// replace the first word of the command line with a patched version of the executable.
			let words = command.split(' ');
			words[0] = executionInfo.patchedPath;
			command = words.join(' ');
		}
		let libraryPath = executionInfo.env.get(DYLD_ENV_VAR_NAME);

		// vscode passes the command to something like `sh`, which we cannot patch or change, and
		// which is SIP protected, so our DYLD env var is silently removed. So in order to bypass
		// that, we set that variable in the command line.
		config[executableFieldName] = `${DYLD_ENV_VAR_NAME}=${libraryPath} ${command}`;
	} else if (executionInfo.patchedPath !== null) {
		config[executableFieldName] = executionInfo.patchedPath!;
	}
}



async function getLastActiveMirrordPath(): Promise<string | null> {
	const binaryPath = globalContext.globalState.get('binaryPath', null);
	if (!binaryPath) {
		return null;
	}
	try {
		await vscode.workspace.fs.stat(binaryPath);
		return binaryPath;
	} catch (e) {
		return null;
	}
}

function setLastActiveMirrordPath(path: string) {
	globalContext.globalState.update('binaryPath', path);
}

export class ConfigurationProvider implements vscode.DebugConfigurationProvider {
	async resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token: vscode.CancellationToken): Promise<vscode.DebugConfiguration | null | undefined> {

		if (!globalContext.workspaceState.get('enabled')) {
			return config;
		}

		// For some reason resolveDebugConfiguration runs twice for Node projects. __parentId is populated.
		if (config.__parentId || config.env?.["__MIRRORD_EXT_INJECTED"] === 'true') {
			return config;
		}

		updateTelemetries();

		//TODO: add progress bar maybe ?
		let cliPath;

		try {
			cliPath = await getMirrordBinary();
		} catch (err) {
			// Get last active, that should work?
			cliPath = await getLastActiveMirrordPath();

			// Well try any mirrord we can try :\
			if (!cliPath) {
				cliPath = await getLocalMirrordBinary();
				if (!cliPath) {
					mirrordFailure(`Couldn't download mirrord binaries or find local one in path ${err}.`);
					return null;
				}
			}
		}
		setLastActiveMirrordPath(cliPath);

		let mirrordApi = new MirrordAPI(cliPath);

		config.env ||= {};
		let target = null;

		let configPath = await MirrordConfigManager.getInstance().resolveMirrordConfig(folder, config);
		// If target wasn't specified in the config file, let user choose pod from dropdown
		if (!await MirrordConfigManager.isTargetInFile(configPath)) {
			let targets;
			try {
				targets = await mirrordApi.listTargets(configPath.path);
			} catch (err) {
				mirrordFailure(`mirrord failed to list targets: ${err}`);
				return null;
			}
			if (targets.length === 0) {
				new NotificationBuilder()	
					.withMessage(
						"No mirrord target available in the configured namespace. " +
						"You can run targetless, or set a different target namespace or kubeconfig in the mirrord configuration file.",	
					)
					.info();
			}

			let selected = false;

			while (!selected) {
				let targetPick = await vscode.window.showQuickPick(targets.quickPickItems(), { 
					placeHolder: 'Select a target path to mirror' 
				});

				if (targetPick) {
					if (targetPick.type === 'page') {
						targets.switchPage(targetPick);

						continue;
					}

					if (targetPick.type !== 'targetless') {
						target = targetPick.value;
					}

					globalContext.globalState.update(LAST_TARGET_KEY, target);
					globalContext.workspaceState.update(LAST_TARGET_KEY, target);
				}

				selected = true;
			}

			if (!target) {
				new NotificationBuilder()
					.withMessage("mirrord running targetless")
					.withDisableAction("promptTargetless")
					.info();
			}
		}

		if (config.type === "go") {
			config.env["MIRRORD_SKIP_PROCESSES"] = "dlv;debugserver;compile;go;asm;cgo;link;git;gcc;as;ld;collect2;cc1";
		} else if (config.type === "python") {
			config.env["MIRRORD_DETECT_DEBUGGER_PORT"] = "debugpy";
		} else if (config.type === "java") {
			config.env["MIRRORD_DETECT_DEBUGGER_PORT"] = "javaagent";
		}

		// Add a fixed range of ports that VS Code uses for debugging.
		// TODO: find a way to use MIRRORD_DETECT_DEBUGGER_PORT for other debuggers.
		config.env["MIRRORD_IGNORE_DEBUGGER_PORTS"] = "45000-65535";

		let isMac = platform() === "darwin";

		let [executableFieldName, executable] = isMac ? getFieldAndExecutable(config) : [null, null];

		let executionInfo;
		try {
			executionInfo = await mirrordApi.binaryExecute(target, configPath.path, executable);
		} catch (err) {
			mirrordFailure(`mirrord preparation failed: ${err}`);
			return null;
		}

		if (isMac) {
			changeConfigForSip(config, executableFieldName as string, executionInfo);
		}

		let env = executionInfo?.env;
		config.env = Object.assign({}, config.env, Object.fromEntries(env));

		config.env["__MIRRORD_EXT_INJECTED"] = 'true';

		return config;
	}
}
