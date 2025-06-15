import * as vscode from 'vscode';
import { MirrordLsOutput } from './api';
import { globalContext } from './extension';
import { NotificationBuilder } from './notification';

type Thenable<T> = Promise<T>;

/// Key used to store the last selected target in the persistent state.
const LAST_TARGET_KEY = "mirrord-last-target";

/**
 * A page in the @see TargetQuickPick.
 */
interface TargetQuickPickPage {
    /**
     * Label to display in the widget.
     */
    label: string,
    /**
     * Prefix of targets visible on this page, mirrord config format.
     * 
     * undefined **only** for namespace selection page.
     */
    targetType?: string,
}

/**
 * Namespace selection page in the @see TargetQuickPick.
 */
const NAMESPACE_SELECTION_PAGE: TargetQuickPickPage = {
    label: 'Select Another Namespace',
};

/**
 * Target selection pages in the @see TargetQuickPick.
 */
const TARGET_SELECTION_PAGES: (TargetQuickPickPage & { targetType: string })[] = [
    {
        label: 'Show Deployments',
        targetType: 'deployment',
    },
    {
        label: 'Show Rollouts',
        targetType: 'rollout',
    },
    {
        label: 'Show Pods',
        targetType: 'pod',
    },
];

/**
 * An item in the @see TargetQuickPick.
 */
type TargetQuickPickItem = vscode.QuickPickItem & (
    { type: 'target', value: string } | // select target
    { type: 'namespace', value: string } | // switch to another namespace
    { type: 'page', value: TargetQuickPickPage } // switch to another page (e.g select pod -> select deployment)
);

/**
 * The item in the @see TargetQuickPick that represents the targetless mode.
 */
const TARGETLESS_ITEM: TargetQuickPickItem = {
    type: 'target',
    label: 'No Target ("targetless")',
    value: 'targetless',
};

/**
 * A function used by @see TargetQuickPick to invoke `mirrord ls` in the given namespace.
 */
export type TargetFetcher = (namespace?: string) => Thenable<MirrordLsOutput>;

/**
 * Describes what the user has selected with the @see TargetQuickPick.
 */
export interface UserSelection {
    /**
     * Selected target.
     */
    path: string,
    /**
     * Selected namespace.
     * 
     * undefined if the CLI does not support listing namespaces.
     */
    namespace?: string,
}

/**
 * A quick pick allowing the user to select the target and, if the CLI supports listing namepaces, switch the namespace.
 */
export class TargetQuickPick {
    /**
     * Output of the last `mirrord ls` invocation.
     * 
     * Should contain only targets that are available and supported by this widget (deployments, rollouts and pods).
     */
    private lsOutput: MirrordLsOutput;
    /**
     * The page we are currently displaying.
     */
    private activePage?: TargetQuickPickPage;
    /**
     * Target that was selected most recently by the user.
     * 
     * This target, if present in @see lsOutput, is put first on its page.
     * Also, determines initial page.
     */
    private readonly lastTarget?: string;
    /**
     * Function used to invoke `mirrord ls` and get its output.
     * 
     * Should return only targets that are available and supported by this widget (deployments, rollouts and pods).
     */
    private readonly getTargets: TargetFetcher;

    private constructor(getTargets: TargetFetcher, lsOutput: MirrordLsOutput) {
        this.lastTarget = globalContext.workspaceState.get(LAST_TARGET_KEY) || globalContext.globalState.get(LAST_TARGET_KEY);
        this.lsOutput = lsOutput;
        this.getTargets = getTargets;
    }

    /**
     * Creates a new instance of this quick pick.
     * 
     * This quick pick can be executed using @see showAndGet.
     */
    static async new(getTargets: (namespace?: string) => Thenable<MirrordLsOutput>): Promise<TargetQuickPick> {
        const getFilteredTargets = async (namespace?: string) => {
            const output = await getTargets(namespace);
            output.targets = output.targets.filter((t: { available: boolean; path: string }) => {
                if (!t.available) {
                    return false;
                }
                const targetType = t.path.split('/')[0];
                return TARGET_SELECTION_PAGES.find(p => p.targetType === targetType) !== undefined;
            });
            return output;
        };

        const lsOutput = await getFilteredTargets();

        return new TargetQuickPick(getFilteredTargets, lsOutput);
    }

    /**
     * Returns whether @see lsOutput has at least one target of this type.
     */
    private hasTargetOfType(targetType: string): boolean {
        return this.lsOutput.targets.find(t => t.path.startsWith(`${targetType}/`)) !== undefined;
    }

    /**
     * Returns a default page to display. undefined if @see lsOutput contains no targets.
     */
    private getDefaultPage(): TargetQuickPickPage | undefined {
        let page: TargetQuickPickPage | undefined;

        const lastTargetType = this.lastTarget?.split('/')[0];
        if (lastTargetType !== undefined && this.hasTargetOfType(lastTargetType)) {
            page = TARGET_SELECTION_PAGES.find(p => p.targetType === lastTargetType);
        }

        if (page === undefined) {
            page = this
                .lsOutput
                .targets
                .map(t => {
                    const targetType = t.path.split('/')[0] ?? '';
                    return TARGET_SELECTION_PAGES.find(p => p.targetType === targetType);
                })
                .find(p => p !== undefined);
        }

        return page;
    }

    /**
     * Prepares a placeholder and items for the quick pick.
     */
    private prepareQuickPick(): [string, TargetQuickPickItem[]] {
        if (this.activePage === undefined) {
            this.activePage = this.getDefaultPage();
        }

        let items: TargetQuickPickItem[];
        let placeholder: string;

        if (this.activePage === undefined) {
            placeholder = "No available targets";
            if (this.lsOutput.current_namespace !== undefined) {
                placeholder += ` in ${this.lsOutput.current_namespace}`;
            }

            items = [TARGETLESS_ITEM];

            if (this.lsOutput.namespaces !== undefined) {
                items.push({
                    type: 'page',
                    value: NAMESPACE_SELECTION_PAGE,
                    label: NAMESPACE_SELECTION_PAGE.label,
                });
            }
        } else if (this.activePage.targetType === undefined) {
            placeholder = "Select another namespace";
            if (this.lsOutput.current_namespace !== undefined) {
                placeholder += ` (current: ${this.lsOutput.current_namespace})`;
            }

            items = this
                .lsOutput
                .namespaces
                ?.filter(ns => ns !== this.lsOutput.current_namespace)
                .map(ns => {
                    return {
                        type: 'namespace',
                        value: ns,
                        label: ns,
                    };
                }) ?? [];

            TARGET_SELECTION_PAGES
                .filter(p => this.hasTargetOfType(p.targetType))
                .forEach(p => {
                    items.push({
                        type: 'page',
                        value: p,
                        label: p.label,
                    });
                });
        } else {
            placeholder = "Select a target";
            if (this.lsOutput.current_namespace !== undefined) {
                placeholder += ` from ${this.lsOutput.current_namespace}`;
            }

            items = this
                .lsOutput
                .targets
                .filter(t => t.path.startsWith(`${this.activePage?.targetType}/`))
                .map(t => {
                    return {
                        type: 'target',
                        value: t.path,
                        label: t.path,
                    };
                });

            if (this.lastTarget !== undefined) {
                const idx = items.findIndex(i => i.value === this.lastTarget);
                if (idx !== -1) {
                    const removed = items.splice(idx, 1);
                    items = removed.concat(items);
                }
            }

            items.push(TARGETLESS_ITEM);

            TARGET_SELECTION_PAGES
                .filter(p => (p.targetType !== this.activePage?.targetType) && this.hasTargetOfType(p.targetType))
                .forEach(p => {
                    items.push({
                        type: 'page',
                        value: p,
                        label: p.label,
                    });
                });

            if (this.lsOutput.namespaces !== undefined) {
                items.push({
                    type: 'page',
                    value: NAMESPACE_SELECTION_PAGE,
                    label: NAMESPACE_SELECTION_PAGE.label,
                });
            }
        }

        return [placeholder, items];
    }

    /**
     * Shows the quick pick and returns user selection.
     * 
     * If the user selected nothing, returns targetless.
     */
    async showAndGet(): Promise<UserSelection> {
        while (true) {
            const [placeHolder, items] = this.prepareQuickPick();
            const newSelection = await vscode.window.showQuickPick(items, { placeHolder });

            switch (newSelection?.type) {
                case 'target':
                    if (newSelection.value !== undefined) {
                        globalContext.globalState.update(LAST_TARGET_KEY, newSelection.value);
                        globalContext.workspaceState.update(LAST_TARGET_KEY, newSelection.value);
                    }

                    return { path: newSelection.value, namespace: this.lsOutput.current_namespace };

                case 'namespace':
                    await vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: "Fetching targets...",
                        cancellable: false
                    }, async (progress: vscode.Progress<{ increment: number }>) => {
                        progress.report({ increment: 0 });
                        this.lsOutput = await this.getTargets(newSelection.value);
                        progress.report({ increment: 100 });
                    });
                    this.activePage = undefined;
                    break;

                case 'page':
                    this.activePage = newSelection.value;
                    break;

                case undefined:
                    new NotificationBuilder()
                        .withMessage("mirrord running targetless")
                        .withDisableAction("promptTargetless")
                        .info();

                    return { path: 'targetless', namespace: this.lsOutput.current_namespace };
            }
        }
    }

    /**
     * Extract the resource types that the quick pick supports from @see TARGET_SELECTION_PAGES
     */
    static getSupportedTargetTypes(): string[] {
        return TARGET_SELECTION_PAGES.map((page) => page.targetType);
    }
}
