import type { Principal } from '@icp-sdk/core/principal';
import type { ActorMethod } from '@icp-sdk/core/agent';
import type { IDL } from '@icp-sdk/core/candid';

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
  'getVapidPublicKey': ActorMethod<[Principal], string>,
  'hasSubscription': ActorMethod<[Principal, string], boolean>,
  'listRelayers': ActorMethod<[], Array<RelayerInfo>>,
  'subscribe': ActorMethod<[Principal, Subscription], undefined>,
  'unsubscribe': ActorMethod<[Principal, string], undefined>,
  'unsubscribeAll': ActorMethod<[Principal], undefined>,
}

export declare const idlFactory: IDL.InterfaceFactory;
export declare const init: (args: { IDL: typeof IDL }) => IDL.Type[];
