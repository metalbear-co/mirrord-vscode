import * as vscode from 'vscode';
import * as semver from 'semver';
import * as https from 'https';
import { platform } from 'os';
import { globalContext } from './extension';
import { NotificationBuilder } from './notification';
import { IncomingMessage } from 'http';

const CI_BUILD_PLUGIN = process.env.CI_BUILD_PLUGIN === 'true';
const versionCheckEndpoint = 'https://version.mirrord.dev/get-latest-version';
const versionCheckInterval = 1000 * 60 * 3;


export async function checkVersion(version: string) {
	const versionUrl = versionCheckEndpoint + '?source=1&version=' + version + '&platform=' + platform();
	https.get(versionUrl, (res: IncomingMessage) => {
		res.on('data', (d: Buffer) => {
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

	}).on('error', (e: Error) => {
		console.error(e);
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