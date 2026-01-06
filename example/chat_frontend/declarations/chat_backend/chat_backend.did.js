export const idlFactory = ({ IDL }) => {
  const User = IDL.Record({
    'principal' : IDL.Principal,
    'displayName' : IDL.Text,
    'joinedAt' : IDL.Int,
  });
  const Message = IDL.Record({
    'id' : IDL.Nat,
    'content' : IDL.Text,
    'sender' : IDL.Principal,
    'timestamp' : IDL.Int,
    'senderName' : IDL.Text,
  });
  const RoomCode = IDL.Text;
  const Room = IDL.Record({
    'creator' : IDL.Principal,
    'participants' : IDL.Vec(User),
    'messages' : IDL.Vec(Message),
    'code' : RoomCode,
    'lastActivity' : IDL.Int,
    'createdAt' : IDL.Int,
  });
  const CreateRoomResult = IDL.Variant({
    'Ok' : IDL.Record({ 'room' : Room, 'roomCode' : RoomCode }),
    'Err' : IDL.Text,
  });
  const GetJoinedRoomResult = IDL.Variant({
    'Ok' : IDL.Record({ 'room' : Room }),
    'Err' : IDL.Text,
  });
  const JoinRoomResult = IDL.Variant({
    'Ok' : IDL.Record({ 'room' : Room }),
    'Err' : IDL.Text,
  });
  const SendMessageResult = IDL.Variant({ 'Ok' : Message, 'Err' : IDL.Text });
  return IDL.Service({
    'cleanup' : IDL.Func([], [], []),
    'createRoom' : IDL.Func([], [CreateRoomResult], []),
    'endRoom' : IDL.Func([RoomCode], [IDL.Bool], []),
    'getDebugInfo' : IDL.Func([RoomCode], [IDL.Text], ['query']),
    'getJoinedRoom' : IDL.Func([RoomCode], [GetJoinedRoomResult], ['query']),
    'getMessages' : IDL.Func([RoomCode], [IDL.Vec(Message)], ['query']),
    'getRoom' : IDL.Func([RoomCode], [IDL.Opt(Room)], ['query']),
    'joinRoom' : IDL.Func([RoomCode], [JoinRoomResult], []),
    'leaveRoom' : IDL.Func([RoomCode], [IDL.Bool], []),
    'myRoomCodes' : IDL.Func([], [IDL.Vec(RoomCode)], ['query']),
    'sendMessage' : IDL.Func([RoomCode, IDL.Text], [SendMessageResult], []),
  });
};
export const init = ({ IDL }) => { return []; };
