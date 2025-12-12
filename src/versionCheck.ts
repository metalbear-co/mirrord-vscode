import * as vscode from 'vscode';
import * as semver from 'semver';
import * as https from 'https';
import { platform } from 'os';
import { globalContext } from './extension';
import { NotificationBuilder } from './notification';
import { IncomingMessage } from 'http';
import Logger from './logger';

const CI_BUILD_PLUGIN = process.env.CI_BUILD_PLUGIN === 'true';
const versionCheckEndpoint = 'https://version.mirrord.dev/get-latest-version';
const versionCheckInterval = 1000 * 60 * 3;


export async function checkVersion(version: string) {
	const versionUrl = versionCheckEndpoint + '?source=1&version=' + version + '&platform=' + platform();
	https.get(versionUrl, (res: IncomingMessage) => {
		res.on('data', (d: Buffer) => {
			if (semver.lt(version, d.toString())) {
				let extensionUri;
				switch (vscode.env.appName) {
					case 'VS Code':
						extensionUri = vscode.Uri.parse('vscode:extension/MetalBear.mirrord');
						break;
					case 'VSCodium':
						extensionUri = vscode.Uri.parse('vscodium:extension/MetalBear.mirrord');
						break;
					case 'Cursor':
						extensionUri = vscode.Uri.parse('cursor:extension/MetalBear.mirrord');
						break;
					default:
						break;
				}
				if (extensionUri) {
					new NotificationBuilder()
						.withMessage("New version of mirrord is available!")
						.withGenericAction("Update", async () => {
							vscode.env.openExternal(extensionUri);
						})
						.withDisableAction("promptOutdated")
						.info();
				} else {
					// user is using a different fork/ app
					new NotificationBuilder()
						.withMessage("New version of mirrord is available! Update it now in the extensions page.")
						.withDisableAction("promptOutdated")
						.info();
				}
			}
		});

	}).on('error', (e: Error) => {
		Logger.error(e.message);
	});
}

// Run the version check, no telemetries are sent in case of an e2e run.
export async function updateTelemetries() {
	if (vscode.env.isTelemetryEnabled && !CI_BUILD_PLUGIN) {
		const lastChecked = globalContext.globalState.get('lastChecked', 0);
		if (lastChecked < Date.now() - versionCheckInterval) {
			checkVersion(globalContext.extension.packageJSON.version);
			globalContext.globalState.update('lastChecked', Date.now());
		}
	}
}