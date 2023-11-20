import axios, { AxiosResponse } from 'axios';
import * as vscode from 'vscode';
import which from 'which';
import { globalContext } from './extension';
import { MirrordAPI } from './api';
import { Utils } from 'vscode-uri';
import * as fs from 'node:fs';
import { platform } from 'os';
import { Uri, workspace, window, ProgressLocation, ExtensionMode } from 'vscode';
import { NotificationBuilder } from './notification';
import * as semver from 'semver';

const mirrordBinaryEndpoint = 'https://version.mirrord.dev/v1/version';
// const binaryCheckInterval = 1000 * 60 * 3;
const baseDownloadUri = 'https://github.com/metalbear-co/mirrord/releases/download';

function getExtensionMirrordPath(): Uri {
    return Utils.joinPath(globalContext.globalStorageUri, 'mirrord');
}


/**
 * Tries to find local mirrord in path or in extension storage.
 * @param version If specified, then the version of the binary is checked and matched path is returned.
 * @returns Path to mirrord binary or null if not found
 */
export async function getLocalMirrordBinary(version?: string): Promise<string | null> {
    try {
        const mirrordPath = await which("mirrord");
        if (version) {
            const api = new MirrordAPI(mirrordPath);
            const installedVersion = await api.getBinaryVersion();

            // we use semver.gte here because installedVersion can be greater than the latest version
            // if we are running on the release CI.
            if ((process.env.CI_BUILD_PLUGIN === "true" && installedVersion && semver.gte(installedVersion, version)) ||
                (!process.env.CI_BUILD_PLUGIN && installedVersion === version)) {
                return mirrordPath;
            }
        } else {
            return mirrordPath;
        }
    } catch (e) {
        console.debug("couldn't find mirrord in path");
    }
    try {
        const mirrordPath = getExtensionMirrordPath();
        await workspace.fs.stat(mirrordPath);
        if (version) {
            const api = new MirrordAPI(mirrordPath.fsPath);
            const installedVersion = await api.getBinaryVersion();
            if (installedVersion === version) {
                return mirrordPath.fsPath;
            }
        } else {
            return mirrordPath.fsPath;
        }
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
        latestVersion = await getLatestSupportedVersion();
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
 * Toggles auto-update of mirrord binary.
 * Criteria for auto-update:
 * - Auto-update is enabled by default
 * - if mirrord binary path is mentioned in workspace settings, then that is used
 * - if a version is specified, that version is downloaded
 * - if auto-update is enabled, then latest supported version is downloaded
 * - if auto-update is disabled, any local mirrord binary is used
 * 
 * @param extensionActivate If true, then a global state is set so that any changes to the workspace settings pertaining
 * to mirrord binary auto-update will prompt the user to reload the window.
 * @returns Path to mirrord binary
*/
export async function getMirrordBinary(): Promise<string> {
    const configured = await getConfiguredMirrordBinary();

    if (configured) {
        vscode.window.showInformationMessage(`Using mirrord binary specified in settings: ${configured}`);
        return configured;
    }

    let foundLocal = await getLocalMirrordBinary();
    const latestVersion = await getLatestSupportedVersion();

    const autoUpdateConfigured = vscode.workspace.getConfiguration().get("mirrord.autoUpdate");

    // values for `mirrord.autoUpdate` can be:
    // - true: auto-update is enabled
    // - false: auto-update is disabled
    // - string: version to download
    // example: "mirrord.autoUpdate": "3.70.1" or "mirrord.autoUpdate": false or "mirrord.autoUpdate": true

    const extensionPath = getExtensionMirrordPath().fsPath;

    // check the type can be only null, string or boolean
    if (typeof autoUpdateConfigured !== 'boolean' && typeof autoUpdateConfigured !== 'string') {
        vscode.window.showErrorMessage(`Invalid autoUpdate setting ${autoUpdateConfigured}: must be a boolean or a string`);
        return extensionPath;
    }

    if (typeof autoUpdateConfigured === 'string') {
        if (semver.valid(autoUpdateConfigured)) {
            const localMirrordBinary = await getLocalMirrordBinary(autoUpdateConfigured);
            if (localMirrordBinary) {
                return localMirrordBinary;
            }
            // donot block and download binary, instead download in background
            await downloadMirrordBinary(getExtensionMirrordPath(), autoUpdateConfigured);
            return extensionPath;
        } else {
            vscode.window.showErrorMessage(`Invalid version format ${autoUpdateConfigured}: must follow semver format`);
        }
    }

    if (autoUpdateConfigured === true) {
        const localMirrordBinary = await getLocalMirrordBinary(latestVersion);
        if (localMirrordBinary) {
            return localMirrordBinary;
        }
        await downloadMirrordBinary(getExtensionMirrordPath(), latestVersion);
        return extensionPath;
    } else {
        if (foundLocal) {
            return foundLocal;
        }
        return extensionPath;
    }
}

/**
 * 
 * @returns The latest supported version of mirrord for current extension version
 */
async function getLatestSupportedVersion(): Promise<string> {
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
    await window.withProgress({
        location: ProgressLocation.Window,
        title: "mirrord",
        cancellable: false
    }, async (progress) => {
        return new Promise<void>(async (resolve, reject) => {
            fs.mkdirSync(Utils.dirname(destPath).fsPath, { recursive: true });
            try {
                const response: AxiosResponse = await axios.get(
                    getMirrordDownloadUrl(version),
                    {
                        onDownloadProgress: function (progressEvent) {
                            progress.report({ increment: progressEvent.progress, "message": "Downloading mirrord binary..." });
                        },
                        responseType: 'arraybuffer',
                    });

                fs.writeFileSync(destPath.fsPath, response.data);
                fs.chmodSync(destPath.fsPath, 0o755);
                new NotificationBuilder()
                    .withMessage(`Downloaded mirrord binary version ${version}`)
                    .info();
                resolve();
            } catch (error) {
                new NotificationBuilder()
                    .withMessage(`Error downloading mirrord binary: ${error}`)
                    .error();
                reject(error);
            }
        });
    });
}