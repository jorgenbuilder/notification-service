export const idlFactory = ({ IDL }) => {
  const SessionId = IDL.Text;
  const User = IDL.Record({
    'principal' : IDL.Principal,
    'displayName' : IDL.Text,
    'joinedAt' : IDL.Int,
    'sessionId' : SessionId,
  });
  const Message = IDL.Record({
    'id' : IDL.Nat,
    'content' : IDL.Text,
    'sender' : SessionId,
    'timestamp' : IDL.Int,
    'senderName' : IDL.Text,
  });
  const RoomCode = IDL.Text;
  const Room = IDL.Record({
    'creator' : SessionId,
    'participants' : IDL.Vec(User),
    'messages' : IDL.Vec(Message),
    'code' : RoomCode,
    'lastActivity' : IDL.Int,
    'createdAt' : IDL.Int,
  });
  const CreateRoomResult = IDL.Variant({
    'Ok' : IDL.Record({
      'room' : Room,
      'sessionId' : SessionId,
      'roomCode' : RoomCode,
    }),
    'Err' : IDL.Text,
  });
  const JoinRoomResult = IDL.Variant({
    'Ok' : IDL.Record({ 'room' : Room, 'sessionId' : SessionId }),
    'Err' : IDL.Text,
  });
  const SendMessageResult = IDL.Variant({ 'Ok' : Message, 'Err' : IDL.Text });
  return IDL.Service({
    'cleanup' : IDL.Func([], [], []),
    'createRoom' : IDL.Func([], [CreateRoomResult], []),
    'endRoom' : IDL.Func([RoomCode, SessionId], [IDL.Bool], []),
    'getAllSessions' : IDL.Func(
        [],
        [IDL.Vec(IDL.Tuple(SessionId, User))],
        ['query'],
      ),
    'getDebugInfo' : IDL.Func([RoomCode], [IDL.Text], ['query']),
    'getMessages' : IDL.Func([RoomCode], [IDL.Vec(Message)], ['query']),
    'getRoom' : IDL.Func([RoomCode], [IDL.Opt(Room)], ['query']),
    'joinRoom' : IDL.Func([RoomCode], [JoinRoomResult], []),
    'leaveRoom' : IDL.Func([RoomCode, SessionId], [IDL.Bool], []),
    'sendMessage' : IDL.Func(
        [RoomCode, SessionId, IDL.Text],
        [SendMessageResult],
        [],
      ),
  });
};
export const init = ({ IDL }) => { return []; };
