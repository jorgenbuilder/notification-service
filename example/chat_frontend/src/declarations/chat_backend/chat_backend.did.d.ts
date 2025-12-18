import type { Principal } from '@dfinity/principal';
import type { ActorMethod } from '@dfinity/agent';
import type { IDL } from '@dfinity/candid';

export type CreateRoomResult = {
    'Ok' : { 'room' : Room, 'sessionId' : SessionId, 'roomCode' : RoomCode }
  } |
  { 'Err' : string };
export type JoinRoomResult = {
    'Ok' : { 'room' : Room, 'sessionId' : SessionId }
  } |
  { 'Err' : string };
export interface Message {
  'id' : bigint,
  'content' : string,
  'sender' : SessionId,
  'timestamp' : bigint,
  'senderName' : string,
}
export interface Room {
  'creator' : SessionId,
  'participants' : Array<User>,
  'messages' : Array<Message>,
  'code' : RoomCode,
  'lastActivity' : bigint,
  'createdAt' : bigint,
}
export type RoomCode = string;
export type SendMessageResult = { 'Ok' : Message } |
  { 'Err' : string };
export type SessionId = string;
export interface User {
  'principal' : Principal,
  'displayName' : string,
  'joinedAt' : bigint,
  'sessionId' : SessionId,
}
export interface _SERVICE {
  'cleanup' : ActorMethod<[], undefined>,
  'createRoom' : ActorMethod<[], CreateRoomResult>,
  'endRoom' : ActorMethod<[RoomCode, SessionId], boolean>,
  'getAllSessions' : ActorMethod<[], Array<[SessionId, User]>>,
  'getDebugInfo' : ActorMethod<[RoomCode], string>,
  'getMessages' : ActorMethod<[RoomCode], Array<Message>>,
  'getRoom' : ActorMethod<[RoomCode], [] | [Room]>,
  'joinRoom' : ActorMethod<[RoomCode], JoinRoomResult>,
  'leaveRoom' : ActorMethod<[RoomCode, SessionId], boolean>,
  'sendMessage' : ActorMethod<[RoomCode, SessionId, string], SendMessageResult>,
}
export declare const idlFactory: IDL.InterfaceFactory;
export declare const init: (args: { IDL: typeof IDL }) => IDL.Type[];
