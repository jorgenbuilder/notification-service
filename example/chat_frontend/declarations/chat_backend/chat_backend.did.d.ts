import type { Principal } from '@dfinity/principal';
import type { ActorMethod } from '@dfinity/agent';
import type { IDL } from '@dfinity/candid';

export type CreateRoomResult = {
    'Ok' : { 'room' : Room, 'roomCode' : RoomCode }
  } |
  { 'Err' : string };
export type GetJoinedRoomResult = { 'Ok' : { 'room' : Room } } |
  { 'Err' : string };
export type JoinRoomResult = { 'Ok' : { 'room' : Room } } |
  { 'Err' : string };
export interface Message {
  'id' : bigint,
  'content' : string,
  'sender' : Principal,
  'timestamp' : bigint,
  'senderName' : string,
}
export interface Room {
  'creator' : Principal,
  'participants' : Array<User>,
  'messages' : Array<Message>,
  'code' : RoomCode,
  'lastActivity' : bigint,
  'createdAt' : bigint,
}
export type RoomCode = string;
export type SendMessageResult = { 'Ok' : Message } |
  { 'Err' : string };
export interface User {
  'principal' : Principal,
  'displayName' : string,
  'joinedAt' : bigint,
}
export interface _SERVICE {
  'cleanup' : ActorMethod<[], undefined>,
  'createRoom' : ActorMethod<[], CreateRoomResult>,
  'endRoom' : ActorMethod<[RoomCode], boolean>,
  'getDebugInfo' : ActorMethod<[RoomCode], string>,
  'getJoinedRoom' : ActorMethod<[RoomCode], GetJoinedRoomResult>,
  'getMessages' : ActorMethod<[RoomCode], Array<Message>>,
  'getRoom' : ActorMethod<[RoomCode], [] | [Room]>,
  'joinRoom' : ActorMethod<[RoomCode], JoinRoomResult>,
  'leaveRoom' : ActorMethod<[RoomCode], boolean>,
  'myRoomCodes' : ActorMethod<[], Array<RoomCode>>,
  'sendMessage' : ActorMethod<[RoomCode, string], SendMessageResult>,
}
export declare const idlFactory: IDL.InterfaceFactory;
export declare const init: (args: { IDL: typeof IDL }) => IDL.Type[];
