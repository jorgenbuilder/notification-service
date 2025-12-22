import Error "mo:core/Error";
import List "mo:core/List";
import Map "mo:core/Map";
import Prim "mo:prim";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Queue "mo:core/Queue";

import PT "mo:promtracker";

import HTTP "./http";

persistent actor class NotificationCanister(worker : Principal) = self {

  type Application = {
    manager : Principal;
    var vapid : ?Vapid;
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

  type Vapid = {
    subject : Text;
    publicKey : Text;
    privateKey : Text;
  };

  type NotificationBody = {
    title : Text;
    content : Text;
    url : ?Text;
  };

  type Notification = {
    subscription : Subscription;
    vapid : Vapid;
    body : NotificationBody;
  };

  let applications : Map.Map<Principal, Application> = Map.empty();
  let notificationsQueue : Queue.Queue<Notification> = Queue.empty();

  private func getApplication(caller : Principal) : Application {
    let ?app = Map.get(applications, Principal.compare, caller) else Prim.trap("Caller does not have any application registered");
    app;
  };

  var ptData : PT.StableData = null;
  transient let pt = PT.PromTracker("", 65);

  ignore pt.addPullValue("applications_count", "", func() = Map.size(applications));
  transient let subscriptionsCount = pt.addCounter("subscriptions_count", "", true);
  transient let totalMessages = pt.addCounter("total_messages", "", true);
  transient let sentMessages = pt.addCounter("sent_messages", "", true);
  ignore pt.addPullValue("messages_in_queue", "", func() = Queue.size(notificationsQueue));

  pt.unshare(ptData);

  system func preupgrade() {
    ptData := pt.share();
  };

  public query func http_request(req : HTTP.HttpRequest) : async HTTP.HttpResponse {
    let ?path = Text.split(req.url, #char '?').next() else return HTTP.render400();
    switch (req.method, path) {
      case ("GET", "/metrics") pt.renderExposition("canister=\"" # PT.shortName(self) # "\"") |> HTTP.renderPlainText(_);
      case (_) HTTP.render400();
    };
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
      var vapid = null;
      subscriptions = Map.empty();
    };
    Map.add(applications, Principal.compare, manager, app);
  };

  public shared ({ caller }) func deregisterApplication(manager : Principal) {
    if (not Principal.isController(caller)) {
      throw Error.reject("Only controllers can register application");
    };
    let ?app = Map.get(applications, Principal.compare, manager) else return;
    var subscriptionsAmount = 0;
    for (subList in Map.values(app.subscriptions)) {
      subscriptionsAmount += List.size(subList);
    };
    subscriptionsCount.sub(subscriptionsAmount);
    Map.remove(applications, Principal.compare, manager);
  };

  // app owner interface
  public shared ({ caller }) func updateApplication(vapid : Vapid) {
    let app = getApplication(caller);
    app.vapid := ?vapid;
  };

  public shared ({ caller }) func subscribe(user : Principal, subscription : Subscription) {
    let app = getApplication(caller);
    let _ = ?app.vapid else throw Error.reject("Vapid is not configured");
    switch (Map.get(app.subscriptions, Principal.compare, user)) {
      case (?list) {
        switch (List.find<Subscription>(list, func(item) = item.endpoint == subscription.endpoint)) {
          case (?_) {};
          case (null) {
            List.add(list, subscription);
            subscriptionsCount.add(1);
          };
        };
      };
      case (null) {
        let l = List.fromArray<Subscription>([subscription]);
        Map.add(app.subscriptions, Principal.compare, user, l);
        subscriptionsCount.add(1);
      };
    };
  };

  public shared ({ caller }) func unsubscribe(user : Principal, endpoint : Text) {
    let app = getApplication(caller);
    switch (Map.get(app.subscriptions, Principal.compare, user)) {
      case (?list) {
        let listUpd = List.filter(list, func(item) = item.endpoint != endpoint);
        if (List.isEmpty(listUpd)) {
          Map.remove(app.subscriptions, Principal.compare, user);
        } else {
          Map.add(app.subscriptions, Principal.compare, user, listUpd);
        };
        subscriptionsCount.sub(List.size(list) - List.size(listUpd));
      };
      case (null) {};
    };
  };

  public shared ({ caller }) func unsubscribeAll(user : Principal) {
    let app = getApplication(caller);
    switch (Map.get(app.subscriptions, Principal.compare, user)) {
      case (?list) {
        Map.remove(app.subscriptions, Principal.compare, user);
        let count = List.size(list);
        if (count > 0) {
          subscriptionsCount.sub(count);
        };
      };
      case (null) {};
    };
  };

  public shared ({ caller }) func sendNotification(user : Principal, body : NotificationBody) {
    let app = getApplication(caller);
    let ?vapid = app.vapid else throw Error.reject("Vapid is not configured");
    let ?userSubscriptions = Map.get(app.subscriptions, Principal.compare, user) else return;
    for (subscription in List.values(userSubscriptions)) {
      Queue.pushBack(notificationsQueue, { subscription; vapid; body });
    };
    totalMessages.add(List.size(userSubscriptions));
  };

  // worker interface
  public shared query ({ caller }) func isQueueEmpty() : async Bool {
    assert caller == worker;
    Queue.isEmpty(notificationsQueue);
  };

  public shared ({ caller }) func collect() : async [Notification] {
    assert caller == worker;
    let ret : List.List<Notification> = List.empty();
    label l while (List.size(ret) < 100) {
      switch (Queue.popFront(notificationsQueue)) {
        case (?n) List.add(ret, n);
        case (null) break l;
      };
    };
    sentMessages.add(List.size(ret));
    List.toArray(ret);
  };

};
