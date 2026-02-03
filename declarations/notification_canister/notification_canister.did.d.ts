import type { Principal } from '@dfinity/principal';
import type { ActorMethod } from '@dfinity/agent';
import type { IDL } from '@dfinity/candid';

export interface EncryptedNotification {
  'context': [Principal, Principal],
  'endpoint': string,
  'encrypted': [] | [
    {
      'cipherText': Uint8Array | number[],
      'salt': Uint8Array | number[],
      'localPublicKey': Uint8Array | number[],
    }
  ],
  'contentEncoding': { 'aesgcm': null } |
    { 'aes128gcm': null },
}

export interface NotificationBody {
  'tag': [] | [string],
  'url': [] | [string],
  'title': string,
  'content': string,
}

export interface RelayerInfo {
  'relayer': Principal,
  'description': string,
  'lastUpdatedAt': bigint,
  'vapid_public_key': string,
  'registeredAt': bigint,
}

export interface Subscription {
  'endpoint': string,
  'keys': SubscriptionKeys,
  'relayer': Principal,
  'expirationTime': [] | [bigint],
}

export interface SubscriptionKeys {
  'auth': string,
  'p256dh': string
}

export interface _SERVICE {
  /**
   * end-user interface
   */
  'getVapidPublicKey': ActorMethod<[Principal], string>,
  'hasSubscription': ActorMethod<[Principal, string], boolean>,
  'listRelayers': ActorMethod<[], Array<RelayerInfo>>,
  'subscribe': ActorMethod<[Principal, Subscription], undefined>,
  'unsubscribe': ActorMethod<[Principal, string], undefined>,
  'unsubscribeAll': ActorMethod<[Principal], undefined>,
  /**
   * admin interface
   */
  'registerRelayer': ActorMethod<[Principal, string, string], undefined>,
  /**
   * app owner interface
   */
  'sendNotifications': ActorMethod<
    [Array<[Principal, NotificationBody]>],
    Array<boolean>
  >,
  /**
   * relayer interface
   */
  'updateRelayer': ActorMethod<[string, string], undefined>,
  'peekQueue': ActorMethod<
    [bigint],
    { 'items': Array<EncryptedNotification>, 'drained': boolean }
  >,
  'popQueue': ActorMethod<[bigint], undefined>,
  'reportBrokenSubscriptions': ActorMethod<
    [
      Array<
        { 'application': Principal, 'endpoint': string, 'user': Principal }
      >,
    ],
    undefined
  >,
}
export declare const idlFactory: IDL.InterfaceFactory;
export declare const init: (args: { IDL: typeof IDL }) => IDL.Type[];
