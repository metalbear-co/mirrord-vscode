import * as vscode from 'vscode';
import { MirrordConfigManager } from './config';

export class MirrordConfigViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'mirrord.configView';
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _configManager: MirrordConfigManager
    ) {
    }

    public refresh() {
        if (this._view) {
            this._updateView(this._view);
        }
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        console.log('ConfigView: resolveWebviewView called');
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
        console.log('ConfigView: HTML set for webview');

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(
            message => {
                console.log('ConfigView: Received message from webview:', message);
                switch (message.type) {
                    case 'ready':
                        console.log('ConfigView: Webview is ready');
                        this._updateView(webviewView);
                        break;
                }
            }
        );

        this._configManager.onActiveConfigChange(async (activeConfig) => {
            console.log('ConfigView: Active config changed:', activeConfig?.path);
            if (this._view) {
                await this._updateView(this._view);
            }
        });

        // Don't call _updateView here, wait for ready message from webview
    }

    private async _updateView(webviewView: vscode.WebviewView) {
        try {
            const activeConfig = this._configManager.activeConfig();
            const configPath = activeConfig ? vscode.workspace.asRelativePath(activeConfig) : 'No active configuration';
            console.log('ConfigView: Updating view with config path:', configPath);

            webviewView.webview.postMessage({
                type: 'update',
                configPath: configPath
            });
        } catch (error) {
            console.error('Error updating config view:', error);
        }
    }

    private _getHtmlForWebview(_webview: vscode.Webview) {
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
                        
                        console.log('ConfigView: Webview script initialized');

                        window.addEventListener('message', event => {
                            console.log('ConfigView: Received message:', event.data);
                            const message = event.data;
                            switch (message.type) {
                                case 'update':
                                    console.log('ConfigView: Updating config path to:', message.configPath);
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
                        
                        // Send initial ready message
                        vscode.postMessage({ type: 'ready' });
                    })();
                </script>
            </body>
            </html>`;
    }
} 