import Text "mo:base/Text";
import Time "mo:base/Time";
import Random "mo:base/Random";
import Char "mo:base/Char";
import Buffer "mo:base/Buffer";
import Array "mo:base/Array";
import _Option "mo:base/Option";
import _Result "mo:base/Result";
import HashMap "mo:base/HashMap";
import Iter "mo:base/Iter";
import Principal "mo:base/Principal";
import _Debug "mo:base/Debug";
import Nat "mo:base/Nat";

persistent actor canChatBackend {
  // Types
  public type RoomCode = Text;
  public type SessionId = Text;
  public type User = {
    sessionId : SessionId;
    principal : Principal;
    displayName : Text;
    joinedAt : Int;
  };

  public type Message = {
    id : Nat;
    sender : SessionId;
    senderName : Text;
    content : Text;
    timestamp : Int;
  };

  public type Room = {
    code : RoomCode;
    creator : SessionId;
    participants : [User];
    messages : [Message];
    createdAt : Int;
    lastActivity : Int;
  };

  public type CreateRoomResult = {
    #Ok : { roomCode : RoomCode; room : Room; sessionId : SessionId };
    #Err : Text;
  };

  public type JoinRoomResult = {
    #Ok : { room : Room; sessionId : SessionId };
    #Err : Text;
  };

  public type SendMessageResult = {
    #Ok : Message;
    #Err : Text;
  };

  // State - Make all counters persistent
  private flexible var rooms : HashMap.HashMap<RoomCode, Room> = HashMap.HashMap<RoomCode, Room>(10, Text.equal, Text.hash);
  private flexible var sessions : HashMap.HashMap<SessionId, User> = HashMap.HashMap<SessionId, User>(10, Text.equal, Text.hash);
  private flexible var messageIdCounter : Nat = 0;
  private flexible var userCounter : Nat = 0;
  private let SESSION_TIMEOUT : Int = 20 * 60 * 1000_000_000; // 20 minutes in nanoseconds
  private let alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

  // Migration function to handle upgrade
  system func preupgrade() {
    // This function is called before upgrade
    // The old stable variables will be automatically migrated
  };

  system func postupgrade() {
    // This function is called after upgrade
    // Initialize any new state if needed
  };

  // Sample uniformly in [0, n) using rejection sampling from 2^p range.
  private func sampleIndex(f : Random.Finite, n : Nat) : ?Nat {
    assert n > 0;

    // Smallest p with 2^p >= n
    var p : Nat8 = 0;
    var m = n - 1 : Nat;
    while (m > 0) { p += 1; m /= 2 };

    switch (f.range(p)) {
      case (?k) {
        if (k < n) ?k else sampleIndex(f, n) // retry via recursion
      };
      case null { null }; // entropy exhausted
    };
  };

  // Get the idx-th character of a Text.
  private func charAt(t : Text, idx : Nat) : Char {
    var i = 0;
    for (c in t.chars()) {
      // iterate characters
      if (i == idx) return c;
      i += 1;
    };
    assert false; // idx < t.size() by construction
    ' ' // unreachable
  };

  // Helper function to generate 6-character alphanumeric code
  private func generateRoomCode() : async Text {
    var f = Random.Finite(await Random.blob()); // fetch 256-bit entropy
    var code = "";
    var i = 0;
    let n = alphabet.size(); // 36 characters

    while (i < 6) {
      switch (sampleIndex(f, n)) {
        case (?j) {
          code #= Char.toText(charAt(alphabet, j));
          i += 1;
        };
        case null {
          // need fresh entropy
          f := Random.Finite(await Random.blob());
        };
      };
    };
    code;
  };

  // Helper function to generate session ID
  private func generateSessionId() : async Text {
    var f = Random.Finite(await Random.blob());
    var sessionId = "";
    var i = 0;
    let n = alphabet.size();

    while (i < 12) {
      // Longer session ID for uniqueness
      switch (sampleIndex(f, n)) {
        case (?j) {
          sessionId #= Char.toText(charAt(alphabet, j));
          i += 1;
        };
        case null {
          f := Random.Finite(await Random.blob());
        };
      };
    };
    sessionId;
  };

  // Helper function to check if room exists and is valid
  private func isRoomValid(roomCode : RoomCode) : Bool {
    switch (rooms.get(roomCode)) {
      case (?room) {
        let now = Time.now();
        now - room.lastActivity <= SESSION_TIMEOUT;
      };
      case null { false };
    };
  };

  // Helper function to clean up expired rooms and sessions
  private func cleanupExpiredRooms() {
    let now = Time.now();
    let expiredRooms = Buffer.Buffer<RoomCode>(0);
    let expiredSessions = Buffer.Buffer<SessionId>(0);

    // Clean up expired rooms
    for ((code, room) in rooms.entries()) {
      if (now - room.lastActivity > SESSION_TIMEOUT) {
        expiredRooms.add(code);
      };
    };

    // Clean up expired sessions
    for ((sessionId, user) in sessions.entries()) {
      if (now - user.joinedAt > SESSION_TIMEOUT) {
        expiredSessions.add(sessionId);
      };
    };

    for (code in expiredRooms.vals()) {
      rooms.delete(code);
    };

    for (sessionId in expiredSessions.vals()) {
      sessions.delete(sessionId);
    };
  };

  // Helper function to create or get user
  private func createOrGetUser(sessionId : SessionId, principal : Principal) : User {
    switch (sessions.get(sessionId)) {
      case (?user) { user };
      case null {
        userCounter += 1; // Increment user counter
        let user : User = {
          sessionId = sessionId;
          principal = principal;
          displayName = "User " # Nat.toText(userCounter); // Use sequential numbering
          joinedAt = Time.now();
        };
        sessions.put(sessionId, user);
        user;
      };
    };
  };

  // Public functions
  public shared (msg) func createRoom() : async CreateRoomResult {
    cleanupExpiredRooms();

    let sessionId = await generateSessionId();
    let user = createOrGetUser(sessionId, msg.caller);

    var roomCode = await generateRoomCode();
    var attempts = 0;

    // Ensure unique room code
    while (rooms.get(roomCode) != null and attempts < 10) {
      roomCode := await generateRoomCode();
      attempts += 1;
    };

    if (attempts >= 10) {
      return #Err("Failed to generate unique room code");
    };

    let now = Time.now();
    let room : Room = {
      code = roomCode;
      creator = sessionId;
      participants = [user];
      messages = [];
      createdAt = now;
      lastActivity = now;
    };

    rooms.put(roomCode, room);
    #Ok({ roomCode; room; sessionId });
  };

  public shared (msg) func joinRoom(roomCode : RoomCode) : async JoinRoomResult {
    cleanupExpiredRooms();

    switch (rooms.get(roomCode)) {
      case (?room) {
        if (not isRoomValid(roomCode)) {
          rooms.delete(roomCode);
          return #Err("Room has expired");
        };

        let sessionId = await generateSessionId();
        let user = createOrGetUser(sessionId, msg.caller);

        // Check if user is already in the room (by session ID)
        if (Array.find<User>(room.participants, func(u) = u.sessionId == sessionId) != null) {
          return #Ok({ room; sessionId });
        };

        // Add user to room
        let updatedRoom = {
          room with
          participants = Array.append<User>(room.participants, [user]);
          lastActivity = Time.now();
        };

        rooms.put(roomCode, updatedRoom);
        #Ok({ room = updatedRoom; sessionId });
      };
      case null {
        #Err("Room not found");
      };
    };
  };

  public shared (_msg) func sendMessage(roomCode : RoomCode, sessionId : SessionId, content : Text) : async SendMessageResult {
    cleanupExpiredRooms();

    switch (rooms.get(roomCode)) {
      case (?room) {
        if (not isRoomValid(roomCode)) {
          rooms.delete(roomCode);
          return #Err("Room has expired");
        };

        // Check if user is in the room
        switch (Array.find<User>(room.participants, func(u) = u.sessionId == sessionId)) {
          case (?user) {
            let message : Message = {
              id = messageIdCounter;
              sender = sessionId;
              senderName = user.displayName;
              content = content;
              timestamp = Time.now();
            };

            messageIdCounter += 1;

            let updatedRoom = {
              room with
              messages = Array.append<Message>(room.messages, [message]);
              lastActivity = Time.now();
            };

            rooms.put(roomCode, updatedRoom);
            #Ok(message);
          };
          case null {
            #Err("You are not a member of this room");
          };
        };
      };
      case null {
        #Err("Room not found");
      };
    };
  };

  public query func getRoom(roomCode : RoomCode) : async ?Room {
    rooms.get(roomCode);
  };

  public query func getMessages(roomCode : RoomCode) : async [Message] {
    switch (rooms.get(roomCode)) {
      case (?room) { room.messages };
      case null { [] };
    };
  };

  // Creator-only: end a room explicitly
  public shared (_msg) func endRoom(roomCode : RoomCode, sessionId : SessionId) : async Bool {
    switch (rooms.get(roomCode)) {
      case (?room) {
        if (room.creator == sessionId) {
          rooms.delete(roomCode);
          true;
        } else {
          false;
        };
      };
      case null { false };
    };
  };

  public shared (_msg) func leaveRoom(roomCode : RoomCode, sessionId : SessionId) : async Bool {
    switch (rooms.get(roomCode)) {
      case (?room) {
        let updatedParticipants = Array.filter<User>(room.participants, func(u) = u.sessionId != sessionId);

        if (updatedParticipants.size() == 0) {
          // Delete room if no participants left
          rooms.delete(roomCode);
        } else {
          // Update room with remaining participants
          let updatedRoom = {
            room with
            participants = updatedParticipants;
            lastActivity = Time.now();
          };
          rooms.put(roomCode, updatedRoom);
        };
        true;
      };
      case null { false };
    };
  };

  // Debug functions to help troubleshoot
  public query func getDebugInfo(roomCode : RoomCode) : async Text {
    switch (rooms.get(roomCode)) {
      case (?room) {
        "Room: " # roomCode # "\n" #
        "Participants: " # Nat.toText(room.participants.size()) # "\n" #
        "Messages: " # Nat.toText(room.messages.size()) # "\n" #
        "User Counter: " # Nat.toText(userCounter) # "\n" #
        "Message Counter: " # Nat.toText(messageIdCounter);
      };
      case null { "Room not found" };
    };
  };

  public query func getAllSessions() : async [(SessionId, User)] {
    Iter.toArray(sessions.entries());
  };

  // Cleanup function (can be called periodically)
  public func cleanup() : async () {
    cleanupExpiredRooms();
  };
};
