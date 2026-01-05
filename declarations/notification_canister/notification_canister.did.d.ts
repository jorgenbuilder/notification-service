import type { Principal } from '@dfinity/principal';
import type { ActorMethod } from '@dfinity/agent';
import type { IDL } from '@dfinity/candid';

export interface HttpRequest {
  'url' : string,
  'method' : string,
  'body' : Uint8Array | number[],
  'headers' : Array<[string, string]>,
}
export interface HttpResponse {
  'body' : Uint8Array | number[],
  'headers' : Array<[string, string]>,
  'status_code' : number,
}
export interface Notification {
  'context' : [Principal, Principal],
  'subscription' : Subscription,
  'body' : NotificationBody,
}
export interface NotificationBody {
  'url' : [] | [string],
  'title' : string,
  'content' : string,
}
export interface NotificationCanister {
  'collect' : ActorMethod<[], Array<Notification>>,
  'deregisterApplication' : ActorMethod<[Principal], undefined>,
  'getVapidPublicKey' : ActorMethod<[], string>,
  'hasSubscription' : ActorMethod<[Principal, string], boolean>,
  'http_request' : ActorMethod<[HttpRequest], HttpResponse>,
  'isQueueEmpty' : ActorMethod<[], boolean>,
  'registerApplication' : ActorMethod<[Principal], undefined>,
  'reportBrokenSubscription' : ActorMethod<
    [Principal, Principal, string],
    undefined
  >,
  'sendNotification' : ActorMethod<[Principal, NotificationBody], bigint>,
  'subscribe' : ActorMethod<[Principal, Subscription], undefined>,
  'unsubscribe' : ActorMethod<[Principal, string], undefined>,
  'unsubscribeAll' : ActorMethod<[Principal], undefined>,
}
export interface Subscription {
  'endpoint' : string,
  'keys' : { 'auth' : string, 'p256dh' : string },
  'expirationTime' : [] | [bigint],
}
export interface _SERVICE extends NotificationCanister {}
export declare const idlFactory: IDL.InterfaceFactory;
export declare const init: (args: { IDL: typeof IDL }) => IDL.Type[];
