import { AuthProvider, AuthContext } from './auth_provider';
import { MongoError } from '../../error';
import { Kerberos } from '../../deps';
import type { Callback } from '../../utils';
import type { HandshakeDocument } from '../connect';

const kGssapiClient = Symbol('GSSAPI_CLIENT');

import * as dns from 'dns';

interface KerberosClient {
  step: (challenge: string, callback?: Callback<string>) => Promise<string> | void;
  wrap: (
    challenge: string,
    options?: { user: string },
    callback?: Callback<string>
  ) => Promise<string> | void;
  unwrap: (challenge: string, callback?: Callback<string>) => Promise<string> | void;
}
interface GSSAPIContext {
  host: string;
  port: string | number;
  serviceName: string;
  canonicalizeHostName: boolean;
  retries: number;
  username: string;
  password: string;
  client: KerberosClient;
}

export class GSSAPI extends AuthProvider {
  [kGssapiClient]: KerberosClient;
  prepare(
    handshakeDoc: HandshakeDocument,
    authContext: AuthContext,
    callback: Callback<HandshakeDocument>
  ): void {
    const { host, port } = authContext.options;
    const { credentials } = authContext;
    if (!host || !port || !credentials) {
      return callback(
        new MongoError(
          `Connection must specify: ${host ? 'host' : ''}, ${port ? 'port' : ''}, ${
            credentials ? 'host' : 'credentials'
          }.`
        )
      );
    }

    if ('kModuleError' in Kerberos) {
      return callback(Kerberos['kModuleError']);
    }

    const { username, password, mechanismProperties } = credentials;
    const serviceName =
      mechanismProperties['gssapiservicename'] ||
      mechanismProperties['gssapiServiceName'] ||
      'mongodb';
    const canonicalizeHostName =
      typeof mechanismProperties.gssapiCanonicalizeHostName === 'boolean'
        ? mechanismProperties.gssapiCanonicalizeHostName
        : false;

    performGssapiCanonicalizeHostName(
      canonicalizeHostName,
      host,
      (err?: Error | MongoError, host?: string) => {
        if (err) return callback(err);

        const initOptions = {};
        if (password != null) {
          Object.assign(initOptions, { user: username, password: password });
        }

        Kerberos.initializeClient(
          `${serviceName}${process.platform === 'win32' ? '/' : '@'}${host}`,
          initOptions,
          (err: string, client: KerberosClient): void => {
            if (err) return callback(new Error(err));
            if (client == null) return callback(new Error('null gssapi client'));
            this[kGssapiClient] = client;
            callback(undefined, handshakeDoc);
          }
        );
      }
    );
  }

  auth(authContext: AuthContext, callback: Callback): void {
    const { connection, credentials } = authContext;
    if (credentials == null) return callback(new Error('credentials required'));
    const { username } = credentials;
    const client = this[kGssapiClient];
    if (client == null) return callback(new Error('gssapi client missing'));
    function externalCommand(
      command: object,
      cb: (
        err: Error | MongoError | undefined,
        result: { result: { payload: string; conversationId: any } }
      ) => void
    ) {
      return connection.command('$external.$cmd', command, cb);
    }
    client.step('', (err, payload) => {
      if (err) return callback(err);

      externalCommand(saslStart(payload), (err, result) => {
        if (err) return callback(err);

        const doc = result.result;
        negotiate(client, 10, doc.payload, (err, payload) => {
          if (err) return callback(err);

          externalCommand(saslContinue(payload, doc.conversationId), (err, result) => {
            if (err) return callback(err);

            const doc = result.result;
            finalize(client, username, doc.payload, (err, payload) => {
              if (err) return callback(err);

              externalCommand(
                {
                  saslContinue: 1,
                  conversationId: doc.conversationId,
                  payload
                },
                (err, result) => {
                  if (err) return callback(err);

                  callback(undefined, result.result);
                }
              );
            });
          });
        });
      });
    });
  }
}
function saslStart(payload?: string): object {
  return {
    saslStart: 1,
    mechanism: 'GSSAPI',
    payload,
    autoAuthorize: 1
  };
}

function saslContinue(payload?: string, conversationId?: number): object {
  return {
    saslContinue: 1,
    conversationId,
    payload
  };
}

function negotiate(
  client: KerberosClient,
  retries: number,
  payload: string,
  callback: Callback<string>
) {
  client.step(payload, (err, response) => {
    if (err && retries === 0) return callback(err);

    // Attempt to re-establish a context
    if (err) {
      // Adjust the number of retries
      // Call same step again
      return negotiate(client, retries - 1, payload, callback);
    }

    // Return the payload
    callback(undefined, response || '');
  });
}

function finalize(
  client: KerberosClient,
  user: string,
  payload: string,
  callback: Callback<string>
) {
  // GSS Client Unwrap
  client.unwrap(payload, (err, response) => {
    if (err) return callback(err);

    // Wrap the response
    client.wrap(response || '', { user }, (err, wrapped) => {
      if (err) return callback(err);

      // Return the payload
      callback(undefined, wrapped);
    });
  });
}

function performGssapiCanonicalizeHostName(
  canonicalizeHostName: boolean,
  host: string,
  callback: Callback<string>
) {
  if (!canonicalizeHostName) return callback(undefined, host);

  // Attempt to resolve the host name
  dns.resolveCname(host, (err: Error | null, r: string[]) => {
    if (err) return callback(err);

    // Get the first resolve host id
    if (Array.isArray(r) && r.length > 0) {
      return callback(undefined, r[0]);
    }

    callback(undefined, host);
  });
}
