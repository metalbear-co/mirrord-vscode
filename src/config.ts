import * as vscode from 'vscode';
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

export type EnvVars = Record<string, string>;

interface LaunchConfig {
  name: string,
  env?: EnvVars;
}

/**
* Output from `mirrord verify-config`.
*/
export type VerifiedConfig = ConfigSuccess | ConfigFail;

/**
* When `mirrord verify-config` results in a `"Success"`.
*/
interface ConfigSuccess { 'type': 'Success', config: Config, warnings: string[] }

/**
* When `mirrord verify-config` results in a `"Fail"`.
*/
interface ConfigFail { 'type': 'Fail', errors: string[] }


/**
* When `mirrord verify-config` results in a `"Success"`, this is the config within.
*/
export interface Config {
  path: Path | undefined
  namespace: string | undefined
}

/**
* Pod/deployment used to detect if `Target` was set in the config.
*/
export interface Path {
  deployment: string | undefined
  container: string | undefined
}

/**
* Looks into the `verifiedConfig` to see if it has a `Target` set (by checking `Config.path`).
*
* Also displays warnings/errors if there are any.
*
* When `Fail` is detected, we throw an exception after displaying the errors to the user to stop
* execution, if you `try/catch` this function call, normal mirrord execution will continue until it
* hits the normal mirrord-config handler.
*/
export function isTargetSet(verifiedConfig: VerifiedConfig): boolean {
  switch (verifiedConfig.type) {
    case 'Success':
      verifiedConfig.warnings.forEach((warn) => new NotificationBuilder().withMessage(warn).warning());
      return verifiedConfig.config.path !== undefined && verifiedConfig.config.path !== null;
    case 'Fail':
      verifiedConfig.errors.forEach((fail) => new NotificationBuilder().withMessage(fail).error());
      throw new Error('mirrord verify-config detected an invalid configuration!');
    default: {
      const _guard: never = verifiedConfig;
      return _guard;
    }
  }
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
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
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

  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
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
    const options = new Map<string, vscode.Uri>();

    const filePatterns = [
      "**/*mirrord.{json,toml,yml,yaml}", // known extensions, names ending with `mirrord`
      "**/*.mirrord/*.{json,toml,yml,yaml}", // known extensions, located in directories with names ending with `.mirrord` 
    ];

    const files = await Promise.all(filePatterns.map(pattern => vscode.workspace.findFiles(pattern)));
    files.flat().forEach(file => options.set(vscode.workspace.asRelativePath(file), file));

    const displayed = this.active ? ["<unset active config>", ...options.keys()] : [...options.keys()];
    const placeHolder = this.active
      ? `Select active mirrord config from the workspace (currently ${vscode.workspace.asRelativePath(this.active)})`
      : "Select active mirrord config from the workspace";
    const selected = await vscode.window.showQuickPick(displayed, { placeHolder });
    if (selected === "<unset active config>") {
      this.setActiveConfig(undefined);
    } else if (selected) {
      const path = options.get(selected)!;
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
    const pattern = new vscode.RelativePattern(folder, ".mirrord/*mirrord.{toml,json,yml,yaml}");
    const files = await vscode.workspace.findFiles(pattern);
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
    const path = vscode.Uri.joinPath(folder.uri, ".mirrord", "mirrord.json");
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
    const options = new Map<string, vscode.Uri>();

    // Active config first.
    if (this.active) {
      options.set(`(active) ${vscode.workspace.asRelativePath(this.active.path)}`, this.active);
    }

    // Then all configs found in launch configurations across the workspace.
    const folders = vscode.workspace.workspaceFolders || [];
    for (const folder of folders) {
      const launchConfigs = vscode.workspace.getConfiguration("launch", folder)?.get<LaunchConfig[]>("configurations") || [];
      for (const launchConfig of launchConfigs) {
        const rawPath = launchConfig.env?.["MIRRORD_CONFIG_FILE"];
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
      const path = await MirrordConfigManager.getDefaultConfig(folder);
      if (path) {
        options.set(`(default) ${vscode.workspace.asRelativePath(path)}`, path);
      } else {
        const path = vscode.Uri.joinPath(folder.uri, ".mirrord/mirrord.json");
        options.set(`(create default) ${vscode.workspace.asRelativePath(path)}`, path);
      }
    }

    const quickPickOptions = [...options.keys()];
    const selected = quickPickOptions.length > 1
      ? await vscode.window.showQuickPick(quickPickOptions, { placeHolder: "Select mirrord config to open" })
      : quickPickOptions[0];

    if (!selected) {
      return;
    }

    const path = options.get(selected)!;
    if (selected.startsWith("(create default)")) {
      await MirrordConfigManager.createDefaultConfig(vscode.workspace.getWorkspaceFolder(path)!);
    }

    const doc = await vscode.workspace.openTextDocument(path.path);
    vscode.window.showTextDocument(doc);
  }

  /**
   * Used when preparing mirrord environment for the process.
   * @param folder optional origin of the launch config
   * @param config debug configuration used
   * @returns path to the mirrord config
   */
  public async resolveMirrordConfig(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): Promise<vscode.Uri | null> {
    if (this.active) {
      // User has selected a config (via active config button).
      new NotificationBuilder()
        .withMessage("Using active mirrord configuration.")
        .withOpenFileAction(this.active)
        .withDisableAction("promptUsingActiveConfig")
        .info();

      return this.active;
    } else if (config.env?.["MIRRORD_CONFIG_FILE"]) {
      // Get the config path from the env var.
      const configFromEnv = vscode.Uri.parse(`file://${config.env?.["MIRRORD_CONFIG_FILE"]}`, true);

      new NotificationBuilder()
        .withMessage(`Using mirrord configuration from env var "MIRRORD_CONFIG_FILE".`)
        .withOpenFileAction(configFromEnv)
        .withDisableAction("promptUsingEnvVarConfig")
        .info();

      return configFromEnv;

    } else if (folder) {
      const configFromMirrordFolder = await MirrordConfigManager.getDefaultConfig(folder);

      if (configFromMirrordFolder) {
        new NotificationBuilder()
          .withMessage(`Using mirrord configuration from ".mirrord" folder.`)
          .withOpenFileAction(configFromMirrordFolder)
          .withDisableAction("promptUsingDefaultConfig")
          .info();

        return configFromMirrordFolder;
      } else {
        // There is no configuration file in a .mirrord directory and no configuration file was specified
        // via "active configuration" extension setting or environment variable. This is a valid case.
        // mirrord will run without a configuration file.
        return null;
      }
    } else {
      // User probably openend vscode in a single file, no folder is loaded and they have
      // not set up the `MIRRORD_CONFIG_FILE` env var.
      new NotificationBuilder()
        .withMessage(`No folder open in editor - so not using a configuration file even if one exists.`)
        .withDisableAction("promptUsingDefaultConfigSingleFileNoFolder")
        .info();

      return null;
    }
  }
}
