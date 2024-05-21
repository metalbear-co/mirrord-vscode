import * as vscode from 'vscode';
import { MirrordConfigManager } from './config';
import { globalContext } from './extension';
import { NotificationBuilder } from './notification';
import { getOperatorUsed } from './mirrordForTeams';

export class MirrordStatus {
    readonly statusBar: vscode.StatusBarItem;
    static readonly toggleCommandId = 'mirrord.toggleMirroring';
    static readonly settingsCommandId = 'mirrord.changeSettings';
    static readonly joinDiscordCommandId = 'mirrord.joinDiscord';
    static readonly mirrordForTeamsCommandId = 'mirrord.mirrordForTeams';
    static readonly selectActiveConfigId = 'mirrord.selectActiveConfig';
    static readonly helpCommandId = 'mirrord.help';

    constructor(statusBar: vscode.StatusBarItem) {
        this.statusBar = statusBar;
    }

    draw() {
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
        statusBar.tooltip.appendMarkdown(`\n\n[Get help on Discord](command:${MirrordStatus.joinDiscordCommandId})`);
        statusBar.tooltip.appendMarkdown(`\n\n[Walkthrough](command:${MirrordStatus.helpCommandId})`);

        statusBar.show();
    }

    register(): MirrordStatus {
        const configManager = MirrordConfigManager.getInstance();
        globalContext.subscriptions.push(configManager);

        configManager.onActiveConfigChange(async () => this.draw());

        globalContext.subscriptions.push(vscode.commands.registerCommand(MirrordStatus.selectActiveConfigId, async () => {
            await configManager.selectActiveConfig();
        }));
        globalContext.subscriptions.push(vscode.commands.registerCommand(MirrordStatus.settingsCommandId, configManager.changeSettings.bind(configManager)));
        globalContext.subscriptions.push(vscode.commands.registerCommand(MirrordStatus.toggleCommandId, this.toggle.bind(this)));
        globalContext.subscriptions.push(vscode.commands.registerCommand(MirrordStatus.joinDiscordCommandId, this.joinDiscord.bind(this)));
        globalContext.subscriptions.push(vscode.commands.registerCommand(MirrordStatus.mirrordForTeamsCommandId, this.mirrordForTeams.bind(this)));
        globalContext.subscriptions.push(vscode.commands.registerCommand(MirrordStatus.helpCommandId, async () => {
            vscode.commands.executeCommand(`workbench.action.openWalkthrough`, `MetalBear.mirrord#mirrord.welcome`, false);
        }));

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
        if (process.platform === "win32") {
            new NotificationBuilder()
                .withMessage("mirrord is not supported on Windows. You can use it via remote development or WSL.")
                .error();
            return;
        }

        this.enabled = !this.enabled;

        this.draw();
    }

    joinDiscord() {
        vscode.env.openExternal(vscode.Uri.parse('https://discord.gg/metalbear'));
    }

    mirrordForTeams() {
        vscode.env.openExternal(vscode.Uri.parse('https://app.metalbear.co/'));
    }
}
