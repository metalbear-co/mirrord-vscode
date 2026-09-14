import * as vscode from 'vscode';
import axios from 'axios';
import { MirrordAPI } from './api';
import { getMirrordBinary, onDidChangeMirrordBinary } from './binaryManager';
import Logger from './logger';

/**
* Scheme of the virtual document that holds the mirrord config JSON schema.
*
* Must match the `onFileSystem:` activation event in `package.json`.
* Thanks to that event, this extension is activated (and the content provider below is registered)
* before VSCode tries to resolve the schema.
*/
const SCHEMA_SCHEME = 'mirrord-schema';

/**
* URI of the virtual document that holds the mirrord config JSON schema.
*
* Must match the `jsonValidation` contribution in `package.json`.
*/
const SCHEMA_URI = vscode.Uri.parse(`${SCHEMA_SCHEME}://mirrord/mirrord-schema.json`);

/**
* Schema of the latest released mirrord config.
*
* Used only as a fallback, when the local binary is too old
* to support the `print-schema` command.
*/
const FALLBACK_SCHEMA_URL = 'https://raw.githubusercontent.com/metalbear-co/mirrord/latest/mirrord-schema.json';

/**
* Timeout for fetching {@link FALLBACK_SCHEMA_URL}.
*/
const FALLBACK_SCHEMA_TIMEOUT_MS = 10000;

/**
* Serves the mirrord config JSON schema to the VSCode JSON language server,
* as the content of the {@link SCHEMA_URI} virtual document.
*
* The schema is produced by the mirrord binary, so that it always matches the version
* of mirrord that the user actually runs.
*/
class MirrordConfigSchemaProvider implements vscode.TextDocumentContentProvider {
  private readonly changeEmitter: vscode.EventEmitter<vscode.Uri>;
  readonly onDidChange: vscode.Event<vscode.Uri>;

  constructor() {
    this.changeEmitter = new vscode.EventEmitter<vscode.Uri>();
    this.onDidChange = this.changeEmitter.event;
  }

  /**
  * Makes VSCode fetch the schema again, e.g. after the mirrord binary was updated.
  */
  refresh(): void {
    this.changeEmitter.fire(SCHEMA_URI);
  }

  async provideTextDocumentContent(): Promise<string> {
    return await schemaFromBinary() ?? await schemaFromGitHub();
  }
}

/**
* Produces the mirrord config JSON schema with the `mirrord print-schema` command.
*
* @returns the schema, or null if we have no usable mirrord binary
*/
async function schemaFromBinary(): Promise<string | null> {
  const binary = await getMirrordBinary(false);
  if (binary === null) {
    Logger.warn(`mirrord config schema: binary not available`);
    return null;
  }

  try {
    const schema = await new MirrordAPI(binary).printSchema();
    Logger.info(`mirrord config schema: taken from ${binary}`);
    return schema;
  } catch (err) {
    // Most likely the binary is too old to support the `print-schema` command.
    const errorMsg = err instanceof Error ? err.message : String(err);
    Logger.warn(`mirrord config schema: \`${binary} print-schema\` failed: ${errorMsg}`);
    return null;
  }
}

/**
* Fetches the mirrord config JSON schema from {@link FALLBACK_SCHEMA_URL}.
*/
async function schemaFromGitHub(): Promise<string> {
  Logger.info(`mirrord config schema: falling back to ${FALLBACK_SCHEMA_URL}`);

  const response = await axios.get(FALLBACK_SCHEMA_URL, {
    timeout: FALLBACK_SCHEMA_TIMEOUT_MS,
    responseType: 'text',
    // Keep the raw text, we only pass it along to the JSON language server.
    transformResponse: (data) => data,
  });

  return response.data as string;
}

/**
* Registers the provider of the mirrord config JSON schema.
*
* Must be called before any mirrord config file is opened.
*/
export function registerConfigSchemaProvider(context: vscode.ExtensionContext) {
  const provider = new MirrordConfigSchemaProvider();

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEMA_SCHEME, provider),
    // The schema comes from the mirrord binary, so it changes when the binary changes.
    onDidChangeMirrordBinary(provider.refresh),
  );
}
