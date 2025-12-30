module {

  public let NOTIFICATION_CANISTER_ID = "zjwxf-jyaaa-aaaao-a43ca-cai";

  public type NotificationBody = {
    title : Text;
    content : Text;
    url : ?Text;
  };

  public type NotificationCanisterActor = actor {
    sendNotification : (user : Principal, body : NotificationBody) -> async Nat;
  };

  public func getActor() : NotificationCanisterActor = actor (NOTIFICATION_CANISTER_ID);

};
