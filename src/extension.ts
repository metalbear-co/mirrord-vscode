import * as vscode from 'vscode';
import { ConfigurationProvider } from './debugger';
import { MirrordStatus } from './status';

export let globalContext: vscode.ExtensionContext;

// This method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	globalContext = context;

	context.workspaceState.update('enabled', false);
	vscode.debug.registerDebugConfigurationProvider('*', new ConfigurationProvider(), 2);

	new MirrordStatus(vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0))
		.register()
		.draw();
}
