import type { Principal } from '@dfinity/principal';
import type { ActorMethod } from '@dfinity/agent';
import type { IDL } from '@dfinity/candid';

export interface NotificationCanister {
  'getVapidPublicKey': ActorMethod<[], string>,
  'hasSubscription' : ActorMethod<[Principal, string], boolean>,
  'subscribe': ActorMethod<[Principal, Subscription], undefined>,
  'unsubscribe': ActorMethod<[Principal, string], undefined>,
  'unsubscribeAll': ActorMethod<[Principal], undefined>,
}

export interface Subscription {
  'endpoint': string,
  'keys': { 'auth': string, 'p256dh': string },
  'expirationTime': [] | [bigint],
}

export interface _SERVICE extends NotificationCanister {
}

export declare const idlFactory: IDL.InterfaceFactory;
export declare const init: (args: { IDL: typeof IDL }) => IDL.Type[];
