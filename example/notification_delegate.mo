module {

  public let NOTIFICATION_CANISTER_ID = "zjwxf-jyaaa-aaaao-a43ca-cai";

  public type NotificationBody = {
    title : Text;
    content : Text;
    url : ?Text;
    tag : ?Text;
  };

  public type NotificationCanisterActor = actor {
    sendNotifications : (arg : [(user : Principal, body : NotificationBody)]) -> async [Bool];
  };

  public func getActor() : NotificationCanisterActor = actor (NOTIFICATION_CANISTER_ID);

};
