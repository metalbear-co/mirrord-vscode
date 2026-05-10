import * as vscode from 'vscode';
import { globalContext } from './extension';
import { NotificationBuilder } from './notification';
import { MirrordStatus } from './status';

const RUN_COUNTER = 'mirrord-for-teams-counter';
const NOTIFICATION_STARTS_AT = 100;
const NOTIFICATION_REPEATS_EVERY = 30;

const OPERATOR_USED = 'mirrord-operator-used';

async function showMirrordForTeamsNotification(message: string) {
  new NotificationBuilder()
    .withMessage(message)
    .withGenericAction("Try it now", async () => {
      await vscode.commands.executeCommand(MirrordStatus.mirrordForTeamsCommandId);
    })
    .withDisableAction("promptMirrordForTeams")
    .info();
}

export function tickMirrordForTeamsCounter() {
  const counter = parseInt(globalContext.globalState.get(RUN_COUNTER) ?? '0') || 0;
  const operatorUsed = globalContext.globalState.get<boolean>(OPERATOR_USED) ?? false;

  if (counter >= NOTIFICATION_STARTS_AT) {
    if (((counter - NOTIFICATION_STARTS_AT) % NOTIFICATION_REPEATS_EVERY === 0) && !operatorUsed) {
      showMirrordForTeamsNotification(
        'mirrord for Teams unlocks team workflow features: DB branching for parallel devs, preview environments for branch testing, and shared targets with queue splitting.'
      );
    }
  }

  globalContext.globalState.update(RUN_COUNTER, `${counter + 1}`);
}

export function setOperatorUsed() {
  globalContext.globalState.update(OPERATOR_USED, true);
}

export function getOperatorUsed(): boolean {
  return globalContext.globalState.get<boolean>(OPERATOR_USED) ?? false;
}
