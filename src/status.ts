import * as vscode from 'vscode';
import * as semver from 'semver';
import { MirrordConfigManager } from './config';
import { globalContext } from './extension';
import { getOperatorUsed } from './mirrordForTeams';
import { NEWSLETTER_COUNTER, MirrordAPI } from './api';
import { NotificationBuilder } from './notification';
import { getMirrordBinary } from './binaryManager';

/**
 * Returns true if the extension host is running in a remote session (WSL, SSH, Dev Container, etc.).
 */
function isRemoteSession(): boolean {
    return !!vscode.env.remoteName;
}

export class MirrordStatus {
    readonly statusBar: vscode.StatusBarItem;
    static readonly toggleCommandId = 'mirrord.toggleMirroring';
    static readonly settingsCommandId = 'mirrord.changeSettings';
    static readonly joinSlackCommandId = 'mirrord.joinSlack';
    static readonly mirrordForTeamsCommandId = 'mirrord.mirrordForTeams';
    static readonly selectActiveConfigId = 'mirrord.selectActiveConfig';
    static readonly helpCommandId = 'mirrord.help';
    static readonly documentationCommandId = 'mirrord.documentation';
    static readonly newsletterCommandId = 'mirrord.newsletter';

    constructor(statusBar: vscode.StatusBarItem) {
        this.statusBar = statusBar;
    }

    draw() {
        const showStatusBar = vscode.workspace.getConfiguration('mirrord').get('showStatusBarButton', true);

        if (!showStatusBar) {
            return;
        }

        const {
            enabled,
            statusBar,
        } = this;

        statusBar.text = `mirrord $(${enabled ? 'circle-large-filled' : 'circle-large-outline'})`;
        statusBar.color = undefined;
        statusBar.backgroundColor = undefined;

        statusBar.command = MirrordStatus.toggleCommandId;

        statusBar.tooltip = new vscode.MarkdownString("", true);
        statusBar.tooltip.isTrusted = true;

        statusBar.tooltip.appendMarkdown(`[${enabled ? 'Enabled' : 'Disabled'}](command:${MirrordStatus.toggleCommandId})`);
        statusBar.tooltip.appendText("\n\n");
        const activeConfig = MirrordConfigManager.getInstance().activeConfig();
        if (activeConfig) {
            statusBar.tooltip.appendMarkdown(`\n\n[Active config: ${vscode.workspace.asRelativePath(activeConfig)}](${activeConfig})`);
        }
        statusBar.tooltip.appendMarkdown(`\n\n[Select active config](command:${MirrordStatus.selectActiveConfigId})`);
        statusBar.tooltip.appendMarkdown(`\n\n[Settings](command:${MirrordStatus.settingsCommandId})`);
        if (!getOperatorUsed()) {
            statusBar.tooltip.appendMarkdown(`\n\n[mirrord for Teams](command:${MirrordStatus.mirrordForTeamsCommandId})`);
        }
        statusBar.tooltip.appendMarkdown(`\n\n[Documentation](command:${MirrordStatus.documentationCommandId})`);
        statusBar.tooltip.appendMarkdown(`\n\n[Get help on Slack](command:${MirrordStatus.joinSlackCommandId})`);
        statusBar.tooltip.appendMarkdown(`\n\n[Walkthrough](command:${MirrordStatus.helpCommandId})`);

        statusBar.show();
    }

    register(): MirrordStatus {
        // Check the mirrord version for support every single time the
        // extension is loaded.
        if (process.platform === "win32") {
            this.checkWindowsSupport();
        }

        const configManager = MirrordConfigManager.getInstance();
        globalContext.subscriptions.push(configManager);

        configManager.onActiveConfigChange(async () => this.draw());

        globalContext.subscriptions.push(vscode.commands.registerCommand(MirrordStatus.selectActiveConfigId, async () => {
            await configManager.selectActiveConfig();
        }));
        globalContext.subscriptions.push(vscode.commands.registerCommand(MirrordStatus.settingsCommandId, configManager.changeSettings.bind(configManager)));
        globalContext.subscriptions.push(vscode.commands.registerCommand(MirrordStatus.toggleCommandId, this.toggle.bind(this)));
        globalContext.subscriptions.push(vscode.commands.registerCommand(MirrordStatus.joinSlackCommandId, this.joinSlack.bind(this)));
        globalContext.subscriptions.push(vscode.commands.registerCommand(MirrordStatus.mirrordForTeamsCommandId, this.mirrordForTeams.bind(this)));
        globalContext.subscriptions.push(vscode.commands.registerCommand(MirrordStatus.helpCommandId, async () => {
            vscode.commands.executeCommand(`workbench.action.openWalkthrough`, `MetalBear.mirrord#mirrord.welcome`, false);
        }));
        globalContext.subscriptions.push(vscode.commands.registerCommand(MirrordStatus.documentationCommandId, this.documentation.bind(this)));
        globalContext.subscriptions.push(vscode.commands.registerCommand(MirrordStatus.newsletterCommandId, this.newsletter.bind(this)));

        globalContext.subscriptions.push(this.statusBar);

        return this;
    }

    get enabled(): boolean {
        return !!globalContext.workspaceState.get('enabled');
    }

    set enabled(val: boolean) {
        globalContext.workspaceState.update('enabled', val);
    }

    toggle() {
        this.enabled = !this.enabled;

        // Check the mirrord version for support every single time the extension
        // is toggled on.
        if (this.enabled) {
            if (process.platform === "win32") {
                this.checkWindowsSupport();
            }
        }

        this.draw();
    }

    joinSlack() {
        vscode.env.openExternal(vscode.Uri.parse('https://metalbear.co/slack'));
    }

    mirrordForTeams() {
        vscode.env.openExternal(vscode.Uri.parse('https://app.metalbear.co/?utm_medium=vscode&utm_source=ui_action'));
    }

    newsletter() {
        const count = globalContext.globalState.get(NEWSLETTER_COUNTER);
        vscode.env.openExternal(vscode.Uri.parse("https://metalbear.co/newsletter" + "?utm_medium=vscode&utm_source=newsletter" + count));
    }

    documentation() {
        vscode.env.openExternal(vscode.Uri.parse('https://mirrord.dev/docs/using-mirrord/vscode-extension/?utm_medium=vscode&utm_source=ui_action'));
    }

    /**
     * Checks whether the current host can run mirrord on Windows.
     *
     * Verifies two things, in order:
     * 1. The host architecture is supported — mirrord currently only ships a
     *    Windows x64 build, so any other `process.arch` is rejected with a
     *    notification pointing users at the issue tracker.
     * 2. The installed mirrord binary is recent enough — Windows support
     *    requires mirrord version 3.201.0 or above.
     *
     * Skips the check when running in a remote session (WSL, SSH, Dev Container)
     * since mirrord runs on the remote host, not locally.
     *
     * @returns `true` if the host is supported and the version is compatible
     * (or cannot be determined), `false` if the arch is unsupported or the
     * installed binary is too old.
     */
    private async checkWindowsSupport(): Promise<boolean> {
        // If it's a remote (including WSL), we don't need to check
        // locally for mirrord.exe.
        if (isRemoteSession()) {
            return true;
        }

        if (process.arch !== 'x64') {
            new NotificationBuilder()
                .withMessage(
                    `mirrord does not currently provide a Windows ${process.arch} build. `
                    + `If you require ${process.arch} support, please open an issue at `
                    + `https://github.com/metalbear-co/mirrord/issues so we can gauge interest.`
                )
                .error();
            return false;
        }

        try {
            const binaryPath = await getMirrordBinary(true);
            // Just in case, return true if we can't get the binary path yet.
            if (!binaryPath) {
                return true;
            }

            const api = new MirrordAPI(binaryPath);
            const version = await api.getBinaryVersion();
            if (version && semver.lt(version, '3.201.0')) {
                new NotificationBuilder()
                    .withMessage(`mirrord ${version} is not supported on Windows. Windows support requires mirrord version 3.201.0 or above.`)
                    .error();
                return false;
            }
            
            return true;
        } catch {
            // If we can't determine the version, don't block the user.
            return true;
        }
    }
}
