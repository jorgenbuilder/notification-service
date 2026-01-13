import Error "mo:core/Error";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Queue "mo:core/Queue";

persistent actor class NotificationCanister(worker : Principal) = self {

  transient let CONST = {
    vapidPublicKey = "BHwsFW3GXWkq7v0U_QM3yF43-4U8bjn0Nfdc3tl4BuX3CkzZv9T3df84QHB8PABj5m34y3YRByQfHgC_uHNFYQ4";
  };

  type Application = {
    manager : Principal;
    subscriptions : Map.Map<Principal, List.List<Subscription>>;
  };

  type Subscription = {
    endpoint : Text;
    expirationTime : ?Nat;
    keys : {
      p256dh : Text;
      auth : Text;
    };
  };

  type NotificationBody = {
    title : Text;
    content : Text;
    url : ?Text;
    tag : ?Text;
  };

  type Notification = {
    subscription : Subscription;
    body : NotificationBody;
    context : (application : Principal, receiver : Principal);
  };

  let applications : Map.Map<Principal, Application> = Map.empty();
  let notificationsQueue : Queue.Queue<Notification> = Queue.empty();

  // end user interface
  public query func getVapidPublicKey() : async Text = async CONST.vapidPublicKey;

  public query ({ caller }) func hasSubscription(application : Principal, endpoint : Text) : async Bool {
    let ?app = Map.get(applications, Principal.compare, application) else throw Error.reject("Application not found");
    let ?list = Map.get(app.subscriptions, Principal.compare, caller) else return false;
    let ?_ = List.findIndex<Subscription>(list, func(item) = item.endpoint == endpoint) else return false;
    true;
  };

  public shared ({ caller }) func subscribe(application : Principal, subscription : Subscription) {
    if (Principal.isAnonymous(caller)) {
      throw Error.reject("Anonymous users cannot subscribe to notifications");
    };
    let ?app = Map.get(applications, Principal.compare, application) else throw Error.reject("Application not found");
    switch (Map.get(app.subscriptions, Principal.compare, caller)) {
      case (?list) {
        switch (List.findIndex<Subscription>(list, func(item) = item.endpoint == subscription.endpoint)) {
          case (?idx) List.put<Subscription>(list, idx, subscription);
          case (null) List.add(list, subscription);
        };
      };
      case (null) Map.add(app.subscriptions, Principal.compare, caller, List.fromArray<Subscription>([subscription]));
    };
  };

  private func removeSubscription_(app : Application, user : Principal, endpoint : Text) {
    switch (Map.get(app.subscriptions, Principal.compare, user)) {
      case (?list) {
        let listUpd = List.filter(list, func(item) = item.endpoint != endpoint);
        if (List.isEmpty(listUpd)) {
          Map.remove(app.subscriptions, Principal.compare, user);
        } else {
          Map.add(app.subscriptions, Principal.compare, user, listUpd);
        };
      };
      case (null) {};
    };
  };

  public shared ({ caller }) func unsubscribe(application : Principal, endpoint : Text) {
    let ?app = Map.get(applications, Principal.compare, application) else throw Error.reject("Application not found");
    removeSubscription_(app, caller, endpoint);
  };

  public shared ({ caller }) func unsubscribeAll(application : Principal) {
    let ?app = Map.get(applications, Principal.compare, application) else throw Error.reject("Application not found");
    Map.remove(app.subscriptions, Principal.compare, caller);
  };

  // admin interface
  public shared ({ caller }) func registerApplication(manager : Principal) {
    if (not Principal.isController(caller)) {
      throw Error.reject("Only controllers can register application");
    };
    if (Map.containsKey(applications, Principal.compare, manager)) {
      throw Error.reject("Already registered");
    };
    let app : Application = {
      manager;
      subscriptions = Map.empty();
    };
    Map.add(applications, Principal.compare, manager, app);
  };

  public shared ({ caller }) func deregisterApplication(manager : Principal) {
    if (not Principal.isController(caller)) {
      throw Error.reject("Only controllers can register application");
    };
    Map.remove(applications, Principal.compare, manager);
  };

  // app owner interface
  public shared ({ caller }) func sendNotifications(arg : [(user : Principal, body : NotificationBody)]) : async () {
    let ?app = Map.get(applications, Principal.compare, caller) else throw Error.reject("Caller does not have any application registered");
    for ((user, body) in arg.values()) {
      let ?userSubscriptions = Map.get(app.subscriptions, Principal.compare, user) else return;
      for (subscription in List.values(userSubscriptions)) {
        Queue.pushBack(notificationsQueue, { subscription; body; context = (caller, user) });
      };
    };
  };

  // worker interface
  public shared query ({ caller }) func peekQueue() : async [Notification] {
    assert caller == worker;
    let ret : List.List<Notification> = List.empty();
    label l for (n in Queue.values(notificationsQueue)) {
      List.add(ret, n);
      if (List.size(ret) == 100) {
        break l;
      };
    };
    List.toArray(ret);
  };

  public shared ({ caller }) func popQueue(amount : Nat) : async () {
    assert caller == worker;
    for (i in Nat.range(0, amount)) {
      ignore Queue.popFront(notificationsQueue);
    };
  };

  public shared ({ caller }) func reportBrokenSubscriptions(arg : [(application : Principal, user : Principal, endpoint : Text)]) : async () {
    assert caller == worker;
    label l for ((application, user, endpoint) in arg.values()) {
      let ?app = Map.get(applications, Principal.compare, application) else continue l;
      removeSubscription_(app, user, endpoint);
    };
  };

};
