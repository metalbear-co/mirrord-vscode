import * as vscode from 'vscode';
import { ConfigurationProvider } from './debugger';
import { MirrordStatus } from './status';
import { getMirrordBinary } from './binaryManager';
import { MirrordConfigManager } from './config';
import { MirrordConfigViewProvider } from './configView';

export let globalContext: vscode.ExtensionContext;

// This method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	globalContext = context;

	const enabled = vscode.workspace.getConfiguration().get<boolean | null>("mirrord.enabledByDefault");
	context.workspaceState.update('enabled', enabled);
	vscode.debug.registerDebugConfigurationProvider('*', new ConfigurationProvider(), 2);

	// Start mirrord binary update, so that we avoid downloading mid session.
	// Do not `await` here. Let this happen in the background.
	getMirrordBinary(true);

	new MirrordStatus(vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0))
		.register()
		.draw();

	// Register the config view provider
	const configManager = MirrordConfigManager.getInstance();
	const configViewProvider = new MirrordConfigViewProvider(context.extensionUri, configManager);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(MirrordConfigViewProvider.viewType, configViewProvider)
	);

	// Register the refresh command for the config view
	context.subscriptions.push(
		vscode.commands.registerCommand('mirrord.refreshConfigView', () => {
			configViewProvider.refresh();
		})
	);
}
