import * as assert from 'assert';
import * as vscode from 'vscode';
import { MirrordConfigViewProvider } from '../configView';
import { MirrordConfigManager } from '../config';

suite('ConfigView Test Suite', () => {
    let configViewProvider: MirrordConfigViewProvider;
    let configManager: MirrordConfigManager;
    let mockWebviewView: vscode.WebviewView;

    setup(() => {
        configManager = MirrordConfigManager.getInstance();
        
        // Create a mock webview view
        mockWebviewView = {
            webview: {
                options: {},
                html: '',
                postMessage: () => Promise.resolve(true),
                onDidReceiveMessage: () => ({ dispose: () => {} })
            },
            onDidDispose: () => ({ dispose: () => {} }),
            onDidChangeVisibility: () => ({ dispose: () => {} }),
            visible: true,
            show: () => {},
            badge: undefined,
            viewType: 'mirrord.configView'
        } as unknown as vscode.WebviewView;

        configViewProvider = new MirrordConfigViewProvider(
            vscode.Uri.file(__dirname),
            configManager
        );
    });

    test('ConfigView should be created successfully', () => {
        assert.ok(configViewProvider);
        assert.strictEqual(MirrordConfigViewProvider.viewType, 'mirrord.configView');
    });

    test('ConfigView should resolve webview view', () => {
        const mockContext = {} as vscode.WebviewViewResolveContext;
        const mockToken = {} as vscode.CancellationToken;

        // This should not throw
        configViewProvider.resolveWebviewView(mockWebviewView, mockContext, mockToken);
        
        // Verify that the webview HTML is set
        assert.ok(mockWebviewView.webview.html.length > 0);
        assert.ok(mockWebviewView.webview.html.includes('Active Configuration:'));
    });

    test('ConfigView should handle active config changes', async () => {
        const mockContext = {} as vscode.WebviewViewResolveContext;
        const mockToken = {} as vscode.CancellationToken;

        let messageSent = false;
        mockWebviewView.webview.postMessage = (message: { type: string; configPath: string }) => {
            messageSent = true;
            assert.strictEqual(message.type, 'update');
            assert.ok('configPath' in message);
            return Promise.resolve(true);
        };

        configViewProvider.resolveWebviewView(mockWebviewView, mockContext, mockToken);

        // Wait a bit for the ready message to be processed
        await new Promise(resolve => setTimeout(resolve, 100));

        // Verify that a message was sent
        assert.ok(messageSent, 'Webview should have received an update message');
    });
}); 