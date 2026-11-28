import * as assert from 'node:assert/strict';
import { approvalUrl, cliErrorText, LOGIN_EXPIRED_CODE, loginSummary, parseCliError, parseWhoami, TOO_OLD_CLI, Whoami, whoamiFailure } from '../../cliOutput';

const EXPIRED = 'Your login to mirrord.corp.example.com expired. Run mirrord login --url https://mirrord.corp.example.com.';

function whoami(overrides: Partial<Whoami> = {}): Whoami {
  return {
    operators: [
      {
        url: 'https://mirrord.corp.example.com',
        host: 'mirrord.corp.example.com',
        account: 'dev@corp.example.com',
        expiresAt: '2027-01-15T14:00:00Z',
        expiresIn: 'in 6 hours',
        active: true,
      },
    ],
    activeOperator: 'https://mirrord.corp.example.com',
    kubeContext: 'staging-eu',
    cloud: null,
    ...overrides,
  };
}

describe('parseCliError', () => {
  it('reads the expired-login code the CLI puts on the JSON error', () => {
    const stderr = `Error: {"message": "${EXPIRED}","code": "${LOGIN_EXPIRED_CODE}","severity": "error","causes": [],"help": "see mirrord whoami"}\n`;

    assert.deepEqual(parseCliError(stderr), { message: EXPIRED, help: 'see mirrord whoami', code: LOGIN_EXPIRED_CODE });
  });

  it('reads errors of older CLIs, which carry no code', () => {
    const stderr = `Error: {"message": "${EXPIRED}","severity": "error","causes": [],"help": "see mirrord whoami"}`;

    assert.deepEqual(parseCliError(stderr), { message: EXPIRED, help: 'see mirrord whoami', code: undefined });
  });

  it('keeps an error line that holds no JSON as the message', () => {
    assert.deepEqual(parseCliError('Error: something broke'), { message: 'something broke' });
  });

  it('finds nothing when stderr holds no error', () => {
    assert.equal(parseCliError('2026-11-28 INFO starting\n'), undefined);
  });
});

describe('parseWhoami', () => {
  it('reads mirrord whoami -o json', () => {
    assert.deepEqual(parseWhoami(JSON.stringify(whoami())), whoami());
  });

  it('gives nothing for a CLI too old for -o json, which prints its usage error', () => {
    assert.equal(parseWhoami("error: unexpected argument '-o' found\n\nUsage: mirrord whoami\n"), undefined);
  });
});

describe('loginSummary', () => {
  const now = new Date('2027-01-15T08:00:00Z');
  const iso = (time: Date) => time.toISOString();

  it('names the operator in use, the account and when the login ends', () => {
    assert.equal(
      loginSummary(whoami(), now, iso),
      'Logged in to mirrord.corp.example.com as dev@corp.example.com, until 2027-01-15T14:00:00.000Z',
    );
  });

  /** The line is computed when shown, so a login that ended while the IDE was open reads as expired. */
  it('says the login in use expired once its end has passed', () => {
    assert.equal(loginSummary(whoami(), new Date('2027-01-15T14:00:01Z'), iso), 'Your login to mirrord.corp.example.com expired');
  });

  it('names the kubeconfig context when saved logins exist but none is in use', () => {
    const [operator] = whoami().operators;
    assert.ok(operator);
    assert.equal(
      loginSummary(whoami({ operators: [{ ...operator, active: false }], activeOperator: null }), now, iso),
      'No operator login in use, mirrord uses your kubeconfig context staging-eu',
    );
  });

  it('shows nothing to users who never logged in to an operator', () => {
    assert.equal(loginSummary(whoami({ operators: [], activeOperator: null }), now, iso), undefined);
  });
});

describe('whoamiFailure', () => {
  it('asks for a newer CLI when the CLI rejects -o', () => {
    assert.equal(whoamiFailure("error: unexpected argument '-o' found\n\nUsage: mirrord whoami\n"), TOO_OLD_CLI);
  });

  /** A current CLI that cannot read the login store is not told to update. */
  it('shows any other failure in the CLI\'s words', () => {
    assert.equal(
      whoamiFailure('Error:   × failed to read ~/.mirrord/auth.json: permission denied\n'),
      'mirrord whoami failed: failed to read ~/.mirrord/auth.json: permission denied',
    );
  });
});

describe('cliErrorText', () => {
  it('turns the error the CLI prints for a person into one line', () => {
    const stderr = 'Error:   × You are not logged in to mirrord.corp.example.com.\n  help: Run mirrord whoami to see your logins.\n';

    assert.equal(
      cliErrorText(stderr),
      'You are not logged in to mirrord.corp.example.com. help: Run mirrord whoami to see your logins.',
    );
  });

  it('drops terminal colors', () => {
    assert.equal(cliErrorText('\u001b[31mError:\u001b[0m   × broke'), 'broke');
  });
});

describe('approvalUrl', () => {
  it('takes the login page from the task mirrord login starts while it waits for the browser', () => {
    const name = 'Approve the login in your browser. If it does not open, visit:\n\nhttps://mirrord.corp.example.com/apis/operator.metalbear.co/sso/authorize?code_challenge=abc&state=xyz\n';

    assert.equal(approvalUrl(name), 'https://mirrord.corp.example.com/apis/operator.metalbear.co/sso/authorize?code_challenge=abc&state=xyz');
  });

  it('finds nothing in other task names', () => {
    assert.equal(approvalUrl('Exchanging grant for the login token'), undefined);
  });
});
