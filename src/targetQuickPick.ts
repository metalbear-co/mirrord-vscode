import * as vscode from 'vscode';
import { MirrordLsOutput } from './api';
import { globalContext } from './extension';
import { NotificationBuilder } from './notification';

/// Key used to store the last selected target in the persistent state.
const LAST_TARGET_KEY = "mirrord-last-target";

type TargetQuickPickPage = {
    label: string,
    targetType?: string,
};

const ALL_QUICK_PICK_PAGES: TargetQuickPickPage[] = [
    {
        label: 'Show Deployments',
        targetType: 'deployment',
    },
    {
        label: 'Show Rollouts',
        targetType: 'rollouts',
    },
    {
        label: 'Show Pods',
        targetType: 'pods',
    },
    {
        label: 'Switch Namespace',
    },
];

type TargetQuickPickItem = vscode.QuickPickItem & (
    { type: 'target', value?: string } |
    { type: 'namespace', value: string } |
    { type: 'page', value: TargetQuickPickPage }
);

const TARGETLESS_ITEM: TargetQuickPickItem = {
    type: 'target',
    label: 'No Target (\"targetless\")',
};

export type TargetFetcher = (namespace?: string) => Thenable<MirrordLsOutput>;

export type UserSelection = {
    path?: string,
    namespace?: string,
};

export class TargetQuickPick {
    private lsOutput: MirrordLsOutput;
    private activePage?: TargetQuickPickPage;
    private readonly lastTarget?: string;
    private readonly getTargets: TargetFetcher;

    private constructor(getTargets: TargetFetcher, lsOutput: MirrordLsOutput) {
        this.lastTarget = globalContext.workspaceState.get(LAST_TARGET_KEY) || globalContext.globalState.get(LAST_TARGET_KEY);
        this.lsOutput = lsOutput;
        this.getTargets = getTargets;
        this.activePage = this.getDefaultPage();
    }

    static async new(getTargets: (namespace?: string) => Thenable<MirrordLsOutput>): Promise<TargetQuickPick> {
        const getFilteredTargets = async (namespace?: string) => {
            const output = await getTargets(namespace);
            output.targets = output.targets.filter(t => {
                if (!t.available) {
                    return false;
                }
                const targetType = t.path.split('/')[0];
                return ALL_QUICK_PICK_PAGES.find(p => p.targetType === targetType) !== undefined;
            });
            return output;
        };

        const lsOutput = await getFilteredTargets();

        return new TargetQuickPick(getFilteredTargets, lsOutput);
    }

    getDefaultPage(): TargetQuickPickPage | undefined {
        let page: TargetQuickPickPage | undefined;

        const lastTargetType = this.lastTarget?.split('/')[0];
        if (lastTargetType !== undefined) {
            page = ALL_QUICK_PICK_PAGES.find(p => p.targetType === lastTargetType);
        }

        if (page === undefined) {
            page = this
                .lsOutput
                .targets
                .map(t => {
                    const targetType = t.path.split('/')[0] ?? '';
                    return ALL_QUICK_PICK_PAGES.find(p => p.targetType === targetType);
                })
                .find(p => p !== undefined);
        }

        return page;
    }

    prepareQuickPick(): [string, TargetQuickPickItem[]] {
        let items: TargetQuickPickItem[];
        let placeholder: string;

        if (this.activePage === undefined) {
            items = [TARGETLESS_ITEM];

            if (this.lsOutput.namespaces !== undefined) {
                const switchNamespacePage = ALL_QUICK_PICK_PAGES.find(p => p.targetType === undefined)!;
                items.push({
                    type: 'page',
                    value: switchNamespacePage,
                    label: switchNamespacePage.label,
                });
            }

            placeholder = "No available targets";
        } else if (this.activePage.targetType === undefined) {
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

            ALL_QUICK_PICK_PAGES
                .filter(p => {
                    p.targetType !== undefined
                        && this.lsOutput.targets.find(t => t.path.startsWith(`${p.targetType}/`)) !== undefined;
                })
                .forEach(p => {
                    items.push({
                        type: 'page',
                        value: p,
                        label: p.label,
                    });
                });

            placeholder = "Switch to another namespace";
        } else {
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

            const redirects = ALL_QUICK_PICK_PAGES
                .filter(p => {
                    p.targetType === undefined
                        || this.lsOutput.targets.find(t => t.path.startsWith(`${p.targetType}/`)) !== undefined;
                })
                .forEach(p => {
                    items.push({
                        type: 'page',
                        value: p,
                        label: p.label,
                    });
                });

            placeholder = "Select a target";
        }

        if (this.lsOutput.current_namespace !== undefined) {
            placeholder += ` (current namespace: ${this.lsOutput.current_namespace})`;
        }

        return [placeholder, items];
    }

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
                    this.lsOutput = await this.getTargets(newSelection.value);
                    this.activePage = this.getDefaultPage();
                    break;

                case 'page':
                    this.activePage = newSelection.value;
                    break;

                case undefined:
                    new NotificationBuilder()
                        .withMessage("mirrord running targetless")
                        .withDisableAction("promptTargetless")
                        .info();

                    return { namespace: this.lsOutput.current_namespace };
            }
        }
    }
}
