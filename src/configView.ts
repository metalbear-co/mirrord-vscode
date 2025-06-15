import * as vscode from 'vscode';
import { MirrordConfigManager } from './config';

export class MirrordConfigViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'mirrord.configView';
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _configManager: MirrordConfigManager
    ) {
        vscode.commands.registerCommand('mirrord.refreshConfigView', () => {
            if (this._view) {
                this._updateView(this._view);
            }
        });
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        this._configManager.onActiveConfigChange(async (activeConfig) => {
            if (this._view) {
                await this._updateView(this._view);
            }
        });

        this._updateView(webviewView);
    }

    private async _updateView(webviewView: vscode.WebviewView) {
        const activeConfig = this._configManager.activeConfig();
        const configPath = activeConfig ? vscode.workspace.asRelativePath(activeConfig) : 'No active configuration';

        webviewView.webview.postMessage({
            type: 'update',
            configPath: configPath
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body {
                        padding: 10px;
                        font-family: var(--vscode-font-family);
                        color: var(--vscode-foreground);
                    }
                    .config-container {
                        display: flex;
                        flex-direction: column;
                        gap: 10px;
                    }
                    .config-item {
                        display: flex;
                        flex-direction: column;
                        gap: 5px;
                    }
                    .config-label {
                        font-weight: bold;
                        color: var(--vscode-descriptionForeground);
                    }
                    .config-value {
                        word-break: break-all;
                    }
                    .no-config {
                        color: var(--vscode-errorForeground);
                        font-style: italic;
                    }
                </style>
            </head>
            <body>
                <div class="config-container">
                    <div class="config-item">
                        <span class="config-label">Active Configuration:</span>
                        <span class="config-value" id="configPath"></span>
                    </div>
                </div>
                <script>
                    (function() {
                        const vscode = acquireVsCodeApi();
                        const configPathElement = document.getElementById('configPath');

                        window.addEventListener('message', event => {
                            const message = event.data;
                            switch (message.type) {
                                case 'update':
                                    if (message.configPath === 'No active configuration') {
                                        configPathElement.textContent = message.configPath;
                                        configPathElement.className = 'config-value no-config';
                                    } else {
                                        configPathElement.textContent = message.configPath;
                                        configPathElement.className = 'config-value';
                                    }
                                    break;
                            }
                        });
                    })();
                </script>
            </body>
            </html>`;
    }
} 