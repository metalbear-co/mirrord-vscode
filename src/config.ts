import * as vscode from 'vscode';
import YAML from 'yaml';
import TOML from 'toml';

/**
 * Default mirrord configuration.
 */
const DEFAULT_CONFIG = `
{
    "accept_invalid_certificates": false,
    "feature": {
        "network": {
            "incoming": "mirror",
            "outgoing": true
        },
        "fs": "read",
        "env": true
    }
}
`;

interface LaunchConfig {
    name: string,
    env?: { [key: string]: string};
}

export class MirrordConfigManager {
    private static instance?: MirrordConfigManager = undefined;

    /**
     * Active config. User can set this for the whole workspace.
     */
    private active?: vscode.Uri;
    private fileListener: vscode.Disposable;

    private constructor() {
        this.fileListener = vscode.workspace.onDidDeleteFiles(event => {
            event.files.find(file => {
                if (file.path === this.active?.path) {
                    vscode.window.showWarningMessage("removed active mirrord configuration");
                    this.active = undefined;
                }
            });
        });
    }

    public dispose() {
        this.fileListener.dispose();
    }

    /**
     * @returns a global instance of this manager
     */
    public static getInstance(): MirrordConfigManager {
        if (MirrordConfigManager.instance === undefined) {
            MirrordConfigManager.instance = new MirrordConfigManager();
        }

        return MirrordConfigManager.instance;
    }

    /**
     * Handles `mirrord.selectActiveConfig` command.
     * Allows the user to set an active mirrord config from quick pick.
     * Any path across the workspace is available, as long as its name ends with `mirrord.{json,toml,yml,yaml}`.
     */
    public async selectActiveConfig() {
        const options: Map<string, vscode.Uri> = new Map();
        const files = await vscode.workspace.findFiles("**/*mirrord.{json,toml,yml,yaml}");
        files.forEach(f => options.set(`use ${vscode.workspace.asRelativePath(f)}`, f));

        const displayed = ["<none>", ...options.keys()];
        const placeHolder = this.active
            ? `Select active mirrord config from the workspace (currently ${vscode.workspace.asRelativePath(this.active)})`
            : "Select active mirrord config from the workspace";
        const selected = await vscode.window.showQuickPick(displayed, {placeHolder});
        if (selected === "<none>") {
            this.active = undefined;
        } else if (selected) {
            let path = options.get(selected)!!;
            this.active = path;
        }
    }

    /**
     * Searches the given workspace folder for a default config.
     * Default configs are located in the `.mirrord` directory and their names end with `mirrord.{toml,json,yml,yaml}`.
     * If there are multiple candidates, they are sorted according alphabetically and the first one is returned.
     * @param folder searched workspace folder
     * @returns path to the found config
     */
    private static async getDefaultConfig(folder: vscode.WorkspaceFolder): Promise<vscode.Uri | undefined> {
        let pattern = new vscode.RelativePattern(folder, ".mirrord/*mirrord.{toml,json,yml,yaml}");
        let files = await vscode.workspace.findFiles(pattern);
        files.sort((f1, f2) => {
            if (f1.path > f1.path) {
                return 1;
            } else if (f1.path < f2.path) {
                return -1;
            } else {
                return 0;
            }
        });
        return files[0];
    }

    /**
     * Creates a default config in the given workspace folder.
     * The config is created under `.mirrord/mirrord.json`.
     * @param folder workspace folder for the config
     * @returns path to the created config
     */
    private static async createDefaultConfig(folder: vscode.WorkspaceFolder): Promise<vscode.Uri> {
        let path = vscode.Uri.joinPath(folder.uri, ".mirrord", "mirrord.json");
        await vscode.workspace.fs.writeFile(path, Buffer.from(DEFAULT_CONFIG));
        return path;
    }

    /**
     * Handles `mirrord.changeSettings` command.
     * Allows the user to open a mirrord config file selected from quick pick.
     * Quick pick options in order:
     *  - active config (if set)
     *  - configs used in launch configurations across the workspace
     *  - default configs across the workspace
     */
    public async changeSettings() {
        const options: Map<string, vscode.Uri> = new Map();

        // Active config first.
        if (this.active) {
            options.set(`(active) ${vscode.workspace.asRelativePath(this.active.path)}`, this.active);
        }

        // Then all configs found in launch configurations across the workspace.
        const folders = vscode.workspace.workspaceFolders || [];
        for (const folder of folders) {
            let launchConfigs = vscode.workspace.getConfiguration("launch", folder)?.get<LaunchConfig[]>("configurations") || [];
            for (const launchConfig of launchConfigs) {
                let rawPath = launchConfig.env?.["MIRRORD_CONFIG_FILE"];
                if (!rawPath) {
                    continue;
                }

                let path;
                if (rawPath.startsWith("/")) {
                    path = vscode.Uri.file(rawPath);
                } else {
                    path = vscode.Uri.joinPath(folder.uri, rawPath);

                }

                if (folders.length > 1) {
                    options.set(`(launch config ${folder.name}:${launchConfig.name}) ${vscode.workspace.asRelativePath(path)}`, path);
                } else {
                    options.set(`(launch config ${launchConfig.name}) ${vscode.workspace.asRelativePath(path)}`, path);
                }
            }
        }

        // Then all default configurations across the workspace.
        for (const folder of folders) {
            let path = await MirrordConfigManager.getDefaultConfig(folder);
            if (path) {
                options.set(`(default) ${vscode.workspace.asRelativePath(path)}`, path);
            } else {
                let path = vscode.Uri.joinPath(folder.uri, ".mirrord/mirrord.json");
                options.set(`(create default) ${vscode.workspace.asRelativePath(path)}`, path);
            }
        }

        let quickPickOptions = [...options.keys()];
        let selected = await vscode.window.showQuickPick(quickPickOptions, {placeHolder: "Select mirrord config to open"});

        if (!selected) {
            return;
        }

        let path = options.get(selected)!!;
        if (selected.startsWith("(create default)")) {
            await MirrordConfigManager.createDefaultConfig(vscode.workspace.getWorkspaceFolder(path)!!);
        }

        let doc = await vscode.workspace.openTextDocument(path.path);
        vscode.window.showTextDocument(doc);
    }

    /**
     * Used when preparing mirrord environment for the process.
     * @param folder optional origin of the launch config
     * @param config debug configuration used
     * @returns path to the mirrord config
     */
    public async resolveMirrordConfig(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): Promise<vscode.Uri> {
        if (this.active) {
            MirrordConfigManager.showConfigSelectedNotification(false, "using active mirrord configuration", this.active);
            return this.active;
        }

        let launchConfig = config.env?.["MIRRORD_CONFIG_FILE"];
        if (launchConfig) {
            return vscode.Uri.file(launchConfig);
        }

        if (folder) {
            let predefinedConfig = await MirrordConfigManager.getDefaultConfig(folder);
            if (predefinedConfig) {
                MirrordConfigManager.showConfigSelectedNotification(true, "using a default mirrord config", predefinedConfig);
                return predefinedConfig;
            }
    
            let defaultConfig = await MirrordConfigManager.createDefaultConfig(folder);
            MirrordConfigManager.showConfigSelectedNotification(true, "created a default mirrord config", defaultConfig);
            return defaultConfig;
        }

        folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            throw new Error("mirrord requires an open folder in the workspace");
        }

        let predefinedConfig = await MirrordConfigManager.getDefaultConfig(folder);
        if (predefinedConfig) {
            MirrordConfigManager.showConfigSelectedNotification(true, `using a default mirrord config from folder ${folder.name}`, predefinedConfig);
            return predefinedConfig;
        }

        let defaultConfig = await MirrordConfigManager.createDefaultConfig(folder);
        MirrordConfigManager.showConfigSelectedNotification(true, `created a default mirrord config in folder ${folder.name}`, defaultConfig);

        return defaultConfig;
    }

    /**
     * Shows a notification about config being selected.
     * The notification is enriched with an `Open` button which allows the user to open the config.
     * @param warning whether the notification is a warning
     * @param message message to display in the notification
     * @param path path to the config
     */
    private static async showConfigSelectedNotification(warning: boolean, message: string, path: vscode.Uri) {
        const func = warning ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
        let selected = await func(message, "Open");
        if (!selected) {
            return;
        }
        let doc = await vscode.workspace.openTextDocument(path);
        vscode.window.showTextDocument(doc);
    }

    /**
     * Checks whether mirrord target is specified in the given config.
     * @param path config path
     */
    public static async isTargetInFile(path: vscode.Uri): Promise<boolean> {
        const contents = (await vscode.workspace.fs.readFile(path)).toString();
        let parsed;
        if (path.path.endsWith('json')) {
            parsed = JSON.parse(contents);
        } else if (path.path.endsWith('yaml') || path.path.endsWith('yml')) {
            parsed = YAML.parse(contents);
        } else if (path.path.endsWith('toml')) {
            parsed = TOML.parse(contents);
        }

        return (parsed && (typeof (parsed['target']) === 'string' || parsed['target']?.['path']));
    }
}
