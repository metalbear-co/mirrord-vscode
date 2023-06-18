import axios, { AxiosResponse } from 'axios';
import which from 'which';
import { globalContext } from './extension';
import { MirrordAPI } from './api';
import { Utils } from 'vscode-uri';
import * as fs from 'node:fs';
import { Uri, workspace, window, ProgressLocation, ExtensionMode } from 'vscode';

const mirrordBinaryEndpoint = 'https://version.mirrord.dev/v1/version';
const binaryCheckInterval = 1000 * 60 * 3;
const baseDownloadUri = 'https://github.com/metalbear-co/mirrord/releases/download';

function getExtensionMirrordPath(): Uri {
    return Utils.joinPath(globalContext.globalStorageUri, 'mirrord');
}


/**
 * Downloads mirrord binary (if needed) and returns its path
 */
export async function getMirrordBinary(): Promise<string> {
    const extensionMirrordPath = getExtensionMirrordPath();

    const latestVersion = await getLatestSupportedVersion();

    // See if maybe we have it installed already, in correct version.
    try {
        const mirrordPath = await which("mirrord");
        const api = new MirrordAPI(mirrordPath);
        const installedVersion = await api.getBinaryVersion();
        if (installedVersion === latestVersion) {
            return mirrordPath;
        }
    } catch (e) {
        // don't care
    }

    // Check if we previously installed latest version.
    let binaryExists = false;
    try {
        await workspace.fs.stat(extensionMirrordPath);
        binaryExists = true;
    } catch (e) {
        // that's okay
    }

    if (binaryExists) {
        const api = new MirrordAPI(extensionMirrordPath.fsPath);
        const installedVersion = await api.getBinaryVersion();
        if (installedVersion === latestVersion) {
            return extensionMirrordPath.fsPath;
        }
    }

    await downloadMirrordBinary(extensionMirrordPath, latestVersion);

    return extensionMirrordPath.fsPath;
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
        "params": { "source": 1, "version": version },
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