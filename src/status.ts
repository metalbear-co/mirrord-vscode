import * as vscode from 'vscode';
import { MirrordConfigManager } from './config';
import { globalContext } from './extension';
import { getOperatorUsed } from './mirrordForTeams';
import { NEWSLETTER_COUNTER } from './api';

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
}
