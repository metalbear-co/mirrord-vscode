import * as vscode from 'vscode';
import * as path from 'node:path';
import { globalContext } from './extension';
import { MirrordConfigManager } from './config';
import { LAST_TARGET_KEY, MirrordAPI, TARGETLESS_TARGET_NAME, mirrordFailure } from './api';
import { updateTelemetries } from './versionCheck';
import { getLocalMirrordBinary, getMirrordBinary } from './binaryManager';

/// Get the name of the field that holds the exectuable in a debug configuration of the given type.
function getExecutableFieldName(config: vscode.DebugConfiguration): keyof vscode.DebugConfiguration {
	switch (config.type) {
		case "pwa-node":
		case "node": {
			return "runtimeExecutable";
		}
		case "python": {
			if ("python" in config) {
				return "python";
			}
			// Official documentation states the relevant field name is "python" (https://code.visualstudio.com/docs/python/debugging#_python), 
			// but when debugging we see the field is called "pythonPath".
			return "pythonPath";
		}
		default: {
			return "program";
		}
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
				vscode.window.showInformationMessage(
					"No mirrord target available in the configured namespace. " +
					"You can run targetless, or set a different target namespace or kubeconfig in the mirrord configuration file.",
				);
			}

			let selected = false;
			let searchKey = !!targets.lastTarget?.startsWith('deployment') ? 'deployment' : 'pod';

			while (!selected) {
				let switchTo = `Show ${searchKey === 'pod' ? 'Deployment' : 'Pod'}s`;
				let targetName = await vscode.window.showQuickPick([...targets[searchKey], TARGETLESS_TARGET_NAME, switchTo], { placeHolder: 'Select a target path to mirror' });
				if (targetName) {
					if (targetName === switchTo) {
						searchKey = (searchKey === 'pod' ? 'deployment' : 'pod');

						continue;
					}

					if (targetName !== TARGETLESS_TARGET_NAME) {
						target = targetName;
					}

					globalContext.globalState.update(LAST_TARGET_KEY, targetName);
					globalContext.workspaceState.update(LAST_TARGET_KEY, targetName);
				}

				selected = true;
			}

			if (!target) {
				vscode.window.showInformationMessage("mirrord running targetless");
			}
		}

		if (config.type === "go") {
			config.env["MIRRORD_SKIP_PROCESSES"] = "dlv;debugserver;compile;go;asm;cgo;link;git;gcc;as;ld;collect2;cc1";
		} else if (config.type === "python") {
			config.env["MIRRORD_DETECT_DEBUGGER_PORT"] = "debugpy";
		}

		// Add a fixed range of ports that VS Code uses for debugging.
		// TODO: find a way to use MIRRORD_DETECT_DEBUGGER_PORT for other debuggers.
		config.env["MIRRORD_IGNORE_DEBUGGER_PORTS"] = "45000-65535";

		let executableFieldName = getExecutableFieldName(config);

		let executionInfo;
		try {
			if (executableFieldName in config) {
				executionInfo = await mirrordApi.binaryExecute(target, configPath.path, config[executableFieldName]);
			} else {
				// Even `program` is not in config, so no idea what's the executable in the end.
				executionInfo = await mirrordApi.binaryExecute(target, configPath.path, null);
			}
		} catch (err) {
			mirrordFailure(`mirrord preparation failed: ${err}`);
			return null;
		}

		// For sidestepping SIP on macOS. If we didn't patch, we don't change that config value.
		let patchedPath = executionInfo?.patchedPath;
		if (patchedPath) {
			config[executableFieldName] = patchedPath;
		}

		let env = executionInfo?.env;
		config.env = Object.assign({}, config.env, env);

		config.env["__MIRRORD_EXT_INJECTED"] = 'true';

		return config;
	}
}