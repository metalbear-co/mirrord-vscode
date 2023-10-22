import * as vscode from 'vscode';
import { MirrordConfigManager } from './config';
import { globalContext } from './extension';
import { waitlistRegisterCommand } from './waitlist';
import { NotificationBuilder } from './notification';
import { toggleAutoUpdate, autoUpdate } from './binaryManager';

export class MirrordStatus {
    readonly statusBar: vscode.StatusBarItem;
    static readonly toggleCommandId = 'mirrord.toggleMirroring';
    static readonly settingsCommandId = 'mirrord.changeSettings';
    static readonly autoUpdateCommandId = 'mirrord.autoUpdate';
    static readonly submitFeedbackCommandId = 'mirrord.submitFeedback';
    static readonly waitlistCommandId = 'mirrord.waitlistSignup';
    static readonly selectActiveConfigId = 'mirrord.selectActiveConfig';
    static readonly helpCommandId = 'mirrord.help';

    constructor(statusBar: vscode.StatusBarItem) {
        this.statusBar = statusBar;
    }

    public draw() {
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
        statusBar.tooltip.appendMarkdown(`\n\n[Auto-update: ${autoUpdate ? 'Enabled' : 'Disabled'}](command:${MirrordStatus.autoUpdateCommandId})`);        
        statusBar.tooltip.appendMarkdown(`\n\n[Select active config](command:${MirrordStatus.selectActiveConfigId})`);
        statusBar.tooltip.appendMarkdown(`\n\n[Settings](command:${MirrordStatus.settingsCommandId})`);
        statusBar.tooltip.appendMarkdown(`\n\n[mirrord for Teams Waitlist](command:${MirrordStatus.waitlistCommandId})`);
        statusBar.tooltip.appendMarkdown(`\n\n[Submit Feedback](command:${MirrordStatus.submitFeedbackCommandId})`);
        statusBar.tooltip.appendMarkdown(`\n\n[Help](command:${MirrordStatus.helpCommandId})`);

        statusBar.show();
    }

    register(): MirrordStatus {
        const configManager = MirrordConfigManager.getInstance();
        globalContext.subscriptions.push(configManager);

        configManager.onActiveConfigChange(async () => this.draw());

        globalContext.subscriptions.push(vscode.commands.registerCommand(MirrordStatus.selectActiveConfigId, async () => {
            await configManager.selectActiveConfig();
        }));
        globalContext.subscriptions.push(vscode.commands.registerCommand(MirrordStatus.autoUpdateCommandId, async () => {
            await toggleAutoUpdate();
            this.draw();
        }));
        globalContext.subscriptions.push(vscode.commands.registerCommand(MirrordStatus.settingsCommandId, configManager.changeSettings.bind(configManager)));
        globalContext.subscriptions.push(vscode.commands.registerCommand(MirrordStatus.toggleCommandId, this.toggle.bind(this)));
        globalContext.subscriptions.push(vscode.commands.registerCommand(MirrordStatus.submitFeedbackCommandId, this.submitFeedback.bind(this)));
        globalContext.subscriptions.push(vscode.commands.registerCommand(MirrordStatus.waitlistCommandId, waitlistRegisterCommand));
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

    submitFeedback() {
        vscode.env.openExternal(vscode.Uri.parse('https://mirrord.dev/feedback'));
    }
}