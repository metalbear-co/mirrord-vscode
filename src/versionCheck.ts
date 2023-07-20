import * as vscode from 'vscode';
import * as semver from 'semver';
import * as https from 'https';
import { platform } from 'os';
import { globalContext } from './extension';
import { NotificationBuilder } from './notification';

const CI_BUILD_PLUGIN = process.env.CI_BUILD_PLUGIN === 'true';
const versionCheckEndpoint = 'https://version.mirrord.dev/get-latest-version';
const versionCheckInterval = 1000 * 60 * 3;


export async function checkVersion(version: string) {
	let versionUrl = versionCheckEndpoint + '?source=1&version=' + version + '&platform=' + platform();
	https.get(versionUrl, (res: any) => {
		res.on('data', (d: any) => {
			if (semver.lt(version, d.toString())) {
				new NotificationBuilder()
					.withMessage("New version of mirrord is available!")
					.withGenericAction("Update", async () => {
						vscode.env.openExternal(vscode.Uri.parse('vscode:extension/MetalBear.mirrord'));
					})
					.withDisableAction("promptOutdated")
					.info();
			}
		});

	}).on('error', (e: any) => {
		console.error(e);
	});
}

// Run the version check, no telemetries are sent in case of an e2e run.
export async function updateTelemetries() {
	if (vscode.env.isTelemetryEnabled && !CI_BUILD_PLUGIN) {
		let lastChecked = globalContext.globalState.get('lastChecked', 0);
		if (lastChecked < Date.now() - versionCheckInterval) {
			checkVersion(globalContext.extension.packageJSON.version);
			globalContext.globalState.update('lastChecked', Date.now());
		}
	}
}