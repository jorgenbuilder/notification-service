module {

  public let NOTIFICATION_CANISTER_ID = "zjwxf-jyaaa-aaaao-a43ca-cai";

  public type Subscription = {
    endpoint : Text;
    expirationTime : ?Nat;
    keys : {
      p256dh : Text;
      auth : Text;
    };
  };

  public type Vapid = {
    subject : Text;
    publicKey : Text;
    privateKey : Text;
  };

  public type NotificationBody = {
    title : Text;
    content : Text;
    url : ?Text;
  };

  public type NotificationCanisterActor = actor {
    updateApplication : (Vapid) -> async ();
    subscribe : (user : Principal, subscription : Subscription) -> async ();
    unsubscribe : (user : Principal, endpoint : Text) -> async ();
    unsubscribeAll : (user : Principal) -> async ();
    sendNotification : (user : Principal, body : NotificationBody) -> async ();
  };

  public func getActor() : NotificationCanisterActor = actor (NOTIFICATION_CANISTER_ID);

};
