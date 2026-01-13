import type { Principal } from '@dfinity/principal';
import type { ActorMethod } from '@dfinity/agent';
import type { IDL } from '@dfinity/candid';

export interface Notification {
  'context' : { 'application' : Principal, 'receiver' : Principal },
  'subscription' : Subscription,
  'body' : NotificationBody,
}
export interface NotificationBody {
  'tag' : [] | [string],
  'url' : [] | [string],
  'title' : string,
  'content' : string,
}
export interface Subscription {
  'endpoint' : string,
  'keys' : SubscriptionKeys,
  'expirationTime' : [] | [bigint],
}
export interface SubscriptionKeys { 'auth' : string, 'p256dh' : string }
export interface _SERVICE {
  'deregisterApplication' : ActorMethod<[Principal], undefined>,
  /**
   * end-user interface
   */
  'getVapidPublicKey' : ActorMethod<[], string>,
  'hasSubscription' : ActorMethod<[Principal, string], boolean>,
  /**
   * worker interface
   */
  'peekQueue' : ActorMethod<[], Array<Notification>>,
  'popQueue' : ActorMethod<[bigint], undefined>,
  /**
   * admin interface
   */
  'registerApplication' : ActorMethod<[Principal], undefined>,
  'reportBrokenSubscriptions' : ActorMethod<
    [
      Array<
        { 'application' : Principal, 'endpoint' : string, 'user' : Principal }
      >,
    ],
    undefined
  >,
  /**
   * app owner interface
   */
  'sendNotifications' : ActorMethod<
    [Array<[Principal, NotificationBody]>],
    undefined
  >,
  'subscribe' : ActorMethod<[Principal, Subscription], undefined>,
  'unsubscribe' : ActorMethod<[Principal, string], undefined>,
  'unsubscribeAll' : ActorMethod<[Principal], undefined>,
}
export declare const idlFactory: IDL.InterfaceFactory;
export declare const init: (args: { IDL: typeof IDL }) => IDL.Type[];
