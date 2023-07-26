import axios, { AxiosResponse } from 'axios';
import which from 'which';
import { globalContext } from './extension';
import { MirrordAPI } from './api';
import { Utils } from 'vscode-uri';
import * as fs from 'node:fs';
import { platform } from 'os';
import { Uri, workspace, window, ProgressLocation, ExtensionMode } from 'vscode';
import { NotificationBuilder } from './notification';

const mirrordBinaryEndpoint = 'https://version.mirrord.dev/v1/version';
// const binaryCheckInterval = 1000 * 60 * 3;
const baseDownloadUri = 'https://github.com/metalbear-co/mirrord/releases/download';

function getExtensionMirrordPath(): Uri {
    return Utils.joinPath(globalContext.globalStorageUri, 'mirrord');
}


/**
 * Tries to find local mirrord in path or in extension storage.
 */
export async function getLocalMirrordBinary(version?: string): Promise<string | null> {
    try {
        const mirrordPath = await which("mirrord");
        if (version) {
            const api = new MirrordAPI(mirrordPath);
            const installedVersion = await api.getBinaryVersion();
            if (installedVersion === version) {
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
        return configured;
    }

    let foundLocal = await getLocalMirrordBinary();
    // timeout is 1s if we have alternative or 10s if we don't
    let timeout = foundLocal ? 1000 : 10000;
    const latestVersion = await getLatestSupportedVersion(timeout);

    // See if maybe we have it installed already, in correct version.
    const localMirrord = await getLocalMirrordBinary(latestVersion);
    if (localMirrord) {
        const api = new MirrordAPI(localMirrord);
        const installedVersion = await api.getBinaryVersion();
        if (installedVersion === latestVersion) {
            return localMirrord;
        }
    }

    const extensionMirrordPath = getExtensionMirrordPath();
    await downloadMirrordBinary(extensionMirrordPath, latestVersion);

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