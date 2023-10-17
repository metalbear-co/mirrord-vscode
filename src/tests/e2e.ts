import { expect } from "chai";
import { join } from "path";
import { VSBrowser, StatusBar, ActivityBar, DebugView, InputBox, DebugToolbar, BottomBarPanel, EditorView } from "vscode-extension-tester";
import get from "axios";

const kubeService = process.env.KUBE_SERVICE;
const podToSelect = process.env.POD_TO_SELECT;


/**
 * This suite tests basic flow of mirroring traffic from remote pod.
 * - Enable mirrord
 * - Start debugging the python file
 * - Select the pod from the QuickPick
 * - Send traffic to the pod
 * - Tests successfully exit if "GET: Request completed" is found in the terminal
*/
describe("mirrord sample flow test", function() {

  this.timeout("6 minutes"); // --> mocha tests timeout
  this.bail(true); // --> stop tests on first failure

  let browser: VSBrowser;

  const testWorkspace = join(__dirname, '../../test-workspace');
  const fileName = "app_flask.py";
  const defaultTimeout = 10000; // = 10 seconds

  before(async function() {
    console.log("podToSelect: " + podToSelect);
    console.log("kubeService: " + kubeService);

    expect(podToSelect).to.not.be.undefined;
    expect(kubeService).to.not.be.undefined;

    browser = VSBrowser.instance;

    await browser.openResources(testWorkspace, join(testWorkspace, fileName));
    await browser.waitForWorkbench();

    const ew = new EditorView();
    try {
      await ew.closeEditor('Welcome');
    } catch (error) {
      console.log("Welcome page is not displayed" + error);
      // continue - Welcome page is not displayed
    }
    await ew.openEditor('app_flask.py');
  });

  it("enable mirrord button", async function() {
    const statusBar = new StatusBar();

    await browser.driver.wait(async () => {
      return await statusBar.isDisplayed();
    });

    // vscode refreshes the status bar on load and there is no deterministic way but to retry to click on
    // the mirrord button after an interval
    await browser.driver.wait(async () => {
      let retries = 0;
      while (retries < 3) {
        try {
          for (let button of await statusBar.getItems()) {
            if ((await button.getText()).startsWith('mirrord')) {
              await button.click();
              return true;
            }
          }
        } catch (e) {
          if (e instanceof Error && e.name === 'StaleElementReferenceError') {
            await new Promise(resolve => setTimeout(resolve, 1000));
            retries++;
          } else {
            throw e;
          }
        }
      }
      throw new Error('Failed to click the button after multiple attempts');
    }, defaultTimeout, "mirrord `enable` button not found -- timed out");
  });

  it("select pod from quickpick", async function() {
    await startDebugging();
    const inputBox = await InputBox.create(defaultTimeout * 2);
    // assertion that podToSelect is not undefined is done in "before" block
    await browser.driver.wait(async () => {
      if (!await inputBox.isDisplayed()) {
        return false;
      }

      for (const pick of await inputBox.getQuickPicks()) {
        let label = await pick.getLabel();

        if (label === podToSelect) {
          return true;
        }
        // to pick up the podToSelect, we need to select the "Show Pods"
        // from quickpick as pods are not displayed first
        if (label === "Show Pods") {
          await pick.select();
        }
      }

      return false;
    }, defaultTimeout * 2, "quickPick not found -- timed out");

    await inputBox.selectQuickPick(podToSelect!);
  });

  it("wait for process to write to terminal", async function() {
    const debugToolbar = await DebugToolbar.create(2 * defaultTimeout);
    const panel = new BottomBarPanel();
    await browser.driver.wait(async () => {
      return await debugToolbar.isDisplayed();
    }, 2 * defaultTimeout, "debug toolbar not found -- timed out");


    let terminal = await panel.openTerminalView();

    await browser.driver.wait(async () => {
      const text = await terminal.getText();
      return await terminal.isDisplayed() && text.includes("Press CTRL+C to quit");
    }, 2 * defaultTimeout, "terminal text not found -- timed out");

    await sendTrafficToPod();

    await browser.driver.wait(async () => {
      const text = await terminal.getText();
      return text.includes("GET: Request completed");
    }, defaultTimeout, "terminal text not found -- timed out");

  });
});


/**
 * sends a GET request to the pod's nodePort
 */
async function sendTrafficToPod() {
  const response = await get(kubeService!!);
  expect(response.status).to.equal(200);
  expect(response.data).to.equal("OK - GET: Request completed\n");
}

/**
 * starts debugging the current file with the provided configuration
 * debugging starts from the "Run and Debug" button in the activity bar
*/
async function startDebugging(configurationFile: string = "Python: Current File") {
  const activityBar = await new ActivityBar().getViewControl("Run and Debug");
  expect(activityBar).to.not.be.undefined;
  const debugView = await activityBar?.openView() as DebugView;
  await debugView.selectLaunchConfiguration(configurationFile);
  await debugView.start();
}
