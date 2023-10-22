import axios, { AxiosResponse } from 'axios';
import * as vscode from 'vscode';
import which from 'which';
import { globalContext } from './extension';
import { MirrordAPI } from './api';
import { Utils } from 'vscode-uri';
import * as fs from 'node:fs';
import { platform } from 'os';
import { Uri, workspace, window, ProgressLocation, ExtensionMode, InputBoxOptions } from 'vscode';
import { NotificationBuilder } from './notification';
import { eq, gte, lt } from 'semver';

const mirrordBinaryEndpoint = 'https://version.mirrord.dev/v1/version';
// const binaryCheckInterval = 1000 * 60 * 3;
const baseDownloadUri = 'https://github.com/metalbear-co/mirrord/releases/download';

export let autoUpdate = true;
let userSpecifiedMirrordBinaryVersion: string | null | undefined = null;

function getExtensionMirrordPath(): Uri {
    return Utils.joinPath(globalContext.globalStorageUri, 'mirrord');
}


/**
 * Tries to find local mirrord in path or in extension storage.
 */
export async function getLocalMirrordBinary(): Promise<string | null> {
    try {
        const mirrordPath = await which("mirrord");
        return mirrordPath;
    } catch (e) {
        console.debug("couldn't find mirrord in path");
    }
    try {
        const mirrordPath = getExtensionMirrordPath();
        await workspace.fs.stat(mirrordPath);
        return mirrordPath.fsPath;
    } catch (e) {
        console.log("couldn't find mirrord in extension storage");
    }
    return null;
}

async function getConfiguredMirrordBinary(): Promise<string | null> {
    const configured = workspace.getConfiguration().get<string | null>("mirrord.binaryPath");
    if (!configured) {
        return null;
    }

    let version;
    try {
        version = await new MirrordAPI(configured).getBinaryVersion();
        if (!version) {
            throw new Error("version command returned malformed output");
        }
    } catch (err) {
        new NotificationBuilder()
            .withMessage(`failed to used mirrord binary specified in settings due to failed version check: ${err}`)
            .warning();
        return null;
    }

    let latestVersion;
    try {
        latestVersion = await getLatestSupportedVersion(1000);
    } catch (err) {
        new NotificationBuilder()
            .withMessage(`failed to check latest supported version of mirrord binary, binary specified in settings may be outdated: ${err}`)
            .warning();
        return configured;
    }

    if (version !== latestVersion) {
        new NotificationBuilder()
            .withMessage(`mirrord binary specified in settings has outdated version ${version}, latest supported version is ${latestVersion}`)
            .warning();
    }

    return configured;
}

/**
 * Downloads mirrord binary (if needed) and returns its path
 */
export async function getMirrordBinary(): Promise<string> {
    const configured = await getConfiguredMirrordBinary();
    if (configured) {
        await vscode.window.showInformationMessage(`Using mirrord binary specified in settings: ${configured}`);
        return configured;
    }

    const extensionMirrordPath = getExtensionMirrordPath();
    const latestVersion = await getLatestSupportedVersion(10000);

    if (autoUpdate) {
        await downloadMirrordBinary(extensionMirrordPath, latestVersion);
        return extensionMirrordPath.fsPath;
    } else {
        if (userSpecifiedMirrordBinaryVersion) {
            await downloadMirrordBinary(extensionMirrordPath, userSpecifiedMirrordBinaryVersion);
            return extensionMirrordPath.fsPath;
        } else {
            let localMirrord = await getLocalMirrordBinary();
            if (localMirrord) {
                const api = new MirrordAPI(localMirrord);
                const installedVersion = await api.getBinaryVersion();

                // in the release CI - the semver version is greater than the current remote semver version
                // and hence, we need to use the local version

                if (installedVersion !== null && installedVersion !== undefined && lt(installedVersion, latestVersion)) {
                    await vscode.window.showInformationMessage(`Using local mirrord binary: ${localMirrord} which is outdated. Latest supported version is ${latestVersion}`);
                } else if (installedVersion !== null && installedVersion !== undefined && eq(installedVersion, latestVersion)) {
                    await vscode.window.showInformationMessage(`Using local mirrord binary: ${localMirrord} which is up-to-date`);
                } else if (installedVersion !== null && installedVersion !== undefined && gte(installedVersion, latestVersion)) {
                    await vscode.window.showInformationMessage(`Using local mirrord binary: ${localMirrord} which is newer than the latest supported version ${latestVersion}. Possily a CI build`);
                }

                return localMirrord;
            } else {
                await downloadMirrordBinary(extensionMirrordPath, latestVersion);
            }
        }
    }

    return extensionMirrordPath.fsPath;
}

/**
 * 
 * @returns The latest supported version of mirrord for current extension version
 */
async function getLatestSupportedVersion(timeout: number): Promise<string> {
    // commented out logic to avoid checking every X seconds
    // uncomment if hits performance or too annoying
    // let lastChecked = globalContext.globalState.get('binaryLastChecked', 0);
    // let lastBinaryVersion = globalContext.globalState.get('lastBinaryVersion', '');

    // if (lastBinaryVersion && lastChecked > Date.now() - binaryCheckInterval) {
    //     return lastBinaryVersion;
    // }
    let version;
    // send test for test runs
    if ((globalContext.extensionMode === ExtensionMode.Development) || (process.env.CI_BUILD_PLUGIN === "true")) {
        version = "test";
    } else {
        version = globalContext.extension.packageJSON.version;
    }
    const response = await axios.get(mirrordBinaryEndpoint, {
        "params": { "source": 1, "version": version, "platform": platform() },
        timeout: 2000,
    });

    // globalContext.globalState.update('binaryLastChecked', Date.now());
    // globalContext.globalState.update('lastBinaryVersion', response.data);
    return response.data as string;
}

function getMirrordDownloadUrl(version: string): string {
    if (process.platform === "darwin") {
        return `${baseDownloadUri}/${version}/mirrord_mac_universal`;
    } else if (process.platform === "linux") {
        switch (process.arch) {
            case 'x64':
                return `${baseDownloadUri}/${version}/mirrord_linux_x86_64`;
            case 'arm64':
                return `${baseDownloadUri}/${version}/mirrord_linux_aarch64`;
            default:
                break;
        }
    }
    throw new Error(`Unsupported platform ${process.platform} ${process.arch}`);
}

/**
 * 
 * @param destPath Path to download the binary to
 */
async function downloadMirrordBinary(destPath: Uri, version: string): Promise<void> {
    fs.mkdirSync(Utils.dirname(destPath).fsPath, { recursive: true });
    const response: AxiosResponse = await window.withProgress({
        location: ProgressLocation.Notification,
        title: "mirrord",
        cancellable: false
    }, (progress, _) => {
        progress.report({ increment: 0, "message": "Downloading mirrord binary..." });
        const p = axios.get(
            getMirrordDownloadUrl(version),
            {
                onDownloadProgress: function (progressEvent) {
                    progress.report({ increment: progressEvent.progress, "message": "Downloading mirrord binary..." });
                },
                responseType: 'arraybuffer',
            });

        return p;
    }
    );
    fs.writeFileSync(destPath.fsPath, response.data);
    fs.chmodSync(destPath.fsPath, 0o755);
}



/**
 * Toggles auto-update of mirrord binary.
 * Criteria for auto-update:
 * - Auto-update is enabled by default
 * - if mirrord binary path is mentioned in workspace settings, then that is used
 * - if auto-update is enabled, then latest supported version is downloaded
 * - if auto-update is disabled, and a version is specified, then that version is downloaded
 * - if auto-update is disabled, and no version is specified, then local mirrord binary is used
 * * - if auto-update is disabled, and no version is specified, and no local mirrord binary is found, then latest supported version is downloaded
 * Note: typing "clear" in the input box will clear the user specified version
*/
export async function toggleAutoUpdate() {
    if (autoUpdate) {
        const options: vscode.InputBoxOptions = {
            title: "Specify mirrord binary version",
            prompt: "Auto-update will be disabled, mirrord will be updated to the specified version on restart.",
            placeHolder: `Current version: ${userSpecifiedMirrordBinaryVersion ?? "unspecified (will download"}`,
        };
        const value = await vscode.window.showInputBox(options);

        if (value) {
            if (value === 'clear') {
                userSpecifiedMirrordBinaryVersion = null;
            } else if (/^[0-9]+\.[0-9]+\.[0-9]+$/.test(value)) {
                userSpecifiedMirrordBinaryVersion = value;
            } else {
                vscode.window.showErrorMessage(`Invalid version format ${value}: must follow semver format`);
            }
        }

        autoUpdate = false;
        vscode.window.showInformationMessage("Auto-update disabled");
    } else {
        autoUpdate = true;
        vscode.window.showInformationMessage("Auto-update enabled");
    }
}