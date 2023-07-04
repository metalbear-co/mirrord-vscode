import * as vscode from 'vscode';
import { ConfigurationProvider } from './debugger';
import { MirrordConfigManager } from './config';
import { waitlistRegisterCommand } from './waitlist';

let buttons: { toggle: vscode.StatusBarItem, settings: vscode.StatusBarItem };
export let globalContext: vscode.ExtensionContext;

async function toggle(context: vscode.ExtensionContext, button: vscode.StatusBarItem) {
	if (process.platform === "win32") {
		vscode.window.showErrorMessage('mirrord is not supported on Windows. You can use it via remote development or WSL.');
		return;
	}
	let state = context.workspaceState;
	if (state.get('enabled')) {
		state.update('enabled', false);
		button.text = 'Enable mirrord';
	} else {
		state.update('enabled', true);
		button.text = 'Disable mirrord';
	}
}

// This method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	globalContext = context;

	context.workspaceState.update('enabled', false);
	vscode.debug.registerDebugConfigurationProvider('*', new ConfigurationProvider(), 2);
	buttons = { toggle: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0), settings: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0) };

	const toggleCommandId = 'mirrord.toggleMirroring';
	context.subscriptions.push(vscode.commands.registerCommand(toggleCommandId, async function () {
		toggle(context, buttons.toggle);
	}));

	buttons.toggle.text = 'Enable mirrord';
	buttons.toggle.command = toggleCommandId;

	let configManager = MirrordConfigManager.getInstance();
	context.subscriptions.push(configManager);

	const selectConfigCommandId = 'mirrord.selectActiveConfig';
	context.subscriptions.push(vscode.commands.registerCommand(selectConfigCommandId, () => configManager.selectActiveConfig()));

	const settingsCommandId = 'mirrord.changeSettings';
	context.subscriptions.push(vscode.commands.registerCommand(settingsCommandId, () => configManager.changeSettings()));
	buttons.settings.text = '$(gear)';
	buttons.settings.command = settingsCommandId;

	for (const button of Object.values(buttons)) {
		context.subscriptions.push(button);
		button.show();
	};

	const waitlistCommandId = 'mirrord.waitlistSignup';
	context.subscriptions.push(vscode.commands.registerCommand(waitlistCommandId, waitlistRegisterCommand));
}
