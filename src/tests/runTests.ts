import * as path from 'path';
import { ExTester, ReleaseQuality } from 'vscode-extension-tester';

// Note: we are using our fork https://github.com/infiniteregrets/vscode-extension-tester/tree/input-box 
// which allows to increase timeout for InputBox.create(), to be removed when
// https://github.com/redhat-developer/vscode-extension-tester/issues/485#issuecomment-1648050797 is fixed

async function main(): Promise<void> {
    const version = "latest";
    const testPath = path.join(__dirname, 'e2e.js');
    const storageFolder = path.join(__dirname, '..', 'storage');
    const extFolder = path.join(__dirname, '..', 'extensions');
    
    // required extension for debugging a python file
    const requiredExtension = "ms-python.python";

    try {
        console.log(`Running tests from ${testPath}`);
        const exTester = new ExTester(storageFolder, ReleaseQuality.Stable, extFolder);
        await exTester.downloadCode(version);
        await exTester.installVsix({ useYarn: false });
        await exTester.installFromMarketplace(requiredExtension);
        await exTester.downloadChromeDriver(version);
        const result = await exTester.runTests(testPath, {
            vscodeVersion: version,
            resources: [storageFolder],
        });

        process.exit(result);
    } catch (err) {
        console.log(err);
        process.exit(1);
    }
}

main();