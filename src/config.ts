import * as vscode from 'vscode';
import YAML from 'yaml';
import TOML from 'toml';
import { NotificationBuilder } from './notification';

/**
 * Default mirrord configuration.
 */
const DEFAULT_CONFIG = `{
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
    private fileListeners: vscode.Disposable[];
    /**
     * All will be called when the active config changes.
     */
    private activeConfigListeners: ((active?: vscode.Uri) => Thenable<any>)[];

    private constructor() {
        this.fileListeners = [];

        this.fileListeners.push(vscode.workspace.onDidDeleteFiles(async event => {
            const activePath = this.active?.path;
            if (!activePath) {
                return;
            }

            const deleted = event.files.find(file => activePath.startsWith(file.path));

            if (deleted) {
                new NotificationBuilder()
                    .withMessage("removed active mirrord configuration")
                    .withDisableAction("promptActiveConfigRemoved")
                    .warning();

                this.setActiveConfig(undefined);

                return;
            }
        }));

        this.fileListeners.push(vscode.workspace.onDidRenameFiles(async event => {
            const activePath = this.active?.path;
            if (!activePath) {
                return;
            }

            const moved = event.files.find(file => activePath.startsWith(file.oldUri.path));
            if (moved) {
                const newPath = activePath.replace(moved.oldUri.path, moved.newUri.path);
                const newUri = vscode.Uri.parse(`file://${newPath}`);
                new NotificationBuilder()
                    .withMessage(`moved active mirrord configuration to ${vscode.workspace.asRelativePath(newUri)}`)
                    .withDisableAction("promptActiveConfigMoved")
                    .warning();

                this.setActiveConfig(newUri);

                return;
            }
        }));

        this.activeConfigListeners = [];
    }

    private setActiveConfig(newConfig?: vscode.Uri) {
        this.active = newConfig;
        this.activeConfigListeners.forEach(l => l(newConfig));
    }

    public dispose() {
        this.fileListeners.forEach(fl => fl.dispose());
    }

    public onActiveConfigChange(listener: (active?: vscode.Uri) => Thenable<any>) {
        this.activeConfigListeners.push(listener);
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

    public activeConfig(): vscode.Uri | undefined {
        return this.active;
    }

    /**
     * Handles `mirrord.selectActiveConfig` command.
     * Allows the user to set an active mirrord config from quick pick.
     * Any path across the workspace is available, as long as its name ends with `mirrord.{json,toml,yml,yaml}`.
     */
    public async selectActiveConfig() {
        const options: Map<string, vscode.Uri> = new Map();
        const files = await vscode.workspace.findFiles("**/*mirrord.{json,toml,yml,yaml}");
        files.forEach(f => options.set(vscode.workspace.asRelativePath(f), f));

        const displayed = this.active ? ["<unset active config>", ...options.keys()] : [...options.keys()];
        const placeHolder = this.active
            ? `Select active mirrord config from the workspace (currently ${vscode.workspace.asRelativePath(this.active)})`
            : "Select active mirrord config from the workspace";
        const selected = await vscode.window.showQuickPick(displayed, {placeHolder});
        if (selected === "<unset active config>") {
            this.setActiveConfig(undefined);
        } else if (selected) {
            let path = options.get(selected)!!;
            this.setActiveConfig(path);
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
        files.sort((f1, f2) => f1.path.localeCompare(f2.path));
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
        let selected = quickPickOptions.length > 1
            ? await vscode.window.showQuickPick(quickPickOptions, {placeHolder: "Select mirrord config to open"})
            : quickPickOptions[0];

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
            new NotificationBuilder()
                .withMessage("using active mirrord configuration")
                .withOpenFileAction(this.active)
                .withDisableAction("promptUsingActiveConfig")
                .info();
            return this.active;
        }

        let launchConfig = config.env?.["MIRRORD_CONFIG_FILE"];
        if (launchConfig) {
            return vscode.Uri.file(launchConfig);
        }

        if (folder) {
            let predefinedConfig = await MirrordConfigManager.getDefaultConfig(folder);
            if (predefinedConfig) {
                new NotificationBuilder()
                    .withMessage("using a default mirrord config")
                    .withOpenFileAction(predefinedConfig)
                    .withDisableAction("promptUsingDefaultConfig")
                    .warning();
                return predefinedConfig;
            }
    
            let defaultConfig = await MirrordConfigManager.createDefaultConfig(folder);
            new NotificationBuilder()
                .withMessage("created a default mirrord config")
                .withOpenFileAction(defaultConfig)
                .withDisableAction("promptCreatedDefaultConfig")
                .warning();
            return defaultConfig;
        }

        folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            throw new Error("mirrord requires an open folder in the workspace");
        }

        let predefinedConfig = await MirrordConfigManager.getDefaultConfig(folder);
        if (predefinedConfig) {
            new NotificationBuilder()
                .withMessage(`using a default mirrord config from folder ${folder.name}`)
                .withOpenFileAction(predefinedConfig)
                .withDisableAction("promptUsingDefaultConfig")
                .warning();
            return predefinedConfig;
        }

        let defaultConfig = await MirrordConfigManager.createDefaultConfig(folder);
        new NotificationBuilder()
            .withMessage(`created a default mirrord config in folder ${folder.name}`)
            .withOpenFileAction(defaultConfig)
            .withDisableAction("promptCreatedDefaultConfig")
            .info();

        return defaultConfig;
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
